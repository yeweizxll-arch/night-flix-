import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
  BadRequestException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuthenticationRateLimiterService } from '../src/auth/authentication-rate-limiter.service';
import { CryptoWorkLimiterService } from '../src/auth/crypto-work-limiter.service';
import { hashPassword } from '../src/auth/password';
import { uuidV7 } from '../src/common/uuid-v7';
import { CustomerAuthenticationService } from '../src/customer-auth/customer-authentication.service';
import { CustomerOtpService } from '../src/customer-auth/customer-otp.service';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';
import { CustomerPrivacyService } from '../src/privacy/customer-privacy.service';
import { LegalDocumentService } from '../src/privacy/legal-document.service';
import { PrivacyErasureWorkerService } from '../src/privacy/privacy-erasure-worker.service';
import type { RedisService } from '../src/redis/redis.service';

let database: PGlite;
let authentication: CustomerAuthenticationService;
let legal: LegalDocumentService;
let privacy: CustomerPrivacyService;
let erasureWorker: PrivacyErasureWorkerService;

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773579001';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773579002';
const actorA = '018f2f45-7f5e-7e70-b17f-f6e773579003';
const dramaA = '018f2f45-7f5e-7e70-b17f-f6e773579004';
const episodeA = '018f2f45-7f5e-7e70-b17f-f6e773579005';
const accountB = '018f2f45-7f5e-7e70-b17f-f6e773579006';
const orderA = '018f2f45-7f5e-7e70-b17f-f6e773579007';
const orderItemA = '018f2f45-7f5e-7e70-b17f-f6e773579008';
const storageProviderA = '018f2f45-7f5e-7e70-b17f-f6e773579009';
const mediaA = '018f2f45-7f5e-7e70-b17f-f6e77357900a';
const paymentProviderA = '018f2f45-7f5e-7e70-b17f-f6e77357900b';
const paymentConfigA = '018f2f45-7f5e-7e70-b17f-f6e77357900c';
const paymentAttemptA = '018f2f45-7f5e-7e70-b17f-f6e77357900d';
const paymentTransactionA = '018f2f45-7f5e-7e70-b17f-f6e77357900e';

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}

function metadata(idempotencyKey = `privacy-${uuidV7()}`) {
  return { idempotencyKey, ip: '203.0.113.42', requestId: uuidV7() };
}

