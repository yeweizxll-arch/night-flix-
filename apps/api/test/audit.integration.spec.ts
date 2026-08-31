import { PGlite, type Transaction } from '@electric-sql/pglite';
import { BadRequestException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../src/audit/audit.service';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';

let database: PGlite;
let audit: AuditService;

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773578101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773578102';
const actorA = '018f2f45-7f5e-7e70-b17f-f6e773578103';
const actorB = '018f2f45-7f5e-7e70-b17f-f6e773578104';
const resourceA = '018f2f45-7f5e-7e70-b17f-f6e773578105';
const resourceB = '018f2f45-7f5e-7e70-b17f-f6e773578106';

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

describe('audit read API data boundary', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of filenames) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(
        source
          .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
          .replace(/\bcitext\b/g, 'text'),
      );
    }
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantA}', 'audit-a', 'Audit A', statement_timestamp() + interval '1 year'),
        ('${tenantB}', 'audit-b', 'Audit B', statement_timestamp() + interval '1 year');
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, before_json, after_json, request_id
      ) values
        (
          '018f2f45-7f5e-7e70-b17f-f6e773578111', 'tenant', '${tenantA}',
          'tenant_staff', '${actorA}', 'tenant.profile.update', 'tenant_profile',
          '${resourceA}', '{"password":"old-password","name":"Old"}'::jsonb,
          '{"metadata":{"refreshToken":"refresh-secret","safe":"visible"},"name":"New"}'::jsonb,
          'audit-request-a-0001'
        ),
        (
          '018f2f45-7f5e-7e70-b17f-f6e773578112', 'tenant', '${tenantA}',
          'tenant_staff', '${actorA}', 'commerce.order.create', 'order',
          '${resourceB}', null, '{"totalMinor":999}'::jsonb,
          'audit-request-a-0002'
        ),
        (
          '018f2f45-7f5e-7e70-b17f-f6e773578113', 'tenant', '${tenantB}',
          'tenant_staff', '${actorB}', 'tenant.profile.update', 'tenant_profile',
          '${resourceB}', null, '{"otp":"8888"}'::jsonb,
          'audit-request-b-0001'
        ),
        (
          '018f2f45-7f5e-7e70-b17f-f6e773578114', 'platform', null,
          'platform_staff', '${actorB}', 'platform.merchant.create', 'tenant',
          '${tenantA}', null, '{"credentialCiphertext":"cipher-value"}'::jsonb,
          'audit-request-platform-0001'
        );
    `);

    const service = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        await transaction.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
        return callback(transactionTag(transaction));
      }),
    } as unknown as DatabaseService;
    audit = new AuditService(service);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('returns only the current tenant, recursively redacts JSON, and paginates at 100 max', async () => {
    const firstPage = await audit.listTenant(tenantA, { page: '1', pageSize: '1' });
    expect(firstPage).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(firstPage.items).toHaveLength(1);

    const profile = await audit.listTenant(tenantA, {
      action: 'tenant.profile.update',
      actor: actorA,
      resource: 'tenant_profile',
      requestId: 'audit-request-a-0001',
    });
    expect(profile.total).toBe(1);
    expect(profile.items[0]).toMatchObject({
      action: 'tenant.profile.update',
      actor: { id: actorA, type: 'tenant_staff' },
      before: { name: 'Old', password: '[REDACTED]' },
      tenantId: tenantA,
    });
    expect(profile.items[0]?.after).toEqual({
      metadata: { refreshToken: '[REDACTED]', safe: 'visible' },
      name: 'New',
    });
    expect(JSON.stringify(profile)).not.toMatch(/old-password|refresh-secret|8888|cipher-value/);

    await expect(audit.listTenant(tenantA, { pageSize: '101' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(audit.listTenant(tenantA, { q: 'x' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(audit.listTenant(tenantA, { tenantId: tenantB }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('lets platform auditors filter tenants while preserving parameterized search', async () => {
    const tenantBPage = await audit.listPlatform({
      actorType: 'tenant_staff',
      tenantId: tenantB,
    });
    expect(tenantBPage.total).toBe(1);
    expect(tenantBPage.items[0]?.tenantId).toBe(tenantB);
    expect(tenantBPage.items[0]?.after).toEqual({ otp: '[REDACTED]' });

    const injectionShaped = await audit.listPlatform({ q: "%'; drop table audit_logs; --" });
    expect(injectionShaped.total).toBe(0);
    const stillPresent = await database.query<{ count: string }>(
      'select count(*)::text as count from audit_logs',
    );
    expect(stillPresent.rows[0]?.count).toBe('4');

    await expect(audit.listPlatform({
      from: '2025-01-01T00:00:00Z',
      to: '2025-05-01T00:00:00Z',
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps the audit table FORCE RLS boundary for a tenant database role', async () => {
    await database.exec(`
      create role audit_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to audit_tenant_probe;
      grant select on audit_logs to audit_tenant_probe;
      set role audit_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    const visible = await database.query<{ tenant_id: string }>(`
      select tenant_id::text from audit_logs order by id
    `);
    expect(visible.rows).toEqual([{ tenant_id: tenantA }, { tenant_id: tenantA }]);
    await database.exec('rollback; reset role');
  });
});
