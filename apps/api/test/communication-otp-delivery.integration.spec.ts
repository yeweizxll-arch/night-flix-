import { PGlite, type Transaction } from '@electric-sql/pglite';
import { ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AuthenticationRateLimiterService } from '../src/auth/authentication-rate-limiter.service';
import {
  CommunicationAdapterRegistry,
  CommunicationProviderError,
  FakeCommunicationProviderAdapter,
} from '../src/communications/communication-provider.adapter';
import { CommunicationSecretCipher } from '../src/communications/communication-secret-cipher';
import type { CommunicationTestRateLimiterService } from '../src/communications/communication-test-rate-limiter.service';
import { CommunicationWorkerService } from '../src/communications/communication-worker.service';
import { OtpDeliveryService } from '../src/communications/otp-delivery.service';
import { TenantCommunicationService } from '../src/communications/tenant-communication.service';
import { CustomerOtpService } from '../src/customer-auth/customer-otp.service';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';

const tenantA = '01930000-0000-7000-8000-000000000001';
const tenantB = '01930000-0000-7000-8000-000000000002';
const staffA = '01930000-0000-7000-8000-000000000003';

let database: PGlite;
let databaseService: DatabaseService;
let communications: TenantCommunicationService;
let otp: CustomerOtpService;
let worker: CommunicationWorkerService;
let emailAdapter: FakeCommunicationProviderAdapter;
let qqAdapter: FakeCommunicationProviderAdapter;
let emailVersion = 0;

const originalEnvironment = {
  expose: process.env.CUSTOMER_OTP_EXPOSE_CODE,
  secret: process.env.CUSTOMER_OTP_HMAC_SECRET,
  universal: process.env.CUSTOMER_UNIVERSAL_OTP_ENABLED,
};

