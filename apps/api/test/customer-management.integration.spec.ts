import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateAccessToken } from '../src/auth/token';
import { uuidV7 } from '../src/common/uuid-v7';
import { CustomerAuthenticationService } from '../src/customer-auth/customer-authentication.service';
import { CustomerManagementService } from '../src/customer-management/customer-management.service';
import type { CustomerActorContext } from '../src/customer-management/customer-management.types';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';

let database: PGlite;
let customers: CustomerManagementService;
let authentication: CustomerAuthenticationService;

const ids = {
  accountA: '018f2f45-7f5e-7e70-b17f-f6e77357c001',
  accountA2: '018f2f45-7f5e-7e70-b17f-f6e77357c002',
  accountB: '018f2f45-7f5e-7e70-b17f-f6e77357c003',
  deviceA: '018f2f45-7f5e-7e70-b17f-f6e77357c004',
  deviceA2: '018f2f45-7f5e-7e70-b17f-f6e77357c005',
  deviceB: '018f2f45-7f5e-7e70-b17f-f6e77357c006',
  platformActor: '018f2f45-7f5e-7e70-b17f-f6e77357c007',
  sessionA: '018f2f45-7f5e-7e70-b17f-f6e77357c008',
  sessionA2: '018f2f45-7f5e-7e70-b17f-f6e77357c009',
  sessionB: '018f2f45-7f5e-7e70-b17f-f6e77357c00a',
  tenantA: '018f2f45-7f5e-7e70-b17f-f6e77357c00b',
  tenantActor: '018f2f45-7f5e-7e70-b17f-f6e77357c00c',
  tenantB: '018f2f45-7f5e-7e70-b17f-f6e77357c00d',
} as const;

const tenantContext: CustomerActorContext = {
  actorId: ids.tenantActor,
  scope: 'tenant',
  tenantId: ids.tenantA,
};
const platformContext: CustomerActorContext = {
  actorId: ids.platformActor,
  scope: 'platform',
};

const accessA = generateAccessToken();

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}

