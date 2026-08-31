import { PGlite, type Transaction } from '@electric-sql/pglite';
import { BadRequestException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { AnalyticsService } from '../src/analytics/analytics.service';
import { uuidV7 } from '../src/common/uuid-v7';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773590101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773590102';
const tenantEmpty = '018f2f45-7f5e-7e70-b17f-f6e773590103';
const customerA = '018f2f45-7f5e-7e70-b17f-f6e773590104';
const customerBeforeBoundary = '018f2f45-7f5e-7e70-b17f-f6e773590105';
const customerB = '018f2f45-7f5e-7e70-b17f-f6e773590106';
const tenantStaff = '018f2f45-7f5e-7e70-b17f-f6e773590107';

let database: PGlite;
let analytics: AnalyticsService;
let todayTokyo: string;

function compactId(): string {
  return uuidV7().replaceAll('-', '').slice(0, 26).toUpperCase();
}

describe('operational analytics', () => {
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
    todayTokyo = localDate(new Date(), 'Asia/Tokyo');
    const dayStart = `('${todayTokyo}'::date::timestamp at time zone 'Asia/Tokyo')`;
    await database.exec(`
      insert into tenants (
        id, code, name, expires_at, timezone, user_site_enabled
      ) values
        ('${tenantA}', 'analytics-a', 'Analytics A', transaction_timestamp() + interval '1 year',
          'Asia/Tokyo', false),
        ('${tenantB}', 'analytics-b', 'Analytics B', transaction_timestamp() + interval '1 year',
          'UTC', true),
        ('${tenantEmpty}', 'analytics-empty', 'Analytics Empty',
          transaction_timestamp() + interval '1 year', 'UTC', true);
      insert into tenant_staff (id, tenant_id, username, password_hash)
      values ('${tenantStaff}', '${tenantA}', 'analytics_owner', '${'s'.repeat(64)}');
      insert into customer_accounts (
        id, tenant_id, username, password_hash, created_at, updated_at
      ) values
        ('${customerA}', '${tenantA}', 'analytics_a', '${'a'.repeat(64)}',
          ${dayStart} + interval '1 minute', ${dayStart} + interval '1 minute'),
        ('${customerBeforeBoundary}', '${tenantA}', 'analytics_before', '${'b'.repeat(64)}',
          ${dayStart} - interval '1 minute', ${dayStart} - interval '1 minute'),
        ('${customerB}', '${tenantB}', 'analytics_b', '${'c'.repeat(64)}',
          ${dayStart} + interval '2 minutes', ${dayStart} + interval '2 minutes');
      insert into dramas (id, owner_type, owner_tenant_id, code, status) values
        ('${uuidV7()}', 'tenant', '${tenantA}', 'analytics-draft', 'draft'),
        ('${uuidV7()}', 'tenant', '${tenantA}', 'analytics-pending', 'pending_review'),
        ('${uuidV7()}', 'tenant', '${tenantA}', 'analytics-published', 'published'),
        ('${uuidV7()}', 'tenant', '${tenantB}', 'analytics-b-published', 'published');
    `);

    const bigOrderA = uuidV7();
    const bigOrderB = uuidV7();
    const eurOrder = uuidV7();
    const refundedOrder = uuidV7();
    const tenantBOrder = uuidV7();
    await database.exec(`
      insert into orders (
        id, tenant_id, account_id, order_no, order_type, status, currency,
        subtotal_minor, total_minor, locale, customer_snapshot_json,
        expires_at, paid_at, refunded_at, created_at, updated_at
      ) values
        ('${bigOrderA}', '${tenantA}', '${customerA}', 'ORD${compactId()}', 'drama', 'paid',
          'USD', 9000000000000000, 9000000000000000, 'en-US', '{}'::jsonb,
          ${dayStart} + interval '2 hours', ${dayStart} + interval '1 hour',
          null,
          ${dayStart} + interval '10 minutes', ${dayStart} + interval '1 hour'),
        ('${bigOrderB}', '${tenantA}', '${customerA}', 'ORD${compactId()}', 'episode', 'paid',
          'USD', 9000000000000000, 9000000000000000, 'en-US', '{}'::jsonb,
          ${dayStart} + interval '3 hours', ${dayStart} + interval '2 hours',
          null,
          ${dayStart} + interval '10 minutes', ${dayStart} + interval '2 hours'),
        ('${eurOrder}', '${tenantA}', '${customerA}', 'ORD${compactId()}', 'episode', 'paid',
          'EUR', 100, 100, 'en-US', '{}'::jsonb,
          ${dayStart} + interval '4 hours', ${dayStart} + interval '3 hours',
          null,
          ${dayStart} + interval '10 minutes', ${dayStart} + interval '3 hours'),
        ('${refundedOrder}', '${tenantA}', '${customerA}', 'ORD${compactId()}', 'episode', 'refunded',
          'USD', 500, 500, 'en-US', '{}'::jsonb,
          ${dayStart} + interval '5 hours', ${dayStart} + interval '4 hours',
          ${dayStart} + interval '4 hours 30 minutes',
          ${dayStart} + interval '10 minutes', ${dayStart} + interval '4 hours 30 minutes'),
        ('${tenantBOrder}', '${tenantB}', '${customerB}', 'ORD${compactId()}', 'episode', 'paid',
          'USD', 200, 200, 'en-US', '{}'::jsonb,
          ${dayStart} + interval '2 hours', ${dayStart} + interval '1 hour',
          null,
          ${dayStart} + interval '10 minutes', ${dayStart} + interval '1 hour');
    `);

    const providerId = uuidV7();
    const configId = uuidV7();
    const attemptId = uuidV7();
    const chargeId = uuidV7();
    const refundTransactionId = uuidV7();
    const refundId = uuidV7();
    const merchantBalanceId = uuidV7();
    await database.exec('set session_replication_role = replica');
    await database.exec(`
      insert into payment_providers (id, code, adapter_code)
      values ('${providerId}', 'analytics-provider', 'fake');
      insert into payment_configs (id, owner_type, owner_tenant_id, provider_id, label)
      values ('${configId}', 'tenant', '${tenantA}', '${providerId}', 'Analytics direct config');
      insert into payment_attempts (
        id, tenant_id, account_id, order_id, provider_id, payment_config_id,
        adapter_code_snapshot, collection_mode, status, currency, amount_minor,
        external_payment_id, idempotency_key, succeeded_at, created_at, updated_at
      ) values (
        '${attemptId}', '${tenantA}', '${customerA}', '${refundedOrder}', '${providerId}',
        '${configId}', 'fake', 'tenant_direct', 'succeeded', 'USD', 500,
        'analytics_payment_001', 'analytics-attempt-key-001',
        ${dayStart} + interval '4 hours', ${dayStart} + interval '3 hours 50 minutes',
        ${dayStart} + interval '4 hours'
      );
      insert into payment_transactions (
        id, tenant_id, attempt_id, order_id, provider_id, transaction_type, status,
        external_transaction_id, currency, amount_minor, payload_hash, occurred_at, created_at
      ) values
        ('${chargeId}', '${tenantA}', '${attemptId}', '${refundedOrder}', '${providerId}',
          'charge', 'succeeded', 'analytics_charge_001', 'USD', 500, '${'a'.repeat(64)}',
          ${dayStart} + interval '4 hours', ${dayStart} + interval '4 hours'),
        ('${refundTransactionId}', '${tenantA}', '${attemptId}', '${refundedOrder}', '${providerId}',
          'refund', 'succeeded', 'analytics_refund_tx_001', 'USD', 500, '${'b'.repeat(64)}',
          ${dayStart} + interval '4 hours 30 minutes',
          ${dayStart} + interval '4 hours 30 minutes');
      insert into payment_refunds (
        id, tenant_id, order_id, attempt_id, payment_transaction_id,
        provider_id, payment_config_id, refund_transaction_id,
        adapter_code_snapshot, collection_mode, external_payment_id_snapshot,
        provider_idempotency_key, status, currency, amount_minor, reason,
        external_refund_id, requested_by_type, requested_by,
        processing_at, succeeded_at, reconciliation_required, reconciliation_reason,
        version, created_at, updated_at
      ) values (
        '${refundId}', '${tenantA}', '${refundedOrder}', '${attemptId}', '${chargeId}',
        '${providerId}', '${configId}', '${refundTransactionId}', 'fake', 'tenant_direct',
        'analytics_payment_001', '${refundId}', 'manual_reconciliation', 'USD', 500,
        'Analytics fixture full refund', 'analytics_refund_001', 'tenant_staff', '${tenantStaff}',
        ${dayStart} + interval '4 hours 10 minutes',
        ${dayStart} + interval '4 hours 30 minutes', true,
        'Analytics fixture reconciliation queue', 2,
        ${dayStart} + interval '4 hours', ${dayStart} + interval '4 hours 30 minutes'
      );
      insert into merchant_balance_accounts (
        id, tenant_id, currency, pending_minor, available_minor, frozen_minor, withdrawn_minor
      ) values (
        '${merchantBalanceId}', '${tenantA}', 'USD', 9000000000000000,
        8000000000000000, 7000000000000000, 6000000000000000
      );
      insert into referral_commission_accounts (
        id, tenant_id, account_id, currency, pending_minor, available_minor, withdrawn_minor
      ) values (
        '${uuidV7()}', '${tenantA}', '${customerA}', 'USD',
        9000000000000000, 8000000000000000, 0
      );
      insert into withdrawals (
        id, tenant_id, balance_account_id, withdrawal_no, currency,
        amount_minor, status, payout_account_fingerprint, applicant_staff_id,
        submitted_at, created_at, updated_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${merchantBalanceId}', 'WDR${compactId()}', 'USD',
        9000000000000000, 'submitted', 'analytics-payout-fingerprint', '${tenantStaff}',
        ${dayStart} + interval '5 hours', ${dayStart} + interval '5 hours',
        ${dayStart} + interval '5 hours'
      );
    `);
    await database.exec('set session_replication_role = origin');
    analytics = new AnalyticsService(testDatabaseService(database));
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('uses the tenant time-zone boundary, never crosses tenants, and keeps currencies separate', async () => {
    const overview = await analytics.getTenantOverview(tenantA, {
      from: todayTokyo,
      to: todayTokyo,
    }) as any;
    expect(overview.range).toMatchObject({
      from: todayTokyo,
      timeZone: 'Asia/Tokyo',
      to: todayTokyo,
    });
    expect(overview.customers).toEqual({ new: 1, paid: 1, total: 2 });
    expect(overview.content).toEqual({ draft: 1, pending: 1, published: 1 });
    expect(overview.orders).toEqual({ paid: 4, refunded: 1 });
    expect(overview.refundBacklog).toEqual({ manualReconciliation: 1, processing: 0 });
    const usd = overview.moneyByCurrency.find((row: any) => row.currency === 'USD');
    expect(usd).toEqual({
      currency: 'USD',
      grossMinor: '18000000000000500',
      netMinor: '18000000000000000',
      refundMinor: '500',
    });
    expect(overview.moneyByCurrency.find((row: any) => row.currency === 'EUR')).toEqual({
      currency: 'EUR',
      grossMinor: '100',
      netMinor: '100',
      refundMinor: '0',
    });
    expect(overview.daily).toEqual([expect.objectContaining({
      date: todayTokyo,
      newCustomers: 1,
      paidOrders: 4,
      refunds: 1,
    })]);
    expect(overview.merchantBalances[0]).toEqual({
      availableMinor: '8000000000000000',
      currency: 'USD',
      frozenMinor: '7000000000000000',
      pendingMinor: '9000000000000000',
      withdrawnMinor: '6000000000000000',
    });
    expect(overview.commissionBalances[0]).toEqual({
      availableMinor: '8000000000000000',
      currency: 'USD',
      pendingMinor: '9000000000000000',
    });
    expect(overview.withdrawals.find((row: any) => row.status === 'submitted')).toEqual({
      amounts: [{ amountMinor: '9000000000000000', currency: 'USD' }],
      count: 1,
      status: 'submitted',
    });
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain('analytics_a');
    expect(serialized).not.toContain('analytics-payout-fingerprint');
    expect(serialized).not.toContain('password');
    expect('onlineUsers' in overview).toBe(false);
  });

  it('returns genuine zeros for an empty tenant and remains available when the user site is off', async () => {
    const todayUtc = localDate(new Date(), 'UTC');
    const empty = await analytics.getTenantOverview(tenantEmpty, {
      from: todayUtc,
      to: todayUtc,
    }) as any;
    expect(empty.customers).toEqual({ new: 0, paid: 0, total: 0 });
    expect(empty.orders).toEqual({ paid: 0, refunded: 0 });
    expect(empty.moneyByCurrency).toEqual([]);
    expect(empty.daily).toEqual([{
      amounts: [],
      date: todayUtc,
      newCustomers: 0,
      paidOrders: 0,
      refunds: 0,
    }]);
    expect(empty.merchantBalances).toEqual([]);
    const closedSite = await analytics.getTenantOverview(tenantA, {}) as any;
    expect(closedSite.customers.total).toBe(2);
    expect(closedSite.range).toMatchObject({
      from: addDays(todayTokyo, -6),
      timeZone: 'Asia/Tokyo',
      to: todayTokyo,
    });
    expect(closedSite.daily).toHaveLength(7);
  });

  it('provides platform totals and a currency-specific cursor ranking', async () => {
    const overview = await analytics.getPlatformOverview({
      from: todayTokyo,
      timeZone: 'Asia/Tokyo',
      to: todayTokyo,
    }) as any;
    expect(overview.tenants).toEqual({ active: 3, expired: 0, suspended: 0, total: 3 });
    expect(overview.customers).toEqual({ new: 2, paid: 2, total: 3 });
    expect(overview.orders).toEqual({ paid: 5, refunded: 1 });
    expect(overview.merchantBalances[0]).toEqual({
      availableMinor: '8000000000000000',
      currency: 'USD',
      frozenMinor: '7000000000000000',
      pendingMinor: '9000000000000000',
      withdrawnMinor: '6000000000000000',
    });
    expect(overview.commissionBalances[0]).toMatchObject({
      availableMinor: '8000000000000000',
      currency: 'USD',
      pendingMinor: '9000000000000000',
    });
    expect(overview.withdrawals.find((row: any) => row.status === 'submitted').count).toBe(1);
    const first = await analytics.getPlatformTenantRanking({
      currency: 'USD',
      from: todayTokyo,
      pageSize: '1',
      timeZone: 'Asia/Tokyo',
      to: todayTokyo,
    }) as any;
    expect(first.items).toEqual([expect.objectContaining({
      grossMinor: '18000000000000500',
      paidOrders: 3,
      tenantId: tenantA,
    })]);
    expect(typeof first.nextCursor).toBe('string');
    const second = await analytics.getPlatformTenantRanking({
      currency: 'USD',
      cursor: first.nextCursor,
      from: todayTokyo,
      pageSize: 1,
      timeZone: 'Asia/Tokyo',
      to: todayTokyo,
    }) as any;
    expect(second.items[0]).toMatchObject({
      grossMinor: '200',
      paidOrders: 1,
      tenantId: tenantB,
    });
    const exact = await analytics.getPlatformTenantRanking({
      currency: 'EUR',
      from: todayTokyo,
      tenantId: tenantA,
      timeZone: 'Asia/Tokyo',
      to: todayTokyo,
    }) as any;
    expect(exact.items).toEqual([expect.objectContaining({
      grossMinor: '100',
      tenantId: tenantA,
    })]);
    await expect(analytics.getPlatformTenantRanking({
      currency: 'EUR',
      cursor: first.nextCursor,
      from: todayTokyo,
      timeZone: 'Asia/Tokyo',
      to: todayTokyo,
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid, future, reversed, oversized, and injection-shaped ranges', async () => {
    const tomorrow = addDays(todayTokyo, 1);
    const ninetyOneDaysAgo = addDays(todayTokyo, -90);
    await expect(analytics.getPlatformOverview({
      from: `${todayTokyo}'; drop table orders; --`,
      to: todayTokyo,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(analytics.getPlatformOverview({
      from: todayTokyo,
      to: tomorrow,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(analytics.getPlatformOverview({
      from: todayTokyo,
      to: addDays(todayTokyo, -1),
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(analytics.getPlatformOverview({
      from: ninetyOneDaysAgo,
      to: todayTokyo,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(analytics.getPlatformOverview({
      from: todayTokyo,
      timeZone: 'UTC; drop schema public',
      to: todayTokyo,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(analytics.getPlatformTenantRanking({
      currency: 'USD OR 1=1',
      from: todayTokyo,
      to: todayTokyo,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(analytics.getTenantOverview(tenantA, {
      from: todayTokyo,
      timeZone: 'UTC',
      to: todayTokyo,
    })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('enforces customer fact RLS for a non-owner tenant database role', async () => {
    await database.exec('create role analytics_tenant_probe nosuperuser nobypassrls');
    await database.exec('grant usage on schema app, public to analytics_tenant_probe');
    await database.exec(`
      grant select on customer_accounts, orders, payment_refunds, dramas,
        merchant_balance_accounts, referral_commission_accounts, withdrawals
      to analytics_tenant_probe
    `);
    await database.exec(`
      set role analytics_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    const rows = await database.query<{
      balances: string;
      commissions: string;
      customers: string;
      dramas: string;
      orders: string;
      refunds: string;
      withdrawals: string;
    }>(`
      select
        (select count(*)::text from customer_accounts) as customers,
        (select count(*)::text from orders) as orders,
        (select count(*)::text from payment_refunds) as refunds,
        (select count(*)::text from dramas) as dramas,
        (select count(*)::text from merchant_balance_accounts) as balances,
        (select count(*)::text from referral_commission_accounts) as commissions,
        (select count(*)::text from withdrawals) as withdrawals
    `);
    expect(rows.rows[0]).toEqual({
      balances: '1',
      commissions: '1',
      customers: '2',
      dramas: '3',
      orders: '4',
      refunds: '1',
      withdrawals: '1',
    });
    await database.exec('rollback; reset role');
  });
});

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

function testDatabaseService(target: PGlite): DatabaseService {
  return {
    inPlatformContext: <T>(
      callback: (transaction: DatabaseTransaction) => Promise<T>,
    ): Promise<T> => target.transaction((transaction) => callback(transactionTag(transaction))),
    inTenantContext: <T>(
      selectedTenant: string,
      callback: (transaction: DatabaseTransaction) => Promise<T>,
    ): Promise<T> => target.transaction(async (transaction) => {
      await transaction.query(
        "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
        [selectedTenant],
      );
      return callback(transactionTag(transaction));
    }),
  } as unknown as DatabaseService;
}

function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  return `${read('year')}-${read('month')}-${read('day')}`;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
