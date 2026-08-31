import { Inject, Injectable } from '@nestjs/common';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import {
  NotificationFrequencyExceeded,
  NotificationRateLimiterService,
  type NotificationCategory,
} from './notification-rate-limiter.service';
import {
  type NotificationLocale,
  NOTIFICATION_LOCALES,
} from './notification.types';
import {
  NotificationSecretCipher,
  type PushProvider,
  type PushProviderEnvironment,
} from './notification-secret-cipher';
import { InvalidPushTokenError, PushAdapterRegistry } from './push-provider.adapter';
import { PushProviderError } from './real-push-provider.adapters';
import { safeDeepLink } from './tenant-notification.service';

const BATCH_SIZE = 200;
const CONSUMER = 'notification.dispatch.v1';

interface ClaimedJob {
  aggregate_id: string;
  aggregate_version: number | null;
  event_id: string;
  id: string;
  job_type: 'campaign_expand' | 'provider_test';
  tenant_id: string;
}

interface ClaimedDelivery {
  account_id: string;
  attempt_count: number;
  body: string;
  campaign_id: string | null;
  category: NotificationCategory;
  deep_link: string | null;
  id: string;
  config_key_version: number;
  config_environment: PushProviderEnvironment;
  config_version: number;
  max_attempts: number;
  platform: 'android' | 'ios';
  provider: PushProvider;
  provider_config_id: string;
  push_token_id: string;
  tenant_id: string;
  title: string;
  token_ciphertext: string;
  token_key_version: number;
  credentials_ciphertext: string;
  device_id: string;
  dedupe_key: string;
}

