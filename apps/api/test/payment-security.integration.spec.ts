import { PGlite, type Transaction } from '@electric-sql/pglite';
import { NotFoundException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import type {
  AdapterPaymentResult,
  CreateAdapterPaymentInput,
  PaymentAdapter,
} from '../src/commerce/payment-adapter';
import {
  FakePaymentAdapter,
  PaymentAdapterRegistry,
  signFakePaymentWebhook,
} from '../src/commerce/payment-adapter';
import { PaymentConfigurationService } from '../src/commerce/payment-configuration.service';
import { PaymentCoreService } from '../src/commerce/payment-core.service';
import type { CustomerPrincipal } from '../src/customer-auth/customer-auth.types';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';

let database: PGlite;
let baseDatabase: InstrumentedDatabase;
let payments: PaymentCoreService;
let platformConfigId: string;
let secondPlatformConfigId: string;
let providerId: string;

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773579101';
const customerA = '018f2f45-7f5e-7e70-b17f-f6e773579102';
const customerB = '018f2f45-7f5e-7e70-b17f-f6e773579103';
const platformStaffId = '018f2f45-7f5e-7e70-b17f-f6e773579104';
const tenantStaffId = '018f2f45-7f5e-7e70-b17f-f6e773579105';
const originalSecret = process.env.FAKE_PAYMENT_WEBHOOK_SECRET;

const principalA: CustomerPrincipal = {
  accountId: customerA,
  deviceId: '018f2f45-7f5e-7e70-b17f-f6e773579106',
  sessionId: '018f2f45-7f5e-7e70-b17f-f6e773579107',
  tenantId,
  username: 'payment_security_a',
};
const principalB: CustomerPrincipal = {
  accountId: customerB,
  deviceId: '018f2f45-7f5e-7e70-b17f-f6e773579108',
  sessionId: '018f2f45-7f5e-7e70-b17f-f6e773579109',
  tenantId,
  username: 'payment_security_b',
};

interface InstrumentedDatabase {
  activeContexts: number;
  service: DatabaseService;
}

describe('payment security acceptance', () => {
  beforeAll(async () => {
    process.env.FAKE_PAYMENT_WEBHOOK_SECRET =
      'payment-security-integration-secret-at-least-thirty-two-characters';
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
      insert into tenants (id, code, name, expires_at)
      values ('${tenantId}', 'payment-security', 'Payment Security', statement_timestamp() + interval '1 year');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaffId}', 'payment-security-platform', '${'p'.repeat(64)}');
      insert into tenant_staff (id, tenant_id, username, password_hash)
      values ('${tenantStaffId}', '${tenantId}', 'payment-security-owner', '${'p'.repeat(64)}');
      insert into customer_accounts (
        id, tenant_id, username, email, email_verified_at, password_hash
      ) values
        ('${customerA}', '${tenantId}', 'payment_security_a', 'pay-a@example.com',
          statement_timestamp(), '${'a'.repeat(64)}'),
        ('${customerB}', '${tenantId}', 'payment_security_b', 'pay-b@example.com',
          statement_timestamp(), '${'b'.repeat(64)}');
    `);
    baseDatabase = makeDatabase();
    const fake = new FakePaymentAdapter();
    const configurations = new PaymentConfigurationService(baseDatabase.service);
    payments = new PaymentCoreService(
      baseDatabase.service,
      new PaymentAdapterRegistry(fake),
    );
    platformConfigId = (await configurations.createPlatformFakeConfig(
      { label: 'Payment security platform config' },
      platformStaffId,
      uuidV7(),
    )).id;
    secondPlatformConfigId = (await configurations.createPlatformFakeConfig(
      { label: 'Payment security second platform config' },
      platformStaffId,
      uuidV7(),
    )).id;
    await configurations.setTenantRouting(
      tenantId,
      platformConfigId,
      'platform_collect',
      tenantStaffId,
      uuidV7(),
    );
    const provider = await database.query<{ provider_id: string }>(`
      select provider_id from payment_configs where id = '${platformConfigId}'
    `);
    providerId = provider.rows[0]?.provider_id as string;
  }, 30_000);

  afterAll(async () => {
    if (originalSecret === undefined) delete process.env.FAKE_PAYMENT_WEBHOOK_SECRET;
    else process.env.FAKE_PAYMENT_WEBHOOK_SECRET = originalSecret;
    await database?.close();
  });

  it('keeps payment detail, order lookup, and idempotency isolated by account', async () => {
    const order = await insertOrder('membership', 800, { durationDays: 30 });
    const attempt = await payments.createPayment(
      principalA,
      order.id,
      {},
      'security-account-key-0001',
      uuidV7(),
    );
    await expect(payments.getPayment(principalB, attempt.id))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(payments.createPayment(
      principalB,
      order.id,
      {},
      'security-account-key-0001',
      uuidV7(),
    )).rejects.toBeInstanceOf(NotFoundException);

    const commands = await database.query<{ count: string }>(`
      select count(*)::text as count from command_idempotency
      where tenant_id = '${tenantId}'
        and actor_id = '${customerB}'
        and idempotency_key = 'security-account-key-0001'
    `);
    expect(commands.rows[0]?.count).toBe('0');
  });

  it('requires the exact config and provider snapshot before accepting a callback', async () => {
    const order = await insertOrder('membership', 825, { durationDays: 30 });
    const attempt = await payments.createPayment(
      principalA,
      order.id,
      {},
      'security-config-key-0001',
      uuidV7(),
    );
    const event = signedEvent(attempt, 'evt_wrong_config', 'payment.succeeded');
    await expect(payments.handleWebhook(
      secondPlatformConfigId,
      event.raw,
      event.signature,
    )).rejects.toBeInstanceOf(NotFoundException);
    const state = await database.query<{ status: string; transactions: string }>(`
      select status,
        (select count(*)::text from payment_transactions where attempt_id = payment_attempts.id)
          as transactions
      from payment_attempts where id = '${attempt.id}'
    `);
    expect(state.rows[0]).toEqual({ status: 'pending', transactions: '0' });
  });

  it('binds the signed attempt reference to the resolved external payment', async () => {
    const mismatchOrder = await insertOrder('episode', 450, { title: 'Bound episode' });
    const mismatchAttempt = await payments.createPayment(
      principalA,
      mismatchOrder.id,
      {},
      'security-binding-key-0001',
      uuidV7(),
    );
    const wrongReference = signedEvent(mismatchAttempt, 'evt_wrong_reference', 'payment.succeeded', {
      attemptReference: uuidV7(),
      externalTransactionId: 'charge_wrong_reference',
    });
    await expect(payments.handleWebhook(
      platformConfigId,
      wrongReference.raw,
      wrongReference.signature,
    )).resolves.toEqual({ duplicate: false, status: 'rejected' });
    const mismatchState = await database.query<{ status: string; transactions: string }>(`
      select status,
        (select count(*)::text from payment_transactions where attempt_id = payment_attempts.id)
          as transactions
      from payment_attempts where id = '${mismatchAttempt.id}'
    `);
    expect(mismatchState.rows[0]).toEqual({ status: 'pending', transactions: '0' });
  });

  it('rejects amount and currency mismatches before transaction or fulfillment', async () => {
    for (const [suffix, overrides] of [
      ['amount', { amountMinor: 451 }],
      ['currency', { currency: 'EUR' }],
    ] as const) {
      const order = await insertOrder('episode', 450, { title: `Mismatch ${suffix}` });
      const attempt = await payments.createPayment(
        principalA,
        order.id,
        {},
        `security-snapshot-${suffix}-key`,
        uuidV7(),
      );
      const event = signedEvent(
        attempt,
        `evt_snapshot_${suffix}`,
        'payment.succeeded',
        { ...overrides, externalTransactionId: `charge_snapshot_${suffix}` },
      );
      await expect(payments.handleWebhook(platformConfigId, event.raw, event.signature))
        .resolves.toEqual({ duplicate: false, status: 'rejected' });
      const state = await database.query<{
        entitlements: string;
        status: string;
        transactions: string;
      }>(`
        select attempt.status,
          (select count(*)::text from payment_transactions where attempt_id = attempt.id)
            as transactions,
          (select count(*)::text from entitlements where source_order_id = attempt.order_id)
            as entitlements
        from payment_attempts as attempt where attempt.id = '${attempt.id}'
      `);
      expect(state.rows[0]).toEqual({
        entitlements: '0',
        status: 'failed',
        transactions: '0',
      });
    }
  });

  it('rejects a signed event older than its order without expiring the live order', async () => {
    const order = await insertOrder('episode', 475, { title: 'Fresh order' });
    const attempt = await payments.createPayment(
      principalA,
      order.id,
      {},
      'security-stale-key-0001',
      uuidV7(),
    );
    const stale = signedEvent(attempt, 'evt_stale_event', 'payment.succeeded', {
      externalTransactionId: 'charge_stale_event',
      occurredAt: new Date(Date.now() - 60 * 60 * 1_000).toISOString(),
    });
    await expect(payments.handleWebhook(platformConfigId, stale.raw, stale.signature))
      .resolves.toEqual({ duplicate: false, status: 'rejected' });
    const state = await database.query<{
      attempt_status: string;
      inbox_status: string;
      order_status: string;
      transactions: string;
    }>(`
      select attempt.status as attempt_status, commerce_order.status as order_status,
        (select count(*)::text from payment_transactions where attempt_id = attempt.id)
          as transactions,
        (select status from payment_webhook_inbox where external_event_id = 'evt_stale_event')
          as inbox_status
      from payment_attempts as attempt
      inner join orders as commerce_order on commerce_order.id = attempt.order_id
      where attempt.id = '${attempt.id}'
    `);
    expect(state.rows[0]).toEqual({
      attempt_status: 'pending',
      inbox_status: 'rejected',
      order_status: 'pending_payment',
      transactions: '0',
    });
  });

  it('rejects failed-to-success reordering without a success transaction or entitlement', async () => {

    const failedOrder = await insertOrder('drama', 650, { title: 'Late success drama' });
    const failedAttempt = await payments.createPayment(
      principalA,
      failedOrder.id,
      {},
      'security-late-key-0001',
      uuidV7(),
    );
    const failed = signedEvent(failedAttempt, 'evt_failed_first', 'payment.failed', {
      externalTransactionId: 'charge_failed_first',
    });
    await expect(payments.handleWebhook(platformConfigId, failed.raw, failed.signature))
      .resolves.toEqual({ duplicate: false, status: 'processed' });
    const late = signedEvent(failedAttempt, 'evt_late_success', 'payment.succeeded', {
      externalTransactionId: 'charge_late_success',
    });
    await expect(payments.handleWebhook(platformConfigId, late.raw, late.signature))
      .resolves.toEqual({ duplicate: false, status: 'rejected' });
    const lateState = await database.query<{
      entitlements: string;
      failed_transactions: string;
      status: string;
      succeeded_transactions: string;
    }>(`
      select attempt.status,
        (select count(*)::text from payment_transactions where attempt_id = attempt.id and status = 'failed')
          as failed_transactions,
        (select count(*)::text from payment_transactions where attempt_id = attempt.id and status = 'succeeded')
          as succeeded_transactions,
        (select count(*)::text from entitlements where source_order_id = attempt.order_id)
          as entitlements
      from payment_attempts as attempt where attempt.id = '${failedAttempt.id}'
    `);
    expect(lateState.rows[0]).toEqual({
      entitlements: '0',
      failed_transactions: '1',
      status: 'failed',
      succeeded_transactions: '0',
    });
  });

  it('requires a succeeded charge before attempt success and a succeeded attempt before order paid', async () => {
    const order = await insertOrder('membership', 775, { durationDays: 14 });
    const attempt = await payments.createPayment(
      principalA,
      order.id,
      {},
      'security-db-chain-key-0001',
      uuidV7(),
    );
    await expect(database.exec(`
      update payment_attempts
      set status = 'succeeded', succeeded_at = statement_timestamp(), version = version + 1
      where id = '${attempt.id}'
    `)).rejects.toThrow(/matching succeeded charge transaction/i);
    await expect(database.exec(`
      update orders
      set status = 'paid', paid_at = statement_timestamp(), version = version + 1
      where id = '${order.id}'
    `)).rejects.toThrow(/matching succeeded payment attempt/i);
  });

  it('keeps one event id idempotent and blocks one provider transaction across attempts', async () => {
    const firstOrder = await insertOrder('membership', 900, { durationDays: 7 });
    const firstAttempt = await payments.createPayment(
      principalA,
      firstOrder.id,
      {},
      'security-external-key-0001',
      uuidV7(),
    );
    const first = signedEvent(firstAttempt, 'evt_shared_transaction_1', 'payment.succeeded', {
      externalTransactionId: 'charge_shared_security',
    });
    await payments.handleWebhook(platformConfigId, first.raw, first.signature);
    await expect(payments.handleWebhook(platformConfigId, first.raw, first.signature))
      .resolves.toEqual({ duplicate: true, status: 'processed' });

    const changed = signedEvent(firstAttempt, 'evt_shared_transaction_1', 'payment.succeeded', {
      externalTransactionId: 'charge_changed_payload',
    });
    await expect(payments.handleWebhook(platformConfigId, changed.raw, changed.signature))
      .resolves.toEqual({ duplicate: true, status: 'rejected' });
    const reuseAlert = await database.query<{ count: string }>(`
      select count(*)::text as count from audit_logs
      where action = 'commerce.payment.webhook.event_reuse'
        and resource_id = '${platformConfigId}'
    `);
    expect(reuseAlert.rows[0]?.count).toBe('1');

    const secondOrder = await insertOrder('membership', 900, { durationDays: 7 });
    const secondAttempt = await payments.createPayment(
      principalA,
      secondOrder.id,
      {},
      'security-external-key-0002',
      uuidV7(),
    );
    const collision = signedEvent(secondAttempt, 'evt_shared_transaction_2', 'payment.succeeded', {
      externalTransactionId: 'charge_shared_security',
    });
    await expect(payments.handleWebhook(
      platformConfigId,
      collision.raw,
      collision.signature,
    )).resolves.toEqual({ duplicate: false, status: 'rejected' });
    const secondState = await database.query<{
      entitlements: string;
      status: string;
      transactions: string;
    }>(`
      select attempt.status,
        (select count(*)::text from payment_transactions where attempt_id = attempt.id)
          as transactions,
        (select count(*)::text from entitlements where source_order_id = attempt.order_id)
          as entitlements
      from payment_attempts as attempt where attempt.id = '${secondAttempt.id}'
    `);
    expect(secondState.rows[0]).toEqual({
      entitlements: '0',
      status: 'pending',
      transactions: '0',
    });
  });

  it('never grants points unless the order atomically reaches paid at the expiry boundary', async () => {
    const order = await insertOrder(
      'points_topup',
      500,
      { bonusPoints: 5, pointsAmount: 100 },
      "statement_timestamp() + interval '50 milliseconds'",
    );
    const attemptId = uuidV7();
    const externalPaymentId = `fake_pay_${attemptId.replaceAll('-', '')}`;
    await database.exec(`
      insert into payment_attempts (
        id, tenant_id, account_id, order_id, provider_id, payment_config_id,
        adapter_code_snapshot, collection_mode, status, currency, amount_minor,
        external_payment_id, checkout_reference, idempotency_key
      ) values (
        '${attemptId}', '${tenantId}', '${customerA}', '${order.id}', '${providerId}',
        '${platformConfigId}', 'fake', 'platform_collect', 'pending', 'USD', 500,
        '${externalPaymentId}', 'fake_checkout_expiry_boundary', 'security-expiry-key-0001'
      )
    `);
    const delayedDatabase = makeDatabase(async (sql) => {
      if (sql.includes('insert into payment_transactions')) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      }
    });
    const delayedPayments = new PaymentCoreService(
      delayedDatabase.service,
      new PaymentAdapterRegistry(new FakePaymentAdapter()),
    );
    const event = signedEvent({
      amountMinor: 500,
      currency: 'USD',
      externalPaymentId,
      id: attemptId,
    }, 'evt_expiry_boundary', 'payment.succeeded', {
      externalTransactionId: 'charge_expiry_boundary',
    });
    await delayedPayments.handleWebhook(platformConfigId, event.raw, event.signature)
      .catch(() => undefined);

    const state = await database.query<{
      attempt_status: string;
      order_status: string;
      points: string;
      transactions: string;
    }>(`
      select attempt.status as attempt_status, commerce_order.status as order_status,
        (select coalesce(sum(delta), 0)::text from point_ledger
          where reference_type = 'payment_transaction'
            and reference_id in (select id from payment_transactions where attempt_id = attempt.id))
          as points,
        (select count(*)::text from payment_transactions where attempt_id = attempt.id)
          as transactions
      from payment_attempts as attempt
      inner join orders as commerce_order on commerce_order.id = attempt.order_id
      where attempt.id = '${attemptId}'
    `);
    if (state.rows[0]?.points !== '0') {
      expect(state.rows[0]).toMatchObject({
        attempt_status: 'succeeded',
        order_status: 'paid',
        transactions: '1',
      });
    } else {
      expect(state.rows[0]?.order_status).not.toBe('paid');
      expect(state.rows[0]?.transactions).toBe('0');
    }
  });

  it('calls the adapter outside SQL transactions with one stable provider key under retries', async () => {
    const order = await insertOrder('membership', 1_100, { durationDays: 30 });
    const calls: Array<{ activeContexts: number; input: CreateAdapterPaymentInput }> = [];
    let release!: () => void;
    const bothCalls = new Promise<void>((resolveBoth) => {
      release = resolveBoth;
    });
    const adapter: PaymentAdapter = {
      code: 'fake',
      refundPayment: async () => { throw new Error('not used by this payment test'); },
      async createPayment(input): Promise<AdapterPaymentResult> {
        calls.push({ activeContexts: baseDatabase.activeContexts, input });
        if (calls.length === 2) release();
        await bothCalls;
        return {
          checkoutReference: `retry_checkout_${input.attemptId}`,
          externalPaymentId: `fake_pay_${input.attemptId.replaceAll('-', '')}`,
          status: 'pending',
        };
      },
      verifyWebhook: new FakePaymentAdapter().verifyWebhook.bind(new FakePaymentAdapter()),
    };
    const concurrentPayments = new PaymentCoreService(
      baseDatabase.service,
      { require: () => adapter } as unknown as PaymentAdapterRegistry,
    );
    const results = await Promise.all([
      concurrentPayments.createPayment(
        principalA,
        order.id,
        {},
        'security-concurrent-key-0001',
        uuidV7(),
      ),
      concurrentPayments.createPayment(
        principalA,
        order.id,
        {},
        'security-concurrent-key-0001',
        uuidV7(),
      ),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.activeContexts === 0)).toBe(true);
    expect(new Set(calls.map((call) => call.input.attemptId)).size).toBe(1);
    expect(calls[0]?.input.providerIdempotencyKey).toBe(calls[0]?.input.attemptId);
    expect(calls[1]?.input.providerIdempotencyKey).toBe(calls[0]?.input.attemptId);
  });

  it('keeps ambiguous adapter failure resumable when a concurrent retry succeeds', async () => {
    const order = await insertOrder('membership', 1_200, { durationDays: 30 });
    let callCount = 0;
    let release!: () => void;
    const bothCalls = new Promise<void>((resolveBoth) => {
      release = resolveBoth;
    });
    const adapter: PaymentAdapter = {
      code: 'fake',
      refundPayment: async () => { throw new Error('not used by this payment test'); },
      async createPayment(input): Promise<AdapterPaymentResult> {
        callCount += 1;
        const call = callCount;
        if (callCount === 2) release();
        await bothCalls;
        if (call === 1) throw new Error('simulated provider timeout after acceptance');
        return {
          checkoutReference: `ambiguous_checkout_${input.attemptId}`,
          externalPaymentId: `fake_pay_${input.attemptId.replaceAll('-', '')}`,
          status: 'pending',
        };
      },
      verifyWebhook: new FakePaymentAdapter().verifyWebhook.bind(new FakePaymentAdapter()),
    };
    const concurrentPayments = new PaymentCoreService(
      baseDatabase.service,
      { require: () => adapter } as unknown as PaymentAdapterRegistry,
    );
    const settled = await Promise.allSettled([
      concurrentPayments.createPayment(
        principalA,
        order.id,
        {},
        'security-ambiguous-key-0001',
        uuidV7(),
      ),
      concurrentPayments.createPayment(
        principalA,
        order.id,
        {},
        'security-ambiguous-key-0001',
        uuidV7(),
      ),
    ]);
    expect(settled.some((result) => result.status === 'fulfilled')).toBe(true);
    const state = await database.query<{ status: string }>(`
      select status from payment_attempts where order_id = '${order.id}'
    `);
    expect(state.rows[0]?.status).toBe('pending');
  });
});

function makeDatabase(
  beforeQuery?: (sql: string) => Promise<void>,
): InstrumentedDatabase {
  const instrumented: InstrumentedDatabase = {
    activeContexts: 0,
    service: undefined as unknown as DatabaseService,
  };
  const context = <T>(
    tenant: string | undefined,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> => database.transaction(async (transaction) => {
    if (tenant) {
      await transaction.query(
        "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
        [tenant],
      );
    }
    instrumented.activeContexts += 1;
    try {
      return await callback(transactionTag(transaction, beforeQuery));
    } finally {
      instrumented.activeContexts -= 1;
    }
  });
  instrumented.service = {
    inPlatformContext: <T>(
      callback: (transaction: DatabaseTransaction) => Promise<T>,
    ) => context(undefined, callback),
    inTenantContext: <T>(
      selectedTenant: string,
      callback: (transaction: DatabaseTransaction) => Promise<T>,
    ) => context(selectedTenant, callback),
  } as unknown as DatabaseService;
  return instrumented;
}

function transactionTag(
  transaction: Transaction,
  beforeQuery?: (sql: string) => Promise<void>,
): DatabaseTransaction {
  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    await beforeQuery?.(sql);
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}

async function insertOrder(
  type: 'drama' | 'episode' | 'membership' | 'points_topup',
  amountMinor: number,
  snapshot: Record<string, unknown>,
  expiresSql = "statement_timestamp() + interval '30 minutes'",
) {
  const id = uuidV7();
  const itemId = uuidV7();
  const productId = uuidV7();
  const orderNo = `ORD${id.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
  await database.exec(`
    insert into orders (
      id, tenant_id, account_id, order_no, order_type, currency,
      subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
    ) values (
      '${id}', '${tenantId}', '${customerA}', '${orderNo}', '${type}', 'USD',
      ${amountMinor}, ${amountMinor}, 'en-US', '{"username":"payment_security_a"}'::jsonb,
      ${expiresSql}
    );
    insert into order_items (
      id, tenant_id, order_id, line_no, item_type, product_id, currency,
      unit_amount_minor, total_amount_minor, product_snapshot_json
    ) values (
      '${itemId}', '${tenantId}', '${id}', 1, '${type}', '${productId}', 'USD',
      ${amountMinor}, ${amountMinor}, '${JSON.stringify(snapshot).replaceAll("'", "''")}'::jsonb
    )
  `);
  return { id };
}

function signedEvent(
  attempt: {
    amountMinor: number;
    currency: string;
    externalPaymentId: string;
    id: string;
  },
  eventId: string,
  eventType: 'payment.failed' | 'payment.succeeded',
  overrides: Partial<Record<string, unknown>> = {},
) {
  const raw = Buffer.from(JSON.stringify({
    amountMinor: attempt.amountMinor,
    attemptReference: attempt.id,
    currency: attempt.currency,
    eventId,
    eventType,
    externalPaymentId: attempt.externalPaymentId,
    externalTransactionId: `charge_${eventId}`,
    occurredAt: new Date().toISOString(),
    ...overrides,
  }));
  return { raw, signature: signFakePaymentWebhook(raw) };
}