describe('customer management PostgreSQL workflow', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const filename of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(source
        .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
        .replace(/\bcitext\b/g, 'text'));
    }
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${ids.tenantA}', 'customers-a', 'Customers A', statement_timestamp() + interval '1 year'),
        ('${ids.tenantB}', 'customers-b', 'Customers B', statement_timestamp() + interval '1 year');
      insert into customer_accounts (
        id, tenant_id, username, email, phone, password_hash,
        email_verified_at, phone_verified_at
      ) values
        ('${ids.accountA}', '${ids.tenantA}', 'viewer.alpha', 'viewer.alpha@example.com', '+12025550111', '${'p'.repeat(64)}', statement_timestamp(), statement_timestamp()),
        ('${ids.accountA2}', '${ids.tenantA}', 'viewer.beta', 'viewer.beta@example.com', null, '${'p'.repeat(64)}', statement_timestamp(), null),
        ('${ids.accountB}', '${ids.tenantB}', 'viewer.other', 'viewer.other@example.com', '+12025550122', '${'p'.repeat(64)}', statement_timestamp(), statement_timestamp());
      insert into customer_devices (
        id, tenant_id, account_id, device_token_hash, platform, label
      ) values
        ('${ids.deviceA}', '${ids.tenantA}', '${ids.accountA}', '${'a'.repeat(64)}', 'ios', 'Alpha Phone'),
        ('${ids.deviceA2}', '${ids.tenantA}', '${ids.accountA2}', '${'b'.repeat(64)}', 'web', 'Beta Web'),
        ('${ids.deviceB}', '${ids.tenantB}', '${ids.accountB}', '${'c'.repeat(64)}', 'android', 'Other Phone');
      insert into customer_sessions (
        id, session_family_id, tenant_id, account_id, device_id,
        access_token_hash, refresh_token_hash, access_expires_at,
        refresh_expires_at, absolute_expires_at
      ) values
        ('${ids.sessionA}', '${ids.sessionA}', '${ids.tenantA}', '${ids.accountA}', '${ids.deviceA}',
          '${accessA.digest}', '${'d'.repeat(64)}', statement_timestamp() + interval '1 hour', statement_timestamp() + interval '2 hours', statement_timestamp() + interval '3 hours'),
        ('${ids.sessionA2}', '${ids.sessionA2}', '${ids.tenantA}', '${ids.accountA2}', '${ids.deviceA2}',
          '${'e'.repeat(64)}', '${'f'.repeat(64)}', statement_timestamp() + interval '1 hour', statement_timestamp() + interval '2 hours', statement_timestamp() + interval '3 hours'),
        ('${ids.sessionB}', '${ids.sessionB}', '${ids.tenantB}', '${ids.accountB}', '${ids.deviceB}',
          '${'1'.repeat(64)}', '${'2'.repeat(64)}', statement_timestamp() + interval '1 hour', statement_timestamp() + interval '2 hours', statement_timestamp() + interval '3 hours');
      insert into customer_push_tokens (
        id, tenant_id, account_id, device_id, platform, token_ciphertext,
        token_digest, token_sha256, key_version
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c00e', '${ids.tenantA}', '${ids.accountA}',
        '${ids.deviceA}', 'ios', '${'x'.repeat(64)}',
        'hmac-sha256.1.${'y'.repeat(43)}', '${'3'.repeat(64)}', 1
      );
      insert into point_accounts (id, tenant_id, account_id) values
        ('018f2f45-7f5e-7e70-b17f-f6e77357c00f', '${ids.tenantA}', '${ids.accountA}');
      insert into orders (
        id, tenant_id, account_id, order_no, order_type, status, currency,
        subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c010', '${ids.tenantA}', '${ids.accountA}',
        'ORD00000000000000000000000001', 'points_topup', 'pending_payment', 'USD',
        100, 100, 'en-US', '{}', statement_timestamp() + interval '1 hour'
      );
    `);

    const databaseService = {
      inPlatformContext: <T>(callback: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> =>
        database.transaction(async (transaction) => {
          await transaction.query("select set_config('app.access_scope', 'platform', true)");
          return callback(transactionTag(transaction));
        }),
      inTenantContext: <T>(tenantId: string, callback: (transaction: DatabaseTransaction) => Promise<T>): Promise<T> =>
        database.transaction(async (transaction) => {
          await transaction.query(
            "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
            [tenantId],
          );
          return callback(transactionTag(transaction));
        }),
    } as unknown as DatabaseService;
    customers = new CustomerManagementService(databaseService);
    authentication = new CustomerAuthenticationService(
      databaseService,
      {} as never,
      {} as never,
      {} as never,
    );
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('lists only the tenant, masks contacts, binds cursors and returns safe summaries', async () => {
    const first = await customers.list(tenantContext, { pageSize: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const second = await customers.list(tenantContext, { cursor: first.nextCursor, pageSize: 1 });
    expect(new Set([...first.items, ...second.items].map((item) => item.id))).toEqual(
      new Set([ids.accountA, ids.accountA2]),
    );
    const alpha = [...first.items, ...second.items].find((item) => item.id === ids.accountA)!;
    expect(alpha).toMatchObject({
      email: 'v***@example.com',
      emailVerified: true,
      orders: { total: 1 },
      phone: '+12****0111',
      phoneVerified: true,
      pointsBalance: '0',
      tenantId: ids.tenantA,
    });
    expect(alpha.devices[0]).toMatchObject({
      activeSessions: 1,
      id: ids.deviceA,
      label: 'Alpha Phone',
      platform: 'ios',
    });
    const serialized = JSON.stringify(alpha);
    expect(serialized).not.toContain('viewer.alpha@example.com');
    expect(serialized).not.toContain('+12025550111');
    expect(serialized).not.toContain(accessA.digest);
    expect(serialized).not.toContain('password');
    expect(() => customers.list(tenantContext, {
      cursor: first.nextCursor,
      pageSize: 1,
      status: 'disabled',
    })).toThrow(BadRequestException);
  });

  it('requires an exact tenant for platform reads and never crosses tenant scope', async () => {
    expect(() => customers.list(platformContext, {})).toThrow(BadRequestException);
    const platform = await customers.list(platformContext, { tenantId: ids.tenantB });
    expect(platform.items.map((item) => item.id)).toEqual([ids.accountB]);
    await expect(customers.detail(tenantContext, undefined, ids.accountB))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(customers.detail(platformContext, ids.tenantA, ids.accountB))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(() => customers.list(tenantContext, { tenantId: ids.tenantB }))
      .toThrow(BadRequestException);
  });

  it('disables idempotently, revokes sessions and push tokens, and invalidates access immediately', async () => {
    await database.exec(`update tenants set user_site_enabled = false, platform_site_enabled = false where id = '${ids.tenantA}'`);
    const current = await customers.detail(tenantContext, undefined, ids.accountA);
    const disabled = await customers.updateStatus(
      tenantContext,
      undefined,
      ids.accountA,
      { expectedVersion: current.version, reason: 'risk review', status: 'disabled' },
      { idempotencyKey: 'customer-disable-0001', requestId: uuidV7() },
    );
    const repeated = await customers.updateStatus(
      tenantContext,
      undefined,
      ids.accountA,
      { expectedVersion: current.version, reason: 'risk review', status: 'disabled' },
      { idempotencyKey: 'customer-disable-0001', requestId: uuidV7() },
    );
    expect(repeated).toEqual(disabled);
    await expect(customers.updateStatus(
      tenantContext,
      undefined,
      ids.accountA,
      { expectedVersion: current.version, reason: 'different request', status: 'disabled' },
      { idempotencyKey: 'customer-disable-0001', requestId: uuidV7() },
    )).rejects.toBeInstanceOf(ConflictException);
    expect(disabled).toMatchObject({ status: 'disabled', version: current.version + 1 });
    const state = await database.query<{ session_active: string; token_active: string }>(`
      select
        (select count(*)::text from customer_sessions where account_id = '${ids.accountA}' and revoked_at is null) as session_active,
        (select count(*)::text from customer_push_tokens where account_id = '${ids.accountA}' and status = 'active') as token_active
    `);
    expect(state.rows[0]).toEqual({ session_active: '0', token_active: '0' });
    await database.exec(`update tenants set user_site_enabled = true, platform_site_enabled = true where id = '${ids.tenantA}'`);
    await expect(authentication.authenticateAccess(ids.tenantA, accessA.token))
      .rejects.toBeInstanceOf(UnauthorizedException);

    const securityRecords = await database.query<{ payload: unknown }>(`
      select after_json as payload from audit_logs where resource_id = '${ids.accountA}'
      union all
      select payload_json as payload from outbox_events where aggregate_id = '${ids.accountA}'
    `);
    const serialized = JSON.stringify(securityRecords.rows);
    expect(serialized).not.toContain('viewer.alpha@example.com');
    expect(serialized).not.toContain('+12025550111');
    expect(serialized).not.toContain(accessA.digest);
    expect(serialized).not.toContain('risk review');
    expect(serialized).not.toContain('token_ciphertext');

    const enabled = await customers.updateStatus(
      tenantContext,
      undefined,
      ids.accountA,
      { expectedVersion: disabled.version, reason: 'risk cleared', status: 'active' },
      { idempotencyKey: 'customer-enable-0001', requestId: uuidV7() },
    );
    expect(enabled.status).toBe('active');
    const oldSessions = await database.query<{ active: string }>(`
      select count(*)::text as active from customer_sessions
      where account_id = '${ids.accountA}' and revoked_at is null
    `);
    expect(oldSessions.rows[0]?.active).toBe('0');
  });

  it('uses optimistic concurrency and rejects body tenant injection', async () => {
    const current = await customers.detail(tenantContext, undefined, ids.accountA2);
    const attempts = await Promise.allSettled([
      customers.updateStatus(
        tenantContext, undefined, ids.accountA2,
        { expectedVersion: current.version, reason: 'review one', status: 'disabled' },
        { idempotencyKey: 'customer-race-0000001', requestId: uuidV7() },
      ),
      customers.updateStatus(
        tenantContext, undefined, ids.accountA2,
        { expectedVersion: current.version, reason: 'review two', status: 'disabled' },
        { idempotencyKey: 'customer-race-0000002', requestId: uuidV7() },
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(1);
    expect(() => customers.updateStatus(
      tenantContext, undefined, ids.accountA2,
      { expectedVersion: 1, reason: 'bad scope', status: 'active', tenantId: ids.tenantB },
      { idempotencyKey: 'customer-inject-0001', requestId: uuidV7() },
    )).toThrow(BadRequestException);
  });

  it('revokes one device or all sessions and rejects cross-account devices', async () => {
    await database.exec(`
      insert into customer_sessions (
        id, session_family_id, tenant_id, account_id, device_id,
        access_token_hash, refresh_token_hash, access_expires_at,
        refresh_expires_at, absolute_expires_at
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c011',
        '018f2f45-7f5e-7e70-b17f-f6e77357c011', '${ids.tenantA}',
        '${ids.accountA2}', '${ids.deviceA2}', '${'4'.repeat(64)}', '${'5'.repeat(64)}',
        statement_timestamp() + interval '1 hour', statement_timestamp() + interval '2 hours',
        statement_timestamp() + interval '3 hours'
      )
    `);
    await database.exec(`
      update customer_devices set platform = 'ios' where id = '${ids.deviceA2}';
      insert into customer_push_tokens (
        id, tenant_id, account_id, device_id, platform, token_ciphertext,
        token_digest, token_sha256, key_version
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c012', '${ids.tenantA}', '${ids.accountA2}',
        '${ids.deviceA2}', 'ios', '${'q'.repeat(64)}',
        'hmac-sha256.1.${'z'.repeat(43)}', '${'6'.repeat(64)}', 1
      )
    `);
    await expect(customers.revokeSessions(
      tenantContext, undefined, ids.accountA2,
      { deviceId: ids.deviceB, reason: 'wrong account' },
      { idempotencyKey: 'customer-device-0001', requestId: uuidV7() },
    )).rejects.toBeInstanceOf(NotFoundException);
    const one = await customers.revokeSessions(
      tenantContext, undefined, ids.accountA2,
      { deviceId: ids.deviceA2, reason: 'support request' },
      { idempotencyKey: 'customer-device-0002', requestId: uuidV7() },
    );
    expect(one).toEqual({
      accountId: ids.accountA2,
      deviceId: ids.deviceA2,
      deviceRevoked: true,
      pushTokensRevoked: 1,
      sessionsRevoked: 1,
    });
    const revokedDevice = await database.query<{ device_status: string; push_status: string }>(`
      select
        (select status from customer_devices where id = '${ids.deviceA2}') as device_status,
        (select status from customer_push_tokens where device_id = '${ids.deviceA2}') as push_status
    `);
    expect(revokedDevice.rows[0]).toEqual({ device_status: 'revoked', push_status: 'revoked' });
    const all = await customers.revokeSessions(
      platformContext, ids.tenantB, ids.accountB,
      { reason: 'platform security response' },
      { idempotencyKey: 'customer-sessions-001', requestId: uuidV7() },
    );
    expect(all).toEqual({ accountId: ids.accountB, sessionsRevoked: 1 });
  });

  it('keeps the maximum page bounded and paginates a larger tenant safely', async () => {
    const values = Array.from({ length: 105 }, (_, index) => {
      const suffix = (index + 1).toString(16).padStart(12, '0');
      return `(
        '018f2f46-7f5e-7e70-817f-${suffix}', '${ids.tenantA}',
        'scale_${String(index + 1).padStart(3, '0')}', '${'p'.repeat(64)}'
      )`;
    }).join(',');
    await database.exec(`
      insert into customer_accounts (id, tenant_id, username, password_hash)
      values ${values}
    `);
    const first = await customers.list(platformContext, {
      pageSize: 100, q: 'scale_', tenantId: ids.tenantA,
    });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toBeTruthy();
    expect(first.items.every((item) => item.devices.length <= 3)).toBe(true);
    const second = await customers.list(platformContext, {
      cursor: first.nextCursor, pageSize: 100, q: 'scale_', tenantId: ids.tenantA,
    });
    expect(second.items).toHaveLength(5);
    expect(second.nextCursor).toBeNull();
    expect(() => customers.list(platformContext, { pageSize: 101, tenantId: ids.tenantA }))
      .toThrow(BadRequestException);
  });
});