@Injectable()
export class NotificationWorkerService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(NotificationSecretCipher) private readonly cipher: NotificationSecretCipher,
    @Inject(PushAdapterRegistry) private readonly adapters: PushAdapterRegistry,
    @Inject(NotificationRateLimiterService) private readonly rateLimiter: NotificationRateLimiterService,
  ) {}

  async processAvailable(maximum = 20): Promise<{ deliveries: number; jobs: number }> {
    const limit = Number.isInteger(maximum) ? Math.max(1, Math.min(100, maximum)) : 20;
    let jobs = 0;
    let deliveries = 0;
    for (; jobs < limit; jobs += 1) {
      const job = await this.claimJob();
      if (!job) break;
      await this.processJob(job);
    }
    for (; deliveries < limit; deliveries += 1) {
      const delivery = await this.claimDelivery();
      if (!delivery) break;
      await this.processDelivery(delivery);
    }
    return { deliveries, jobs };
  }

  async recoverStaleLocks(): Promise<void> {
    await this.database.inPlatformContext(async (transaction) => {
      await transaction`
        update notification_dispatch_jobs set status = 'retry',
          retry_count = retry_count + 1, available_at = statement_timestamp(),
          locked_at = null, locked_by = null, last_error = 'worker lock expired'
        where status = 'processing' and locked_at < statement_timestamp() - interval '10 minutes'
          and retry_count + 1 < max_attempts
      `;
      await transaction`
        update notification_dispatch_jobs set status = 'dead_letter',
          retry_count = max_attempts, locked_at = null, locked_by = null,
          last_error = 'worker_lock_expired'
        where status = 'processing' and locked_at < statement_timestamp() - interval '10 minutes'
          and retry_count + 1 >= max_attempts
      `;
      await transaction`
        update notification_deliveries set status = 'retry',
          attempt_count = attempt_count + 1, available_at = statement_timestamp(),
          locked_at = null, locked_by = null, last_error = 'worker lock expired'
        where status = 'processing' and locked_at < statement_timestamp() - interval '10 minutes'
          and attempt_count + 1 < max_attempts
      `;
      await transaction`
        update notification_deliveries set status = 'dead_letter',
          attempt_count = max_attempts, locked_at = null, locked_by = null,
          last_error = 'worker_lock_expired'
        where status = 'processing' and locked_at < statement_timestamp() - interval '10 minutes'
          and attempt_count + 1 >= max_attempts
      `;
    });
  }

  async enqueueTransactional(input: {
    accountId: string;
    body: string;
    channels: readonly ('in_app' | 'push')[];
    deepLink?: string;
    eventId: string;
    locale: NotificationLocale;
    tenantId: string;
    title: string;
  }): Promise<void> {
    const deepLink = safeDeepLink(input.deepLink);
    if (!NOTIFICATION_LOCALES.includes(input.locale)) throw new TypeError('locale is invalid');
    if (!input.channels.length || input.channels.some((channel) => channel !== 'in_app' && channel !== 'push')) {
      throw new TypeError('channels are invalid');
    }
    if (!validText(input.title, 200) || !validText(input.body, 2000)) {
      throw new TypeError('notification content is invalid');
    }
    await this.database.inPlatformContext(async (transaction) => {
      const claimed = await transaction<{ event_id: string }[]>`
        insert into notification_event_consumptions (event_id, consumer)
        values (${input.eventId}, ${`${CONSUMER}.transactional`})
        on conflict do nothing returning event_id
      `;
      if (!claimed[0]) return;
      const eligible = await transaction<{ id: string }[]>`
        select account.id from customer_accounts as account
        inner join tenants as tenant on tenant.id = account.tenant_id
        where account.tenant_id = ${input.tenantId} and account.id = ${input.accountId}
          and account.status = 'active' and tenant.status = 'active'
          and tenant.expires_at > statement_timestamp()
          and tenant.user_site_enabled and tenant.platform_site_enabled
        for share of account, tenant
      `;
      if (!eligible[0]) return;
      try {
        await this.rateLimiter.consume({
          accountId: input.accountId, category: 'transactional',
          deliveryId: `transactional:${input.eventId}:${input.accountId}`,
          tenantId: input.tenantId,
        });
      } catch (error: unknown) {
        if (error instanceof NotificationFrequencyExceeded) return;
        throw error;
      }
      if (input.channels.includes('in_app')) {
        const inboxId = uuidV7();
        await transaction`
          insert into customer_inbox_messages (
            id, tenant_id, account_id, category, source_type, locale,
            title, body, deep_link
          ) values (
            ${inboxId}, ${input.tenantId}, ${input.accountId}, 'transactional',
            'system', ${input.locale}, ${input.title}, ${input.body}, ${deepLink ?? null}
          )
        `;
        await transaction`
          insert into notification_deliveries (
            id, tenant_id, account_id, source_type, category, channel,
            inbox_message_id, status, dedupe_key, title, body, deep_link, sent_at
          ) values (
            ${uuidV7()}, ${input.tenantId}, ${input.accountId}, 'system', 'transactional',
            'in_app', ${inboxId}, 'sent', ${`${input.eventId}:in_app`},
            ${input.title}, ${input.body}, ${deepLink ?? null}, statement_timestamp()
          ) on conflict (tenant_id, dedupe_key) do nothing
        `;
      }
      if (input.channels.includes('push')) {
        await insertPushDeliveries(transaction, {
          accountId: input.accountId, body: input.body, category: 'transactional',
          deepLink, dedupePrefix: input.eventId, sourceType: 'system', tenantId: input.tenantId,
          title: input.title,
        });
      }
    });
  }

  private async claimJob(): Promise<ClaimedJob | undefined> {
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<ClaimedJob[]>`
        with candidate as (
          select id from notification_dispatch_jobs
          where status in ('pending', 'retry') and available_at <= statement_timestamp()
          order by available_at, created_at, id for update skip locked limit 1
        )
        update notification_dispatch_jobs as job set status = 'processing',
          locked_at = statement_timestamp(), locked_by = ${workerId()}, last_error = null
        from candidate where job.id = candidate.id
        returning job.id, job.tenant_id, job.event_id, job.job_type,
          job.aggregate_id, job.aggregate_version
      `;
      return rows[0];
    });
  }

  private async processJob(job: ClaimedJob): Promise<void> {
    try {
      if (job.job_type === 'provider_test') await this.processProviderTest(job);
      else await this.expandCampaign(job);
    } catch (error: unknown) {
      await this.failJob(job.id, error);
    }
  }

  private async processProviderTest(job: ClaimedJob): Promise<void> {
    const secret = await this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{
        credentials_ciphertext: string; environment: PushProviderEnvironment; id: string; key_version: number;
        provider: PushProvider; tenant_id: string; version: number;
      }>>`
        select id, tenant_id, provider, environment, credentials_ciphertext, key_version, version
        from notification_provider_configs
        where id = ${job.aggregate_id} and tenant_id = ${job.tenant_id}
          and version = ${job.aggregate_version}
      `;
      return rows[0];
    });
    if (!secret) {
      await this.database.inPlatformContext(async (transaction) => {
        await completeJob(transaction, job.id);
        await transaction`
          insert into notification_event_consumptions (event_id, consumer)
          values (${job.event_id}, ${CONSUMER}) on conflict do nothing
        `;
      });
      return;
    }
    const credentials = this.cipher.decryptProviderCredentials(secret.credentials_ciphertext, {
      configId: secret.id, keyVersion: secret.key_version, kind: 'provider_config',
      environment: secret.environment, provider: secret.provider, tenantId: secret.tenant_id,
    });
    try {
      await this.adapters.require(secret.provider).test(credentials);
    } catch (error: unknown) {
      await this.database.inPlatformContext(async (transaction) => {
        const updated = await transaction<{ id: string }[]>`
          update notification_provider_configs set status = 'disabled',
            last_test_status = 'failed', last_tested_at = statement_timestamp(),
            last_test_error = ${safeErrorCode(error)}, version = version + 1
          where id = ${secret.id} and tenant_id = ${secret.tenant_id}
            and version = ${secret.version}
          returning id
        `;
        if (updated[0]) {
          await workerAudit(transaction, secret.tenant_id, job.event_id,
            'notification.config.test_failed', secret.id,
            { provider: secret.provider, result: safeErrorCode(error) });
        }
        await completeJob(transaction, job.id);
        await transaction`
          insert into notification_event_consumptions (event_id, consumer)
          values (${job.event_id}, ${CONSUMER}) on conflict do nothing
        `;
      });
      return;
    }
    await this.database.inPlatformContext(async (transaction) => {
      const updated = await transaction<{ id: string }[]>`
        update notification_provider_configs set last_test_status = 'passed',
          last_tested_at = statement_timestamp(), last_test_error = null,
          version = version + 1 where id = ${secret.id} and tenant_id = ${secret.tenant_id}
            and version = ${secret.version} returning id
      `;
      if (!updated[0]) throw new Error('Provider configuration changed during test');
      await workerAudit(transaction, secret.tenant_id, job.event_id,
        'notification.config.test_passed', secret.id,
        { provider: secret.provider, result: 'passed' });
      await transaction`
        update notification_dispatch_jobs set status = 'completed', locked_at = null,
          locked_by = null where id = ${job.id} and status = 'processing'
      `;
      await transaction`
        insert into notification_event_consumptions (event_id, consumer)
        values (${job.event_id}, ${CONSUMER}) on conflict do nothing
      `;
    });
  }

  private async expandCampaign(job: ClaimedJob): Promise<void> {
    await this.database.inPlatformContext(async (transaction) => {
      const already = await transaction<{ event_id: string }[]>`
        select event_id from notification_event_consumptions
        where event_id = ${job.event_id} and consumer = ${CONSUMER}
      `;
      if (already[0]) {
        await completeJob(transaction, job.id);
        return;
      }
      const campaigns = await transaction<Array<{
        channels: string[]; deep_link: string | null; id: string; status: string;
        default_locale: NotificationLocale; target_json: Record<string, unknown>;
        target_type: string; tenant_id: string;
      }>>`
        select campaign.id, campaign.tenant_id, campaign.status, campaign.channels,
          campaign.target_type, campaign.target_json, campaign.deep_link,
          tenant.default_locale
        from notification_campaigns as campaign
        inner join tenants as tenant on tenant.id = campaign.tenant_id
        where campaign.id = ${job.aggregate_id}
          and campaign.tenant_id = ${job.tenant_id} for update of campaign
      `;
      const campaign = campaigns[0];
      if (!campaign || campaign.status === 'cancelled') {
        await completeJob(transaction, job.id);
        return;
      }
      if (campaign.status === 'scheduled') {
        const transitioned = await transaction<{ id: string }[]>`
          update notification_campaigns set status = 'dispatching', version = version + 1
          where id = ${campaign.id} and status = 'scheduled'
            and scheduled_at <= statement_timestamp() returning id
        `;
        if (!transitioned[0]) throw new Error('Campaign is not due');
      } else if (campaign.status !== 'dispatching') {
        await completeJob(transaction, job.id);
        return;
      }
      const target = parseStoredTarget(campaign.target_type, campaign.target_json);
      const accounts = await transaction<Array<{ account_id: string; locale: NotificationLocale }>>`
        select account.id as account_id,
          coalesce(preference.preferred_locale, tenant.default_locale)::text as locale
        from customer_accounts as account
        inner join tenants as tenant on tenant.id = account.tenant_id
        left join customer_notification_preferences as preference
          on preference.tenant_id = account.tenant_id and preference.account_id = account.id
        where account.tenant_id = ${campaign.tenant_id} and account.status = 'active'
          and tenant.status = 'active' and tenant.expires_at > statement_timestamp()
          and tenant.user_site_enabled and tenant.platform_site_enabled
          and (${target.locales.length === 0}
            or coalesce(preference.preferred_locale, tenant.default_locale) = any(${target.locales}))
          and (${target.registeredAfter}::timestamptz is null
            or account.created_at >= ${target.registeredAfter})
          and (${target.registeredBefore}::timestamptz is null
            or account.created_at < ${target.registeredBefore})
          and not exists (
            select 1 from notification_campaign_recipients as recipient
            where recipient.tenant_id = account.tenant_id
              and recipient.campaign_id = ${campaign.id} and recipient.account_id = account.id
          )
        order by account.created_at, account.id limit ${BATCH_SIZE}
        for share of account
      `;
      const translations = await transaction<Array<{
        body: string; locale: NotificationLocale; title: string;
      }>>`
        select locale, title, body from notification_campaign_translations
        where tenant_id = ${campaign.tenant_id} and campaign_id = ${campaign.id}
        order by locale
      `;
      if (!translations.length) throw new Error('Campaign has no translations');
      for (const account of accounts) {
        const translation = translationFor(translations, account.locale, campaign.default_locale);
        const recipientId = uuidV7();
        await transaction`
          insert into notification_campaign_recipients (
            id, tenant_id, campaign_id, account_id, locale, expansion_event_id
          ) values (
            ${recipientId}, ${campaign.tenant_id}, ${campaign.id}, ${account.account_id},
            ${translation.locale}, ${job.event_id}
          ) on conflict (tenant_id, campaign_id, account_id) do nothing
        `;
        const preferences = await transaction<Array<{
          marketing_in_app_enabled: boolean; marketing_push_enabled: boolean;
        }>>`
          select marketing_in_app_enabled, marketing_push_enabled
          from customer_notification_preferences where tenant_id = ${campaign.tenant_id}
            and account_id = ${account.account_id}
        `;
        const preference = preferences[0] ?? {
          marketing_in_app_enabled: true, marketing_push_enabled: true,
        };
        const inAppEnabled = campaign.channels.includes('in_app')
          && preference.marketing_in_app_enabled;
        const pushEnabled = campaign.channels.includes('push')
          && preference.marketing_push_enabled;
        if (!inAppEnabled && !pushEnabled) continue;
        try {
          await this.rateLimiter.consume({
            accountId: account.account_id, category: 'marketing',
            deliveryId: `campaign:${campaign.id}:account:${account.account_id}`,
            tenantId: campaign.tenant_id,
          });
        } catch (error: unknown) {
          if (error instanceof NotificationFrequencyExceeded) continue;
          throw error;
        }
        if (inAppEnabled) {
          const inboxId = uuidV7();
          await transaction`
            insert into customer_inbox_messages (
              id, tenant_id, account_id, campaign_id, category, source_type,
              locale, title, body, deep_link
            ) values (
              ${inboxId}, ${campaign.tenant_id}, ${account.account_id}, ${campaign.id},
              'marketing', 'campaign', ${translation.locale}, ${translation.title},
              ${translation.body}, ${campaign.deep_link}
            )
          `;
          await transaction`
            insert into notification_deliveries (
              id, tenant_id, account_id, campaign_id, recipient_id,
              inbox_message_id, source_type, category, channel, status,
              dedupe_key, title, body, deep_link, sent_at
            ) values (
              ${uuidV7()}, ${campaign.tenant_id}, ${account.account_id}, ${campaign.id},
              ${recipientId}, ${inboxId}, 'campaign', 'marketing', 'in_app', 'sent',
              ${`${campaign.id}:${account.account_id}:in_app`}, ${translation.title},
              ${translation.body}, ${campaign.deep_link}, statement_timestamp()
            ) on conflict (tenant_id, dedupe_key) do nothing
          `;
        }
        if (pushEnabled) {
          await insertPushDeliveries(transaction, {
            accountId: account.account_id, body: translation.body, campaignId: campaign.id,
            category: 'marketing', deepLink: campaign.deep_link ?? undefined,
            dedupePrefix: campaign.id, recipientId, sourceType: 'campaign',
            tenantId: campaign.tenant_id, title: translation.title,
          });
        }
      }
      if (accounts.length < BATCH_SIZE) {
        await transaction`
          update notification_campaigns set status = 'completed',
            expansion_completed_at = statement_timestamp(), version = version + 1
          where id = ${campaign.id} and status = 'dispatching'
        `;
        await transaction`
          insert into notification_event_consumptions (event_id, consumer)
          values (${job.event_id}, ${CONSUMER}) on conflict do nothing
        `;
        await completeJob(transaction, job.id);
      } else {
        await transaction`
          update notification_dispatch_jobs set status = 'pending', available_at = statement_timestamp(),
            locked_at = null, locked_by = null where id = ${job.id} and status = 'processing'
        `;
      }
    });
  }

  private async claimDelivery(): Promise<ClaimedDelivery | undefined> {
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<ClaimedDelivery[]>`
        with candidate as (
          select delivery.id from notification_deliveries as delivery
          where delivery.channel = 'push' and delivery.status in ('pending', 'retry')
            and delivery.available_at <= statement_timestamp()
          order by delivery.available_at, delivery.created_at, delivery.id
          for update skip locked limit 1
        ), claimed as (
          update notification_deliveries as delivery set status = 'processing',
            locked_at = statement_timestamp(), locked_by = ${workerId()}, last_error = null
          from candidate where delivery.id = candidate.id returning delivery.*
        )
        select claimed.id, claimed.tenant_id, claimed.account_id, claimed.campaign_id,
          claimed.dedupe_key, claimed.category,
          claimed.title, claimed.body, claimed.deep_link, claimed.attempt_count,
          claimed.max_attempts, claimed.push_token_id, claimed.provider_config_id,
          token.device_id, token.platform, token.token_ciphertext,
          token.key_version as token_key_version, config.provider,
          config.credentials_ciphertext, config.key_version as config_key_version,
          config.environment as config_environment, config.version as config_version
        from claimed
        inner join customer_push_tokens as token on token.id = claimed.push_token_id
          and token.tenant_id = claimed.tenant_id and token.account_id = claimed.account_id
        inner join notification_provider_configs as config on config.id = claimed.provider_config_id
          and config.tenant_id = claimed.tenant_id
      `;
      return rows[0];
    });
  }

  private async processDelivery(delivery: ClaimedDelivery): Promise<void> {
    try {
      const eligible = await this.database.inPlatformContext(async (transaction) => {
        const rows = await transaction<{ eligible: boolean }[]>`
          select exists (
            select 1 from customer_accounts as account
            inner join tenants as tenant on tenant.id = account.tenant_id
            left join customer_notification_preferences as preference
              on preference.tenant_id = account.tenant_id and preference.account_id = account.id
            inner join customer_push_tokens as token on token.tenant_id = account.tenant_id
              and token.account_id = account.id and token.id = ${delivery.push_token_id}
              and token.status = 'active'
            inner join notification_provider_configs as config
              on config.tenant_id = account.tenant_id and config.id = ${delivery.provider_config_id}
              and config.status = 'active'
              and config.version = ${delivery.config_version}
              and config.key_version = ${delivery.config_key_version}
            where account.tenant_id = ${delivery.tenant_id} and account.id = ${delivery.account_id}
              and account.status = 'active' and tenant.status = 'active'
              and tenant.expires_at > statement_timestamp()
              and tenant.user_site_enabled and tenant.platform_site_enabled
              and (${delivery.category} = 'transactional'
                or coalesce(preference.marketing_push_enabled, true))
              and (${delivery.category} = 'transactional' or exists (
                select 1 from notification_campaigns as campaign
                where campaign.id = ${delivery.campaign_id}
                  and campaign.tenant_id = ${delivery.tenant_id}
                  and campaign.status <> 'cancelled'
              ))
          ) as eligible
        `;
        return rows[0]?.eligible === true;
      });
      if (!eligible) {
        await this.skipDelivery(delivery.id, 'recipient opted out or delivery binding is inactive');
        return;
      }
      await this.rateLimiter.consume({
        accountId: delivery.account_id, category: delivery.category,
        deliveryId: delivery.category === 'marketing' && delivery.campaign_id
          ? `campaign:${delivery.campaign_id}:account:${delivery.account_id}`
          : `transactional:${delivery.dedupe_key.split(':push:')[0]}:${delivery.account_id}`,
        tenantId: delivery.tenant_id,
      });
      const token = this.cipher.decryptDeviceToken(delivery.token_ciphertext, {
        accountId: delivery.account_id, deviceId: delivery.device_id,
        keyVersion: delivery.token_key_version, kind: 'device_token', platform: delivery.platform,
        tenantId: delivery.tenant_id, tokenId: delivery.push_token_id,
      });
      const credentials = this.cipher.decryptProviderCredentials(delivery.credentials_ciphertext, {
        configId: delivery.provider_config_id, keyVersion: delivery.config_key_version,
        environment: delivery.config_environment, kind: 'provider_config',
        provider: delivery.provider, tenantId: delivery.tenant_id,
      });
      if (delivery.category === 'marketing' && delivery.campaign_id) {
        const campaignStillActive = await this.database.inPlatformContext(async (transaction) => {
          const rows = await transaction<{ active: boolean }[]>`
            select exists (
              select 1 from notification_campaigns where id = ${delivery.campaign_id}
                and tenant_id = ${delivery.tenant_id} and status <> 'cancelled'
            ) as active
          `;
          return rows[0]?.active === true;
        });
        if (!campaignStillActive) {
          await this.skipDelivery(delivery.id, 'campaign_cancelled');
          return;
        }
      }
      const bindingStillActive = await this.database.inPlatformContext(async (transaction) => {
        const rows = await transaction<{ active: boolean }[]>`
          select exists (
            select 1 from customer_push_tokens as token
            inner join customer_accounts as account on account.id = token.account_id
              and account.tenant_id = token.tenant_id and account.status = 'active'
            inner join tenants as tenant on tenant.id = account.tenant_id
              and tenant.status = 'active' and tenant.expires_at > statement_timestamp()
              and tenant.user_site_enabled and tenant.platform_site_enabled
            inner join notification_provider_configs as config
              on config.id = ${delivery.provider_config_id}
              and config.tenant_id = token.tenant_id and config.status = 'active'
              and config.version = ${delivery.config_version}
              and config.key_version = ${delivery.config_key_version}
            where token.id = ${delivery.push_token_id}
              and token.tenant_id = ${delivery.tenant_id}
              and token.account_id = ${delivery.account_id}
              and token.status = 'active' and token.key_version = ${delivery.token_key_version}
          ) as active
        `;
        return rows[0]?.active === true;
      });
      if (!bindingStillActive) {
        await this.skipDelivery(delivery.id, 'delivery_binding_changed');
        return;
      }
      const result = await this.adapters.require(delivery.provider).send({
        body: delivery.body, credentials, deepLink: delivery.deep_link ?? undefined,
        deliveryId: delivery.id, deviceToken: token, provider: delivery.provider,
        title: delivery.title,
      });
      if (typeof result.providerMessageId !== 'string'
        || !/^[-A-Za-z0-9._:@/%+=]{1,500}$/.test(result.providerMessageId)) {
        throw new PushProviderError('unexpected_provider_response', false);
      }
      await this.database.inPlatformContext(async (transaction) => {
        await transaction`
          update notification_deliveries set status = 'sent', sent_at = statement_timestamp(),
            provider_message_id = ${result.providerMessageId}, locked_at = null, locked_by = null
          where id = ${delivery.id} and status = 'processing'
        `;
      });
    } catch (error: unknown) {
      if (error instanceof NotificationFrequencyExceeded) {
        await this.skipDelivery(delivery.id, 'notification_frequency_limit_exceeded');
        return;
      }
      if (error instanceof InvalidPushTokenError) {
        await this.database.inPlatformContext(async (transaction) => {
          await transaction`
            update customer_push_tokens set status = 'revoked',
              revoked_at = statement_timestamp(), revoke_reason = 'provider rejected device token'
            where id = ${delivery.push_token_id} and tenant_id = ${delivery.tenant_id}
              and status = 'active'
          `;
          await transaction`
            update notification_deliveries set status = 'skipped',
              last_error = 'invalid_push_token', locked_at = null, locked_by = null
            where id = ${delivery.id} and status = 'processing'
          `;
        });
        return;
      }
      await this.failDelivery(delivery, error);
    }
  }

  private async failJob(id: string, error: unknown): Promise<void> {
    await this.database.inPlatformContext(async (transaction) => {
      await transaction`
        update notification_dispatch_jobs set
          retry_count = retry_count + 1,
          status = case when retry_count + 1 >= max_attempts then 'dead_letter' else 'retry' end,
          available_at = statement_timestamp() + make_interval(secs => least(3600, 2 ^ retry_count)),
          locked_at = null, locked_by = null, last_error = ${safeErrorCode(error)}
        where id = ${id} and status = 'processing'
      `;
    });
  }

  private async failDelivery(delivery: ClaimedDelivery, error: unknown): Promise<void> {
    const retryable = !(error instanceof PushProviderError) || error.retryable;
    await this.database.inPlatformContext(async (transaction) => {
      await transaction`
        update notification_deliveries set attempt_count = attempt_count + 1,
          status = case when not ${retryable} or attempt_count + 1 >= max_attempts
            then 'dead_letter' else 'retry' end,
          available_at = statement_timestamp()
            + make_interval(secs => least(3600, 2 ^ attempt_count)),
          locked_at = null, locked_by = null, last_error = ${safeErrorCode(error)}
        where id = ${delivery.id} and status = 'processing'
      `;
    });
  }

  private async skipDelivery(id: string, reason: string): Promise<void> {
    await this.database.inPlatformContext(async (transaction) => {
      await transaction`
        update notification_deliveries set status = 'skipped', last_error = ${reason},
          locked_at = null, locked_by = null where id = ${id} and status = 'processing'
      `;
    });
  }
}