describe('customer legal consent and privacy erasure', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CUSTOMER_OTP_HMAC_SECRET = 'privacy-test-customer-otp-hmac-key-123456';
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const filename of (await readdir(directory)).filter(
      (name) => name.endsWith('.sql'),
    ).sort()) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(source
        .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
        .replace(/\bcitext\b/g, 'text'));
    }
    await database.exec(`
      insert into app.database_access_principals (role_name, access_scope)
      select current_user, 'platform' on conflict (role_name) do nothing;
      insert into tenants (id, code, name, expires_at) values
        ('${tenantA}', 'privacy-a', 'Privacy A', transaction_timestamp() + interval '1 year'),
        ('${tenantB}', 'privacy-b', 'Privacy B', transaction_timestamp() + interval '1 year');
      insert into customer_accounts (
        id, tenant_id, username, password_hash
      ) values (
        '${accountB}', '${tenantB}', 'privacy_other', '${'x'.repeat(64)}'
      );
      insert into storage_providers (
        id, owner_type, owner_tenant_id, provider, account_label, endpoint,
        bucket, credential_ciphertext, key_version
      ) values (
        '${storageProviderA}', 'tenant', '${tenantA}', 's3', 'privacy-media',
        'https://s3.privacy.example', 'privacy-bucket',
        'test-privacy-storage-credential-ciphertext', 1
      );
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, storage_provider_id, object_key,
        mime_type, size_bytes, checksum, status, transcode_status, duration_seconds
      ) values (
        '${mediaA}', 'tenant', '${tenantA}', 'video', '${storageProviderA}',
        'privacy/video.mp4', 'video/mp4', 1024, '${'e'.repeat(64)}',
        'ready', 'not_required', 120
      );
      insert into dramas (
        id, owner_type, owner_tenant_id, code, status, total_episodes
      ) values (
        '${dramaA}', 'tenant', '${tenantA}', 'privacy-drama', 'published', 1
      );
      insert into episodes (
        id, drama_id, episode_no, status, duration_seconds, media_asset_id
      ) values (
        '${episodeA}', '${dramaA}', 1, 'published', 120, '${mediaA}'
      );
      insert into payment_providers (id, code, adapter_code)
      values ('${paymentProviderA}', 'privacy_fake', 'fake');
      insert into payment_configs (
        id, owner_type, provider_id, label
      ) values (
        '${paymentConfigA}', 'platform', '${paymentProviderA}', 'Privacy fake payments'
      );
    `);
    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(
        (transaction) => callback(transactionTag(transaction)),
      ),
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        const tagged = transactionTag(transaction);
        await tagged`
          select set_config('app.access_scope', 'tenant', true),
            set_config('app.tenant_id', ${tenantId}, true)
        `;
        return callback(tagged);
      }),
    } as unknown as DatabaseService;
    const rateLimiter = new AuthenticationRateLimiterService({
      configured: false,
    } as RedisService);
    const crypto = new CryptoWorkLimiterService();
    const otp = new CustomerOtpService(databaseService, rateLimiter);
    authentication = new CustomerAuthenticationService(
      databaseService, rateLimiter, crypto, otp,
    );
    legal = new LegalDocumentService(databaseService);
    privacy = new CustomerPrivacyService(databaseService, crypto);
    erasureWorker = new PrivacyErasureWorkerService(databaseService);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('publishes immutable legal versions and fails registration closed without exact consent', async () => {
    await expect(authentication.register(tenantB, {
      legalConsents: [
        { documentId: uuidV7(), version: 1 },
        { documentId: uuidV7(), version: 1 },
      ],
      legalLocale: 'en-US',
      password: 'privacy registration password',
      username: 'missing_legal_docs',
    }, metadata())).rejects.toBeInstanceOf(ServiceUnavailableException);

    const privacyDraft = await legal.create(
      { actorId: actorA, tenantId: tenantA },
      {
        bodyMarkdown: '# Privacy\nPlain controlled Markdown.',
        documentType: 'privacy',
        locale: 'en-US',
        requiredForRegistration: true,
        title: 'Privacy notice',
      },
      metadata('legal-create-privacy'),
    );
    const termsDraft = await legal.create(
      { actorId: actorA, tenantId: tenantA },
      {
        bodyMarkdown: '# Terms\nPlain controlled Markdown.',
        documentType: 'terms',
        locale: 'en-US',
        requiredForRegistration: true,
        title: 'Terms of service',
      },
      metadata('legal-create-terms'),
    );
    expect(() => legal.create(
      { actorId: actorA, tenantId: tenantA },
      {
        bodyMarkdown: '<script>alert(1)</script>',
        documentType: 'community',
        locale: 'en-US',
        requiredForRegistration: false,
        title: 'Unsafe',
      },
      metadata('legal-create-unsafe'),
    )).toThrow(BadRequestException);
    const [privacyDocument, termsDocument] = await Promise.all([
      legal.publish(
        { actorId: actorA, tenantId: tenantA }, privacyDraft.id,
        { effectiveAt: new Date(Date.now() - 1000).toISOString(), expectedVersion: 0 },
        metadata('legal-publish-privacy'),
      ),
      legal.publish(
        { actorId: actorA, tenantId: tenantA }, termsDraft.id,
        { effectiveAt: new Date(Date.now() - 1000).toISOString(), expectedVersion: 0 },
        metadata('legal-publish-terms'),
      ),
    ]);
    await expect(database.exec(`
      update tenant_legal_document_versions set title = 'tampered'
      where id = '${privacyDocument.id}'
    `)).rejects.toThrow(/append-only/i);

    await expect(authentication.register(tenantA, {
      legalConsents: [{ documentId: privacyDocument.id, version: 1 }],
      legalLocale: 'en-US',
      password: 'privacy registration password',
      username: 'missing_terms_consent',
    }, metadata())).rejects.toThrow(/legalConsents|documents/i);
    const registered = await authentication.register(tenantA, {
      legalConsents: [
        { documentId: privacyDocument.id, version: privacyDocument.version },
        { documentId: termsDocument.id, version: termsDocument.version },
      ],
      legalLocale: 'en-US',
      password: 'privacy registration password',
      username: 'privacy_customer',
    }, metadata());
    const facts = await database.query<{
      accounts: string; consents: string; current_documents: string;
    }>(`
      select
        (select count(*)::text from customer_accounts
          where tenant_id = '${tenantA}' and username = 'privacy_customer') as accounts,
        (select count(*)::text from customer_legal_consents
          where tenant_id = '${tenantA}' and account_id = '${registered.accountId}') as consents,
        (select count(*)::text from tenant_legal_document_versions
          where tenant_id = '${tenantA}' and status = 'published'
            and effective_at <= transaction_timestamp()) as current_documents
    `);
    expect(facts.rows[0]).toEqual({ accounts: '1', consents: '2', current_documents: '2' });

    const current = await legal.current(tenantA, { locale: 'fr-FR' });
    expect(current.documents).toEqual(expect.arrayContaining([
      expect.objectContaining({ documentType: 'privacy', locale: 'en-US', version: 1 }),
      expect.objectContaining({ documentType: 'terms', locale: 'en-US', version: 1 }),
    ]));
  });

  it('requires a current password for bounded exports and never crosses accounts', async () => {
    const account = await database.query<{ id: string }>(`
      select id from customer_accounts where tenant_id = '${tenantA}'
        and username = 'privacy_customer'
    `);
    const accountId = account.rows[0]?.id as string;
    const principal = {
      accountId,
      deviceId: uuidV7(),
      sessionId: uuidV7(),
      tenantId: tenantA,
      username: 'privacy_customer',
    };
    await expect(privacy.exportData(principal, {
      currentPassword: 'wrong password', section: 'profile',
    }, { requestId: uuidV7() })).rejects.toBeInstanceOf(UnauthorizedException);
    const profile = await privacy.exportData(principal, {
      currentPassword: 'privacy registration password',
      pageSize: 10,
      section: 'profile',
    }, { requestId: uuidV7() });
    expect(profile.items).toEqual([
      expect.objectContaining({ accountId, username: 'privacy_customer' }),
    ]);
    expect(JSON.stringify(profile)).not.toMatch(
      /password_hash|token_hash|device_token|verification_grant|ciphertext|privacy_other/,
    );
  });

  it.each(['  password with edge spaces  ', 'a'.repeat(300), '汉字密码'])(
    'preserves valid login password bytes for exports and erasure (%#)', async (password) => {
      const accountId = uuidV7();
      await database.query(`insert into customer_accounts (id, tenant_id, username, password_hash)
        values ($1, $2, $3, $4)`, [accountId, tenantA, `password-${accountId}`, await hashPassword(password)]);
      const principal = { accountId, tenantId: tenantA, deviceId: uuidV7(), sessionId: uuidV7(), username: `password-${accountId}` };
      const result = await privacy.exportData(principal, { currentPassword: password, section: 'profile' }, { requestId: uuidV7() });
      expect(result.items).toEqual([expect.objectContaining({ accountId })]);
      if (password !== password.trim()) {
        await expect(privacy.exportData(principal, { currentPassword: password.trim(), section: 'profile' }, { requestId: uuidV7() }))
          .rejects.toBeInstanceOf(UnauthorizedException);
      }
      await expect(privacy.exportData(principal, { currentPassword: 'a'.repeat(4097), section: 'profile' }, { requestId: uuidV7() }))
        .rejects.toBeInstanceOf(BadRequestException);
      const resultErasure = await privacy.requestErasure(principal, { currentPassword: password, acknowledgeRetention: true }, metadata());
      expect(resultErasure.status).toBe('submitted');
    },
  );

  it('queues one erasure, revokes access, irreversibly scrubs PII, and retains anonymous facts', async () => {
    const account = await database.query<{ id: string }>(`
      select id from customer_accounts where tenant_id = '${tenantA}'
        and username = 'privacy_customer'
    `);
    const accountId = account.rows[0]?.id as string;
    const session = await authentication.login(tenantA, {
      deviceLabel: 'Personal phone with a name',
      devicePlatform: 'ios',
      identifier: 'privacy_customer',
      password: 'privacy registration password',
    }, metadata());
    const principal = session.principal;
    const commentId = uuidV7();
    const bulletId = uuidV7();
    const otpId = uuidV7();
    const inboxId = uuidV7();
    const entitlementId = uuidV7();
    await database.exec(`
      insert into interaction_comments (
        id, tenant_id, drama_id, episode_id, account_id, body
      ) values (
        '${commentId}', '${tenantA}', '${dramaA}', '${episodeA}', '${accountId}',
        'Contact me at personal@example.test'
      );
      insert into interaction_bullet_comments (
        id, tenant_id, drama_id, episode_id, account_id, position_ms, body
      ) values (
        '${bulletId}', '${tenantA}', '${dramaA}', '${episodeA}', '${accountId}',
        1000, 'phone +819012345678'
      );
      insert into customer_otp_challenges (
        id, tenant_id, account_id, purpose, channel, destination_hash,
        code_hash, expires_at
      ) values (
        '${otpId}', '${tenantA}', '${accountId}', 'login', 'email',
        '${'a'.repeat(64)}', '${'b'.repeat(64)}',
        transaction_timestamp() + interval '5 minutes'
      );
      insert into customer_inbox_messages (
        id, tenant_id, account_id, category, source_type, locale, title, body
      ) values (
        '${inboxId}', '${tenantA}', '${accountId}', 'transactional', 'system',
        'en-US', 'Private receipt', 'Personal address: private@example.test'
      );
      insert into orders (
        id, tenant_id, account_id, order_no, order_type, currency,
        subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
      ) values (
        '${orderA}', '${tenantA}', '${accountId}', 'ORD${'A'.repeat(26)}',
        'membership', 'USD', 1000, 1000, 'en-US',
        '{"accountId":"${accountId}","username":"privacy_customer","email":"private@example.test","phone":"+819012345678"}',
        transaction_timestamp() + interval '1 hour'
      );
      insert into order_items (
        id, tenant_id, order_id, line_no, item_type, product_id,
        currency, unit_amount_minor, total_amount_minor, product_snapshot_json
      ) values (
        '${orderItemA}', '${tenantA}', '${orderA}', 1, 'membership', '${dramaA}',
        'USD', 1000, 1000, '{"title":"Membership"}'
      );
      insert into payment_attempts (
        id, tenant_id, account_id, order_id, provider_id, payment_config_id,
        adapter_code_snapshot, collection_mode, currency, amount_minor,
        idempotency_key
      ) values (
        '${paymentAttemptA}', '${tenantA}', '${accountId}', '${orderA}',
        '${paymentProviderA}', '${paymentConfigA}', 'fake', 'platform_collect',
        'USD', 1000, 'privacy-payment-attempt'
      );
      insert into payment_transactions (
        id, tenant_id, attempt_id, order_id, provider_id, transaction_type,
        status, external_transaction_id, currency, amount_minor, payload_hash,
        occurred_at
      ) values (
        '${paymentTransactionA}', '${tenantA}', '${paymentAttemptA}', '${orderA}',
        '${paymentProviderA}', 'charge', 'succeeded', 'privacy-charge-001',
        'USD', 1000, '${'f'.repeat(64)}', transaction_timestamp()
      );
      update payment_attempts set status = 'succeeded',
        succeeded_at = transaction_timestamp(), version = 1
      where id = '${paymentAttemptA}';
      update orders set status = 'paid', paid_at = transaction_timestamp(), version = 1
      where id = '${orderA}';
      insert into entitlements (
        id, tenant_id, account_id, entitlement_type, product_id,
        source_order_id, source_order_item_id, starts_at
      ) values (
        '${entitlementId}', '${tenantA}', '${accountId}', 'membership', '${dramaA}',
        '${orderA}', '${orderItemA}', transaction_timestamp()
      );
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, status, response_status, response_json,
        locked_at, expires_at
      ) values (
        '${uuidV7()}', 'tenant', '${tenantA}', 'customer', '${accountId}',
        'customer.profile.update', 'privacy-command-1', '${'c'.repeat(64)}',
        'completed', 200, '{"email":"private@example.test"}', null,
        transaction_timestamp() + interval '1 day'
      );
      insert into customer_referral_codes (id, tenant_id, account_id, code)
      values ('${uuidV7()}', '${tenantA}', '${accountId}', 'ABCDEFGH23');
    `);
    const key = 'privacy-erasure-idempotency-1';
    const first = await privacy.requestErasure(principal, {
      acknowledgeRetention: true,
      currentPassword: 'privacy registration password',
    }, metadata(key));
    expect(first).toMatchObject({
      dataErasurePerformed: false,
      status: 'submitted',
      subprocessorStatus: expect.arrayContaining([
        expect.objectContaining({
          provider: 'email_sms_provider',
          status: 'operator_follow_up_required',
        }),
      ]),
    });
    await expect(authentication.authenticateAccessForAccountClosure(
      tenantA, session.accessToken,
    )).rejects.toBeInstanceOf(UnauthorizedException);

    const completed = await erasureWorker.processRequest(first.requestId);
    expect(completed).toMatchObject({
      dataErasurePerformed: true,
      requestId: first.requestId,
      status: 'completed',
    });
    await expect(erasureWorker.processRequest(first.requestId)).resolves.toMatchObject({
      dataErasurePerformed: true,
      status: 'completed',
    });
    const facts = await database.query<{
      account: unknown;
      audit_leak_count: string;
      bullet_body: string;
      command_response: unknown;
      comment_body: string;
      consent_count: string;
      data_erasure_performed: boolean;
      device_count: string;
      entitlement_revoked: boolean;
      inbox_count: string;
      order_snapshot: unknown;
      otp_count: string;
      retention_count: string;
      session_count: string;
    }>(`
      select
        (select jsonb_build_object(
          'username', username::text, 'email', email, 'phone', phone,
          'password', password_hash, 'status', status
        ) from customer_accounts where id = '${accountId}') as account,
        (select body from interaction_comments where id = '${commentId}') as comment_body,
        (select body from interaction_bullet_comments where id = '${bulletId}') as bullet_body,
        (select customer_snapshot_json from orders where id = '${orderA}') as order_snapshot,
        (select revoked_at is not null from entitlements where id = '${entitlementId}')
          as entitlement_revoked,
        (select response_json from command_idempotency
          where actor_id = '${accountId}' and route_key = 'customer.profile.update')
          as command_response,
        (select count(*)::text from customer_sessions where account_id = '${accountId}')
          as session_count,
        (select count(*)::text from customer_devices where account_id = '${accountId}')
          as device_count,
        (select count(*)::text from customer_otp_challenges where account_id = '${accountId}')
          as otp_count,
        (select count(*)::text from customer_inbox_messages where account_id = '${accountId}')
          as inbox_count,
        (select count(*)::text from customer_legal_consents where account_id = '${accountId}')
          as consent_count,
        (select count(*)::text from customer_privacy_retention_items
          where request_id = '${first.requestId}') as retention_count,
        (select data_erasure_performed from customer_privacy_requests
          where id = '${first.requestId}') as data_erasure_performed,
        (select count(*)::text from audit_logs
          where tenant_id = '${tenantA}'
            and (coalesce(before_json::text, '') || coalesce(after_json::text, '')
              || coalesce(ip::text, '') || coalesce(user_agent, ''))
              ~* 'privacy_customer|private@example|203\\.0\\.113\\.42') as audit_leak_count
    `);
    expect(facts.rows[0]).toMatchObject({
      account: expect.objectContaining({
        email: null, password: null, phone: null, status: 'erased',
      }),
      audit_leak_count: '0',
      bullet_body: '[content erased]',
      command_response: { redacted: 'customer_erasure' },
      comment_body: '[content erased]',
      consent_count: '2',
      data_erasure_performed: true,
      device_count: '0',
      entitlement_revoked: true,
      inbox_count: '0',
      order_snapshot: { erased: true, subjectId: accountId },
      otp_count: '0',
      retention_count: '3',
      session_count: '0',
    });
    expect((facts.rows[0]?.account as { username: string }).username).toMatch(
      /^erased_[0-9a-f]{32}$/,
    );
    expect(JSON.stringify(facts.rows[0])).not.toMatch(
      /Personal phone|personal@example|private@example|\+819012345678|privacy_customer/,
    );
  });

  it('forces privacy RLS and denies tenant-role consent fabrication or erasure transitions', async () => {
    await database.exec(`
      create role privacy_tenant_probe;
      grant usage on schema app to privacy_tenant_probe;
      grant execute on function app.current_tenant_id() to privacy_tenant_probe;
      grant execute on function app.has_platform_access(name) to privacy_tenant_probe;
      grant select, insert, update on customer_legal_consents,
        customer_privacy_requests, customer_accounts to privacy_tenant_probe;
      set role privacy_tenant_probe;
      begin;
      select set_config('app.access_scope', 'tenant', true),
        set_config('app.tenant_id', '${tenantA}', true);
    `);
    try {
      const other = await database.query(`
        select id from customer_accounts where tenant_id = '${tenantB}'
      `);
      expect(other.rows).toHaveLength(0);
      await expect(database.exec(`
        insert into customer_privacy_requests (
          id, tenant_id, account_id, request_type, idempotency_key, request_hash,
          password_reverified_at
        ) values (
          '${uuidV7()}', '${tenantA}', '${accountB}', 'account_erasure',
          'forged-erasure-key', '${'d'.repeat(64)}', transaction_timestamp()
        )
      `)).rejects.toThrow();
      await expect(database.exec(`
        update customer_accounts set status = 'erased', password_hash = null,
          username = 'erased_${'f'.repeat(32)}', email = null, phone = null,
          email_verified_at = null, phone_verified_at = null,
          disabled_at = transaction_timestamp(), disabled_by = id,
          disable_reason = 'account_erased'
        where tenant_id = '${tenantA}'
      `)).rejects.toThrow();
    } finally {
      await database.exec('rollback; reset role');
    }
  });
});
