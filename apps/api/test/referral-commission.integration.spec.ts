import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  FakePaymentAdapter,
  PaymentAdapterRegistry,
  signFakePaymentWebhook,
} from '../src/commerce/payment-adapter';
import { PaymentConfigurationService } from '../src/commerce/payment-configuration.service';
import { PaymentCoreService } from '../src/commerce/payment-core.service';
import { uuidV7 } from '../src/common/uuid-v7';
import type { CustomerPrincipal } from '../src/customer-auth/customer-auth.types';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';
import {
  ReferralService,
  ReferralSettlementWorkerService,
} from '../src/referrals/referral.service';

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773581101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773581102';
const tenantStaff = '018f2f45-7f5e-7e70-b17f-f6e773581103';
const platformStaff = '018f2f45-7f5e-7e70-b17f-f6e773581104';
const upstream = '018f2f45-7f5e-7e70-b17f-f6e773581105';
const inviter = '018f2f45-7f5e-7e70-b17f-f6e773581106';
const buyer = '018f2f45-7f5e-7e70-b17f-f6e773581107';
const lateInvitee = '018f2f45-7f5e-7e70-b17f-f6e773581108';
const foreignCustomer = '018f2f45-7f5e-7e70-b17f-f6e773581109';

let database: PGlite;
let referrals: ReferralService;
let settlements: ReferralSettlementWorkerService;
let payments: PaymentCoreService;
let paymentConfigId: string;
let upstreamCode: string;
let inviterCode: string;
let foreignCode: string;

const principal = (accountId: string, selectedTenant = tenantA): CustomerPrincipal => ({
  accountId,
  deviceId: uuidV7(),
  sessionId: uuidV7(),
  tenantId: selectedTenant,
  username: `referral_${accountId.slice(-4)}`,
});