describe('tenant communication and OTP delivery security', () => {
  beforeAll(async () => {
    process.env.CUSTOMER_OTP_HMAC_SECRET = 'communication-otp-test-hmac-secret-32bytes';
    process.env.CUSTOMER_OTP_EXPOSE_CODE = 'true';
    process.env.CUSTOMER_UNIVERSAL_OTP_ENABLED = 'false';
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const filename of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(source.replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
        .replace(/\bcitext\b/g, 'text'));
    }
    await database.exec(`
      insert into tenants (id, code, name, default_locale, expires_at) values
        ('${tenantA}', 'communication-a', 'Communication A', 'ja-JP', now() + interval '1 year'),
        ('${tenantB}', 'communication-b', 'Communication B', 'en-US', now() + interval '1 year');
    `);
    databaseService = {
      inPlatformContext: <T>(callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(tenantId: string, callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction(async (transaction) => {
          const sql = transactionTag(transaction);
          await sql`select set_config('app.access_scope', 'tenant', true),
            set_config('app.tenant_id', ${tenantId}, true)`;
          return callback(sql);
        }),
    } as unknown as DatabaseService;
    const cipher = new CommunicationSecretCipher({
      activeVersion: 9,
      keys: new Map([[9, Buffer.alloc(32, 9)]]),
    });
    emailAdapter = new FakeCommunicationProviderAdapter('resend', 'email');
    qqAdapter = new FakeCommunicationProviderAdapter('qq_smtp', 'email');
    const registry = new CommunicationAdapterRegistry([emailAdapter, qqAdapter]);
    worker = new CommunicationWorkerService(databaseService, cipher, registry);
    communications = new TenantCommunicationService(databaseService, cipher, {
      consume: async () => undefined,
    } as unknown as CommunicationTestRateLimiterService);
    otp = new CustomerOtpService(databaseService, {
      consume: async () => undefined,
    } as unknown as AuthenticationRateLimiterService, new OtpDeliveryService(cipher));
  }, 30_000);

  afterAll(async () => {
    restore('CUSTOMER_OTP_EXPOSE_CODE', originalEnvironment.expose);
    restore('CUSTOMER_OTP_HMAC_SECRET', originalEnvironment.secret);
    restore('CUSTOMER_UNIVERSAL_OTP_ENABLED', originalEnvironment.universal);
    await database?.close();
  });

  it('requires tenant-owned configuration and atomically resets testing after credential rotation', async () => {
    await expect(otp.createChallenge(tenantB, {
      channel: 'email', destination: 'unknown@example.com', purpose: 'password_reset',
    }, request('no-provider'))).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect((await database.query<{ count: string }>(`
      select count(*)::text as count from customer_otp_challenges where tenant_id = '${tenantB}'
    `)).rows[0]?.count).toBe('0');

    const created = await communications.upsertConfig(tenantA, 'email', {
      credentials: { apiKey: `re_${'a'.repeat(32)}`,
        fromEmail: 'security@example.com', type: 'resend' },
      expectedVersion: 0,
    }, metadata('create-email-config'));
    expect(created).toMatchObject({ channel: 'email', provider: 'resend', status: 'disabled', version: 0 });
    const test = await communications.testConfig(tenantA, 'email', {
      destination: 'test@example.com', expectedVersion: 0,
    }, metadata('test-email-config'));
    expect(test).toEqual({ jobId: expect.any(String), status: 'pending', version: 1 });
    await worker.processAvailable(1);
    const enabled = await communications.setConfigStatus(
      tenantA, 'email', true, test.version, metadata('enable-email-config'),
    );
    emailVersion = enabled.version;
    expect(enabled).toMatchObject({ lastTestStatus: 'passed', status: 'active', version: 2 });

    const rotated = await communications.upsertConfig(tenantA, 'email', {
      credentials: { apiKey: `re_${'b'.repeat(32)}`,
        fromEmail: 'security@example.com', type: 'resend' },
      expectedVersion: emailVersion,
    }, metadata('rotate-email-config'));
    expect(rotated).toMatchObject({ status: 'disabled', version: 3 });
    expect(rotated.lastTestStatus).toBeUndefined();
    await expect(communications.setConfigStatus(
      tenantA, 'email', true, rotated.version, metadata('unsafe-enable-after-rotate'),
    )).rejects.toBeInstanceOf(ConflictException);

    const retest = await communications.testConfig(tenantA, 'email', {
      destination: 'test@example.com', expectedVersion: rotated.version,
    }, metadata('retest-email-config'));
    await worker.processAvailable(1);
    const reenabled = await communications.setConfigStatus(
      tenantA, 'email', true, retest.version, metadata('reenable-email-config'),
    );
    emailVersion = reenabled.version;

    const leakScan = await database.query<{ text: string }>(`
      select concat(
        coalesce((select string_agg(coalesce(after_json::text, ''), '') from audit_logs
          where tenant_id = '${tenantA}'), ''),
        coalesce((select string_agg(payload_json::text, '') from outbox_events
          where tenant_id = '${tenantA}'), ''),
        coalesce((select string_agg(coalesce(response_json::text, ''), '') from command_idempotency
          where tenant_id = '${tenantA}'), '')
      ) as text
    `);
    expect(leakScan.rows[0]?.text).not.toContain('test@example.com');
    expect(leakScan.rows[0]?.text).not.toContain(`re_${'a'.repeat(32)}`);
    expect(leakScan.rows[0]?.text).not.toContain(`re_${'b'.repeat(32)}`);
  });

  it('explicitly creates a non-delivery challenge only under the universal-code switch', async () => {
    process.env.CUSTOMER_UNIVERSAL_OTP_ENABLED = 'true';
    const cipher = (worker as unknown as { cipher: CommunicationSecretCipher }).cipher;
    const universalOtp = new CustomerOtpService(databaseService, {
      consume: async () => undefined,
    } as unknown as AuthenticationRateLimiterService, new OtpDeliveryService(cipher));
    const challenge = await universalOtp.createChallenge(tenantB, {
      channel: 'email', destination: 'fallback@example.com', purpose: 'password_reset',
    }, request('universal-no-provider'));
    process.env.CUSTOMER_UNIVERSAL_OTP_ENABLED = 'false';
    expect(challenge).toMatchObject({ deliveryRequired: false,
      developmentCode: expect.stringMatching(/^[0-9]{6}$/) });
    expect((await database.query<{ count: string }>(`
      select count(*)::text as count from customer_otp_delivery_jobs
      where challenge_id = '${challenge.challengeId}'
    `)).rows[0]?.count).toBe('0');
  });

  it('delivers a plus-address email once under concurrent workers without plaintext persistence', async () => {
    const challenge = await otp.createChallenge(tenantA, {
      channel: 'email', destination: '+tag@example.com', purpose: 'password_reset',
    }, request('unknown-password-reset'));
    expect(challenge).toMatchObject({ deliveryRequired: true,
      developmentCode: expect.stringMatching(/^[0-9]{6}$/) });
    const secondWorker = new CommunicationWorkerService(
      databaseService,
      (worker as unknown as { cipher: CommunicationSecretCipher }).cipher,
      (worker as unknown as { adapters: CommunicationAdapterRegistry }).adapters,
    );
    const callsBefore = emailAdapter.calls.length;
    await Promise.all([worker.processAvailable(1), secondWorker.processAvailable(1)]);
    expect(emailAdapter.calls).toHaveLength(callsBefore + 1);
    expect(emailAdapter.calls.at(-1)?.destination).toBe('+tag@example.com');
    const facts = await database.query<{
      audit: string; code_hash: string; outbox: string; payload_ciphertext: string | null; status: string;
    }>(`
      select challenge.code_hash, job.payload_ciphertext, job.status,
        (select coalesce(string_agg(coalesce(after_json::text, ''), ''), '') from audit_logs
          where tenant_id = '${tenantA}') as audit,
        (select coalesce(string_agg(payload_json::text, ''), '') from outbox_events
          where tenant_id = '${tenantA}') as outbox
      from customer_otp_challenges as challenge
      inner join customer_otp_delivery_jobs as job on job.challenge_id = challenge.id
      where challenge.id = '${challenge.challengeId}'
    `);
    expect(facts.rows[0]).toMatchObject({ code_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      payload_ciphertext: null, status: 'sent' });
    const persisted = JSON.stringify(facts.rows[0]);
    expect(persisted).not.toContain('+tag@example.com');
    expect(persisted).not.toContain(challenge.developmentCode);
  });

  it('rejects a claimed job after configuration disable and never sends with stale version', async () => {
    const challenge = await otp.createChallenge(tenantA, {
      channel: 'email', destination: 'race@example.com', purpose: 'password_reset',
    }, request('disable-race'));
    const harness = worker as unknown as {
      claim(): Promise<unknown>;
      process(job: unknown): Promise<void>;
    };
    const claimed = await harness.claim();
    expect(claimed).toBeTruthy();
    const callsBefore = emailAdapter.calls.length;
    const disabled = await communications.setConfigStatus(
      tenantA, 'email', false, emailVersion, metadata('disable-during-claim'),
    );
    emailVersion = disabled.version;
    await harness.process(claimed);
    expect(emailAdapter.calls).toHaveLength(callsBefore);
    const state = await database.query<{ last_error: string; status: string }>(`
      select status, last_error from customer_otp_delivery_jobs
      where challenge_id = '${challenge.challengeId}'
    `);
    expect(state.rows[0]).toEqual({ last_error: 'config_changed', status: 'dead_letter' });
  });

  it('stores only fixed error codes when an adapter leaks a raw secret error', async () => {
    const test = await communications.testConfig(tenantA, 'email', {
      destination: 'error@example.com', expectedVersion: emailVersion,
    }, metadata('raw-error-test'));
    emailVersion = test.version;
    emailAdapter.failure = new Error('raw api key re_super_secret and destination error@example.com');
    await worker.processAvailable(1);
    emailAdapter.failure = undefined;
    const facts = await database.query<{ last_error: string; last_test_error: string }>(`
      select job.last_error, config.last_test_error
      from customer_otp_delivery_jobs as job
      inner join tenant_communication_configs as config on config.id = job.config_id
      where job.job_type = 'config_test' and job.status = 'dead_letter'
      order by job.created_at desc limit 1
    `);
    expect(facts.rows[0]).toEqual({
      last_error: 'unexpected_provider_response',
      last_test_error: 'unexpected_provider_response',
    });
    expect(JSON.stringify(facts.rows[0])).not.toContain('re_super_secret');
    expect(JSON.stringify(facts.rows[0])).not.toContain('error@example.com');
  });

  it('retries transient provider failures with the same job id and clears ciphertext on success', async () => {
    const test = await communications.testConfig(tenantA, 'email', {
      destination: 'retry@example.com', expectedVersion: emailVersion,
    }, metadata('retry-provider-test'));
    emailVersion = test.version;
    emailAdapter.failure = new CommunicationProviderError('provider_timeout', true);
    await worker.processAvailable(1);
    const retry = await database.query<{
      attempt_count: number; available_later: boolean; payload_ciphertext: string; status: string;
    }>(`
      select attempt_count, status, payload_ciphertext,
        available_at > created_at as available_later
      from customer_otp_delivery_jobs where id = '${test.jobId}'
    `);
    expect(retry.rows[0]).toMatchObject({ attempt_count: 1, available_later: true,
      payload_ciphertext: expect.any(String), status: 'retry' });
    await database.exec(`
      update customer_otp_delivery_jobs set available_at = statement_timestamp()
      where id = '${test.jobId}'
    `);
    emailAdapter.failure = undefined;
    await worker.processAvailable(1);
    const attempts = emailAdapter.calls.filter((call) => call.jobId === test.jobId);
    expect(attempts).toHaveLength(2);
    expect((await database.query<{ payload_ciphertext: null; status: string }>(`
      select payload_ciphertext, status from customer_otp_delivery_jobs where id = '${test.jobId}'
    `)).rows[0]).toEqual({ payload_ciphertext: null, status: 'sent' });
  });

  it('recovers a stale final attempt directly to dead-letter without exceeding max attempts', async () => {
    const test = await communications.testConfig(tenantA, 'email', {
      destination: 'stale@example.com', expectedVersion: emailVersion,
    }, metadata('stale-provider-test'));
    emailVersion = test.version;
    const harness = worker as unknown as { claim(): Promise<unknown> };
    expect(await harness.claim()).toBeTruthy();
    await database.exec(`
      update customer_otp_delivery_jobs set attempt_count = max_attempts - 1,
        locked_at = statement_timestamp() - interval '3 minutes'
      where id = '${test.jobId}'
    `);
    expect(await worker.recoverStaleLocks()).toBe(1);
    expect((await database.query<{
      attempt_count: number; last_error: string; payload_ciphertext: null; status: string;
    }>(`
      select attempt_count, status, last_error, payload_ciphertext
      from customer_otp_delivery_jobs where id = '${test.jobId}'
    `)).rows[0]).toEqual({ attempt_count: 5, last_error: 'provider_timeout',
      payload_ciphertext: null, status: 'dead_letter' });
  });

  it('rotates Resend to QQ with re-testing, drops old jobs and preserves encryption and provider identity', async () => {
    const staleTest = await communications.testConfig(tenantA, 'email', {
      destination: 'stale@example.com', expectedVersion: emailVersion,
    }, metadata('before-qq-switch'));
    const changed = await communications.upsertConfig(tenantA, 'email', {
      credentials: { type: 'qq_smtp', authCode: 'q'.repeat(16), fromEmail: 'nightflix-test@qq.com' },
      expectedVersion: staleTest.version,
    }, metadata('switch-to-qq'));
    expect(changed).toMatchObject({ provider: 'qq_smtp', status: 'disabled' });
    await expect(communications.setConfigStatus(tenantA, 'email', true, changed.version, metadata('enable-qq-too-early'))).rejects.toThrow();
    await worker.processAvailable(1);
    expect(qqAdapter.calls).toHaveLength(0);
    expect((await database.query<{ last_error: string }>(`select last_error from customer_otp_delivery_jobs where id = '${staleTest.jobId}'`)).rows[0]?.last_error).toBe('config_changed');
    const test = await communications.testConfig(tenantA, 'email', {
      destination: 'test@example.com', expectedVersion: changed.version,
    }, metadata('test-qq-config'));
    await worker.processAvailable(1);
    expect(qqAdapter.calls).toHaveLength(1);
    const enabled = await communications.setConfigStatus(tenantA, 'email', true, test.version, metadata('enable-qq-config'));
    emailVersion = enabled.version;
    await expect(database.exec(`update tenant_communication_configs set provider = 'resend' where id = '${changed.id}'`)).rejects.toThrow(/provider change/);
    const challenge = await otp.createChallenge(tenantA, {
      channel: 'email', destination: 'new-user@example.com', purpose: 'verify_email',
    }, request('qq-signup'));
    await worker.processAvailable(1);
    expect(qqAdapter.calls).toHaveLength(2);
    expect(qqAdapter.calls[1]?.code).toBe(challenge.developmentCode);
    const facts = await database.query(`select status, payload_ciphertext from customer_otp_delivery_jobs where challenge_id = '${challenge.challengeId}'`);
    expect(facts.rows[0]).toEqual({ status: 'sent', payload_ciphertext: null });
    // Switching back also invalidates testing; Resend remains available.
    const restored = await communications.upsertConfig(tenantA, 'email', {
      credentials: { type: 'resend', apiKey: `re_${'b'.repeat(32)}`, fromEmail: 'security@example.com' },
      expectedVersion: emailVersion,
    }, metadata('switch-back-resend'));
    emailVersion = restored.version;
    expect(restored).toMatchObject({ provider: 'resend', status: 'disabled', lastTestStatus: undefined });
  });

  it('exposes config and delivery facts read-only while secrets have no tenant policy', async () => {
    expect(await communications.listConfigs(tenantB)).toEqual({ items: [] });
    const graph = await database.query<{ challenge_id: string; config_id: string; expires_at: Date; job_id: string }>(`
      select
        (select id from customer_otp_challenges where tenant_id = '${tenantB}' order by created_at desc limit 1)
          as challenge_id,
        (select id from tenant_communication_configs where tenant_id = '${tenantA}' and channel = 'email')
          as config_id,
        (select expires_at from customer_otp_challenges where tenant_id = '${tenantB}' order by created_at desc limit 1)
          as expires_at,
        (select id from customer_otp_delivery_jobs where tenant_id = '${tenantA}' limit 1) as job_id
    `);
    const row = graph.rows[0];
    await expect(database.exec(`
      insert into customer_otp_delivery_jobs (
        id, tenant_id, challenge_id, config_id, config_version, job_type,
        channel, purpose, payload_ciphertext, key_version, expires_at
      ) values (
        '01930000-0000-7000-8000-000000000099', '${tenantA}', '${row?.challenge_id}',
        '${row?.config_id}', ${emailVersion}, 'otp', 'email', 'password_reset',
        '${'x'.repeat(80)}', 9, '${new Date(row?.expires_at ?? 0).toISOString()}'
      )
    `)).rejects.toThrow(/challenge binding is invalid/);
    await expect(database.exec(`
      delete from customer_otp_delivery_jobs where id = '${row?.job_id}'
    `)).rejects.toThrow(/immutable|cannot be deleted|append-only/);
    const policies = await database.query<{ policyname: string; tablename: string }>(`
      select tablename, policyname from pg_policies
      where tablename in (
        'tenant_communication_configs', 'tenant_communication_secrets',
        'customer_otp_delivery_jobs'
      ) order by tablename, policyname
    `);
    const secretPolicies = policies.rows.filter((row) => row.tablename === 'tenant_communication_secrets');
    expect(secretPolicies.map((row) => row.policyname)).toEqual([
      'tenant_communication_secrets_platform_access',
    ]);
    expect(policies.rows.filter((row) => row.tablename === 'customer_otp_delivery_jobs')
      .map((row) => row.policyname)).toEqual(expect.arrayContaining([
        'customer_otp_delivery_jobs_tenant_insert',
        'customer_otp_delivery_jobs_tenant_select',
      ]));
  });
});

function metadata(key: string) {
  return { actorId: staffA, idempotencyKey: key.padEnd(8, 'x'),
    ip: '203.0.113.20', requestId: `request-${key}` };
}
function request(key: string) {
  return { ip: '203.0.113.30', requestId: `request-${key}` };
}
function restore(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
}
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
