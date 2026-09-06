import { PGlite, type Transaction } from '@electric-sql/pglite';
import { ConflictException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import { CustomerNotificationService } from '../src/notifications/customer-notification.service';
import { NotificationWorkerService } from '../src/notifications/notification-worker.service';
import { NotificationSecretCipher } from '../src/notifications/notification-secret-cipher';
import { FakePushProviderAdapter, PushAdapterRegistry } from '../src/notifications/push-provider.adapter';
import type { NotificationRateLimiterService } from '../src/notifications/notification-rate-limiter.service';
import { TenantNotificationService } from '../src/notifications/tenant-notification.service';
import { TransactionalNotificationOutboxWorkerService } from '../src/notifications/transactional-notification-outbox-worker.service';

let database: PGlite;
let databaseService: DatabaseService;
let cipher: NotificationSecretCipher;
let worker: NotificationWorkerService;
let customerNotifications: CustomerNotificationService;
let tenantNotifications: TenantNotificationService;
let transactionalOutbox: TransactionalNotificationOutboxWorkerService;
let rateLimitCalls = 0;

const tenant = '01910000-0000-7000-8000-000000000001';
const accountA = '01910000-0000-7000-8000-000000000002';
const accountB = '01910000-0000-7000-8000-000000000003';
const deviceA = '01910000-0000-7000-8000-000000000004';
const deviceB = '01910000-0000-7000-8000-000000000005';
const tokenA = '01910000-0000-7000-8000-000000000006';
const tokenB = '01910000-0000-7000-8000-000000000007';
const apnsConfig = '01910000-0000-7000-8000-000000000008';
const fcmConfig = '01910000-0000-7000-8000-000000000009';
const campaignA = '01910000-0000-7000-8000-000000000010';
const campaignB = '01910000-0000-7000-8000-000000000011';
const recipientA = '01910000-0000-7000-8000-000000000012';
const recipientB = '01910000-0000-7000-8000-000000000013';
const inboxA = '01910000-0000-7000-8000-000000000014';

describe('notification database security boundaries', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of filenames) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(source
        .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
        .replace(/\bcitext\b/g, 'text'));
    }
    cipher = new NotificationSecretCipher({
      activeVersion: 1,
      keys: new Map([[1, Buffer.alloc(32, 7)]]),
    });
    const encryptedTokenA = cipher.encryptDeviceToken('raw-device-token-a-secure', {
      accountId: accountA, deviceId: deviceA, kind: 'device_token', platform: 'ios',
      tenantId: tenant, tokenId: tokenA,
    });
    const encryptedTokenB = cipher.encryptDeviceToken('raw-device-token-b-secure', {
      accountId: accountB, deviceId: deviceB, kind: 'device_token', platform: 'ios',
      tenantId: tenant, tokenId: tokenB,
    });
    const encryptedApns = cipher.encryptProviderCredentials({
      type: 'apns', bundleId: 'com.example.drama', keyId: 'KEY123',
      privateKey: 'x'.repeat(64), teamId: 'TEAM123',
    }, { configId: apnsConfig, environment: 'production', kind: 'provider_config', provider: 'apns', tenantId: tenant });
    const encryptedFcm = cipher.encryptProviderCredentials({
      type: 'fcm', clientEmail: 'push@example.com', privateKey: 'y'.repeat(64),
      projectId: 'example-project',
    }, { configId: fcmConfig, environment: 'production', kind: 'provider_config', provider: 'fcm', tenantId: tenant });
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenant}', 'notification-security', 'Notification security', now() + interval '1 year');
      insert into customer_accounts (id, tenant_id, username, password_hash) values
        ('${accountA}', '${tenant}', 'notify_account_a', '${'p'.repeat(32)}'),
        ('${accountB}', '${tenant}', 'notify_account_b', '${'q'.repeat(32)}');
      insert into customer_devices (
        id, tenant_id, account_id, device_token_hash, platform
      ) values
        ('${deviceA}', '${tenant}', '${accountA}', '${'a'.repeat(64)}', 'ios'),
        ('${deviceB}', '${tenant}', '${accountB}', '${'b'.repeat(64)}', 'ios');
      insert into customer_push_tokens (
        id, tenant_id, account_id, device_id, platform, token_ciphertext,
        token_digest, token_sha256, key_version
      ) values
        ('${tokenA}', '${tenant}', '${accountA}', '${deviceA}', 'ios',
          '${encryptedTokenA.ciphertext}', '${encryptedTokenA.tokenDigest}',
          '${encryptedTokenA.tokenSha256}', ${encryptedTokenA.keyVersion}),
        ('${tokenB}', '${tenant}', '${accountB}', '${deviceB}', 'ios',
          '${encryptedTokenB.ciphertext}', '${encryptedTokenB.tokenDigest}',
          '${encryptedTokenB.tokenSha256}', ${encryptedTokenB.keyVersion});
      insert into notification_provider_configs (
        id, tenant_id, provider, credentials_ciphertext, key_version, status,
        last_test_status, last_tested_at, created_by
      ) values
        ('${apnsConfig}', '${tenant}', 'apns', '${encryptedApns.ciphertext}',
          ${encryptedApns.keyVersion}, 'active',
          'passed', statement_timestamp(), '${accountA}'),
        ('${fcmConfig}', '${tenant}', 'fcm', '${encryptedFcm.ciphertext}',
          ${encryptedFcm.keyVersion}, 'active',
          'passed', statement_timestamp(), '${accountA}');
      insert into notification_campaigns (
        id, tenant_id, name, channels, target_type, created_by
      ) values
        ('${campaignA}', '${tenant}', 'Campaign A', array['in_app','push'], 'all', '${accountA}'),
        ('${campaignB}', '${tenant}', 'Campaign B', array['push'], 'all', '${accountA}');
      insert into notification_campaign_translations (
        id, tenant_id, campaign_id, locale, title, body
      ) values
        ('01910000-0000-7000-8000-000000000020', '${tenant}', '${campaignA}',
          'en-US', 'Title A', 'Body A'),
        ('01910000-0000-7000-8000-000000000021', '${tenant}', '${campaignB}',
          'en-US', 'Title B', 'Body B');
      update notification_campaigns set status = 'scheduled',
        scheduled_at = statement_timestamp() + interval '1 hour'
      where id in ('${campaignA}', '${campaignB}');
      insert into notification_campaign_recipients (
        id, tenant_id, campaign_id, account_id, locale, expansion_event_id
      ) values
        ('${recipientA}', '${tenant}', '${campaignA}', '${accountA}', 'en-US',
          '01910000-0000-7000-8000-000000000030'),
        ('${recipientB}', '${tenant}', '${campaignA}', '${accountB}', 'en-US',
          '01910000-0000-7000-8000-000000000031');
      insert into customer_inbox_messages (
        id, tenant_id, account_id, campaign_id, category, source_type,
        locale, title, body
      ) values (
        '${inboxA}', '${tenant}', '${accountA}', '${campaignA}', 'marketing',
        'campaign', 'en-US', 'Title A', 'Body A'
      );
      insert into notification_deliveries (
        id, tenant_id, account_id, campaign_id, recipient_id, push_token_id,
        provider_config_id, source_type, category, channel, dedupe_key, title, body
      ) values (
        '01910000-0000-7000-8000-000000000040', '${tenant}', '${accountA}',
        '${campaignA}', '${recipientA}', '${tokenA}', '${apnsConfig}', 'campaign',
        'marketing', 'push', 'valid-campaign-a-token-a', 'Title A', 'Body A'
      );
    `);
    databaseService = {
      inPlatformContext: <T>(callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ) => database.transaction(async (transaction) => {
        const tagged = transactionTag(transaction);
        await tagged`select set_config('app.access_scope', 'tenant', true),
          set_config('app.tenant_id', ${tenantId}, true)`;
        return callback(tagged);
      }),
    } as unknown as DatabaseService;
    const limiter = {
      consume: async () => { rateLimitCalls += 1; },
    } as unknown as NotificationRateLimiterService;
    worker = new NotificationWorkerService(
      databaseService,
      cipher,
      new PushAdapterRegistry([
        new FakePushProviderAdapter('apns'), new FakePushProviderAdapter('fcm'),
      ]),
      limiter,
    );
    customerNotifications = new CustomerNotificationService(databaseService, cipher);
    tenantNotifications = new TenantNotificationService(databaseService, cipher);
    transactionalOutbox = new TransactionalNotificationOutboxWorkerService(databaseService, worker);
  }, 30_000);

  afterAll(async () => database?.close());

  it('freezes a scheduled campaign, including translations and scheduled time', async () => {
    await expect(database.exec(`
      insert into notification_campaign_translations (
        id, tenant_id, campaign_id, locale, title, body
      ) values (
        '01910000-0000-7000-8000-000000000041', '${tenant}', '${campaignA}',
        'fr-FR', 'Titre', 'Corps'
      )
    `)).rejects.toThrow(/immutable after scheduling/);
    await expect(database.exec(`
      update notification_campaigns set scheduled_at = scheduled_at + interval '1 hour'
      where id = '${campaignA}'
    `)).rejects.toThrow(/immutable/);
    await expect(database.exec(`
      update notification_campaigns set target_json = '{"locales":["fr-FR"]}'::jsonb
      where id = '${campaignA}'
    `)).rejects.toThrow(/immutable/);
  });

  it('rejects cross-account and cross-campaign delivery graph splicing', async () => {
    await expect(database.exec(`
      insert into notification_deliveries (
        id, tenant_id, account_id, campaign_id, recipient_id, push_token_id,
        provider_config_id, source_type, category, channel, dedupe_key, title, body
      ) values (
        '01910000-0000-7000-8000-000000000042', '${tenant}', '${accountB}',
        '${campaignA}', '${recipientA}', '${tokenB}', '${apnsConfig}', 'campaign',
        'marketing', 'push', 'cross-account-recipient', 'x', 'x'
      )
    `)).rejects.toThrow(/recipient account or campaign binding/);
    await expect(database.exec(`
      insert into notification_deliveries (
        id, tenant_id, account_id, campaign_id, recipient_id, push_token_id,
        provider_config_id, source_type, category, channel, dedupe_key, title, body
      ) values (
        '01910000-0000-7000-8000-000000000043', '${tenant}', '${accountA}',
        '${campaignB}', '${recipientA}', '${tokenA}', '${apnsConfig}', 'campaign',
        'marketing', 'push', 'cross-campaign-recipient', 'x', 'x'
      )
    `)).rejects.toThrow(/recipient account or campaign binding/);
    await expect(database.exec(`
      insert into notification_deliveries (
        id, tenant_id, account_id, campaign_id, recipient_id, push_token_id,
        provider_config_id, source_type, category, channel, dedupe_key, title, body
      ) values (
        '01910000-0000-7000-8000-000000000044', '${tenant}', '${accountA}',
        '${campaignA}', '${recipientA}', '${tokenB}', '${apnsConfig}', 'campaign',
        'marketing', 'push', 'cross-account-token', 'x', 'x'
      )
    `)).rejects.toThrow(/push token or active matching provider/);
  });

  it('requires an active token and the platform-matching active tenant provider', async () => {
    await expect(database.exec(`
      insert into notification_deliveries (
        id, tenant_id, account_id, campaign_id, recipient_id, push_token_id,
        provider_config_id, source_type, category, channel, dedupe_key, title, body
      ) values (
        '01910000-0000-7000-8000-000000000045', '${tenant}', '${accountA}',
        '${campaignA}', '${recipientA}', '${tokenA}', '${fcmConfig}', 'campaign',
        'marketing', 'push', 'wrong-provider', 'x', 'x'
      )
    `)).rejects.toThrow(/active matching provider/);
    await database.exec(`
      update customer_push_tokens set status = 'revoked', revoked_at = statement_timestamp(),
        revoke_reason = 'security test' where id = '${tokenB}'
    `);
    await expect(database.exec(`
      insert into notification_deliveries (
        id, tenant_id, account_id, campaign_id, recipient_id, push_token_id,
        provider_config_id, source_type, category, channel, dedupe_key, title, body
      ) values (
        '01910000-0000-7000-8000-000000000046', '${tenant}', '${accountB}',
        '${campaignA}', '${recipientB}', '${tokenB}', '${apnsConfig}', 'campaign',
        'marketing', 'push', 'revoked-token', 'x', 'x'
      )
    `)).rejects.toThrow(/active matching provider/);
  });

  it('requires a bounded provider message id for a successful push fact', async () => {
    const delivery = '01910000-0000-7000-8000-000000000048';
    await database.exec(`
      insert into notification_deliveries (
        id, tenant_id, account_id, campaign_id, recipient_id, push_token_id,
        provider_config_id, source_type, category, channel, dedupe_key, title, body
      ) values (
        '${delivery}', '${tenant}', '${accountA}', '${campaignA}', '${recipientA}',
        '${tokenA}', '${apnsConfig}', 'campaign', 'marketing', 'push',
        'provider-message-id-check', 'x', 'x'
      )
    `);
    await expect(database.exec(`
      update notification_deliveries set status = 'sent', sent_at = statement_timestamp()
      where id = '${delivery}'
    `)).rejects.toThrow();
    await expect(database.exec(`
      update notification_deliveries set status = 'sent', sent_at = statement_timestamp(),
        provider_message_id = 'contains spaces' where id = '${delivery}'
    `)).rejects.toThrow();
    await expect(database.exec(`
      update notification_deliveries set status = 'sent', sent_at = statement_timestamp(),
        provider_message_id = 'projects/drama-project/messages/0:12345%message_1'
      where id = '${delivery}'
    `)).resolves.not.toThrow();
  });

  it('makes delivered inbox payload immutable and only permits unread to read', async () => {
    await database.exec(`
      update customer_inbox_messages set status = 'read', read_at = statement_timestamp()
      where id = '${inboxA}'
    `);
    await expect(database.exec(`
      update customer_inbox_messages set body = 'tampered' where id = '${inboxA}'
    `)).rejects.toThrow(/payload are immutable/);
    await expect(database.exec(`
      update customer_inbox_messages set status = 'unread', read_at = null where id = '${inboxA}'
    `)).rejects.toThrow(/cannot become unread/);
    await expect(database.exec(`
      delete from customer_inbox_messages where id = '${inboxA}'
    `)).rejects.toThrow();
  });

  it('freezes provider tenant, provider and creator identity', async () => {
    await expect(database.exec(`
      update notification_provider_configs set provider = 'fcm'
      where id = '${apnsConfig}'
    `)).rejects.toThrow(/identity is immutable/);
    await expect(database.exec(`
      update notification_provider_configs set environment = 'sandbox'
      where id = '${apnsConfig}'
    `)).rejects.toThrow(/environment requires new credentials/);
    await expect(database.exec(`
      update notification_provider_configs set environment = 'sandbox',
        credentials_ciphertext = credentials_ciphertext || 'x', version = version + 1
      where id = '${apnsConfig}'
    `)).rejects.toThrow(/reset test state/);
  });

  it('prevents merchant campaigns from claiming transactional delivery semantics', async () => {
    await expect(database.exec(`
      insert into notification_deliveries (
        id, tenant_id, account_id, campaign_id, recipient_id, inbox_message_id,
        source_type, category, channel, status, sent_at, dedupe_key, title, body
      ) values (
        '01910000-0000-7000-8000-000000000047', '${tenant}', '${accountA}',
        '${campaignA}', '${recipientA}', '${inboxA}', 'campaign', 'transactional',
        'in_app', 'sent', statement_timestamp(), 'fake-transactional', 'x', 'x'
      )
    `)).rejects.toThrow();
  });

  it('lets tenant cancellation only mark an unclaimed campaign delivery skipped', async () => {
    // Use the actual runtime authority, not the offline migration/function owner.
    await database.exec(`
      create role notification_cancellation_probe nosuperuser nobypassrls;
      grant usage on schema app, public to notification_cancellation_probe;
      grant select, update on notification_deliveries to notification_cancellation_probe;
      set role notification_cancellation_probe;
    `);
    await database.exec(`
      begin;
      select set_config('app.access_scope', 'tenant', true),
        set_config('app.tenant_id', '${tenant}', true);
      update notification_deliveries set status = 'skipped',
        last_error = 'campaign_cancelled' where id = '01910000-0000-7000-8000-000000000040';
      rollback;
    `);
    await expect(database.exec(`
      begin;
      select set_config('app.access_scope', 'tenant', true),
        set_config('app.tenant_id', '${tenant}', true);
      update notification_deliveries set status = 'skipped',
        last_error = 'campaign_cancelled', body = 'tampered'
      where id = '01910000-0000-7000-8000-000000000040';
    `)).rejects.toThrow(/only cancel/);
    await database.exec('rollback; reset role');
  });

  it('does not let the tenant database role forge a transactional inbox message', async () => {
    await database.exec(`
      create role notification_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to notification_tenant_probe;
      grant select, insert, update on customer_inbox_messages to notification_tenant_probe;
      set role notification_tenant_probe;
      begin;
      select set_config('app.access_scope', 'tenant', true),
        set_config('app.tenant_id', '${tenant}', true);
    `);
    await expect(database.exec(`
      insert into customer_inbox_messages (
        id, tenant_id, account_id, category, source_type, locale, title, body
      ) values (
        '01910000-0000-7000-8000-000000000049', '${tenant}', '${accountA}',
        'transactional', 'system', 'en-US', 'forged', 'forged'
      )
    `)).rejects.toThrow();
    await database.exec('rollback; reset role');
  });

  it('claims a transactional event atomically so concurrent delivery creates one inbox row', async () => {
    const eventId = '01910000-0000-7000-8000-000000000060';
    const input = {
      accountId: accountA, body: 'Receipt body', channels: ['in_app'] as const,
      eventId, locale: 'en-US' as const, tenantId: tenant, title: 'Receipt',
    };
    await Promise.all([worker.enqueueTransactional(input), worker.enqueueTransactional(input)]);
    const count = await database.query<{ count: string }>(`
      select count(*)::text as count from customer_inbox_messages
      where tenant_id = '${tenant}' and account_id = '${accountA}'
        and source_type = 'system' and title = 'Receipt'
    `);
    expect(count.rows[0]?.count).toBe('1');
  });

  it('consumes trusted commerce/security outbox facts once and ignores payload identities and marketing opt-out', async () => {
    const orderId = '01910000-0000-7000-8000-000000000100';
    const events = [
      ['01910000-0000-7000-8000-000000000101', 'OrderPendingPaymentCreated', 'order', orderId],
      ['01910000-0000-7000-8000-000000000102', 'CustomerPasswordChanged', 'customer_account', accountA],
      ['01910000-0000-7000-8000-000000000103', 'CustomerPasswordReset', 'customer_account', accountA],
      ['01910000-0000-7000-8000-000000000104', 'CustomerDeviceRevoked', 'customer_account', accountA],
    ] as const;
    await database.exec(`
      insert into customer_notification_preferences (
        tenant_id, account_id, preferred_locale, marketing_in_app_enabled,
        marketing_push_enabled
      ) values ('${tenant}', '${accountA}', 'ja-JP', false, false)
      on conflict (tenant_id, account_id) do update set preferred_locale = 'ja-JP',
        marketing_in_app_enabled = false, marketing_push_enabled = false;
      insert into orders (
        id, tenant_id, account_id, order_no, order_type, currency,
        subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
      ) values (
        '${orderId}', '${tenant}', '${accountA}', 'ORD01910000000070008000000001',
        'episode', 'USD', 199, 199, 'ja-JP', '{}'::jsonb,
        statement_timestamp() + interval '1 day'
      );
      ${events.map(([id, eventType, aggregateType, aggregateId]) => `
        insert into outbox_events (
          id, scope_type, tenant_id, event_key, idempotency_key,
          aggregate_type, aggregate_id, event_type, payload_json
        ) values (
          '${id}', 'tenant', '${tenant}', 'event:${id}', 'notification:${id}',
          '${aggregateType}', '${aggregateId}', '${eventType}',
          '{"accountId":"${accountB}","totalMinor":9000000000000000,"email":"leak@example.com"}'::jsonb
        );`).join('')}
    `);

    await Promise.all([transactionalOutbox.processAvailable(20), transactionalOutbox.processAvailable(20)]);
    const inbox = await database.query<{
      account_id: string; body: string; deep_link: string; locale: string; title: string;
    }>(`
      select account_id, body, deep_link, locale, title from customer_inbox_messages
      where source_type = 'system' and deep_link in (
        '/account/orders/${orderId}', '/account/security', '/account/devices'
      ) order by deep_link, title
    `);
    expect(inbox.rows).toHaveLength(4);
    expect(inbox.rows.every((row) => row.account_id === accountA && row.locale === 'ja-JP')).toBe(true);
    expect(JSON.stringify(inbox.rows)).not.toContain(accountB);
    expect(JSON.stringify(inbox.rows)).not.toContain('9000000000000000');
    expect(JSON.stringify(inbox.rows)).not.toContain('leak@example.com');
    const facts = await database.query<{ consumed: string; pushes: string }>(`
      select
        (select count(*)::text from notification_event_consumptions
          where event_id in (${events.map(([id]) => `'${id}'`).join(',')})
            and consumer = 'notification.dispatch.v1.transactional') as consumed,
        (select count(*)::text from notification_deliveries
          where dedupe_key in (${events.map(([id]) => `'${id}:push:${tokenA}'`).join(',')})) as pushes
    `);
    expect(facts.rows[0]).toEqual({ consumed: '4', pushes: '4' });

    await transactionalOutbox.processAvailable(20);
    const replayCount = await database.query<{ count: string }>(`
      select count(*)::text as count from customer_inbox_messages
      where source_type = 'system' and deep_link in (
        '/account/orders/${orderId}', '/account/security', '/account/devices'
      )
    `);
    expect(replayCount.rows[0]?.count).toBe('4');
  });

  it('re-queries successful payment/refund facts and ignores wrong-status or cross-tenant events', async () => {
    const otherTenant = '01910000-0000-7000-8000-000000000110';
    const orderId = '01910000-0000-7000-8000-000000000111';
    const providerId = '01910000-0000-7000-8000-000000000112';
    const configId = '01910000-0000-7000-8000-000000000113';
    const attemptId = '01910000-0000-7000-8000-000000000114';
    const chargeId = '01910000-0000-7000-8000-000000000115';
    const refundTransactionId = '01910000-0000-7000-8000-000000000116';
    const succeededRefundId = '01910000-0000-7000-8000-000000000117';
    const failedRefundId = '01910000-0000-7000-8000-000000000118';
    const mismatchedAttemptId = '01910000-0000-7000-8000-000000000124';
    const mismatchedChargeId = '01910000-0000-7000-8000-000000000125';
    const validEvents = [
      ['01910000-0000-7000-8000-000000000119', 'PaymentSucceeded', 'payment_attempt', attemptId],
      ['01910000-0000-7000-8000-000000000120', 'PaymentRefundSucceeded', 'payment_refund', succeededRefundId],
      ['01910000-0000-7000-8000-000000000121', 'PaymentRefundFailed', 'payment_refund', failedRefundId],
    ] as const;
    const ignoredEvents = [
      ['01910000-0000-7000-8000-000000000122', tenant, 'PaymentRefundSucceeded', failedRefundId],
      ['01910000-0000-7000-8000-000000000123', otherTenant, 'PaymentSucceeded', attemptId],
      ['01910000-0000-7000-8000-000000000126', tenant, 'PaymentSucceeded', mismatchedAttemptId],
    ] as const;
    await database.exec('set session_replication_role = replica');
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values (
        '${otherTenant}', 'notification-other-tenant', 'Other tenant',
        statement_timestamp() + interval '1 year'
      );
      insert into orders (
        id, tenant_id, account_id, order_no, order_type, status, currency,
        subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at,
        paid_at, refunded_at
      ) values (
        '${orderId}', '${tenant}', '${accountA}', 'ORD01910000000070008000000002',
        'episode', 'refunded', 'EUR', 599, 599, 'fr-FR', '{}'::jsonb,
        statement_timestamp() + interval '1 day', statement_timestamp(), statement_timestamp()
      );
      insert into payment_providers (id, code, adapter_code) values (
        '${providerId}', 'notification-fake', 'fake'
      );
      insert into payment_configs (
        id, owner_type, owner_tenant_id, provider_id, label
      ) values (
        '${configId}', 'tenant', '${tenant}', '${providerId}', 'Notification fixture'
      );
      insert into payment_attempts (
        id, tenant_id, account_id, order_id, provider_id, payment_config_id,
        adapter_code_snapshot, collection_mode, status, currency, amount_minor,
        external_payment_id, idempotency_key, succeeded_at
      ) values (
        '${attemptId}', '${tenant}', '${accountA}', '${orderId}', '${providerId}',
        '${configId}', 'fake', 'tenant_direct', 'succeeded', 'EUR', 599,
        'notification_payment_001', 'notification-payment-attempt-001', statement_timestamp()
      );
      insert into payment_attempts (
        id, tenant_id, account_id, order_id, provider_id, payment_config_id,
        adapter_code_snapshot, collection_mode, status, currency, amount_minor,
        external_payment_id, idempotency_key, succeeded_at
      ) values (
        '${mismatchedAttemptId}', '${tenant}', '${accountB}', '${orderId}', '${providerId}',
        '${configId}', 'fake', 'tenant_direct', 'succeeded', 'EUR', 599,
        'notification_payment_cross_account', 'notification-payment-cross-account',
        statement_timestamp()
      );
      insert into payment_transactions (
        id, tenant_id, attempt_id, order_id, provider_id, transaction_type,
        status, external_transaction_id, currency, amount_minor, payload_hash, occurred_at
      ) values
        ('${chargeId}', '${tenant}', '${attemptId}', '${orderId}', '${providerId}',
          'charge', 'succeeded', 'notification_charge_001', 'EUR', 599,
          '${'a'.repeat(64)}', statement_timestamp()),
        ('${refundTransactionId}', '${tenant}', '${attemptId}', '${orderId}', '${providerId}',
          'refund', 'succeeded', 'notification_refund_tx_001', 'EUR', 599,
          '${'b'.repeat(64)}', statement_timestamp()),
        ('${mismatchedChargeId}', '${tenant}', '${mismatchedAttemptId}', '${orderId}',
          '${providerId}', 'charge', 'succeeded', 'notification_cross_account_charge',
          'EUR', 599, '${'c'.repeat(64)}', statement_timestamp());
      insert into payment_refunds (
        id, tenant_id, order_id, attempt_id, payment_transaction_id,
        provider_id, payment_config_id, refund_transaction_id,
        adapter_code_snapshot, collection_mode, external_payment_id_snapshot,
        provider_idempotency_key, status, currency, amount_minor, reason,
        external_refund_id, requested_by_type, requested_by, processing_at,
        succeeded_at
      ) values (
        '${succeededRefundId}', '${tenant}', '${orderId}', '${attemptId}', '${chargeId}',
        '${providerId}', '${configId}', '${refundTransactionId}', 'fake', 'tenant_direct',
        'notification_payment_001', 'notification-refund-success-001', 'succeeded',
        'EUR', 599, 'Customer requested refund', 'notification_refund_001',
        'tenant_staff', '${accountA}', statement_timestamp(), statement_timestamp()
      );
      insert into payment_refunds (
        id, tenant_id, order_id, attempt_id, payment_transaction_id,
        provider_id, payment_config_id, adapter_code_snapshot, collection_mode,
        external_payment_id_snapshot, provider_idempotency_key, status, currency,
        amount_minor, reason, requested_by_type, requested_by, processing_at,
        failed_at, failure_code, failure_message
      ) values (
        '${failedRefundId}', '${tenant}', '${orderId}', '${attemptId}', '${chargeId}',
        '${providerId}', '${configId}', 'fake', 'tenant_direct',
        'notification_payment_001', 'notification-refund-failed-001', 'failed',
        'EUR', 599, 'Customer requested refund', 'tenant_staff', '${accountA}',
        statement_timestamp(), statement_timestamp(), 'provider_rejected',
        'Refund provider rejected the request'
      );
      ${validEvents.map(([id, eventType, aggregateType, aggregateId]) => `
        insert into outbox_events (
          id, scope_type, tenant_id, event_key, idempotency_key,
          aggregate_type, aggregate_id, event_type, payload_json
        ) values (
          '${id}', 'tenant', '${tenant}', 'event:${id}', 'notification:${id}',
          '${aggregateType}', '${aggregateId}', '${eventType}',
          '{"accountId":"${accountB}","orderId":"${tokenB}","amountMinor":1,"phone":"+15555550123"}'::jsonb
        );`).join('')}
      ${ignoredEvents.map(([id, eventTenant, eventType, aggregateId]) => `
        insert into outbox_events (
          id, scope_type, tenant_id, event_key, idempotency_key,
          aggregate_type, aggregate_id, event_type, payload_json
        ) values (
          '${id}', 'tenant', '${eventTenant}', 'event:${id}', 'notification:${id}',
          '${eventType === 'PaymentSucceeded' ? 'payment_attempt' : 'payment_refund'}',
          '${aggregateId}', '${eventType}', '{}'::jsonb
        );`).join('')}
    `);
    await database.exec('set session_replication_role = origin');

    await Promise.all([transactionalOutbox.processAvailable(20), transactionalOutbox.processAvailable(20)]);
    const inbox = await database.query<{
      account_id: string; body: string; deep_link: string; locale: string; title: string;
    }>(`
      select account_id, body, deep_link, locale, title from customer_inbox_messages
      where source_type = 'system' and deep_link = '/account/orders/${orderId}'
      order by title
    `);
    expect(inbox.rows).toHaveLength(3);
    expect(inbox.rows.map((row) => row.title).sort()).toEqual([
      'Paiement réussi', 'Remboursement effectué', 'Remboursement non effectué',
    ].sort());
    expect(inbox.rows.every((row) => row.account_id === accountA && row.locale === 'fr-FR')).toBe(true);
    expect(JSON.stringify(inbox.rows)).not.toContain(accountB);
    expect(JSON.stringify(inbox.rows)).not.toContain('+15555550123');
    const consumption = await database.query<{ count: string }>(`
      select count(*)::text as count from notification_event_consumptions
      where event_id in (
        ${[...validEvents, ...ignoredEvents].map(([id]) => `'${id}'`).join(',')}
      ) and consumer = 'notification.dispatch.v1.transactional'
    `);
    expect(consumption.rows[0]?.count).toBe('6');

    await transactionalOutbox.processAvailable(20);
    const replay = await database.query<{ count: string }>(`
      select count(*)::text as count from customer_inbox_messages
      where source_type = 'system' and deep_link = '/account/orders/${orderId}'
    `);
    expect(replay.rows[0]?.count).toBe('3');
  });

  it('safely consumes but does not notify when the tenant site is disabled', async () => {
    const eventId = '01910000-0000-7000-8000-000000000105';
    await database.exec(`
      update tenants set user_site_enabled = false where id = '${tenant}';
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        '${eventId}', 'tenant', '${tenant}', 'event:${eventId}', 'notification:${eventId}',
        'customer_account', '${accountA}', 'CustomerPasswordChanged', '{}'::jsonb
      )
    `);
    await transactionalOutbox.processAvailable(20);
    const facts = await database.query<{ consumed: string; visible: string }>(`
      select
        (select count(*)::text from notification_event_consumptions where event_id = '${eventId}') as consumed,
        (select count(*)::text from customer_inbox_messages
          where source_type = 'system' and title = 'パスワード変更') as visible
    `);
    expect(facts.rows[0]).toEqual({ consumed: '1', visible: '1' });
    await database.exec(`update tenants set user_site_enabled = true where id = '${tenant}'`);
  });

  it('drops a claimed push if its provider is disabled or version changes before network dispatch', async () => {
    const harness = worker as unknown as {
      claimDelivery(): Promise<{ id: string } | undefined>;
      processDelivery(delivery: unknown): Promise<void>;
    };
    const claimed = await harness.claimDelivery();
    expect(claimed).toBeDefined();
    await database.exec(`
      update notification_provider_configs set status = 'disabled', version = version + 1
      where id = '${apnsConfig}'
    `);
    await harness.processDelivery(claimed);
    const state = await database.query<{ last_error: string; status: string }>(`
      select status, last_error from notification_deliveries where id = '${claimed?.id}'
    `);
    expect(state.rows[0]).toEqual({
      last_error: 'recipient opted out or delivery binding is inactive', status: 'skipped',
    });
    await database.exec(`
      update notification_provider_configs set status = 'active', version = version + 1
      where id = '${apnsConfig}'
    `);
  });

  it('skips a marketing push when cancellation commits after claim but before send', async () => {
    const harness = worker as unknown as {
      claimDelivery(): Promise<unknown>;
      processDelivery(delivery: unknown): Promise<void>;
    };
    const claimed = await harness.claimDelivery();
    expect(claimed).toBeDefined();
    await database.exec(`
      update notification_campaigns set status = 'cancelled',
        cancelled_at = statement_timestamp(), cancel_reason = 'urgent stop'
      where id = '${campaignA}'
    `);
    await harness.processDelivery(claimed);
    const state = await database.query<{ status: string }>(`
      select status from notification_deliveries
      where id = '01910000-0000-7000-8000-000000000040'
    `);
    expect(state.rows[0]?.status).toBe('skipped');
  });

  it('stores only a fixed provider-test error code when an adapter leaks a secret in its error', async () => {
    const version = await database.query<{ version: number }>(`
      select version from notification_provider_configs where id = '${apnsConfig}'
    `);
    const eventId = '01910000-0000-7000-8000-000000000090';
    await database.exec(`
      insert into notification_dispatch_jobs (
        id, tenant_id, event_id, job_type, aggregate_id, aggregate_version
      ) values (
        '01910000-0000-7000-8000-000000000091', '${tenant}', '${eventId}',
        'provider_test', '${apnsConfig}', ${version.rows[0]?.version ?? 0}
      )
    `);
    const leakedSecret = 'PRIVATE_TOKEN_SHOULD_NEVER_REACH_DATABASE';
    const failedWorker = new NotificationWorkerService(
      databaseService,
      cipher,
      new PushAdapterRegistry([
        new FakePushProviderAdapter('apns', new Error(leakedSecret)),
      ]),
      { consume: async () => undefined } as unknown as NotificationRateLimiterService,
    );
    await failedWorker.processAvailable(1);
    const result = await database.query<{
      after_json: unknown; last_test_error: string; status: string;
    }>(`
      select config.status, config.last_test_error, audit.after_json
      from notification_provider_configs as config
      inner join audit_logs as audit on audit.resource_id = config.id
        and audit.action = 'notification.config.test_failed'
      where config.id = '${apnsConfig}'
    `);
    expect(result.rows[0]?.status).toBe('disabled');
    expect(result.rows[0]?.last_test_error).toBe('external_provider_failure');
    expect(JSON.stringify(result.rows[0])).not.toContain(leakedSecret);
  });

  it('does not consume marketing quota or create inbox rows when all chosen channels are opted out', async () => {
    const id = '01910000-0000-7000-8000-000000000061';
    const event = '01910000-0000-7000-8000-000000000062';
    const job = '01910000-0000-7000-8000-000000000063';
    await database.exec(`
      insert into customer_notification_preferences (
        tenant_id, account_id, preferred_locale, marketing_in_app_enabled,
        marketing_push_enabled
      ) values
        ('${tenant}', '${accountA}', 'en-US', false, false),
        ('${tenant}', '${accountB}', 'en-US', false, false)
      on conflict (tenant_id, account_id) do update set
        marketing_in_app_enabled = false, marketing_push_enabled = false;
      insert into notification_campaigns (
        id, tenant_id, name, channels, target_type, created_by
      ) values ('${id}', '${tenant}', 'Optout campaign', array['in_app'], 'all', '${accountA}');
      insert into notification_campaign_translations (
        id, tenant_id, campaign_id, locale, title, body
      ) values (
        '01910000-0000-7000-8000-000000000064', '${tenant}', '${id}',
        'en-US', 'Should not appear', 'Opted out'
      );
      update notification_campaigns set status = 'scheduled',
        scheduled_at = statement_timestamp() where id = '${id}';
      insert into notification_dispatch_jobs (
        id, tenant_id, event_id, job_type, aggregate_id
      ) values ('${job}', '${tenant}', '${event}', 'campaign_expand', '${id}');
    `);
    const beforeCalls = rateLimitCalls;
    await worker.processAvailable(10);
    const inbox = await database.query<{ count: string }>(`
      select count(*)::text as count from customer_inbox_messages
      where campaign_id = '${id}'
    `);
    expect(inbox.rows[0]?.count).toBe('0');
    expect(rateLimitCalls).toBe(beforeCalls);
  });

  it('never returns or audits a plaintext push token and blocks active cross-account reuse', async () => {
    const newDevice = '01910000-0000-7000-8000-000000000070';
    await database.exec(`
      insert into customer_devices (
        id, tenant_id, account_id, device_token_hash, platform
      ) values ('${newDevice}', '${tenant}', '${accountA}', '${'9'.repeat(64)}', 'ios')
    `);
    const principal = { accountId: accountA, deviceId: deviceA,
      sessionId: '01910000-0000-7000-8000-000000000071', tenantId: tenant,
      username: 'notify_account_a' };
    const rawToken = 'brand-new-plaintext-device-token';
    const response = await customerNotifications.registerPushToken(
      principal,
      { deviceId: newDevice, platform: 'ios', token: rawToken },
      { actorId: accountA, actorType: 'user', requestId: 'notification-register-request' },
    );
    expect(JSON.stringify(response)).not.toContain(rawToken);
    const stored = await database.query<{ after_json: unknown; token_ciphertext: string }>(`
      select token.token_ciphertext, audit.after_json
      from customer_push_tokens as token
      inner join audit_logs as audit on audit.resource_id = token.id
      where token.id = '${response.id}'
    `);
    expect(stored.rows[0]?.token_ciphertext).not.toContain(rawToken);
    expect(JSON.stringify(stored.rows[0]?.after_json)).not.toContain(rawToken);
    await expect(customerNotifications.registerPushToken(
      { ...principal, accountId: accountB, deviceId: deviceB, username: 'notify_account_b' },
      { deviceId: deviceB, platform: 'ios', token: rawToken },
      { actorId: accountB, actorType: 'user', requestId: 'notification-reuse-request' },
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('maps concurrent cross-account token registration to one success and one 409 without revoking loser state', async () => {
    const deviceOne = '01910000-0000-7000-8000-000000000080';
    const deviceTwo = '01910000-0000-7000-8000-000000000081';
    const oldOne = '01910000-0000-7000-8000-000000000082';
    const oldTwo = '01910000-0000-7000-8000-000000000083';
    const encryptedOne = cipher.encryptDeviceToken('old-device-token-one-secure', {
      accountId: accountA, deviceId: deviceOne, kind: 'device_token', platform: 'ios',
      tenantId: tenant, tokenId: oldOne,
    });
    const encryptedTwo = cipher.encryptDeviceToken('old-device-token-two-secure', {
      accountId: accountB, deviceId: deviceTwo, kind: 'device_token', platform: 'ios',
      tenantId: tenant, tokenId: oldTwo,
    });
    await database.exec(`
      insert into customer_devices (
        id, tenant_id, account_id, device_token_hash, platform
      ) values
        ('${deviceOne}', '${tenant}', '${accountA}', '${'7'.repeat(64)}', 'ios'),
        ('${deviceTwo}', '${tenant}', '${accountB}', '${'8'.repeat(64)}', 'ios');
      insert into customer_push_tokens (
        id, tenant_id, account_id, device_id, platform, token_ciphertext,
        token_digest, token_sha256, key_version
      ) values
        ('${oldOne}', '${tenant}', '${accountA}', '${deviceOne}', 'ios',
          '${encryptedOne.ciphertext}', '${encryptedOne.tokenDigest}',
          '${encryptedOne.tokenSha256}', ${encryptedOne.keyVersion}),
        ('${oldTwo}', '${tenant}', '${accountB}', '${deviceTwo}', 'ios',
          '${encryptedTwo.ciphertext}', '${encryptedTwo.tokenDigest}',
          '${encryptedTwo.tokenSha256}', ${encryptedTwo.keyVersion});
    `);
    const shared = 'concurrent-shared-push-token-secure';
    const first = customerNotifications.registerPushToken(
      { accountId: accountA, deviceId: deviceOne,
        sessionId: '01910000-0000-7000-8000-000000000084', tenantId: tenant,
        username: 'notify_account_a' },
      { deviceId: deviceOne, platform: 'ios', token: shared },
      { actorId: accountA, actorType: 'user', requestId: 'notification-concurrent-a' },
    );
    const second = customerNotifications.registerPushToken(
      { accountId: accountB, deviceId: deviceTwo,
        sessionId: '01910000-0000-7000-8000-000000000085', tenantId: tenant,
        username: 'notify_account_b' },
      { deviceId: deviceTwo, platform: 'ios', token: shared },
      { actorId: accountB, actorType: 'user', requestId: 'notification-concurrent-b' },
    );
    const results = await Promise.allSettled([first, second]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' ? rejected.reason : undefined)
      .toBeInstanceOf(ConflictException);
    const state = await database.query<{ count: string }>(`
      select count(*)::text as count from customer_push_tokens
      where id in ('${oldOne}', '${oldTwo}') and status = 'active'
    `);
    expect(state.rows[0]?.count).toBe('1');
  });

  it('uses expectedVersion for schedule/cancel idempotency and rejects concurrent stale writes', async () => {
    const id = '01910000-0000-7000-8000-000000000092';
    await database.exec(`
      insert into notification_campaigns (
        id, tenant_id, name, channels, target_type, created_by
      ) values (
        '${id}', '${tenant}', 'Optimistic campaign', array['in_app'], 'all', '${accountA}'
      );
      insert into notification_campaign_translations (
        id, tenant_id, campaign_id, locale, title, body
      ) values (
        '01910000-0000-7000-8000-000000000093', '${tenant}', '${id}',
        'en-US', 'Versioned', 'Versioned body'
      )
    `);
    const scheduledAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const metadata = (key: string) => ({
      actorId: accountA,
      actorType: 'tenant_staff' as const,
      idempotencyKey: key,
      requestId: `request-${key}`,
    });
    await expect(tenantNotifications.scheduleCampaign(
      tenant,
      id,
      { expectedVersion: 1, scheduledAt },
      metadata('schedule-stale-version'),
    )).rejects.toBeInstanceOf(ConflictException);
    const scheduled = await tenantNotifications.scheduleCampaign(
      tenant,
      id,
      { expectedVersion: 0, scheduledAt },
      metadata('schedule-current-version'),
    );
    expect(scheduled).toMatchObject({ status: 'scheduled', version: 1 });
    await expect(tenantNotifications.scheduleCampaign(
      tenant,
      id,
      { expectedVersion: 1, scheduledAt },
      metadata('schedule-current-version'),
    )).rejects.toBeInstanceOf(ConflictException);

    const cancellations = await Promise.allSettled([
      tenantNotifications.cancelCampaign(
        tenant,
        id,
        { expectedVersion: 1, reason: 'first concurrent cancellation' },
        metadata('cancel-concurrent-first'),
      ),
      tenantNotifications.cancelCampaign(
        tenant,
        id,
        { expectedVersion: 1, reason: 'second concurrent cancellation' },
        metadata('cancel-concurrent-second'),
      ),
    ]);
    expect(cancellations.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const failed = cancellations.find((result) => result.status === 'rejected');
    expect(failed?.status === 'rejected' ? failed.reason : undefined)
      .toBeInstanceOf(ConflictException);
    const state = await database.query<{ status: string; version: number }>(`
      select status, version from notification_campaigns where id = '${id}'
    `);
    expect(state.rows[0]).toEqual({ status: 'cancelled', version: 2 });
  });
});

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = (strings: TemplateStringsArray | string, ...values: unknown[]) => {
    if (typeof strings === 'string') return { identifier: strings };
    let sql = strings[0] ?? '';
    const parameters: unknown[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (typeof value === 'object' && value !== null
        && 'identifier' in value && typeof value.identifier === 'string') {
        sql += `"${value.identifier}"${strings[index + 1] ?? ''}`;
      } else {
        parameters.push(value);
        sql += `$${parameters.length}${strings[index + 1] ?? ''}`;
      }
    }
    return transaction.query(sql, parameters).then((result) => result.rows);
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}