async function insertPushDeliveries(transaction: DatabaseTransaction, input: {
  accountId: string; body: string; campaignId?: string; category: NotificationCategory;
  deepLink?: string; dedupePrefix: string; recipientId?: string;
  sourceType: 'campaign' | 'system'; tenantId: string; title: string;
}): Promise<void> {
  const bindings = await transaction<Array<{
    config_id: string; provider: PushProvider; token_id: string;
  }>>`
    select token.id as token_id, config.id as config_id, config.provider
    from customer_push_tokens as token
    inner join notification_provider_configs as config on config.tenant_id = token.tenant_id
      and config.status = 'active'
      and ((token.platform = 'ios' and config.provider = 'apns')
        or (token.platform = 'android' and config.provider = 'fcm'))
    where token.tenant_id = ${input.tenantId} and token.account_id = ${input.accountId}
      and token.status = 'active'
    order by token.created_at desc, token.id
  `;
  for (const binding of bindings) {
    await transaction`
      insert into notification_deliveries (
        id, tenant_id, account_id, campaign_id, recipient_id, push_token_id,
        provider_config_id, source_type, category, channel, dedupe_key,
        title, body, deep_link
      ) values (
        ${uuidV7()}, ${input.tenantId}, ${input.accountId}, ${input.campaignId ?? null},
        ${input.recipientId ?? null}, ${binding.token_id}, ${binding.config_id},
        ${input.sourceType}, ${input.category}, 'push',
        ${`${input.dedupePrefix}:push:${binding.token_id}`}, ${input.title},
        ${input.body}, ${input.deepLink ?? null}
      ) on conflict (tenant_id, dedupe_key) do nothing
    `;
  }
}

