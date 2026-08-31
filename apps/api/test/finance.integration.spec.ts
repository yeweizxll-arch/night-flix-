import { PGlite, type Transaction } from '@electric-sql/pglite';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import { FinancePayoutCipher } from '../src/finance/finance-payout-cipher';
import { FinanceService } from '../src/finance/finance.service';

let database: PGlite;
let finance: FinanceService;

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773576101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773576102';
const applicant = '018f2f45-7f5e-7e70-b17f-f6e773576103';
const reviewer = '018f2f45-7f5e-7e70-b17f-f6e773576104';
const confirmer = '018f2f45-7f5e-7e70-b17f-f6e773576105';
const customer = '018f2f45-7f5e-7e70-b17f-f6e773576106';
const proofAsset = '018f2f45-7f5e-7e70-b17f-f6e773576107';
const balanceAccount = '018f2f45-7f5e-7e70-b17f-f6e773576108';
const settlementId = '018f2f45-7f5e-7e70-b17f-f6e773576109';

describe('merchant settlement and withdrawal finance domain', () => {
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
    const providerId = uuidV7();
    const configId = uuidV7();
    const orderId = uuidV7();
    const orderItemId = uuidV7();
    const attemptId = uuidV7();
    const transactionId = uuidV7();
    const productId = uuidV7();
    const orderNo = `ORD${orderId.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantA}', 'finance-a', 'Finance A', transaction_timestamp() + interval '1 year'),
        ('${tenantB}', 'finance-b', 'Finance B', transaction_timestamp() + interval '1 year');
      insert into tenant_staff (id, tenant_id, username, password_hash) values
        ('${applicant}', '${tenantA}', 'finance-applicant', '${'p'.repeat(64)}');
      insert into platform_staff (id, username, password_hash) values
        ('${reviewer}', 'finance-reviewer', '${'p'.repeat(64)}'),
        ('${confirmer}', 'finance-confirmer', '${'p'.repeat(64)}'),
        ('${applicant}', 'same-id-reviewer', '${'p'.repeat(64)}');
      insert into customer_accounts (
        id, tenant_id, username, email, email_verified_at, password_hash
      ) values (
        '${customer}', '${tenantA}', 'finance_customer', 'finance@example.com',
        transaction_timestamp(), '${'x'.repeat(64)}'
      );
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, source_url, checksum,
        status, transcode_status, metadata_json
      ) values (
        '${proofAsset}', 'platform', null, 'file',
        'https://proofs.example.test/transfer.pdf', '${'f'.repeat(64)}',
        'ready', 'not_required', '{"immutable":true}'::jsonb
      );
      insert into orders (
        id, tenant_id, account_id, order_no, order_type, currency,
        subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
      ) values (
        '${orderId}', '${tenantA}', '${customer}', '${orderNo}', 'membership', 'USD',
        1000, 1000, 'en-US', '{}'::jsonb, transaction_timestamp() + interval '1 hour'
      );
      insert into order_items (
        id, tenant_id, order_id, line_no, item_type, product_id, currency,
        unit_amount_minor, total_amount_minor, product_snapshot_json
      ) values (
        '${orderItemId}', '${tenantA}', '${orderId}', 1, 'membership', '${productId}',
        'USD', 1000, 1000, '{"durationDays":30}'::jsonb
      );
      insert into payment_providers (id, code, adapter_code)
      values ('${providerId}', 'finance-test', 'fake');
      insert into payment_configs (id, owner_type, provider_id, label)
      values ('${configId}', 'platform', '${providerId}', 'Finance test config');
      insert into payment_attempts (
        id, tenant_id, account_id, order_id, provider_id, payment_config_id,
        adapter_code_snapshot, collection_mode, status, currency, amount_minor,
        external_payment_id, checkout_reference, idempotency_key
      ) values (
        '${attemptId}', '${tenantA}', '${customer}', '${orderId}', '${providerId}',
        '${configId}', 'fake', 'platform_collect', 'pending', 'USD', 1000,
        'fake_pay_${attemptId.replaceAll('-', '')}', 'fake_checkout_finance_test',
        'finance-payment-attempt-0001'
      );
      insert into payment_transactions (
        id, tenant_id, attempt_id, order_id, provider_id, transaction_type,
        status, external_transaction_id, currency, amount_minor, payload_hash,
        occurred_at
      ) values (
        '${transactionId}', '${tenantA}', '${attemptId}', '${orderId}', '${providerId}',
        'charge', 'succeeded', 'finance-charge-0001', 'USD', 1000,
        '${'a'.repeat(64)}', transaction_timestamp()
      );
      update payment_attempts set status = 'succeeded',
        succeeded_at = transaction_timestamp(), version = version + 1
      where id = '${attemptId}';
      update orders set status = 'paid', paid_at = transaction_timestamp(), version = version + 1
      where id = '${orderId}';
      insert into merchant_balance_accounts (id, tenant_id, currency)
      values ('${balanceAccount}', '${tenantA}', 'USD');
      insert into merchant_balance_ledger (
        id, tenant_id, balance_account_id, bucket, entry_type, delta_minor,
        balance_after_minor, currency, reference_type, reference_id, idempotency_key
      ) values (
        '${uuidV7()}', '${tenantA}', '${balanceAccount}', 'pending', 'payment_pending',
        1000, 0, 'USD', 'payment_transaction', '${transactionId}',
        'finance-payment-pending-0001'
      );
      insert into merchant_settlements (
        id, tenant_id, balance_account_id, payment_transaction_id,
        currency, amount_minor, eligible_at
      ) values (
        '${settlementId}', '${tenantA}', '${balanceAccount}', '${transactionId}',
        'USD', 1000, transaction_timestamp()
      );
    `);
    const service = makeDatabaseService(database);
    finance = new FinanceService(
      service,
      new FinancePayoutCipher({
        activeVersion: 1,
        keys: new Map([[1, Buffer.alloc(32, 7)]]),
      }),
    );
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('settles a due platform collection exactly once using balanced ledger entries', async () => {
    await expect(finance.settleDue(reviewer, {}, uuidV7())).resolves.toEqual({ settled: 1 });
    await expect(finance.settleDue(reviewer, {}, uuidV7())).resolves.toEqual({ settled: 0 });
    const state = await balances();
    expect(state).toEqual({ available: '1000', frozen: '0', pending: '0', withdrawn: '0' });
    const ledger = await database.query<{ count: string }>(`
      select count(*)::text as count from merchant_balance_ledger
      where reference_type = 'merchant_settlement' and reference_id = '${settlementId}'
    `);
    expect(ledger.rows[0]?.count).toBe('2');
  });

  it('submits idempotently, encrypts payout details, and cancels only the submitted version', async () => {
    const input = withdrawalInput(100);
    const submitted = await finance.submitWithdrawal(
      tenantA, applicant, input, 'finance-submit-key-0001', uuidV7(),
    );
    await expect(finance.submitWithdrawal(
      tenantA, applicant, input, 'finance-submit-key-0001', uuidV7(),
    )).resolves.toEqual(submitted);
    await expect(finance.submitWithdrawal(
      tenantA, applicant, withdrawalInput(101), 'finance-submit-key-0001', uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
    const snapshot = await database.query<{ ciphertext: string }>(`
      select ciphertext from withdrawal_payout_snapshots where withdrawal_id = '${submitted.id}'
    `);
    expect(snapshot.rows[0]?.ciphertext).not.toContain('1234567890123456');
    expect(await balances()).toEqual({
      available: '900', frozen: '100', pending: '0', withdrawn: '0',
    });
    await expect(finance.cancelWithdrawal(
      tenantA, submitted.id, applicant, submitted.version, uuidV7(),
    )).resolves.toMatchObject({ status: 'cancelled', version: 1 });
    await expect(finance.cancelWithdrawal(
      tenantA, submitted.id, applicant, 1, uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(await balances()).toEqual({
      available: '1000', frozen: '0', pending: '0', withdrawn: '0',
    });
  });

  it('rejects and unfreezes atomically, including stale/double reviews', async () => {
    const submitted = await finance.submitWithdrawal(
      tenantA, applicant, withdrawalInput(200), 'finance-submit-key-0002', uuidV7(),
    );
    await expect(finance.reviewWithdrawal(
      submitted.id,
      applicant,
      { decision: 'approve', version: 0 },
      uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(finance.reviewWithdrawal(
      submitted.id,
      reviewer,
      { decision: 'reject', reason: 'Bank account requires correction', version: 0 },
      uuidV7(),
    )).resolves.toMatchObject({ status: 'rejected', version: 1 });
    await expect(finance.reviewWithdrawal(
      submitted.id,
      reviewer,
      { decision: 'reject', reason: 'Duplicate review', version: 0 },
      uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(await balances()).toEqual({
      available: '1000', frozen: '0', pending: '0', withdrawn: '0',
    });
  });

  it('approves and confirms an offline transfer with proof without partial balance updates', async () => {
    const submitted = await finance.submitWithdrawal(
      tenantA, applicant, withdrawalInput(600), 'finance-submit-key-0003', uuidV7(),
    );
    const approved = await finance.reviewWithdrawal(
      submitted.id,
      reviewer,
      { decision: 'approve', version: 0 },
      uuidV7(),
    );
    await expect(finance.confirmTransfer(
      submitted.id,
      confirmer,
      { bankReference: 'BANK-TRANSFER-0001', mediaAssetId: uuidV7(), version: approved.version },
      uuidV7(),
    )).rejects.toThrow();
    expect(await balances()).toEqual({
      available: '400', frozen: '600', pending: '0', withdrawn: '0',
    });
    await expect(finance.confirmTransfer(
      submitted.id,
      confirmer,
      {
        bankReference: 'BANK-TRANSFER-0001',
        mediaAssetId: proofAsset,
        version: approved.version,
      },
      uuidV7(),
    )).resolves.toMatchObject({ status: 'paid', version: 2 });
    await expect(finance.confirmTransfer(
      submitted.id,
      confirmer,
      { bankReference: 'BANK-TRANSFER-0001', mediaAssetId: proofAsset, version: 1 },
      uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(await balances()).toEqual({
      available: '400', frozen: '0', pending: '0', withdrawn: '600',
    });
  });

  it('rejects cross-tenant reads, insufficient funds, and direct tenant-role finance mutations', async () => {
    const paid = await database.query<{ id: string }>(`
      select id from withdrawals where tenant_id = '${tenantA}' and status = 'paid'
    `);
    await expect(finance.getTenantWithdrawal(tenantB, paid.rows[0]?.id as string))
      .rejects.toBeInstanceOf(NotFoundException);
    await expect(finance.submitWithdrawal(
      tenantA, applicant, withdrawalInput(401), 'finance-submit-key-0004', uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);

    await database.exec(`
      create role finance_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to finance_tenant_probe;
      grant select, insert, update on merchant_balance_accounts, merchant_balance_ledger,
        withdrawals, withdrawal_actions, withdrawal_payout_snapshots to finance_tenant_probe;
      set role finance_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    await expect(database.exec(`
      insert into merchant_balance_ledger (
        id, tenant_id, balance_account_id, bucket, entry_type, delta_minor,
        balance_after_minor, currency, reference_type, reference_id, idempotency_key
      ) values (
        '${uuidV7()}', '${tenantA}', '${balanceAccount}', 'available', 'adjustment',
        999999, 0, 'USD', 'manual_adjustment', '${uuidV7()}', 'forged-adjustment-0001'
      )
    `)).rejects.toThrow();
    await expect(database.exec(`
      update withdrawals set status = 'approved', reviewed_by = '${reviewer}',
        reviewed_at = transaction_timestamp(), version = version + 1
      where id = '${paid.rows[0]?.id}'
    `)).rejects.toThrow();
    await expect(database.exec(`
      insert into withdrawal_actions (
        id, tenant_id, withdrawal_id, action, from_status, to_status,
        actor_type, actor_id
      ) values (
        '${uuidV7()}', '${tenantA}', '${paid.rows[0]?.id}', 'approve',
        'submitted', 'approved', 'platform_staff', '${reviewer}'
      )
    `)).rejects.toThrow();
    await database.exec('rollback; reset role');
  });
});

function makeDatabaseService(target: PGlite): DatabaseService {
  return {
    inPlatformContext: <T>(
      callback: (transaction: DatabaseTransaction) => Promise<T>,
    ): Promise<T> => target.transaction((transaction) => callback(transactionTag(transaction))),
    inTenantContext: <T>(
      tenantId: string,
      callback: (transaction: DatabaseTransaction) => Promise<T>,
    ): Promise<T> => target.transaction(async (transaction) => {
      await transaction.query(
        "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
        [tenantId],
      );
      return callback(transactionTag(transaction));
    }),
  } as unknown as DatabaseService;
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

function withdrawalInput(amountMinor: number) {
  return {
    amountMinor,
    currency: 'USD',
    payoutAccount: {
      accountHolder: 'Drama Merchant LLC',
      accountNumber: '1234567890123456',
      bankName: 'Example Bank',
      countryCode: 'US',
      routingCode: '110000000',
    },
  };
}

async function balances() {
  const rows = await database.query<{
    available: string;
    frozen: string;
    pending: string;
    withdrawn: string;
  }>(`
    select available_minor::text as available, frozen_minor::text as frozen,
      pending_minor::text as pending, withdrawn_minor::text as withdrawn
    from merchant_balance_accounts where id = '${balanceAccount}'
  `);
  return rows.rows[0];
}