describe('direct referral commissions', () => {
  beforeAll(async () => {
    process.env.FAKE_PAYMENT_WEBHOOK_SECRET =
      'referral-test-secret-with-at-least-thirty-two-characters';
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
        ('${tenantA}', 'referral-a', 'Referral A', transaction_timestamp() + interval '1 year'),
        ('${tenantB}', 'referral-b', 'Referral B', transaction_timestamp() + interval '1 year');
      insert into tenant_staff (id, tenant_id, username, password_hash)
      values ('${tenantStaff}', '${tenantA}', 'referral-owner', '${'t'.repeat(64)}');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaff}', 'referral-platform', '${'p'.repeat(64)}');
      insert into customer_accounts (id, tenant_id, username, password_hash) values
        ('${upstream}', '${tenantA}', 'referral_upstream', '${'a'.repeat(64)}'),
        ('${inviter}', '${tenantA}', 'referral_inviter', '${'b'.repeat(64)}'),
        ('${buyer}', '${tenantA}', 'referral_buyer', '${'c'.repeat(64)}'),
        ('${lateInvitee}', '${tenantA}', 'referral_late', '${'d'.repeat(64)}'),
        ('${foreignCustomer}', '${tenantB}', 'referral_foreign', '${'e'.repeat(64)}');
    `);
    const databaseService = testDatabaseService(database);
    referrals = new ReferralService(databaseService);
    settlements = new ReferralSettlementWorkerService(databaseService);
    const fake = new FakePaymentAdapter();
    payments = new PaymentCoreService(
      databaseService,
      new PaymentAdapterRegistry(fake),
      referrals,
    );
    const configurations = new PaymentConfigurationService(databaseService);
    const config = await configurations.createPlatformFakeConfig(
      { label: 'Referral fake payment' },
      platformStaff,
      uuidV7(),
    );
    paymentConfigId = config.id;
    await configurations.setTenantRouting(
      tenantA,
      paymentConfigId,
      'platform_collect',
      tenantStaff,
      uuidV7(),
    );
  }, 30_000);

  afterAll(async () => {
    delete process.env.FAKE_PAYMENT_WEBHOOK_SECRET;
    await database?.close();
  });

  it('defaults disabled, manages a versioned eligible-product configuration', async () => {
    await expect(referrals.getTenantConfig(tenantA)).resolves.toEqual({
      applicableOrderTypes: [],
      commissionBps: 0,
      enabled: false,
      settlementDays: 7,
      version: 0,
    });
    await expect(referrals.upsertTenantConfig(
      tenantA,
      tenantStaff,
      {
        applicableOrderTypes: ['membership'],
        commissionBps: 333,
        enabled: true,
        settlementDays: 0,
        version: 0,
      },
      uuidV7(),
    )).resolves.toMatchObject({
      commissionBps: 333,
      enabled: true,
      settlementDays: 0,
      version: 0,
    });
    await expect(referrals.upsertTenantConfig(
      tenantA,
      tenantStaff,
      {
        applicableOrderTypes: ['membership'],
        commissionBps: 100,
        enabled: true,
        settlementDays: 1,
        version: 9,
      },
      uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('creates one code per user and binds only once without self/cross-tenant binding', async () => {
    const upstreamResult = await referrals.createInviteCode(
      principal(upstream),
      'referral-code-upstream-001',
      uuidV7(),
    );
    await expect(referrals.createInviteCode(
      principal(upstream),
      'referral-code-upstream-001',
      uuidV7(),
    )).resolves.toEqual(upstreamResult);
    upstreamCode = upstreamResult.code;
    inviterCode = (await referrals.createInviteCode(
      principal(inviter),
      'referral-code-inviter-0001',
      uuidV7(),
    )).code;
    foreignCode = (await referrals.createInviteCode(
      principal(foreignCustomer, tenantB),
      'referral-code-foreign-0001',
      uuidV7(),
    )).code;

    await expect(referrals.bindReferral(
      principal(upstream),
      { code: upstreamCode },
      'referral-self-bind-000001',
      uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(referrals.bindReferral(
      principal(buyer),
      { code: foreignCode },
      'referral-cross-bind-00001',
      uuidV7(),
    )).rejects.toBeInstanceOf(NotFoundException);

    await referrals.bindReferral(
      principal(inviter),
      { code: upstreamCode },
      'referral-bind-level-one',
      uuidV7(),
    );
    const bound = await referrals.bindReferral(
      principal(buyer),
      { code: inviterCode },
      'referral-bind-buyer-0001',
      uuidV7(),
    );
    await expect(referrals.bindReferral(
      principal(buyer),
      { code: inviterCode },
      'referral-bind-buyer-0002',
      uuidV7(),
    )).resolves.toEqual(bound);
    await expect(referrals.bindReferral(
      principal(buyer),
      { code: upstreamCode },
      'referral-rebind-buyer-01',
      uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('uses the paid order snapshot, rounds down, and credits only the direct inviter once', async () => {
    const order = await insertMembershipOrder(buyer, 1001);
    const payment = await payOrder(principal(buyer), order.id, 'referral-charge-main-0001');
    await expect(payments.handleWebhook(
      paymentConfigId,
      payment.raw,
      payment.signature,
    )).resolves.toEqual({ duplicate: true, status: 'processed' });

    const facts = await database.query<{
      commission_bps_snapshot: number;
      commission_minor: string;
      invitee_account_id: string;
      inviter_account_id: string;
      order_total_minor_snapshot: string;
      status: string;
    }>(`
      select commission_bps_snapshot, commission_minor::text,
        invitee_account_id, inviter_account_id,
        order_total_minor_snapshot::text, status
      from referral_commissions where order_id = '${order.id}'
    `);
    expect(facts.rows).toEqual([expect.objectContaining({
      commission_bps_snapshot: 333,
      commission_minor: '33',
      invitee_account_id: buyer,
      inviter_account_id: inviter,
      order_total_minor_snapshot: '1001',
      status: 'pending',
    })]);
    const accounts = await database.query<{
      account_id: string;
      pending_minor: string;
    }>(`
      select account_id, pending_minor::text from referral_commission_accounts
      where tenant_id = '${tenantA}'
    `);
    expect(accounts.rows).toEqual([{ account_id: inviter, pending_minor: '33' }]);
    const upstreamFacts = await database.query<{ count: string }>(`
      select count(*)::text as count from referral_commissions
      where inviter_account_id = '${upstream}'
    `);
    expect(upstreamFacts.rows[0]?.count).toBe('0');
  });

  it('does not create a false balance for a zero rounded commission', async () => {
    const order = await insertMembershipOrder(buyer, 1);
    await payOrder(principal(buyer), order.id, 'referral-charge-zero-0001');
    const result = await database.query<{ count: string }>(`
      select count(*)::text as count from referral_commissions
      where order_id = '${order.id}'
    `);
    expect(result.rows[0]?.count).toBe('0');
  });

  it('settles due payable commission with balanced immutable bucket entries', async () => {
    await expect(settlements.settleDue(100)).resolves.toEqual({ settled: 1 });
    await expect(settlements.settleDue(100)).resolves.toEqual({ settled: 0 });
    const accounts = await database.query<{
      available_minor: string;
      pending_minor: string;
      withdrawn_minor: string;
    }>(`
      select pending_minor::text, available_minor::text, withdrawn_minor::text
      from referral_commission_accounts
      where tenant_id = '${tenantA}' and account_id = '${inviter}' and currency = 'USD'
    `);
    expect(accounts.rows[0]).toEqual({
      available_minor: '33',
      pending_minor: '0',
      withdrawn_minor: '0',
    });
    const ledger = await database.query<{ entry_type: string }>(`
      select entry_type from referral_commission_ledger
      order by created_at, entry_type
    `);
    expect(ledger.rows.map((row) => row.entry_type).sort()).toEqual([
      'commission_pending',
      'settlement_available_credit',
      'settlement_pending_debit',
    ]);
  });

  it('rejects referral binding after the first paid order even when it earned no commission', async () => {
    const order = await insertMembershipOrder(lateInvitee, 500);
    await payOrder(principal(lateInvitee), order.id, 'referral-charge-late-0001');
    await expect(referrals.bindReferral(
      principal(lateInvitee),
      { code: inviterCode },
      'referral-bind-after-pay01',
      uuidV7(),
    )).rejects.toBeInstanceOf(Error);
    const relationships = await database.query<{ count: string }>(`
      select count(*)::text as count from customer_referrals
      where tenant_id = '${tenantA}' and invitee_account_id = '${lateInvitee}'
    `);
    expect(relationships.rows[0]?.count).toBe('0');
  });

  it('keeps tenant database access read-only for invitation and commission facts', async () => {
    const policies = await database.query<{ cmd: string; tablename: string }>(`
      select tablename, cmd from pg_policies
      where schemaname = 'public'
        and tablename in (
          'customer_referral_codes', 'customer_referrals',
          'referral_commission_accounts', 'referral_commissions',
          'referral_commission_ledger'
        )
        and policyname like '%tenant%'
      order by tablename
    `);
    expect(policies.rows).toHaveLength(5);
    expect(policies.rows.every((row) => row.cmd === 'SELECT')).toBe(true);
    await expect(database.exec(`
      update referral_commission_accounts set available_minor = 999
      where tenant_id = '${tenantA}' and account_id = '${inviter}'
    `)).rejects.toThrow(/only change through their immutable ledger/i);
    await expect(database.exec(`
      delete from tenant_referral_configs where tenant_id = '${tenantA}'
    `)).rejects.toThrow(/append-only/i);
  });
});

async function insertMembershipOrder(accountId: string, totalMinor: number) {
  const id = uuidV7();
  const itemId = uuidV7();
  const productId = uuidV7();
  await database.exec(`
    insert into orders (
      id, tenant_id, account_id, order_no, order_type, currency,
      subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
    ) values (
      '${id}', '${tenantA}', '${accountId}', 'ORD${compactId()}', 'membership', 'USD',
      ${totalMinor}, ${totalMinor}, 'en-US', '{"username":"referral"}'::jsonb,
      transaction_timestamp() + interval '30 minutes'
    );
    insert into order_items (
      id, tenant_id, order_id, line_no, item_type, product_id,
      currency, unit_amount_minor, total_amount_minor, product_snapshot_json
    ) values (
      '${itemId}', '${tenantA}', '${id}', 1, 'membership', '${productId}',
      'USD', ${totalMinor}, ${totalMinor}, '{"durationDays":30}'::jsonb
    );
  `);
  return { id };
}

async function payOrder(
  selectedPrincipal: CustomerPrincipal,
  orderId: string,
  externalTransactionId: string,
) {
  const attempt = await payments.createPayment(
    selectedPrincipal,
    orderId,
    {},
    `payment-${externalTransactionId}`,
    uuidV7(),
  );
  const raw = Buffer.from(JSON.stringify({
    amountMinor: attempt.amountMinor,
    attemptReference: attempt.id,
    currency: attempt.currency,
    eventId: `event-${externalTransactionId}`,
    eventType: 'payment.succeeded',
    externalPaymentId: attempt.externalPaymentId,
    externalTransactionId,
    occurredAt: new Date().toISOString(),
  }));
  const signature = signFakePaymentWebhook(raw);
  await expect(payments.handleWebhook(paymentConfigId, raw, signature)).resolves.toEqual({
    duplicate: false,
    status: 'processed',
  });
  return { raw, signature };
}

function compactId(): string {
  return uuidV7().replaceAll('-', '').slice(0, 26).toUpperCase();
}

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

function testDatabaseService(instance: PGlite): DatabaseService {
  return {
    inPlatformContext: <T>(
      callback: (transaction: DatabaseTransaction) => Promise<T>,
    ): Promise<T> => instance.transaction((transaction) => callback(transactionTag(transaction))),
    inTenantContext: <T>(
      selectedTenant: string,
      callback: (transaction: DatabaseTransaction) => Promise<T>,
    ): Promise<T> => instance.transaction(async (transaction) => {
      await transaction.query(
        "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
        [selectedTenant],
      );
      return callback(transactionTag(transaction));
    }),
  } as unknown as DatabaseService;
}