async function completeJob(transaction: DatabaseTransaction, id: string): Promise<void> {
  await transaction`
    update notification_dispatch_jobs set status = 'completed', locked_at = null,
      locked_by = null where id = ${id} and status = 'processing'
  `;
}

async function workerAudit(
  transaction: DatabaseTransaction,
  tenantId: string,
  requestId: string,
  action: string,
  resourceId: string,
  after: unknown,
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, request_id
    ) values (
      ${uuidV7()}, 'tenant', ${tenantId}, 'system', null, ${action},
      'notification_provider_config', ${resourceId},
      ${transaction.json(json(after))}, ${requestId}
    )
  `;
}

function parseStoredTarget(type: string, value: Record<string, unknown>) {
  if (type === 'all') return { locales: [] as string[], registeredAfter: null, registeredBefore: null };
  const locales = Array.isArray(value.locales)
    ? value.locales.filter((item): item is string => typeof item === 'string') : [];
  return {
    locales,
    registeredAfter: typeof value.registeredAfter === 'string' ? value.registeredAfter : null,
    registeredBefore: typeof value.registeredBefore === 'string' ? value.registeredBefore : null,
  };
}

function translationFor<T extends { locale: NotificationLocale }>(
  rows: T[],
  locale: NotificationLocale,
  tenantDefault: NotificationLocale,
): T {
  return rows.find((row) => row.locale === locale)
    ?? rows.find((row) => row.locale === tenantDefault)
    ?? rows.find((row) => row.locale === 'en-US') ?? rows[0]!;
}

function validText(value: string, maximum: number): boolean {
  return value === value.trim() && value.length > 0 && value.length <= maximum;
}

function safeErrorCode(error: unknown): string {
  if (error instanceof NotificationFrequencyExceeded) return 'notification_frequency_limit_exceeded';
  if (error instanceof PushProviderError) return error.code;
  const message = error instanceof Error ? error.message : '';
  if (message.includes('adapter is not installed')) return 'provider_adapter_unavailable';
  if (message.includes('ciphertext authentication failed')) return 'secret_authentication_failed';
  if (message.includes('no longer exists')) return 'notification_resource_missing';
  if (message.includes('not due')) return 'campaign_not_due';
  return 'external_provider_failure';
}

function workerId(): string { return `notification-${process.pid}`; }

function json(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
