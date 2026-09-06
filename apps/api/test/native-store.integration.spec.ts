import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { NativeStoreService } from '../src/commerce/native-store.service';
import type { NativeReceiptVerifier, VerifiedNativePurchase } from '../src/commerce/native-receipt-verifier';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
const tenant = '018f2f45-7f5e-7e70-b17f-f6e773573101';
const otherTenant = '018f2f45-7f5e-7e70-b17f-f6e773573102';
const account = '018f2f45-7f5e-7e70-b17f-f6e773573103';
const otherAccount = '018f2f45-7f5e-7e70-b17f-f6e773573104';
const coins = '018f2f45-7f5e-7e70-b17f-f6e773573108';
const plan = '018f2f45-7f5e-7e70-b17f-f6e773573109';
vi.mock('../src/commerce/native-store-config', () => ({ nativeStoreConfig: () => ({
  applicationId: 'com.tenant.test', environment: 'Sandbox', products: {
    coins: { kind: 'points_topup', productId: '018f2f45-7f5e-7e70-b17f-f6e773573108' },
    member: { kind: 'membership', productId: '018f2f45-7f5e-7e70-b17f-f6e773573109' },
  },
}) }));
let db: PGlite; let store: NativeStoreService; let binding: string;
const principal = { tenantId: tenant, accountId: account, username: 'store-user', deviceId: account, sessionId: account };
function tag(transaction: Transaction): DatabaseTransaction {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0] ?? ''; values.forEach((_, i) => { query += `$${i + 1}${strings[i + 1] ?? ''}`; });
    return (await transaction.query(query, values)).rows;
  };
  Object.assign(sql, { json: (value: unknown) => JSON.stringify(value) });
  return sql as unknown as DatabaseTransaction;
}
function purchase(id: string, overrides: Partial<VerifiedNativePurchase> = {}): VerifiedNativePurchase {
  return { store: 'apple', applicationId: 'com.tenant.test', environment: 'Sandbox', externalId: id, originalId: id,
    tokenHash: 'a'.repeat(64), productId: 'coins', accountBinding: binding, kind: 'points_topup', currency: 'USD',
    grossMinor: '199', netMinor: null, refundedMinor: '0', purchasedAt: new Date(Date.now() - 1000),
    expiresAt: null, observedAt: new Date(), status: 'active', ...overrides };
}
describe('native store fulfillment and refunds', () => {
  beforeAll(async () => {
    db = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort()) {
      await db.exec((await readFile(resolve(directory, file), 'utf8'))
        .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '').replace(/\bcitext\b/g, 'text'));
    }
    await db.exec(`insert into tenants(id, code, name, expires_at) values
      ('${tenant}', 'store-a', 'A', statement_timestamp() + interval '1 year'),
      ('${otherTenant}', 'store-b', 'B', statement_timestamp() + interval '1 year');
      insert into customer_accounts(id, tenant_id, username, password_hash) values
      ('${account}', '${tenant}', 'store-user', '${'x'.repeat(32)}'),
      ('${otherAccount}', '${tenant}', 'store-other', '${'x'.repeat(32)}');
      insert into points_topup_packages(id, tenant_id, code, points_amount, bonus_points) values ('${coins}', '${tenant}', 'coins', 100, 20);
      insert into membership_plans(id, tenant_id, code, duration_days) values ('${plan}', '${tenant}', 'monthly', 30);`);
    const database = { inPlatformContext: <T>(fn: (tx: DatabaseTransaction) => Promise<T>) => db.transaction(tx => fn(tag(tx))) } as DatabaseService;
    store = new NativeStoreService(database, {} as NativeReceiptVerifier);
    binding = (await store.prepare(principal)).accountBinding;
  }, 120000);
  afterAll(async () => { await db?.close(); });

  it('issues one stable binding and rejects foreign account/tenant proofs', async () => {
    expect((await store.prepare(principal)).accountBinding).toBe(binding);
    await expect(store.apply(tenant, purchase('1'), otherAccount)).rejects.toThrow('another account');
    await expect(store.apply(otherTenant, purchase('1'))).rejects.toThrow('another account');
    expect((await db.query('select id from native_store_transactions')).rows).toHaveLength(0);
  });
  it('grants a topup once across duplicate confirmations and notifications', async () => {
    const first = purchase('1');
    const result = await store.apply(tenant, first, account);
    await expect(store.apply(tenant, first)).resolves.toMatchObject({ id: result.id, duplicate: true });
    expect((await db.query('select balance::text from point_accounts')).rows).toEqual([{ balance: '120' }]);
    expect((await db.query('select id from point_ledger')).rows).toHaveLength(1);
    await expect(store.apply(tenant, { ...first, grossMinor: '200' })).rejects.toThrow('Immutable');
  });
  it('recovers refunds idempotently, preserves debt for spent credits, and repays on the next topup', async () => {
    const wallet = (await db.query<{ id: string }>('select id from point_accounts')).rows[0]!;
    await db.exec(`insert into point_ledger(id, tenant_id, account_id, point_account_id, entry_type, delta, balance_after,
      reference_type, reference_id, idempotency_key, created_by_type) values
      ('018f2f45-7f5e-7e70-b17f-f6e773573110', '${tenant}', '${account}', '${wallet.id}', 'adjustment', -100, 0,
      'audit_spend', '${coins}', 'audit-spend-coins', 'system');`);
    const refund = purchase('1', { status: 'refunded', refundedMinor: '199' });
    await store.apply(tenant, refund);
    await store.apply(tenant, refund);
    expect((await db.query('select balance::text from point_accounts')).rows).toEqual([{ balance: '0' }]);
    expect((await db.query('select points::text from native_refund_debts')).rows).toEqual([{ points: '100' }]);
    await store.apply(tenant, purchase('1')); // old active proof cannot resurrect a refunded transaction.
    expect((await db.query('select balance::text from point_accounts')).rows).toEqual([{ balance: '0' }]);
    await store.apply(tenant, purchase('2'));
    expect((await db.query('select balance::text from point_accounts')).rows).toEqual([{ balance: '20' }]);
    expect((await db.query('select points::text from native_refund_debts')).rows).toEqual([{ points: '0' }]);
  });
  it('handles renewal, expiration and revocation as separate immutable membership periods', async () => {
    const first = purchase('3', { kind: 'membership', productId: 'member', expiresAt: new Date(Date.now() + 86400000) });
    await store.apply(tenant, first);
    await store.apply(tenant, first);
    expect((await db.query('select id from entitlements where revoked_at is null')).rows).toHaveLength(1);
    const next = { ...first, externalId: '4', purchasedAt: new Date(), expiresAt: new Date(Date.now() + 2 * 86400000), observedAt: new Date() };
    await store.apply(tenant, next);
    expect((await db.query('select id from entitlements where revoked_at is null')).rows).toHaveLength(2);
    await store.apply(tenant, { ...first, status: 'refunded', refundedMinor: '199', observedAt: new Date() });
    expect((await db.query('select id from entitlements where revoked_at is null')).rows).toHaveLength(1);
    await store.apply(tenant, { ...next, status: 'inactive', observedAt: new Date() });
    expect((await db.query('select id from entitlements where revoked_at is null')).rows).toHaveLength(0);
  });
  it('does not manufacture refund debt for a charge that never delivered points', async () => {
    await store.apply(tenant, purchase('5', { status: 'refunded', refundedMinor: '199' }));
    expect((await db.query('select points::text from native_refund_debts')).rows).toEqual([{ points: '0' }]);
  });
  it('pins SKU credits before purchase and stops new sales of a disabled product without blocking restore', async () => {
    await store.prepare(principal, { store: 'apple', productId: 'coins' });
    await db.query('update points_topup_packages set points_amount = 500, bonus_points = 50 where id = $1', [coins]);
    await store.apply(tenant, purchase('6'), account);
    expect((await db.query("select points_snapshot::text, bonus_snapshot::text from native_store_transactions where external_id='6'")).rows)
      .toEqual([{ points_snapshot: '100', bonus_snapshot: '20' }]);
    await db.query("update points_topup_packages set status = 'disabled' where id = $1", [coins]);
    await expect(store.prepare(principal, { store: 'apple', productId: 'coins' })).rejects.toThrow('unavailable');
    await expect(store.prepare(principal)).resolves.toMatchObject({ accountBinding: binding });
    await expect(store.apply(tenant, purchase('6'), account)).resolves.toMatchObject({ duplicate: true });
  });
});
