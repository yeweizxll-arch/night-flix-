import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import {
  NotificationSecretCipher,
  type PushProvider,
  type PushProviderEnvironment,
} from './notification-secret-cipher';
import {
  NOTIFICATION_LOCALES,
  type CancelCampaignInput,
  type CreateCampaignInput,
  type NotificationLocale,
  type NotificationMutationMetadata,
  type ScheduleCampaignInput,
  type UpdateCampaignInput,
  type UpsertProviderConfigInput,
} from './notification.types';

type Channel = 'in_app' | 'push';

@Injectable()
export class TenantNotificationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(NotificationSecretCipher) private readonly cipher: NotificationSecretCipher,
  ) {}

  async listProviderConfigs(tenantId: string) {
    return this.database.inTenantContext(uuid(tenantId, 'tenantId'), async (transaction) => {
      await requireTenant(transaction, tenantId);
      const rows = await transaction<Array<{
        environment: PushProviderEnvironment; id: string; last_test_error: string | null; last_test_status: string | null;
        last_tested_at: Date | string | null; provider: PushProvider; status: string; version: number;
      }>>`
        select id, provider, environment, status, last_test_status, last_tested_at, last_test_error, version
        from notification_provider_configs where tenant_id = ${tenantId}
        order by provider
      `;
      return rows.map(safeConfig);
    });
  }

  async upsertProviderConfig(
    tenantId: string,
    providerValue: unknown,
    rawInput: UpsertProviderConfigInput,
    metadata: NotificationMutationMetadata,
  ) {
    const provider = pushProvider(providerValue);
    const input = providerConfigInput(rawInput);
    const environment = providerEnvironment(provider, input.environment);
    const configId = uuidV7();
    let encrypted: { ciphertext: string; keyVersion: number };
    try {
      encrypted = this.cipher.encryptProviderCredentials(input.credentials, {
        configId, environment, kind: 'provider_config', provider, tenantId,
      });
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Credentials are invalid');
    }
    return this.database.inTenantContext(uuid(tenantId, 'tenantId'), async (transaction) => {
      await requireTenant(transaction, tenantId);
      const command = await beginCommand<ReturnType<typeof safeConfig>>(transaction, {
        metadata, request: {
          credentialFingerprint: credentialFingerprint(provider, input.credentials),
          environment,
          expectedVersion: input.expectedVersion,
          provider,
        },
        routeKey: `notification.config.${provider}.upsert`, tenantId,
      });
      if (command.cached) return command.cached;
      const current = await transaction<Array<{ id: string; version: number }>>`
        select id, version from notification_provider_configs
        where tenant_id = ${tenantId} and provider = ${provider} for update
      `;
      if (current[0] && input.expectedVersion !== current[0].version) {
        throw new ConflictException('Provider configuration version changed');
      }
      if (!current[0] && input.expectedVersion !== undefined && input.expectedVersion !== 0) {
        throw new ConflictException('Provider configuration does not exist at that version');
      }
      const effectiveId = current[0]?.id ?? configId;
      if (effectiveId !== configId) {
        encrypted = this.cipher.encryptProviderCredentials(input.credentials, {
          configId: effectiveId, environment, kind: 'provider_config', provider, tenantId,
        });
      }
      const rows = await transaction<Array<{
        environment: PushProviderEnvironment; id: string; last_test_error: string | null; last_test_status: string | null;
        last_tested_at: Date | string | null; provider: PushProvider; status: string; version: number;
      }>>`
        insert into notification_provider_configs (
          id, tenant_id, provider, environment, credentials_ciphertext, key_version,
          status, created_by, updated_by
        ) values (
          ${effectiveId}, ${tenantId}, ${provider}, ${environment}, ${encrypted.ciphertext},
          ${encrypted.keyVersion}, 'disabled', ${metadata.actorId}, ${metadata.actorId}
        ) on conflict (tenant_id, provider) do update set
          credentials_ciphertext = excluded.credentials_ciphertext,
          environment = excluded.environment,
          key_version = excluded.key_version, status = 'disabled',
          last_test_status = null, last_tested_at = null, last_test_error = null,
          version = notification_provider_configs.version + 1,
          updated_by = excluded.updated_by
        returning id, provider, environment, status, last_test_status, last_tested_at, last_test_error, version
      `;
      const response = safeConfig(required(rows[0], 'Provider configuration was not saved'));
      await audit(transaction, tenantId, metadata, 'notification.config.upsert',
        'notification_provider_config', effectiveId, { environment, provider, status: 'disabled' });
      await completeCommand(transaction, command.id, response, 200, 'notification_provider_config', effectiveId);
      return response;
    });
  }

  async testProviderConfig(
    tenantId: string,
    providerValue: unknown,
    expectedVersionValue: unknown,
    metadata: NotificationMutationMetadata,
  ) {
    const provider = pushProvider(providerValue);
    const expectedVersion = integer(expectedVersionValue, 'expectedVersion', 0);
    return this.database.inTenantContext(uuid(tenantId, 'tenantId'), async (transaction) => {
      await requireTenant(transaction, tenantId);
      const command = await beginCommand<{ jobId: string; status: string }>(transaction, {
        metadata, request: { expectedVersion, provider },
        routeKey: `notification.config.${provider}.test`, tenantId,
      });
      if (command.cached) return command.cached;
      const configs = await transaction<{ id: string; version: number }[]>`
        select id, version from notification_provider_configs
        where tenant_id = ${tenantId} and provider = ${provider} for update
      `;
      const config = configs[0];
      if (!config) throw new NotFoundException('Provider configuration not found');
      if (config.version !== expectedVersion) throw new ConflictException('Provider configuration version changed');
      const eventId = uuidV7();
      const jobId = uuidV7();
      await transaction`
        insert into notification_dispatch_jobs (
          id, tenant_id, event_id, job_type, aggregate_id, aggregate_version
        ) values (
          ${jobId}, ${tenantId}, ${eventId}, 'provider_test', ${config.id}, ${config.version}
        )
      `;
      await outbox(transaction, tenantId, eventId, config.id, 'NotificationProviderTestRequested', {
        configId: config.id, provider,
      }, metadata.requestId);
      const response = { jobId, status: 'pending' };
      await audit(transaction, tenantId, metadata, 'notification.config.test_requested',
        'notification_provider_config', config.id, { jobId, provider });
      await completeCommand(transaction, command.id, response, 202, 'notification_provider_config', config.id);
      return response;
    });
  }

  async setProviderStatus(
    tenantId: string,
    providerValue: unknown,
    active: boolean,
    expectedVersionValue: unknown,
    metadata: NotificationMutationMetadata,
  ) {
    const provider = pushProvider(providerValue);
    const expectedVersion = integer(expectedVersionValue, 'expectedVersion', 0);
    return this.database.inTenantContext(uuid(tenantId, 'tenantId'), async (transaction) => {
      await requireTenant(transaction, tenantId);
      const command = await beginCommand<ReturnType<typeof safeConfig>>(transaction, {
        metadata, request: { active, expectedVersion, provider },
        routeKey: `notification.config.${provider}.${active ? 'enable' : 'disable'}`, tenantId,
      });
      if (command.cached) return command.cached;
      const rows = await transaction<Array<{
        environment: PushProviderEnvironment; id: string; last_test_error: string | null; last_test_status: string | null;
        last_tested_at: Date | string | null; provider: PushProvider; status: string; version: number;
      }>>`
        update notification_provider_configs set
          status = ${active ? 'active' : 'disabled'},
          version = version + 1, updated_by = ${metadata.actorId}
        where tenant_id = ${tenantId} and provider = ${provider}
          and version = ${expectedVersion}
          and (${!active} or last_test_status = 'passed')
        returning id, provider, environment, status, last_test_status, last_tested_at, last_test_error, version
      `;
      const row = rows[0];
      if (!row) throw new ConflictException(
        active ? 'Provider configuration must pass a test before activation' : 'Provider configuration not found',
      );
      const response = safeConfig(row);
      await audit(transaction, tenantId, metadata,
        active ? 'notification.config.enable' : 'notification.config.disable',
        'notification_provider_config', row.id, response);
      await completeCommand(transaction, command.id, response, 200, 'notification_provider_config', row.id);
      return response;
    });
  }

  async listCampaigns(tenantId: string, query: Record<string, unknown>) {
    const page = integer(query.page ?? 1, 'page', 1, 10_000);
    const pageSize = integer(query.pageSize ?? 20, 'pageSize', 1, 50);
    return this.database.inTenantContext(uuid(tenantId, 'tenantId'), async (transaction) => {
      await requireTenant(transaction, tenantId);
      const rows = await transaction<Array<{
        channels: Channel[]; created_at: Date | string; id: string; name: string;
        scheduled_at: Date | string | null; status: string; target_type: string; version: number;
      }>>`
        select id, name, status, channels, target_type, scheduled_at, version, created_at
        from notification_campaigns where tenant_id = ${tenantId}
        order by created_at desc, id desc limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return { items: rows.map((row) => ({ id: row.id, name: row.name, status: row.status,
        channels: row.channels, targetType: row.target_type,
        scheduledAt: row.scheduled_at ? iso(row.scheduled_at) : undefined,
        createdAt: iso(row.created_at), version: row.version })), page, pageSize };
    });
  }

  async getCampaign(tenantId: string, campaignIdValue: unknown) {
    const campaignId = uuid(campaignIdValue, 'campaignId');
    return this.database.inTenantContext(uuid(tenantId, 'tenantId'), async (transaction) => {
      await requireTenant(transaction, tenantId);
      const campaigns = await transaction<Array<{
        channels: Channel[]; deep_link: string | null; id: string; name: string;
        scheduled_at: Date | string | null; status: string; target_json: Record<string, unknown>;
        target_type: 'all' | 'conditions'; version: number;
      }>>`
        select id, name, status, channels, target_type, target_json, deep_link,
          scheduled_at, version from notification_campaigns
        where tenant_id = ${tenantId} and id = ${campaignId}
      `;
      const campaign = campaigns[0];
      if (!campaign) throw new NotFoundException('Campaign not found');
      const translations = await transaction<Array<{
        body: string; locale: NotificationLocale; title: string;
      }>>`
        select locale, title, body from notification_campaign_translations
        where tenant_id = ${tenantId} and campaign_id = ${campaignId} order by locale
      `;
      return { id: campaign.id, name: campaign.name, status: campaign.status,
        channels: campaign.channels, target: { type: campaign.target_type,
          conditions: campaign.target_type === 'conditions' ? campaign.target_json : undefined },
        deepLink: campaign.deep_link ?? undefined,
        scheduledAt: campaign.scheduled_at ? iso(campaign.scheduled_at) : undefined,
        translations: translations.map((row) => ({ locale: row.locale, title: row.title, body: row.body })),
        version: campaign.version };
    });
  }

  async updateDraftCampaign(
    tenantId: string,
    campaignIdValue: unknown,
    rawInput: UpdateCampaignInput,
    metadata: NotificationMutationMetadata,
  ) {
    const campaignId = uuid(campaignIdValue, 'campaignId');
    const input = campaignInput(rawInput);
    const expectedVersion = integer(rawInput.expectedVersion, 'expectedVersion', 0);
    return this.database.inTenantContext(uuid(tenantId, 'tenantId'), async (transaction) => {
      await requireTenant(transaction, tenantId);
      const command = await beginCommand<{ id: string; status: string; version: number }>(transaction, {
        metadata, request: { campaignId, expectedVersion, ...input },
        routeKey: `notification.campaign.${campaignId}.update`, tenantId,
      });
      if (command.cached) return command.cached;
      const rows = await transaction<{ id: string; version: number }[]>`
        update notification_campaigns set name = ${input.name}, channels = ${input.channels},
          target_type = ${input.target.type},
          target_json = ${transaction.json(json(input.target.conditions ?? {}))},
          deep_link = ${input.deepLink ?? null}, version = version + 1,
          updated_by = ${metadata.actorId}
        where tenant_id = ${tenantId} and id = ${campaignId} and status = 'draft'
          and version = ${expectedVersion} returning id, version
      `;
      const row = rows[0];
      if (!row) throw new ConflictException('Draft campaign version changed or campaign is not editable');
      await transaction`
        delete from notification_campaign_translations
        where tenant_id = ${tenantId} and campaign_id = ${campaignId}
      `;
      for (const translation of input.translations) {
        await transaction`
          insert into notification_campaign_translations (
            id, tenant_id, campaign_id, locale, title, body
          ) values (${uuidV7()}, ${tenantId}, ${campaignId}, ${translation.locale},
            ${translation.title}, ${translation.body})
        `;
      }
      const response = { id: campaignId, status: 'draft', version: row.version };
      await audit(transaction, tenantId, metadata, 'notification.campaign.update',
        'notification_campaign', campaignId, { ...response, channels: input.channels, target: input.target });
      await completeCommand(transaction, command.id, response, 200, 'notification_campaign', campaignId);
      return response;
    });
  }

  async createCampaign(
    tenantId: string,
    rawInput: CreateCampaignInput,
    metadata: NotificationMutationMetadata,
  ) {
    const input = campaignInput(rawInput);
    return this.database.inTenantContext(uuid(tenantId, 'tenantId'), async (transaction) => {
      await requireTenant(transaction, tenantId);
      const command = await beginCommand<{ id: string; status: string; version: number }>(transaction, {
        metadata, request: input, routeKey: 'notification.campaign.create', tenantId,
      });
      if (command.cached) return command.cached;
      const id = uuidV7();
      await transaction`
        insert into notification_campaigns (
          id, tenant_id, name, channels, target_type, target_json,
          deep_link, created_by, updated_by
        ) values (
          ${id}, ${tenantId}, ${input.name}, ${input.channels}, ${input.target.type},
          ${transaction.json(json(input.target.conditions ?? {}))}, ${input.deepLink ?? null},
          ${metadata.actorId}, ${metadata.actorId}
        )
      `;
      for (const translation of input.translations) {
        await transaction`
          insert into notification_campaign_translations (
            id, tenant_id, campaign_id, locale, title, body
          ) values (
            ${uuidV7()}, ${tenantId}, ${id}, ${translation.locale},
            ${translation.title}, ${translation.body}
          )
        `;
      }
      const response = { id, status: 'draft', version: 0 };
      await audit(transaction, tenantId, metadata, 'notification.campaign.create',
        'notification_campaign', id, { ...response, channels: input.channels, target: input.target });
      await completeCommand(transaction, command.id, response, 201, 'notification_campaign', id);
      return response;
    });
  }

  async scheduleCampaign(
    tenantId: string,
    campaignIdValue: unknown,
    rawInput: ScheduleCampaignInput,
    metadata: NotificationMutationMetadata,
  ) {
    const campaignId = uuid(campaignIdValue, 'campaignId');
    const input = scheduleInput(rawInput);
    return this.database.inTenantContext(uuid(tenantId, 'tenantId'), async (transaction) => {
      await requireTenant(transaction, tenantId);
      const command = await beginCommand<{
        id: string; jobId: string; scheduledAt: string; status: string; version: number;
      }>(
        transaction, { metadata, request: { campaignId, ...input },
          routeKey: `notification.campaign.${campaignId}.schedule`, tenantId },
      );
      if (command.cached) return command.cached;
      const rows = await transaction<{
        id: string; scheduled_at: Date | string; version: number;
      }[]>`
        update notification_campaigns set status = 'scheduled', scheduled_at = ${input.scheduledAt},
          version = version + 1, updated_by = ${metadata.actorId}
        where tenant_id = ${tenantId} and id = ${campaignId} and status = 'draft'
          and version = ${input.expectedVersion}
          and ${input.scheduledAt}::timestamptz >= statement_timestamp()
          and ${input.scheduledAt}::timestamptz <= statement_timestamp() + interval '366 days'
          and exists (select 1 from notification_campaign_translations
            where tenant_id = ${tenantId} and campaign_id = ${campaignId})
        returning id, scheduled_at, version
      `;
      const campaign = rows[0];
      if (!campaign) throw new ConflictException('Draft campaign is unavailable or schedule is invalid');
      const jobId = uuidV7();
      const eventId = uuidV7();
      await transaction`
        insert into notification_dispatch_jobs (
          id, tenant_id, event_id, job_type, aggregate_id, available_at
        ) values (
          ${jobId}, ${tenantId}, ${eventId}, 'campaign_expand', ${campaignId}, ${input.scheduledAt}
        )
      `;
      await outbox(transaction, tenantId, eventId, campaignId, 'NotificationCampaignScheduled',
        { campaignId, scheduledAt: iso(campaign.scheduled_at) }, metadata.requestId);
      const response = {
        id: campaignId,
        jobId,
        scheduledAt: iso(campaign.scheduled_at),
        status: 'scheduled',
        version: campaign.version,
      };
      await audit(transaction, tenantId, metadata, 'notification.campaign.schedule',
        'notification_campaign', campaignId, response);
      await completeCommand(transaction, command.id, response, 202, 'notification_campaign', campaignId);
      return response;
    });
  }

  async cancelCampaign(
    tenantId: string,
    campaignIdValue: unknown,
    rawInput: CancelCampaignInput,
    metadata: NotificationMutationMetadata,
  ) {
    const campaignId = uuid(campaignIdValue, 'campaignId');
    const input = cancelInput(rawInput);
    return this.database.inTenantContext(uuid(tenantId, 'tenantId'), async (transaction) => {
      await requireTenant(transaction, tenantId);
      const command = await beginCommand<{
        deliveredInAppMessagesRetained: true; id: string; status: string; version: number;
      }>(transaction, {
        metadata, request: { campaignId, ...input },
        routeKey: `notification.campaign.${campaignId}.cancel`, tenantId,
      });
      if (command.cached) return command.cached;
      const rows = await transaction<{ id: string; version: number }[]>`
        update notification_campaigns set status = 'cancelled',
          cancelled_at = statement_timestamp(), cancel_reason = ${input.reason},
          version = version + 1, updated_by = ${metadata.actorId}
        where tenant_id = ${tenantId} and id = ${campaignId}
          and status in ('draft', 'scheduled', 'dispatching')
          and version = ${input.expectedVersion}
        returning id, version
      `;
      if (!rows[0]) throw new ConflictException('Campaign cannot be cancelled');
      await transaction`
        update notification_deliveries set status = 'skipped',
          last_error = 'campaign_cancelled', locked_at = null, locked_by = null
        where tenant_id = ${tenantId} and campaign_id = ${campaignId}
          and status in ('pending', 'retry')
      `;
      // Inbox delivery is an immutable fact. Cancellation stops expansion and
      // unclaimed push work, but does not retract messages already delivered.
      const response = {
        deliveredInAppMessagesRetained: true as const,
        id: campaignId,
        status: 'cancelled',
        version: rows[0].version,
      };
      await audit(transaction, tenantId, metadata, 'notification.campaign.cancel',
        'notification_campaign', campaignId, { ...response, reason: input.reason });
      await completeCommand(transaction, command.id, response, 200, 'notification_campaign', campaignId);
      return response;
    });
  }
}

export function safeDeepLink(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 1000 || value !== value.trim()) {
    throw new BadRequestException('deepLink is invalid');
  }
  // Only app-local absolute paths are supported. Network-path references, schemes,
  // credentials, backslashes and control characters are deliberately excluded.
  if (!/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/?#-]+$/.test(value)
    || value.includes('\\') || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new BadRequestException('deepLink must be an app-local route');
  }
  return value;
}

function campaignInput(value: CreateCampaignInput) {
  if (!record(value)) throw new BadRequestException('Body is required');
  rejectUnknown(value as unknown as Record<string, unknown>, [
    'channels', 'deepLink', 'expectedVersion', 'name', 'target', 'translations',
  ]);
  const name = text(value.name, 'name', 1, 200);
  if (!Array.isArray(value.channels) || value.channels.length < 1 || value.channels.length > 2) {
    throw new BadRequestException('channels is invalid');
  }
  const channels = [...new Set(value.channels.map((item) => {
    if (item !== 'in_app' && item !== 'push') throw new BadRequestException('channels is invalid');
    return item;
  }))] as Channel[];
  if (channels.length !== value.channels.length) throw new BadRequestException('channels is invalid');
  if (!Array.isArray(value.translations) || value.translations.length < 1 || value.translations.length > 6) {
    throw new BadRequestException('translations is invalid');
  }
  const translations = value.translations.map((raw) => {
    if (!record(raw) || !NOTIFICATION_LOCALES.includes(raw.locale as NotificationLocale)) {
      throw new BadRequestException('translation locale is invalid');
    }
    return { locale: raw.locale as NotificationLocale,
      title: text(raw.title, 'translation title', 1, 200),
      body: text(raw.body, 'translation body', 1, 2000) };
  });
  if (new Set(translations.map((item) => item.locale)).size !== translations.length) {
    throw new BadRequestException('translation locale is duplicated');
  }
  const target = targetInput(value.target);
  return { channels, deepLink: safeDeepLink(value.deepLink), name, target, translations };
}

function targetInput(value: unknown): { type: 'all' | 'conditions'; conditions?: Record<string, unknown> } {
  if (!record(value) || (value.type !== 'all' && value.type !== 'conditions')) {
    throw new BadRequestException('target is invalid');
  }
  if (value.type === 'all') {
    if (value.conditions !== undefined && record(value.conditions) && Object.keys(value.conditions).length) {
      throw new BadRequestException('all target cannot contain conditions');
    }
    return { type: 'all' };
  }
  if (!record(value.conditions)) throw new BadRequestException('target conditions are invalid');
  const allowed = new Set(['locales', 'registeredAfter', 'registeredBefore']);
  if (Object.keys(value.conditions).some((key) => !allowed.has(key))) {
    throw new BadRequestException('target condition is unsupported');
  }
  const conditions: Record<string, unknown> = {};
  if (value.conditions.locales !== undefined) {
    if (!Array.isArray(value.conditions.locales) || value.conditions.locales.length < 1
      || value.conditions.locales.length > 6 || value.conditions.locales.some(
        (locale) => !NOTIFICATION_LOCALES.includes(locale as NotificationLocale),
      )) throw new BadRequestException('target locales are invalid');
    conditions.locales = [...new Set(value.conditions.locales)];
  }
  for (const field of ['registeredAfter', 'registeredBefore'] as const) {
    if (value.conditions[field] !== undefined) {
      const date = new Date(String(value.conditions[field]));
      if (!Number.isFinite(date.getTime())) throw new BadRequestException(`${field} is invalid`);
      conditions[field] = date.toISOString();
    }
  }
  if (conditions.registeredAfter && conditions.registeredBefore
    && String(conditions.registeredAfter) >= String(conditions.registeredBefore)) {
    throw new BadRequestException('target registration range is invalid');
  }
  return { conditions, type: 'conditions' };
}

function providerConfigInput(value: UpsertProviderConfigInput): {
  credentials: unknown;
  environment?: unknown;
  expectedVersion?: number;
} {
  if (!record(value) || value.credentials === undefined) throw new BadRequestException('credentials are required');
  rejectUnknown(value as unknown as Record<string, unknown>, ['credentials', 'environment', 'expectedVersion']);
  return { credentials: value.credentials, environment: value.environment,
    expectedVersion: value.expectedVersion === undefined
      ? undefined : integer(value.expectedVersion, 'expectedVersion', 0) };
}

function scheduleInput(value: ScheduleCampaignInput): {
  expectedVersion: number;
  scheduledAt: string;
} {
  if (!record(value) || typeof value.scheduledAt !== 'string') {
    throw new BadRequestException('scheduledAt is required');
  }
  rejectUnknown(value as unknown as Record<string, unknown>, ['expectedVersion', 'scheduledAt']);
  const parsed = new Date(value.scheduledAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value.scheduledAt) {
    throw new BadRequestException('scheduledAt must be an ISO timestamp');
  }
  return {
    expectedVersion: integer(value.expectedVersion, 'expectedVersion', 0),
    scheduledAt: value.scheduledAt,
  };
}

function cancelInput(value: CancelCampaignInput): { expectedVersion: number; reason: string } {
  if (!record(value)) throw new BadRequestException('Cancellation input is required');
  rejectUnknown(value as unknown as Record<string, unknown>, ['expectedVersion', 'reason']);
  return {
    expectedVersion: integer(value.expectedVersion, 'expectedVersion', 0),
    reason: text(value.reason, 'reason', 1, 1000),
  };
}

async function requireTenant(transaction: DatabaseTransaction, tenantId: string): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    select id from tenants where id = ${tenantId} and status = 'active'
      and expires_at > statement_timestamp() for share
  `;
  if (!rows[0]) throw new ForbiddenException('Tenant is unavailable');
}

async function beginCommand<T>(transaction: DatabaseTransaction, input: {
  metadata: NotificationMutationMetadata; request: unknown; routeKey: string; tenantId: string;
}): Promise<{ cached?: T; id?: string }> {
  const key = typeof input.metadata.idempotencyKey === 'string'
    ? input.metadata.idempotencyKey.trim() : '';
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    throw new BadRequestException('A valid Idempotency-Key header is required');
  }
  const requestHash = createHash('sha256').update(JSON.stringify(json(input.request))).digest('hex');
  const id = uuidV7();
  const inserted = await transaction<{ id: string }[]>`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, expires_at
    ) values (
      ${id}, 'tenant', ${input.tenantId}, 'tenant_staff', ${input.metadata.actorId},
      ${input.routeKey}, ${key}, ${requestHash}, statement_timestamp() + interval '24 hours'
    ) on conflict do nothing returning id
  `;
  if (inserted[0]) return { id };
  const rows = await transaction<Array<{
    id: string; request_hash: string; response_json: unknown; status: string;
  }>>`
    select id, request_hash, response_json, status from command_idempotency
    where scope_type = 'tenant' and tenant_id = ${input.tenantId}
      and actor_type = 'tenant_staff' and actor_id = ${input.metadata.actorId}
      and route_key = ${input.routeKey} and idempotency_key = ${key} for update
  `;
  const existing = rows[0];
  if (!existing) throw new ConflictException('Idempotency record is unavailable');
  if (existing.request_hash !== requestHash) throw new ConflictException('Idempotency-Key was used for another request');
  if (existing.status === 'completed' && existing.response_json !== null) {
    return { cached: existing.response_json as T };
  }
  throw new ConflictException('The same command is already processing');
}

async function completeCommand(
  transaction: DatabaseTransaction, id: string | undefined, response: unknown, status: number,
  resourceType: string, resourceId: string,
): Promise<void> {
  if (!id) return;
  await transaction`
    update command_idempotency set status = 'completed', response_status = ${status},
      response_json = ${transaction.json(json(response))}, resource_type = ${resourceType},
      resource_id = ${resourceId}, locked_at = null where id = ${id} and status = 'processing'
  `;
}

async function audit(
  transaction: DatabaseTransaction, tenantId: string, metadata: NotificationMutationMetadata,
  action: string, resourceType: string, resourceId: string, after: unknown,
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action, resource_type,
      resource_id, after_json, ip, request_id
    ) values (
      ${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff', ${metadata.actorId}, ${action},
      ${resourceType}, ${resourceId}, ${transaction.json(json(after))},
      ${metadata.ip ?? null}, ${metadata.requestId}
    )
  `;
}

async function outbox(
  transaction: DatabaseTransaction, tenantId: string, eventId: string, aggregateId: string,
  eventType: string, payload: unknown, requestId: string,
): Promise<void> {
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key, aggregate_type,
      aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, 'tenant', ${tenantId}, ${`event:${eventId}`},
      ${`${requestId}:${eventType}`}, 'notification_campaign', ${aggregateId},
      ${eventType}, ${transaction.json(json(payload))}
    )
  `;
}

function safeConfig(row: {
  environment: PushProviderEnvironment; id: string; last_test_error: string | null; last_test_status: string | null;
  last_tested_at: Date | string | null; provider: PushProvider; status: string; version: number;
}) {
  return { id: row.id, environment: row.environment, provider: row.provider, status: row.status,
    lastTestStatus: row.last_test_status ?? undefined,
    lastTestedAt: row.last_tested_at ? iso(row.last_tested_at) : undefined,
    lastTestError: row.last_test_error ?? undefined, version: row.version };
}

function pushProvider(value: unknown): PushProvider {
  if (value !== 'apns' && value !== 'fcm') throw new BadRequestException('provider is invalid');
  return value;
}

function providerEnvironment(
  provider: PushProvider,
  value: unknown,
): PushProviderEnvironment {
  const environment = value === undefined ? 'production' : value;
  if (environment !== 'production' && environment !== 'sandbox') {
    throw new BadRequestException('environment is invalid');
  }
  if (provider === 'fcm' && environment !== 'production') {
    throw new BadRequestException('FCM environment must be production');
  }
  return environment;
}

function credentialFingerprint(provider: PushProvider, value: unknown): string {
  if (!record(value)) throw new BadRequestException('Credentials are invalid');
  const ordered = provider === 'apns'
    ? [value.bundleId, value.keyId, value.privateKey, value.teamId]
    : [value.clientEmail, value.privateKey, value.projectId];
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function text(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value !== value.trim()
    || value.length < minimum || value.length > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

function integer(value: unknown, field: string, minimum: number, maximum = 2_147_483_647): number {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed)
    || parsed < minimum || parsed > maximum) throw new BadRequestException(`${field} is invalid`);
  return parsed;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new BadRequestException('Body contains unsupported fields');
  }
}

function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function iso(value: Date | string): string { return new Date(value).toISOString(); }
function json(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
