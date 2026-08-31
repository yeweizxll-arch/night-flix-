import { PGlite, type Transaction } from '@electric-sql/pglite';
import { BadRequestException, ConflictException, UnauthorizedException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import {
  FakePaymentAdapter,
  PaymentAdapterDefinitiveError,
  PaymentAdapterRegistry,
  signFakePaymentWebhook,
} from '../src/commerce/payment-adapter';
import { PaymentConfigurationService } from '../src/commerce/payment-configuration.service';
import { PaymentCoreService } from '../src/commerce/payment-core.service';
import { RefundService } from '../src/commerce/refund.service';
import type { CustomerPrincipal } from '../src/customer-auth/customer-auth.types';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';

let database: PGlite;
let configurations: PaymentConfigurationService;
let payments: PaymentCoreService;
let refunds: RefundService;
let databaseService: DatabaseService;
let platformConfigId: string;

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773575101';
const customerId = '018f2f45-7f5e-7e70-b17f-f6e773575102';
const platformStaffId = '018f2f45-7f5e-7e70-b17f-f6e773575103';
const tenantStaffId = '018f2f45-7f5e-7e70-b17f-f6e773575104';

const principal: CustomerPrincipal = {
  accountId: customerId,
  deviceId: '018f2f45-7f5e-7e70-b17f-f6e773575105',
  sessionId: '018f2f45-7f5e-7e70-b17f-f6e773575106',
  tenantId,
  username: 'payment_customer',
};

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

describe('payment core', () => {
  beforeAll(async () => {
    process.env.FAKE_PAYMENT_WEBHOOK_SECRET = 'payment-test-secret-with-at-least-thirty-two-characters';
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
      values ('${tenantId}', 'payment-tenant', 'Payment Tenant', statement_timestamp() + interval '1 year');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaffId}', 'payment-platform', '${'p'.repeat(64)}');
      insert into tenant_staff (id, tenant_id, username, password_hash)
      values ('${tenantStaffId}', '${tenantId}', 'payment-owner', '${'p'.repeat(64)}');
      insert into customer_accounts (
        id, tenant_id, username, email, email_verified_at, password_hash
      ) values (
        '${customerId}', '${tenantId}', 'payment_customer', 'payment@example.com',
        statement_timestamp(), '${'x'.repeat(64)}'
      );
    `);
    databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        selectedTenant: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        await transaction.query(
          "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
          [selectedTenant],
        );
        return callback(transactionTag(transaction));
      }),
    } as unknown as DatabaseService;
    const fake = new FakePaymentAdapter();
    const adapters = new PaymentAdapterRegistry(fake);
    configurations = new PaymentConfigurationService(databaseService);
    payments = new PaymentCoreService(databaseService, adapters);
    refunds = new RefundService(databaseService, adapters);
    const config = await configurations.createPlatformFakeConfig(
      { label: 'Platform local payment' },
      platformStaffId,
      uuidV7(),
    );
    platformConfigId = config.id;
    await configurations.setTenantRouting(
      tenantId,
      platformConfigId,
      'platform_collect',
      tenantStaffId,
      uuidV7(),
    );
  }, 30_000);

  afterAll(async () => {
    delete process.env.FAKE_PAYMENT_WEBHOOK_SECRET;
    await database?.close();
  });

  it('uses server amount, verifies exact raw bytes, and fulfills a platform-collected order once', async () => {
    const order = await insertOrder('membership', 1299, { durationDays: 30 });
    await expect(payments.createPayment(
      principal,
      order.id,
      { amountMinor: 1 },
      'platform-payment-key-0001',
      uuidV7(),
    )).rejects.toBeInstanceOf(BadRequestException);

    const attempt = await payments.createPayment(
      principal,
      order.id,
      {},
      'platform-payment-key-0001',
      uuidV7(),
    );
    expect(attempt).toMatchObject({
      amountMinor: 1299,
      collectionMode: 'platform_collect',
      currency: 'USD',
      orderId: order.id,
      status: 'pending',
    });
    await expect(payments.createPayment(
      principal,
      order.id,
      {},
      'platform-payment-key-0001',
      uuidV7(),
    )).resolves.toEqual(attempt);

    // Existing attempts remain callback-capable after a config is disabled.
    await database.exec(`
      update payment_configs set status = 'disabled', version = version + 1
      where id = '${platformConfigId}'
    `);

    const raw = Buffer.from(`{\n  "currency":"USD", "eventId":"evt_platform_1",\n  "externalPaymentId":"${attempt.externalPaymentId}", "attemptReference":"${attempt.id}",\n  "eventType":"payment.succeeded", "externalTransactionId":"charge_platform_1",\n  "amountMinor":1299, "occurredAt":"${new Date().toISOString()}"\n}`);
    const signature = signFakePaymentWebhook(raw);
    await expect(payments.handleWebhook(platformConfigId, raw, signature)).resolves.toEqual({
      duplicate: false,
      status: 'processed',
    });
    await expect(payments.handleWebhook(platformConfigId, raw, signature)).resolves.toEqual({
      duplicate: true,
      status: 'processed',
    });
    await database.exec(`
      update payment_configs set status = 'active', version = version + 1
      where id = '${platformConfigId}'
    `);
    const reordered = Buffer.from(JSON.stringify({
      amountMinor: 1299,
      attemptReference: attempt.id,
      currency: 'USD',
      eventId: 'evt_platform_1',
      eventType: 'payment.succeeded',
      externalPaymentId: attempt.externalPaymentId,
      externalTransactionId: 'charge_platform_1',
      occurredAt: JSON.parse(raw.toString()).occurredAt,
    }));
    await expect(payments.handleWebhook(
      platformConfigId,
      reordered,
      signature,
    )).rejects.toBeInstanceOf(UnauthorizedException);

    const state = await database.query<{
      balance: string;
      entitlements: string;
      ledgers: string;
      status: string;
      transactions: string;
    }>(`
      select
        commerce_order.status,
        (select count(*)::text from entitlements where source_order_id = commerce_order.id) as entitlements,
        (select count(*)::text from payment_transactions where order_id = commerce_order.id) as transactions,
        (select count(*)::text from merchant_balance_ledger where reference_type = 'payment_transaction') as ledgers,
        (select pending_minor::text from merchant_balance_accounts where tenant_id = '${tenantId}' and currency = 'USD') as balance
      from orders as commerce_order where commerce_order.id = '${order.id}'
    `);
    expect(state.rows[0]).toEqual({
      balance: '1299',
      entitlements: '1',
      ledgers: '1',
      status: 'paid',
      transactions: '1',
    });
    const backed = await database.query<{ balance_id: string; transaction_id: string }>(`
      select balance.id as balance_id, payment_transaction.id as transaction_id
      from merchant_balance_accounts as balance
      cross join payment_transactions as payment_transaction
      where balance.tenant_id = '${tenantId}' and balance.currency = 'USD'
        and payment_transaction.order_id = '${order.id}'
    `);
    await expect(database.exec(`
      insert into merchant_balance_ledger (
        id, tenant_id, balance_account_id, bucket, entry_type,
        delta_minor, balance_after_minor, currency, reference_type,
        reference_id, idempotency_key
      ) values (
        '${uuidV7()}', '${tenantId}', '${backed.rows[0]?.balance_id}', 'pending',
        'payment_pending', 1, 0, 'USD', 'payment_transaction',
        '${backed.rows[0]?.transaction_id}', 'forged-merchant-amount-0001'
      )
    `)).rejects.toThrow(/platform-collected charge/i);
  });

  it('fulfills points and content in direct mode without crediting platform settlement', async () => {
    const direct = await configurations.createTenantFakeConfig(
      tenantId,
      { label: 'Merchant local payment' },
      tenantStaffId,
      uuidV7(),
    );
    await configurations.setTenantRouting(
      tenantId,
      direct.id,
      'tenant_direct',
      tenantStaffId,
      uuidV7(),
    );
    const pointsOrder = await insertOrder('points_topup', 500, {
      bonusPoints: 25,
      pointsAmount: 500,
    });
    await paySuccessfully(direct.id, pointsOrder.id, 'direct-points-key-0001', 'points');
    const dramaOrder = await insertOrder('drama', 700, { title: 'Paid drama snapshot' });
    await paySuccessfully(direct.id, dramaOrder.id, 'direct-drama-key-0001', 'drama');

    const state = await database.query<{
      direct_ledger: string;
      drama_entitlement: string;
      points: string;
    }>(`
      select
        (select balance::text from point_accounts where tenant_id = '${tenantId}' and account_id = '${customerId}') as points,
        (select count(*)::text from entitlements where source_order_id = '${dramaOrder.id}') as drama_entitlement,
        (select count(*)::text from merchant_balance_ledger where reference_id in (
          select id from payment_transactions where order_id in ('${pointsOrder.id}', '${dramaOrder.id}')
        )) as direct_ledger
    `);
    expect(state.rows[0]).toEqual({
      direct_ledger: '0',
      drama_entitlement: '1',
      points: '525',
    });
    const directReferences = await database.query<{
      balance_id: string;
      point_account_id: string;
      transaction_id: string;
    }>(`
      select balance.id as balance_id, point_account.id as point_account_id,
        payment_transaction.id as transaction_id
      from merchant_balance_accounts as balance
      cross join point_accounts as point_account
      cross join payment_transactions as payment_transaction
      where balance.tenant_id = '${tenantId}' and balance.currency = 'USD'
        and point_account.tenant_id = '${tenantId}' and point_account.account_id = '${customerId}'
        and payment_transaction.order_id = '${dramaOrder.id}'
    `);
    await expect(database.exec(`
      insert into merchant_balance_ledger (
        id, tenant_id, balance_account_id, bucket, entry_type,
        delta_minor, balance_after_minor, currency, reference_type,
        reference_id, idempotency_key
      ) values (
        '${uuidV7()}', '${tenantId}', '${directReferences.rows[0]?.balance_id}', 'pending',
        'payment_pending', 700, 0, 'USD', 'payment_transaction',
        '${directReferences.rows[0]?.transaction_id}', 'forged-direct-merchant-0001'
      )
    `)).rejects.toThrow(/platform-collected charge/i);
    await expect(database.exec(`
      insert into point_ledger (
        id, tenant_id, account_id, point_account_id, entry_type, delta,
        balance_after, reference_type, reference_id, idempotency_key,
        created_by_type
      ) values (
        '${uuidV7()}', '${tenantId}', '${customerId}',
        '${directReferences.rows[0]?.point_account_id}', 'topup', 700, 0,
        'payment_transaction', '${directReferences.rows[0]?.transaction_id}',
        'forged-points-topup-0001', 'system'
      )
    `)).rejects.toThrow(/paid points order/i);
  });

  it('rejects late success without a transaction and never derives attempt IDs from provider IDs', async () => {
    await configurations.setTenantRouting(
      tenantId,
      platformConfigId,
      'platform_collect',
      tenantStaffId,
      uuidV7(),
    );
    const order = await insertOrder('episode', 399, { title: 'Expired episode' }, true);
    const provider = await database.query<{ provider_id: string }>(`
      select provider_id from payment_configs where id = '${platformConfigId}'
    `);
    const attemptId = uuidV7();
    const unrelatedProviderId = `fake_pay_${uuidV7().replaceAll('-', '')}`;
    await database.exec(`
      insert into payment_attempts (
        id, tenant_id, account_id, order_id, provider_id, payment_config_id,
        adapter_code_snapshot, collection_mode, status, currency, amount_minor,
        external_payment_id, checkout_reference, idempotency_key
      ) values (
        '${attemptId}', '${tenantId}', '${customerId}', '${order.id}',
        '${provider.rows[0]?.provider_id}', '${platformConfigId}', 'fake',
        'platform_collect', 'pending', 'USD', 399, '${unrelatedProviderId}',
        'fake_checkout_unrelated_attempt', 'late-payment-key-0001'
      )
    `);
    const raw = Buffer.from(JSON.stringify({
      amountMinor: 399,
      attemptReference: attemptId,
      currency: 'USD',
      eventId: 'evt_late_1',
      eventType: 'payment.succeeded',
      externalPaymentId: unrelatedProviderId,
      externalTransactionId: 'charge_late_1',
      occurredAt: new Date().toISOString(),
    }));
    await expect(payments.handleWebhook(
      platformConfigId,
      raw,
      signFakePaymentWebhook(raw),
    )).resolves.toEqual({ duplicate: false, status: 'rejected' });
    const state = await database.query<{
      attempt_id: string;
      attempt_status: string;
      order_status: string;
      transactions: string;
    }>(`
      select inbox.attempt_id, attempt.status as attempt_status,
        commerce_order.status as order_status,
        (select count(*)::text from payment_transactions where attempt_id = attempt.id) as transactions
      from payment_webhook_inbox as inbox
      inner join payment_attempts as attempt on attempt.id = inbox.attempt_id
      inner join orders as commerce_order on commerce_order.id = attempt.order_id
      where inbox.external_event_id = 'evt_late_1'
    `);
    expect(state.rows[0]).toEqual({
      attempt_id: attemptId,
      attempt_status: 'expired',
      order_status: 'expired',
      transactions: '0',
    });
  });

  it('forces payment RLS and hides platform credentials from a tenant database role', async () => {
    const providerId = uuidV7();
    const configId = uuidV7();
    await database.exec(`
      insert into payment_providers (id, code, adapter_code)
      values ('${providerId}', 'future-gateway', 'future_gateway');
      insert into payment_configs (id, owner_type, provider_id, label)
      values ('${configId}', 'platform', '${providerId}', 'Future gateway');
      insert into payment_config_secrets (
        payment_config_id, owner_type, credential_ciphertext, credential_key_version
      ) values ('${configId}', 'platform', '${'encrypted-secret-data'.repeat(2)}', 1);
      create role payment_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to payment_tenant_probe;
      grant select on payment_configs, payment_config_secrets to payment_tenant_probe;
      set role payment_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantId}'
    `);
    const configs = await database.query<{ id: string }>(`
      select id from payment_configs where id = '${configId}'
    `);
    const secrets = await database.query(`select * from payment_config_secrets`);
    expect(configs.rows).toEqual([{ id: configId }]);
    expect(secrets.rows).toHaveLength(0);
    await database.exec('rollback; reset role');

    const tables = [
      'merchant_balance_accounts',
      'merchant_balance_ledger',
      'payment_attempts',
      'payment_config_secrets',
      'payment_configs',
      'payment_providers',
      'payment_refunds',
      'payment_transactions',
      'payment_webhook_inbox',
      'payment_webhook_outbox',
      'tenant_payment_routing',
    ];
    const rows = await database.query<{ forced: boolean; row_security: boolean }>(`
      select relation.relrowsecurity as row_security, relation.relforcerowsecurity as forced
      from pg_class as relation
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = any(array[${tables.map((table) => `'${table}'`).join(',')}])
    `);
    expect(rows.rows).toHaveLength(tables.length);
    expect(rows.rows.every((row) => row.row_security && row.forced)).toBe(true);
    const refundPolicies = await database.query<{ cmd: string; policyname: string }>(`
      select policyname, cmd from pg_policies
      where schemaname = 'public' and tablename = 'payment_refunds'
        and policyname = 'payment_refunds_tenant_access'
    `);
    expect(refundPolicies.rows).toEqual([{
      cmd: 'SELECT',
      policyname: 'payment_refunds_tenant_access',
    }]);
  });

  it('fully refunds a platform-collected order from immutable server snapshots', async () => {
    await configurations.setTenantRouting(
      tenantId,
      platformConfigId,
      'platform_collect',
      tenantStaffId,
      uuidV7(),
    );
    const order = await insertOrder('membership', 1777, { durationDays: 30 });
    await paySuccessfully(
      platformConfigId,
      order.id,
      'platform-refund-payment-0001',
      'platform_refund',
    );
    const unrelated = await database.query<{
      adapter_code_snapshot: string;
      attempt_id: string;
      charge_id: string;
      collection_mode: string;
      config_id: string;
      external_payment_id: string;
      provider_id: string;
    }>(`
      select attempt.id as attempt_id, attempt.provider_id,
        attempt.payment_config_id as config_id, attempt.adapter_code_snapshot,
        attempt.collection_mode, attempt.external_payment_id, charge.id as charge_id
      from payment_attempts as attempt
      inner join payment_transactions as charge
        on charge.attempt_id = attempt.id and charge.transaction_type = 'charge'
      where attempt.order_id <> '${order.id}' and attempt.collection_mode = 'platform_collect'
      limit 1
    `);
    const wrong = unrelated.rows[0];
    await expect(database.exec(`
      insert into payment_refunds (
        id, tenant_id, order_id, attempt_id, payment_transaction_id,
        provider_id, payment_config_id, adapter_code_snapshot, collection_mode,
        external_payment_id_snapshot, provider_idempotency_key, status,
        currency, amount_minor, reason, requested_by_type, requested_by
      ) values (
        '${uuidV7()}', '${tenantId}', '${order.id}', '${wrong?.attempt_id}',
        '${wrong?.charge_id}', '${wrong?.provider_id}', '${wrong?.config_id}',
        '${wrong?.adapter_code_snapshot}', '${wrong?.collection_mode}',
        '${wrong?.external_payment_id}', '${uuidV7()}', 'requested', 'USD', 1777,
        'cross-bound refund source', 'platform_staff', '${platformStaffId}'
      )
    `)).rejects.toThrow(/does not match its paid charge/i);
    await expect(refunds.createPlatformRefund(
      platformStaffId,
      order.id,
      { amountMinor: 1, reason: 'Customer support approved full refund' },
      'platform-refund-command-0001',
      uuidV7(),
    )).rejects.toBeInstanceOf(BadRequestException);

    const response = await refunds.createPlatformRefund(
      platformStaffId,
      order.id,
      { reason: 'Customer support approved full refund' },
      'platform-refund-command-0001',
      uuidV7(),
    );
    expect(response).toMatchObject({
      amountMinor: 1777,
      collectionMode: 'platform_collect',
      fullRefund: true,
      manualReconciliation: false,
      orderId: order.id,
      reconciliationRequired: false,
      status: 'succeeded',
    });
    await expect(refunds.createPlatformRefund(
      platformStaffId,
      order.id,
      { reason: 'Customer support approved full refund' },
      'platform-refund-command-0001',
      uuidV7(),
    )).resolves.toEqual(response);

    const state = await database.query<{
      entitlement_revoked: boolean;
      order_status: string;
      pending_minor: string;
      refund_ledger: string;
      refund_transactions: string;
      settlement_status: string;
    }>(`
      select commerce_order.status as order_status,
        (select revoked_at is not null from entitlements
          where source_order_id = commerce_order.id) as entitlement_revoked,
        (select count(*)::text from payment_transactions
          where order_id = commerce_order.id and transaction_type = 'refund') as refund_transactions,
        (select count(*)::text from merchant_balance_ledger
          where reference_type = 'payment_refund' and reference_id = '${response.id}') as refund_ledger,
        (select pending_minor::text from merchant_balance_accounts
          where tenant_id = '${tenantId}' and currency = 'USD') as pending_minor,
        (select status from merchant_settlements where payment_refund_id = '${response.id}') as settlement_status
      from orders as commerce_order where commerce_order.id = '${order.id}'
    `);
    expect(state.rows[0]).toEqual({
      entitlement_revoked: true,
      order_status: 'refunded',
      pending_minor: '1299',
      refund_ledger: '1',
      refund_transactions: '1',
      settlement_status: 'refunded',
    });
    await expect(database.exec(`
      update payment_refunds
      set external_refund_id = 'tampered_refund', version = version + 1
      where id = '${response.id}'
    `)).rejects.toThrow(/terminal refund facts are immutable/i);
    await expect(database.exec(`
      update merchant_settlements
      set payment_refund_id = '${uuidV7()}', version = version + 1
      where payment_refund_id = '${response.id}'
    `)).rejects.toThrow(/refunded settlement facts are immutable/i);
    await database.exec('create role refund_tenant_probe nosuperuser nobypassrls');
    await database.exec('grant usage on schema app, public to refund_tenant_probe');
    await database.exec('grant select, update on payment_refunds to refund_tenant_probe');
    await database.exec(`
      set role refund_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantId}'
    `);
    const forged = await database.query<{ id: string }>(`
      update payment_refunds set version = version + 1
      where id = '${response.id}' returning id
    `);
    expect(forged.rows).toHaveLength(0);
    await database.exec('rollback; reset role');
  });

  it('keeps ambiguous provider errors safe and resumes the same refund command', async () => {
    const direct = await configurations.createTenantFakeConfig(
      tenantId,
      { label: 'Refund retry local payment' },
      tenantStaffId,
      uuidV7(),
    );
    await configurations.setTenantRouting(
      tenantId,
      direct.id,
      'tenant_direct',
      tenantStaffId,
      uuidV7(),
    );
    const before = await currentPointBalance();
    const order = await insertOrder('points_topup', 250, {
      bonusPoints: 0,
      pointsAmount: 250,
    });
    await paySuccessfully(direct.id, order.id, 'refund-retry-payment-0001', 'refund_retry');

    let calls = 0;
    const providerKeys = new Set<string>();
    const recovering = new RefundService(databaseService, {
      require: () => ({
        refundPayment: async (input: {
          amountMinor: number;
          currency: 'CNY' | 'EUR' | 'JPY' | 'KRW' | 'USD';
          providerIdempotencyKey: string;
          refundId: string;
        }) => {
          calls += 1;
          providerKeys.add(input.providerIdempotencyKey);
          if (calls === 1) {
            throw new Error('https://provider.invalid/refund?token=DO_NOT_PERSIST');
          }
          return {
            amountMinor: input.amountMinor,
            currency: input.currency,
            externalRefundId: `retry_refund_${input.refundId.replaceAll('-', '')}`,
            occurredAt: new Date(),
            status: 'succeeded' as const,
          };
        },
      }),
    } as unknown as PaymentAdapterRegistry);
    const first = await recovering.createTenantRefund(
      tenantId,
      tenantStaffId,
      order.id,
      { reason: 'Retry an uncertain provider result' },
      'tenant-refund-retry-key-0001',
      uuidV7(),
    );
    expect(first).toMatchObject({
      reconciliationRequired: true,
      status: 'processing',
    });
    const ambiguous = await database.query<{
      command_status: string;
      last_error: string;
      leaked: boolean;
    }>(`
      select refund.last_error,
        command.status as command_status,
        exists(
          select 1 from audit_logs
          where resource_id = refund.id and after_json::text like '%DO_NOT_PERSIST%'
        ) as leaked
      from payment_refunds as refund
      inner join command_idempotency as command
        on command.resource_type = 'payment_refund' and command.resource_id = refund.id
      where refund.id = '${first.id}'
    `);
    expect(ambiguous.rows[0]).toEqual({
      command_status: 'processing',
      last_error: 'Provider refund outcome is ambiguous and requires reconciliation',
      leaked: false,
    });

    const completed = await recovering.createTenantRefund(
      tenantId,
      tenantStaffId,
      order.id,
      { reason: 'Retry an uncertain provider result' },
      'tenant-refund-retry-key-0001',
      uuidV7(),
    );
    expect(completed).toMatchObject({
      id: first.id,
      reconciliationRequired: false,
      status: 'succeeded',
    });
    expect(calls).toBe(2);
    expect(providerKeys).toEqual(new Set([first.id]));
    expect(await currentPointBalance()).toBe(before);

    const failedOrder = await insertOrder('points_topup', 90, {
      bonusPoints: 0,
      pointsAmount: 90,
    });
    await paySuccessfully(
      direct.id,
      failedOrder.id,
      'refund-definitive-payment-0001',
      'refund_definitive',
    );
    let failureCalls = 0;
    const definitivelyRejected = new RefundService(databaseService, {
      require: () => ({
        refundPayment: async () => {
          failureCalls += 1;
          if (failureCalls === 1) throw new Error('ambiguous before rejection');
          throw new PaymentAdapterDefinitiveError('provider token must stay private');
        },
      }),
    } as unknown as PaymentAdapterRegistry);
    const uncertain = await definitivelyRejected.createTenantRefund(
      tenantId,
      tenantStaffId,
      failedOrder.id,
      { reason: 'Provider later gives a definitive rejection' },
      'tenant-refund-definitive-0001',
      uuidV7(),
    );
    expect(uncertain.reconciliationRequired).toBe(true);
    const failed = await definitivelyRejected.createTenantRefund(
      tenantId,
      tenantStaffId,
      failedOrder.id,
      { reason: 'Provider later gives a definitive rejection' },
      'tenant-refund-definitive-0001',
      uuidV7(),
    );
    expect(failed).toMatchObject({
      id: uncertain.id,
      reconciliationRequired: false,
      status: 'failed',
    });
    expect(await currentPointBalance()).toBe(before + 90);
  });

  it('recovers with one provider key when the process loses transaction B', async () => {
    const direct = await configurations.createTenantFakeConfig(
      tenantId,
      { label: 'Refund transaction recovery payment' },
      tenantStaffId,
      uuidV7(),
    );
    await configurations.setTenantRouting(
      tenantId,
      direct.id,
      'tenant_direct',
      tenantStaffId,
      uuidV7(),
    );
    const order = await insertOrder('drama', 811, { title: 'Refund recovery drama' });
    await paySuccessfully(direct.id, order.id, 'refund-txb-payment-0001', 'refund_txb');

    let platformTransactions = 0;
    const flakyDatabase = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => {
        platformTransactions += 1;
        if (platformTransactions === 2) {
          return Promise.reject(new Error('simulated transaction B outage'));
        }
        return databaseService.inPlatformContext(callback);
      },
      inTenantContext: databaseService.inTenantContext.bind(databaseService),
    } as unknown as DatabaseService;
    const providerKeys: string[] = [];
    const service = new RefundService(flakyDatabase, {
      require: () => ({
        refundPayment: async (input: {
          amountMinor: number;
          currency: 'CNY' | 'EUR' | 'JPY' | 'KRW' | 'USD';
          providerIdempotencyKey: string;
          refundId: string;
        }) => {
          providerKeys.push(input.providerIdempotencyKey);
          return {
            amountMinor: input.amountMinor,
            currency: input.currency,
            externalRefundId: `txb_refund_${input.refundId.replaceAll('-', '')}`,
            occurredAt: new Date(),
            status: 'succeeded' as const,
          };
        },
      }),
    } as unknown as PaymentAdapterRegistry);
    await expect(service.createTenantRefund(
      tenantId,
      tenantStaffId,
      order.id,
      { reason: 'Recover after local completion transaction outage' },
      'tenant-refund-txb-recovery-0001',
      uuidV7(),
    )).rejects.toThrow(/transaction B outage/i);
    const stuck = await database.query<{ command_status: string; status: string }>(`
      select refund.status, command.status as command_status
      from payment_refunds as refund
      inner join command_idempotency as command
        on command.resource_type = 'payment_refund' and command.resource_id = refund.id
      where refund.order_id = '${order.id}'
    `);
    expect(stuck.rows[0]).toEqual({ command_status: 'processing', status: 'processing' });

    const recovered = await service.createTenantRefund(
      tenantId,
      tenantStaffId,
      order.id,
      { reason: 'Recover after local completion transaction outage' },
      'tenant-refund-txb-recovery-0001',
      uuidV7(),
    );
    expect(recovered.status).toBe('succeeded');
    expect(providerKeys).toHaveLength(2);
    expect(new Set(providerKeys)).toEqual(new Set([recovered.id]));
    const result = await database.query<{ refunds: string; status: string }>(`
      select status,
        (select count(*)::text from payment_transactions
          where order_id = commerce_order.id and transaction_type = 'refund') as refunds
      from orders as commerce_order where id = '${order.id}'
    `);
    expect(result.rows[0]).toEqual({ refunds: '1', status: 'refunded' });
  });

  it('records a successful provider refund for manual reconciliation without negative merchant funds', async () => {
    await configurations.setTenantRouting(
      tenantId,
      platformConfigId,
      'platform_collect',
      tenantStaffId,
      uuidV7(),
    );
    const order = await insertOrder('episode', 2000, { title: 'Manual reconciliation episode' });
    await paySuccessfully(
      platformConfigId,
      order.id,
      'manual-refund-payment-0001',
      'manual_refund',
    );
    const account = await database.query<{
      id: string;
      pending_minor: string;
    }>(`
      select id, pending_minor::text from merchant_balance_accounts
      where tenant_id = '${tenantId}' and currency = 'USD'
    `);
    await database.exec(`
      insert into merchant_balance_ledger (
        id, tenant_id, balance_account_id, bucket, entry_type,
        delta_minor, balance_after_minor, currency, reference_type,
        reference_id, idempotency_key, created_by_type, created_by
      ) values (
        '${uuidV7()}', '${tenantId}', '${account.rows[0]?.id}', 'pending', 'adjustment',
        -2000, 0, 'USD', 'manual_adjustment', '${uuidV7()}',
        'manual-adjustment-before-refund-0001', 'platform_staff', '${platformStaffId}'
      )
    `);
    const response = await refunds.createPlatformRefund(
      platformStaffId,
      order.id,
      { reason: 'Provider refund succeeds after merchant funds moved' },
      'platform-manual-refund-command-0001',
      uuidV7(),
    );
    expect(response).toMatchObject({
      manualReconciliation: true,
      reconciliationRequired: true,
      status: 'manual_reconciliation',
    });
    const state = await database.query<{
      order_status: string;
      pending_minor: string;
      refund_ledger: string;
      security_event: string;
      settlement_status: string;
    }>(`
      select commerce_order.status as order_status,
        (select pending_minor::text from merchant_balance_accounts
          where tenant_id = '${tenantId}' and currency = 'USD') as pending_minor,
        (select count(*)::text from merchant_balance_ledger
          where reference_type = 'payment_refund' and reference_id = '${response.id}') as refund_ledger,
        (select count(*)::text from outbox_events
          where aggregate_id = '${response.id}'
            and event_type = 'PaymentRefundReconciliationRequired') as security_event,
        (select status from merchant_settlements
          where payment_refund_id = '${response.id}') as settlement_status
      from orders as commerce_order where id = '${order.id}'
    `);
    expect(state.rows[0]).toEqual({
      order_status: 'refunded',
      pending_minor: '1299',
      refund_ledger: '0',
      security_event: '1',
      settlement_status: 'refunded',
    });
  });
});

async function insertOrder(
  type: 'drama' | 'episode' | 'membership' | 'points_topup',
  amountMinor: number,
  snapshot: Record<string, unknown>,
  expired = false,
) {
  const id = uuidV7();
  const productId = uuidV7();
  const itemId = uuidV7();
  const orderNo = `ORD${id.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
  const created = expired ? "statement_timestamp() - interval '2 hours'" : 'statement_timestamp()';
  const expires = expired
    ? "statement_timestamp() - interval '1 hour'"
    : "statement_timestamp() + interval '30 minutes'";
  await database.exec(`
    insert into orders (
      id, tenant_id, account_id, order_no, order_type, currency,
      subtotal_minor, total_minor, locale, customer_snapshot_json,
      created_at, updated_at, expires_at
    ) values (
      '${id}', '${tenantId}', '${customerId}', '${orderNo}', '${type}', 'USD',
      ${amountMinor}, ${amountMinor}, 'en-US', '{"username":"payment_customer"}'::jsonb,
      ${created}, ${created}, ${expires}
    );
    insert into order_items (
      id, tenant_id, order_id, line_no, item_type, product_id, currency,
      unit_amount_minor, total_amount_minor, product_snapshot_json
    ) values (
      '${itemId}', '${tenantId}', '${id}', 1, '${type}', '${productId}', 'USD',
      ${amountMinor}, ${amountMinor}, '${JSON.stringify(snapshot).replaceAll("'", "''")}'::jsonb
    );
  `);
  return { id, itemId, productId };
}

async function paySuccessfully(
  configId: string,
  orderId: string,
  idempotencyKey: string,
  suffix: string,
) {
  const attempt = await payments.createPayment(
    principal,
    orderId,
    {},
    idempotencyKey,
    uuidV7(),
  );
  const raw = Buffer.from(JSON.stringify({
    amountMinor: attempt.amountMinor,
    attemptReference: attempt.id,
    currency: attempt.currency,
    eventId: `evt_direct_${suffix}`,
    eventType: 'payment.succeeded',
    externalPaymentId: attempt.externalPaymentId,
    externalTransactionId: `charge_direct_${suffix}`,
    occurredAt: new Date().toISOString(),
  }));
  await payments.handleWebhook(configId, raw, signFakePaymentWebhook(raw));
}

async function currentPointBalance(): Promise<number> {
  const rows = await database.query<{ balance: string }>(`
    select balance::text from point_accounts
    where tenant_id = '${tenantId}' and account_id = '${customerId}'
  `);
  return Number(rows.rows[0]?.balance ?? 0);
}
