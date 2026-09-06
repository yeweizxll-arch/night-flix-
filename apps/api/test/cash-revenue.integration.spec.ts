import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { uuidV7 } from '../src/common/uuid-v7';
import { NativeStoreService } from '../src/commerce/native-store.service';
import type { NativeReceiptVerifier, VerifiedNativePurchase } from '../src/commerce/native-receipt-verifier';
import { PointUnlockService } from '../src/commerce/point-unlock.service';
import { RevenueShareService } from '../src/public-drama-pool/revenue-share.service';
import { AdObservationService } from '../src/rewarded-unlocks/ad-observation.controller';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';

const tenant = '018f2f45-7f5e-7e70-b17f-f6e773570301';
const account = '018f2f45-7f5e-7e70-b17f-f6e773570302';
const actor = '018f2f45-7f5e-7e70-b17f-f6e773570303';
const coins = '018f2f45-7f5e-7e70-b17f-f6e773570304';
const member = '018f2f45-7f5e-7e70-b17f-f6e773570305';
const dramas = [6, 7, 8, 9].map(n => '018f2f45-7f5e-7e70-b17f-f6e77357030' + n);
vi.mock('../src/commerce/native-store-config', () => ({ nativeStoreConfig: () => ({
  applicationId: 'com.cash.test', environment: 'Production', products: {
    coins: { kind: 'points_topup', productId: '018f2f45-7f5e-7e70-b17f-f6e773570304' },
    member: { kind: 'membership', productId: '018f2f45-7f5e-7e70-b17f-f6e773570305' },
  },
}) }));
let db: PGlite; let store: NativeStoreService; let revenue: RevenueShareService; let unlock: PointUnlockService; let binding: string;
let observations: AdObservationService;
const principal = { tenantId: tenant, accountId: account, username: 'cash-user', deviceId: account, sessionId: account };
const metadata = { actorId: actor, requestId: 'cash-audit' };
function tag(tx: Transaction): DatabaseTransaction {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let query = strings[0] ?? ''; values.forEach((_, i) => { query += `$${i + 1}${strings[i + 1] ?? ''}`; });
    return (await tx.query(query, values)).rows;
  };
  Object.assign(sql, { json: (value: unknown) => JSON.stringify(value) });
  return sql as unknown as DatabaseTransaction;
}
function purchase(id: string, overrides: Partial<VerifiedNativePurchase> = {}): VerifiedNativePurchase {
  return { store: 'apple', applicationId: 'com.cash.test', environment: 'Production', externalId: id, originalId: id,
    tokenHash: 'a'.repeat(64), productId: 'coins', accountBinding: binding, kind: 'points_topup', currency: 'USD',
    grossMinor: '199', netMinor: null, refundedMinor: '0', purchasedAt: new Date(Date.now() - 1000),
    expiresAt: null, observedAt: new Date(), status: 'active', ...overrides };
}
describe('paid cash provenance, allocation and append-only refunds', () => {
  beforeAll(async () => {
    db = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql')).sort())
      await db.exec((await readFile(resolve(directory, file), 'utf8')).replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '').replace(/\bcitext\b/g, 'text'));
    await db.exec(`create role cash_platform nosuperuser nobypassrls;
      create role cash_tenant nosuperuser nobypassrls;
      grant usage on schema public, app to cash_platform, cash_tenant;
      grant select, insert, update, delete on all tables in schema public to cash_platform, cash_tenant;
      insert into app.database_access_principals(role_name, access_scope) values ('cash_platform', 'platform');
      insert into tenants(id, code, name, expires_at) values ('${tenant}', 'cash-test', 'Cash', statement_timestamp() + interval '1 year');
      insert into platform_staff(id, username, password_hash) values ('${actor}', 'cash-auditor', '${'x'.repeat(64)}');
      insert into customer_accounts(id, tenant_id, username, password_hash) values ('${account}', '${tenant}', 'cash-user', '${'x'.repeat(64)}');
      insert into points_topup_packages(id, tenant_id, code, points_amount, bonus_points) values ('${coins}', '${tenant}', 'cash-coins', 100, 20);
      insert into membership_plans(id, tenant_id, code, duration_days) values ('${member}', '${tenant}', 'cash-monthly', 30);`);
    for (const [i, drama] of dramas.entries()) {
      await db.query("insert into dramas(id, owner_type, owner_tenant_id, code, status) values ($1, 'tenant', $2, $3, 'published')", [drama, tenant, 'cash-' + i]);
      await db.query("insert into content_point_prices(id, tenant_id, target_type, target_id, points_amount, status) values ($1, $2, 'drama', $3, $4, 'active')", [uuidV7(), tenant, drama, [50, 70, 1, 1][i]]);
    }
    const database = { inPlatformContext: <T>(fn: (tx: DatabaseTransaction) => Promise<T>) => db.transaction(async tx => {
      await tx.exec('set local role cash_platform'); return fn(tag(tx));
    }) } as DatabaseService;
    store = new NativeStoreService(database, {} as NativeReceiptVerifier);
    revenue = new RevenueShareService(database); unlock = new PointUnlockService(database);
    observations = new AdObservationService(database);
    binding = (await store.prepare(principal)).accountBinding;
  }, 120000);
  afterAll(async () => { await db?.close(); });
  it('records verified paid credits separately from bonuses and requires an explicit basis', async () => {
    await revenue.upsertPolicy(tenant, { contentScope: 'private', incomeType: 'coin_unlock', headquartersBps: 2000, tenantBps: 8000, creatorBps: 0, expectedVersion: 0 }, metadata);
    await store.apply(tenant, purchase('100'), account);
    await unlock.unlock(principal, 'drama', dramas[0], {}, 'cash-unlock-one', 'cash-audit');
    expect((await db.query('select remaining::text, not is_cash as gift from point_cash_lots order by created_at')).rows)
      .toEqual([{ remaining: '50', gift: false }, { remaining: '20', gift: true }]);
    expect(await revenue.cashStatus(tenant)).toMatchObject({ basis: null, unvalued: 1 });
    expect((await db.query('select id from content_revenue_ledger')).rows).toHaveLength(0);
    await revenue.configureBasis(tenant, 'gross', metadata);
    await revenue.reconcile(tenant, metadata);
    expect((await db.query('select gross_minor::text, headquarters_minor::text, tenant_minor::text from content_revenue_ledger')).rows)
      .toEqual([{ gross_minor: '99', headquarters_minor: '19', tenant_minor: '80' }]);
  });
  it('allocates rounding remainder once, creates no bonus revenue and is idempotent', async () => {
    await unlock.unlock(principal, 'drama', dramas[1], {}, 'cash-unlock-two', 'cash-audit');
    await unlock.unlock(principal, 'drama', dramas[1], {}, 'cash-unlock-two', 'cash-audit');
    await store.apply(tenant, purchase('100'), account);
    expect((await db.query('select sum(gross_minor)::text as total, count(*)::integer as count from content_revenue_ledger')).rows)
      .toEqual([{ total: '199', count: 2 }]);
    expect((await db.query('select balance::text from point_accounts')).rows).toEqual([{ balance: '0' }]);
  });
  it('appends partial/full refund adjustments even for settled revenue without mutating the charge', async () => {
    await db.exec("update content_revenue_ledger set status = 'settled' where source_type = 'cash_event'");
    await store.apply(tenant, purchase('100', { refundedMinor: '99' }));
    await store.apply(tenant, purchase('100', { refundedMinor: '99' }));
    expect((await db.query("select sum(gross_minor)::text as total from content_revenue_ledger where source_type = 'cash_refund'")).rows)
      .toEqual([{ total: '-98' }]);
    await store.apply(tenant, purchase('100', { refundedMinor: '199', status: 'refunded' }));
    await store.apply(tenant, purchase('100', { refundedMinor: '199', status: 'refunded' }));
    expect((await db.query('select sum(gross_minor)::text as total, sum(headquarters_minor)::text as hq, sum(tenant_minor)::text as tenant from content_revenue_ledger')).rows)
      .toEqual([{ total: '0', hq: '0', tenant: '0' }]);
    expect((await db.query("select gross_minor::text, status from content_revenue_ledger where source_type = 'cash_event' order by content_revenue_ledger.gross_minor")).rows)
      .toEqual([{ gross_minor: '99', status: 'settled' }, { gross_minor: '100', status: 'settled' }]);
    expect((await db.query('select points::text from native_refund_debts')).rows).toEqual([{ points: '120' }]);
  });
  it('membership has no drama/creator share, and net basis stays unvalued without a statement', async () => {
    await revenue.configureBasis(tenant, 'net', metadata);
    await revenue.upsertPolicy(tenant, { contentScope: 'private', incomeType: 'membership', headquartersBps: 2000, tenantBps: 8000, creatorBps: 0, expectedVersion: 0 }, metadata);
    await store.apply(tenant, purchase('101', { kind: 'membership', productId: 'member', expiresAt: new Date(Date.now() + 86400000) }));
    expect((await db.query("select drama_id, creator_id, state, basis from content_revenue_events where income_type = 'membership'")).rows)
      .toEqual([{ drama_id: null, creator_id: null, state: 'unvalued', basis: 'net' }]);
    await store.apply(tenant, purchase('102', { kind: 'membership', productId: 'member', netMinor: '139', expiresAt: new Date(Date.now() + 86400000) }));
    expect((await db.query("select gross_minor::text, creator_minor::text from content_revenue_ledger where income_type = 'membership'")).rows)
      .toEqual([{ gross_minor: '139', creator_minor: '0' }]);
  });
  it('tenant SQL cannot alter money sources or execute a settlement through forged platform GUCs', async () => {
    await expect(db.transaction(async tx => {
      await tx.exec("set local role cash_tenant");
      await tx.query("select set_config('app.tenant_id', $1, true), set_config('app.access_scope', 'platform', true)", [tenant]);
      await tx.query("insert into content_revenue_basis(tenant_id, basis, updated_by) values ($1, 'gross', $2) on conflict(tenant_id) do update set basis='gross'", [tenant, actor]);
    })).rejects.toThrow();
    expect((await db.query("select basis from content_revenue_basis")).rows).toEqual([{ basis: 'net' }]);
  });

  it('a partial refund of unused coins preserves the paid/bonus split and does not subtract cash twice', async () => {
    const user = uuidV7();
    await db.query("insert into customer_accounts(id, tenant_id, username, password_hash) values ($1, $2, $3, $4)", [user, tenant, 'refund-' + user, 'x'.repeat(64)]);
    const customer = { ...principal, accountId: user };
    const accountBinding = (await store.prepare(customer)).accountBinding;
    await revenue.configureBasis(tenant, 'gross', metadata);
    const paid = purchase('103', { accountBinding });
    await store.apply(tenant, paid, user);
    await store.apply(tenant, { ...paid, refundedMinor: '99', observedAt: new Date() });
    expect((await db.query('select remaining::text, not is_cash as gift from point_cash_lots where account_id = $1 order by created_at', [user])).rows)
      .toEqual([{ remaining: '50', gift: false }, { remaining: '10', gift: true }]);
    await unlock.unlock(customer, 'drama', dramas[0], {}, 'unused-refund-unlock', 'cash-audit');
    expect((await db.query("select l.gross_minor::text from content_revenue_ledger l join content_revenue_events e on e.ledger_id = l.id join content_cash_sources s on s.id=e.source_id where s.account_id=$1", [user])).rows)
      .toEqual([{ gross_minor: '100' }]);
    expect((await db.query("select count(*)::integer as count from content_revenue_ledger l join content_revenue_events e on e.ledger_id=l.reversal_of_id join content_cash_sources s on s.id=e.source_id where s.account_id=$1", [user])).rows)
      .toEqual([{ count: 0 }]);
  });

  it('headquarters statements unblock net valuation and public ad reports split three ways exactly once', async () => {
    const sources = await db.query<{ id: string }>("select id from native_store_transactions where external_id='101'");
    const statement = { sourceId: sources.rows[0]!.id, currency: 'USD', grossMinor: '199', netMinor: '139', reportId: 'store-monthly-01', rowId: 'line-1', reportSha256: 'b'.repeat(64) };
    await revenue.attachNetStatement(tenant, statement, metadata);
    await expect(revenue.attachNetStatement(tenant, statement, metadata)).resolves.toEqual({ duplicate: true });
    await expect(revenue.attachNetStatement(tenant, { ...statement, netMinor: '140' }, metadata)).rejects.toThrow('immutable');
    await revenue.reconcile(tenant, metadata);
    expect((await db.query("select state from content_revenue_events where source_id=$1", [statement.sourceId])).rows).toEqual([{ state: 'posted' }]);
    const publicId = uuidV7();
    await db.query("insert into dramas(id, owner_type, code, status, shanchuang_work_id, shanchuang_creator_id, public_revision) values ($1, 'platform', $2, 'published', 'cash-work', 'cash-creator', 1)", [publicId, 'public-' + publicId]);
    await revenue.upsertPolicy(tenant, { contentScope: 'public', incomeType: 'content_ad', headquartersBps: 2000, tenantBps: 5000, creatorBps: 3000, expectedVersion: 0 }, metadata);
    const report = { currency: 'USD', grossMinor: '101', dramaId: publicId, occurredAt: new Date(Date.now() - 1000).toISOString(), reportId: 'ad-monthly-01', rowId: 'line-1', reportSha256: 'c'.repeat(64) };
    const result = await revenue.importAdStatement(tenant, report, metadata);
    await expect(revenue.importAdStatement(tenant, report, metadata)).resolves.toEqual({ ...result, duplicate: true });
    await expect(revenue.importAdStatement(tenant, { ...report, grossMinor: '102' }, metadata)).rejects.toThrow('different facts');
    expect((await db.query("select headquarters_minor::text, tenant_minor::text, creator_minor::text from content_revenue_ledger where source_id=$1", [result.id])).rows)
      .toEqual([{ headquarters_minor: '20', tenant_minor: '51', creator_minor: '30' }]);
  });
  it('keeps client paid-ad observations untrusted, tenant/platform-bound and out of the cash ledger', async () => {
    const unit = 'ca-app-pub-1111111111111111/1111111111';
    await db.query(`insert into tenant_app_runtime_configs(tenant_id, admob_json, created_by, updated_by) values ($1, $2, $3, $3)
      on conflict(tenant_id) do update set admob_json=excluded.admob_json`,
      [tenant, JSON.stringify({ enabled: true, android: { native: unit } }), actor]);
    const before = (await db.query('select id from content_revenue_ledger')).rows.length;
    const input = { eventId: 'observed-revenue-0001', platform: 'android' as const, format: 'native', adUnitId: unit,
      currency: 'USD', valueMicros: '1234', precision: 'precise' };
    await observations.record(tenant, input); await observations.record(tenant, input);
    expect((await db.query('select trust_level from ad_paid_observations')).rows).toEqual([{ trust_level: 'client_unverified' }]);
    expect((await db.query('select id from content_revenue_ledger')).rows).toHaveLength(before);
    await expect(observations.record(tenant, { ...input, platform: 'ios' })).rejects.toThrow('does not belong');
    await expect(observations.record(tenant, { ...input, valueMicros: '-1' })).rejects.toThrow('Invalid');
  });
  it('records an immutable headquarters historical sign-off and an empty closed month', async () => {
    await db.query("insert into content_revenue_legacy_review(tenant_id, reason) values ($1, 'Imported historical wallet')", [tenant]);
    const input = { reportId: 'signed-off-historical-01', reportSha256: 'd'.repeat(64) };
    await revenue.acknowledgeLegacyReview(tenant, input, metadata);
    expect((await revenue.cashStatus(tenant)).legacyReview).toBeNull();
    await expect(revenue.acknowledgeLegacyReview(tenant, input, metadata)).resolves.toEqual({ duplicate: true });
    await expect(revenue.acknowledgeLegacyReview(tenant, { ...input, reportId: 'different' }, metadata)).rejects.toThrow('immutable');
    expect(await revenue.settleMonth(tenant, '2020-01', 'EUR', metadata)).toMatchObject({ count: 0, alreadySettled: false });
    expect(await revenue.settleMonth(tenant, '2020-01', 'EUR', metadata)).toMatchObject({ count: 0, alreadySettled: true });
  });
});
