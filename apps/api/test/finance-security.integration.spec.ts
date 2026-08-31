import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';
import { FinancePayoutCipher } from '../src/finance/finance-payout-cipher';
import { FinanceService } from '../src/finance/finance.service';

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773575101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773575102';
const applicantA = '018f2f45-7f5e-7e70-b17f-f6e773575103';
const otherStaffA = '018f2f45-7f5e-7e70-b17f-f6e773575104';
const applicantB = '018f2f45-7f5e-7e70-b17f-f6e773575105';
const reviewer = '018f2f45-7f5e-7e70-b17f-f6e773575106';
const confirmer = '018f2f45-7f5e-7e70-b17f-f6e773575107';
const customerA = '018f2f45-7f5e-7e70-b17f-f6e773575108';
const providerId = '018f2f45-7f5e-7e70-b17f-f6e773575109';
const configId = '018f2f45-7f5e-7e70-b17f-f6e77357510a';
const proofA = '018f2f45-7f5e-7e70-b17f-f6e77357510b';
const proofB = '018f2f45-7f5e-7e70-b17f-f6e77357510c';
const proofPending = '018f2f45-7f5e-7e70-b17f-f6e77357510d';

let database: PGlite;
let finance: FinanceService;
let balanceAccountId: string;
let firstSettlementId: string;

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

describe('settlement and withdrawal financial security', () => {
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
        ('${tenantA}', 'finance-a', 'Finance A', transaction_timestamp() + interval '1 year'),
        ('${tenantB}', 'finance-b', 'Finance B', transaction_timestamp() + interval '1 year');
      insert into platform_staff (id, username, password_hash) values
        ('${reviewer}', 'finance_reviewer', '${'r'.repeat(64)}'),
        ('${confirmer}', 'finance_confirmer', '${'c'.repeat(64)}');
      insert into tenant_staff (id, tenant_id, username, password_hash) values
        ('${applicantA}', '${tenantA}', 'finance_applicant', '${'a'.repeat(64)}'),
        ('${otherStaffA}', '${tenantA}', 'finance_other_staff', '${'o'.repeat(64)}'),
        ('${applicantB}', '${tenantB}', 'finance_cross_tenant', '${'b'.repeat(64)}');
      insert into customer_accounts (id, tenant_id, username, password_hash)
      values ('${customerA}', '${tenantA}', 'finance_customer', '${'u'.repeat(64)}');
      insert into payment_providers (id, code, adapter_code)
      values ('${providerId}', 'finance-test-provider', 'fake');
      insert into payment_configs (id, owner_type, provider_id, label)
      values ('${configId}', 'platform', '${providerId}', 'Finance test config');
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, source_url, checksum,
        status, metadata_json
      ) values
        ('${proofA}', 'tenant', '${tenantA}', 'image',
          'https://media.example.com/proof-a.png', '${'a'.repeat(64)}',
          'ready', '{"immutable":true}'::jsonb),
        ('${proofB}', 'tenant', '${tenantB}', 'image',
          'https://media.example.com/proof-b.png', '${'b'.repeat(64)}',
          'ready', '{"immutable":true}'::jsonb),
        ('${proofPending}', 'tenant', '${tenantA}', 'file',
          'https://media.example.com/proof-pending.pdf', '${'c'.repeat(64)}',
          'pending', '{"immutable":true}'::jsonb);
      insert into tenant_settlement_policies (tenant_id, currency, delay_days)
      values ('${tenantA}', 'USD', 0)
    `);

    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(
        (transaction) => callback(transactionTag(transaction)),
      ),
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        const tagged = transactionTag(transaction);
        await tagged`
          select
            set_config('app.access_scope', 'tenant', true),
            set_config('app.tenant_id', ${tenantId}, true)
        `;
        return callback(tagged);
      }),
    } as unknown as DatabaseService;
    const payoutCipher = new FinancePayoutCipher({
      activeVersion: 1,
      keys: new Map([[1, randomBytes(32)]]),
    });
    finance = new FinanceService(databaseService, payoutCipher);

    const transactionId = await createPaidCharge('platform_collect', 1_000);
    balanceAccountId = uuidV7();
    firstSettlementId = uuidV7();
    await database.exec(`
      insert into merchant_balance_accounts (id, tenant_id, currency)
      values ('${balanceAccountId}', '${tenantA}', 'USD');
      insert into merchant_balance_ledger (
        id, tenant_id, balance_account_id, bucket, entry_type,
        delta_minor, balance_after_minor, currency, reference_type,
        reference_id, idempotency_key
      ) values (
        '${uuidV7()}', '${tenantA}', '${balanceAccountId}', 'pending',
        'payment_pending', 1000, 0, 'USD', 'payment_transaction',
        '${transactionId}', 'finance-seed-payment-pending'
      );
      insert into merchant_settlements (
        id, tenant_id, balance_account_id, payment_transaction_id,
        currency, amount_minor, eligible_at
      ) values (
        '${firstSettlementId}', '${tenantA}', '${balanceAccountId}',
        '${transactionId}', 'USD', 1000, transaction_timestamp()
      )
    `);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('accepts only one platform-collected succeeded charge and snapshots policy delay', async () => {
    const directTransaction = await createPaidCharge('tenant_direct', 50);
    await expect(database.exec(`
      insert into merchant_settlements (
        id, tenant_id, balance_account_id, payment_transaction_id,
        currency, amount_minor, eligible_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${balanceAccountId}',
        '${directTransaction}', 'USD', 50, transaction_timestamp()
      )
    `)).rejects.toThrow(/platform-collected/);

    const firstTransaction = await database.query<{ payment_transaction_id: string }>(`
      select payment_transaction_id from merchant_settlements where id = '${firstSettlementId}'
    `);
    await expect(database.exec(`
      insert into merchant_settlements (
        id, tenant_id, balance_account_id, payment_transaction_id,
        currency, amount_minor, eligible_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${balanceAccountId}',
        '${firstTransaction.rows[0]?.payment_transaction_id}', 'USD', 1000,
        transaction_timestamp()
      )
    `)).rejects.toThrow();

    await finance.upsertSettlementPolicy(tenantA, reviewer, {
      currency: 'USD',
      delayDays: 5,
    }, uuidV7());
    const delayedTransaction = await createPaidCharge('platform_collect', 75);
    const delayedSettlement = uuidV7();
    await database.exec(`
      insert into merchant_balance_ledger (
        id, tenant_id, balance_account_id, bucket, entry_type,
        delta_minor, balance_after_minor, currency, reference_type,
        reference_id, idempotency_key
      ) values (
        '${uuidV7()}', '${tenantA}', '${balanceAccountId}', 'pending',
        'payment_pending', 75, 0, 'USD', 'payment_transaction',
        '${delayedTransaction}', 'finance-delayed-payment-pending'
      );
      insert into merchant_settlements (
        id, tenant_id, balance_account_id, payment_transaction_id,
        currency, amount_minor, eligible_at
      ) values (
        '${delayedSettlement}', '${tenantA}', '${balanceAccountId}',
        '${delayedTransaction}', 'USD', 75,
        transaction_timestamp() + (
          select delay_days * interval '1 day' from tenant_settlement_policies
          where tenant_id = '${tenantA}' and currency = 'USD'
        )
      )
    `);
    const before = await database.query<{ eligible_at: Date }>(`
      select eligible_at from merchant_settlements where id = '${delayedSettlement}'
    `);
    await finance.upsertSettlementPolicy(tenantA, reviewer, {
      currency: 'USD',
      delayDays: 1,
    }, uuidV7());
    const after = await database.query<{ eligible_at: Date }>(`
      select eligible_at from merchant_settlements where id = '${delayedSettlement}'
    `);
    expect(after.rows[0]?.eligible_at.toISOString()).toBe(
      before.rows[0]?.eligible_at.toISOString(),
    );
  });

  it('rolls back an unbalanced settlement and atomically moves pending to available', async () => {
    const before = await balances();
    await expect(database.transaction(async (transaction) => {
      const sql = transactionTag(transaction);
      await sql`
        insert into merchant_balance_ledger (
          id, tenant_id, balance_account_id, bucket, entry_type,
          delta_minor, balance_after_minor, currency, reference_type,
          reference_id, idempotency_key
        ) values (
          ${uuidV7()}, ${tenantA}, ${balanceAccountId}, 'pending',
          'settlement_available', -1000, 0, 'USD', 'merchant_settlement',
          ${firstSettlementId}, 'finance-unbalanced-settlement'
        )
      `;
      await sql`
        update merchant_settlements
        set status = 'settled', settled_at = transaction_timestamp(), version = version + 1
        where id = ${firstSettlementId}
      `;
    })).rejects.toThrow(/balanced pending and available/);
    expect(await balances()).toEqual(before);

    await expect(finance.settleDue(reviewer, {
      limit: 10,
      tenantId: tenantA,
      currency: 'USD',
    }, uuidV7())).resolves.toEqual({ settled: 1 });
    expect(await balances()).toMatchObject({
      available_minor: '1000',
      pending_minor: '75',
    });
    await expect(finance.settleDue(reviewer, {
      limit: 10,
      tenantId: tenantA,
      currency: 'USD',
    }, uuidV7())).resolves.toEqual({ settled: 0 });
  });

  it('makes withdrawal submission idempotent and serializes concurrent overdraws', async () => {
    const inputs = [
      ['finance-withdrawal-concurrent-a', 700],
      ['finance-withdrawal-concurrent-b', 700],
    ] as const;
    const outcomes = await Promise.allSettled(inputs.map(([key, amountMinor]) =>
      finance.submitWithdrawal(
        tenantA,
        applicantA,
        { amountMinor, currency: 'USD', payoutAccount: payout() },
        key,
        uuidV7(),
      )));
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const winnerIndex = outcomes.findIndex((outcome) => outcome.status === 'fulfilled');
    const winner = outcomes[winnerIndex];
    if (!winner || winner.status !== 'fulfilled') {
      throw new Error('Concurrent withdrawal winner was not found');
    }
    const winnerKey = inputs[winnerIndex]?.[0] as string;
    const withdrawalId = winner.value.id as string;
    expect(outcomes.find((outcome) => outcome.status === 'rejected'))
      .toMatchObject({ reason: expect.any(ConflictException) });
    await expect(finance.submitWithdrawal(
      tenantA,
      applicantA,
      { amountMinor: 700, currency: 'USD', payoutAccount: payout() },
      winnerKey,
      uuidV7(),
    )).resolves.toMatchObject({ id: withdrawalId });
    await expect(finance.submitWithdrawal(
      tenantA,
      applicantA,
      { amountMinor: 701, currency: 'USD', payoutAccount: payout() },
      winnerKey,
      uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(await balances()).toMatchObject({
      available_minor: '300',
      frozen_minor: '700',
    });

    const balanceBeforeDuplicateLeg = await balances();
    await expect(database.exec(`
      insert into merchant_balance_ledger (
        id, tenant_id, balance_account_id, bucket, entry_type,
        delta_minor, balance_after_minor, currency, reference_type,
        reference_id, idempotency_key
      ) values (
        '${uuidV7()}', '${tenantA}', '${balanceAccountId}', 'available',
        'freeze', -700, 0, 'USD', 'withdrawal', '${withdrawalId}',
        'finance-withdrawal-duplicate-leg-new-key'
      )
    `)).rejects.toThrow();
    expect(await balances()).toEqual(balanceBeforeDuplicateLeg);

    await expect(finance.cancelWithdrawal(
      tenantA,
      withdrawalId,
      otherStaffA,
      0,
      uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(finance.cancelWithdrawal(
      tenantB,
      withdrawalId,
      applicantB,
      0,
      uuidV7(),
    )).rejects.toBeInstanceOf(NotFoundException);
    await expect(finance.cancelWithdrawal(
      tenantA,
      withdrawalId,
      applicantA,
      0,
      uuidV7(),
    )).resolves.toMatchObject({ status: 'cancelled', version: 1 });
    expect(await balances()).toMatchObject({
      available_minor: '1000',
      frozen_minor: '0',
    });
  });

  it('unfreezes rejected funds and confirms paid funds only with valid owned proof', async () => {
    const rejected = await finance.submitWithdrawal(
      tenantA,
      applicantA,
      { amountMinor: 200, currency: 'USD', payoutAccount: payout() },
      'finance-withdrawal-reject-0001',
      uuidV7(),
    );
    await expect(finance.reviewWithdrawal(
      String(rejected.id),
      reviewer,
      { decision: 'reject', reason: 'manual risk review', version: 0 },
      uuidV7(),
    )).resolves.toMatchObject({ status: 'rejected', version: 1 });
    await expect(database.exec(`
      insert into withdrawal_actions (
        id, tenant_id, withdrawal_id, action, from_status, to_status,
        actor_type, actor_id, reason
      ) values (
        '${uuidV7()}', '${tenantA}', '${String(rejected.id)}', 'reject',
        'submitted', 'rejected', 'platform_staff', '${confirmer}',
        'manual risk review'
      )
    `)).rejects.toThrow(/review action is invalid/i);
    expect(await balances()).toMatchObject({
      available_minor: '1000',
      frozen_minor: '0',
    });

    const approved = await finance.submitWithdrawal(
      tenantA,
      applicantA,
      { amountMinor: 300, currency: 'USD', payoutAccount: payout() },
      'finance-withdrawal-paid-0001',
      uuidV7(),
    );
    await finance.reviewWithdrawal(
      String(approved.id),
      reviewer,
      { decision: 'approve', version: 0 },
      uuidV7(),
    );
    const beforeInvalidProof = await balances();
    await expect(finance.confirmTransfer(
      String(approved.id),
      confirmer,
      { bankReference: 'BANK-INVALID-TENANT', mediaAssetId: proofB, version: 1 },
      uuidV7(),
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(finance.confirmTransfer(
      String(approved.id),
      confirmer,
      { bankReference: 'BANK-PENDING-PROOF', mediaAssetId: proofPending, version: 1 },
      uuidV7(),
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(await balances()).toEqual(beforeInvalidProof);
    await expect(finance.confirmTransfer(
      String(approved.id),
      confirmer,
      { bankReference: 'BANK-PAID-0001', mediaAssetId: proofA, version: 1 },
      uuidV7(),
    )).resolves.toMatchObject({ status: 'paid', version: 2 });
    await expect(database.exec(`
      insert into withdrawal_actions (
        id, tenant_id, withdrawal_id, action, from_status, to_status,
        actor_type, actor_id, proof_media_asset_id, bank_reference
      ) values (
        '${uuidV7()}', '${tenantA}', '${String(approved.id)}', 'confirm_transfer',
        'approved', 'paid', 'platform_staff', '${reviewer}', '${proofA}',
        'BANK-PAID-0001'
      )
    `)).rejects.toThrow(/transfer action is invalid/i);
    await expect(database.exec(`
      insert into withdrawal_actions (
        id, tenant_id, withdrawal_id, action, from_status, to_status,
        actor_type, actor_id, proof_media_asset_id, bank_reference
      ) values (
        '${uuidV7()}', '${tenantA}', '${String(approved.id)}', 'confirm_transfer',
        'approved', 'paid', 'platform_staff', '${confirmer}', '${proofA}',
        'BANK-FORGED-REFERENCE'
      )
    `)).rejects.toThrow(/transfer action is invalid/i);
    expect(await balances()).toMatchObject({
      available_minor: '700',
      frozen_minor: '0',
      withdrawn_minor: '300',
    });
    await expect(finance.confirmTransfer(
      String(approved.id),
      confirmer,
      { bankReference: 'BANK-DUPLICATE', mediaAssetId: proofA, version: 1 },
      uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('never exposes payout plaintext or ciphertext to tenant APIs, audit, or outbox', async () => {
    const submitted = await finance.submitWithdrawal(
      tenantA,
      applicantA,
      { amountMinor: 100, currency: 'USD', payoutAccount: payout() },
      'finance-withdrawal-secrecy-0001',
      uuidV7(),
    );
    expect(JSON.stringify(submitted)).not.toContain('1234567890123456');
    const tenantView = await finance.getTenantWithdrawal(tenantA, String(submitted.id));
    expect(JSON.stringify(tenantView)).not.toContain('1234567890123456');
    expect(JSON.stringify(tenantView)).not.toMatch(/fp1\./);
    const platformView = await finance.getPlatformWithdrawal(String(submitted.id));
    expect(JSON.stringify(platformView)).not.toContain('1234567890123456');
    expect(JSON.stringify(platformView)).not.toMatch(/fp1\./);
    const sensitiveView = await finance.getPlatformPayoutAccount(
      String(submitted.id), confirmer, uuidV7(),
    );
    expect(sensitiveView.payoutAccount.accountNumber).toBe('1234567890123456');
    const sensitiveAudit = await database.query<{ count: string }>(`
      select count(*)::text as count from audit_logs
      where action = 'finance.withdrawal.payout_account.view'
        and resource_id = '${String(submitted.id)}'
        and actor_id = '${confirmer}'
    `);
    expect(sensitiveAudit.rows[0]?.count).toBe('1');
    await expect(database.transaction(async (transaction) => {
      const sql = transactionTag(transaction);
      await sql`
        update withdrawals
        set status = 'approved', reviewed_by = ${reviewer},
          reviewed_at = transaction_timestamp(), version = version + 1
        where id = ${String(submitted.id)}
      `;
    })).rejects.toThrow(/matching immutable action/i);
    const unchanged = await database.query<{ status: string }>(`
      select status from withdrawals where id = '${String(submitted.id)}'
    `);
    expect(unchanged.rows[0]?.status).toBe('submitted');
    const stored = await database.query<{ ciphertext: string }>(`
      select ciphertext from withdrawal_payout_snapshots
      where withdrawal_id = '${String(submitted.id)}'
    `);
    expect(stored.rows[0]?.ciphertext).toMatch(/^fp1\./);
    expect(stored.rows[0]?.ciphertext).not.toContain('1234567890123456');
    const emitted = await database.query<{ documents: string }>(`
      select concat(
        coalesce((select json_agg(audit)::text from audit_logs as audit
          where resource_id = '${String(submitted.id)}'), ''),
        coalesce((select json_agg(event)::text from outbox_events as event
          where aggregate_id = '${String(submitted.id)}'), '')
      ) as documents
    `);
    expect(emitted.rows[0]?.documents).not.toContain('1234567890123456');
    expect(emitted.rows[0]?.documents).not.toMatch(/fp1\./);
    const beforeDuplicate = await balances();
    await expect(database.exec(`
      insert into merchant_balance_ledger (
        id, tenant_id, balance_account_id, bucket, entry_type,
        delta_minor, balance_after_minor, currency, reference_type,
        reference_id, idempotency_key
      ) values (
        '${uuidV7()}', '${tenantA}', '${balanceAccountId}', 'available',
        'freeze', -100, 0, 'USD', 'withdrawal', '${String(submitted.id)}',
        'finance-duplicate-freeze-leg'
      )
    `)).rejects.toThrow();
    expect(await balances()).toEqual(beforeDuplicate);
  });

  it('binds immutable action history to the actual reviewer, confirmer, and proof facts', async () => {
    const rejected = await database.query<{
      id: string;
      review_reason: string;
    }>(`
      select id, review_reason from withdrawals
      where tenant_id = '${tenantA}' and status = 'rejected'
      order by created_at desc limit 1
    `);
    const paid = await database.query<{
      bank_reference: string;
      id: string;
      proof_media_asset_id: string;
    }>(`
      select id, proof_media_asset_id, bank_reference from withdrawals
      where tenant_id = '${tenantA}' and status = 'paid'
      order by created_at desc limit 1
    `);
    await expect(database.exec(`
      insert into withdrawal_actions (
        id, tenant_id, withdrawal_id, action, from_status, to_status,
        actor_type, actor_id, reason
      ) values (
        '${uuidV7()}', '${tenantA}', '${rejected.rows[0]?.id}', 'reject',
        'submitted', 'rejected', 'platform_staff', '${confirmer}',
        '${rejected.rows[0]?.review_reason}'
      )
    `)).rejects.toThrow(/action is invalid/);
    await expect(database.exec(`
      insert into withdrawal_actions (
        id, tenant_id, withdrawal_id, action, from_status, to_status,
        actor_type, actor_id, proof_media_asset_id, bank_reference
      ) values (
        '${uuidV7()}', '${tenantA}', '${paid.rows[0]?.id}', 'confirm_transfer',
        'approved', 'paid', 'platform_staff', '${reviewer}',
        '${paid.rows[0]?.proof_media_asset_id}', '${paid.rows[0]?.bank_reference}'
      )
    `)).rejects.toThrow(/action is invalid/);
    await expect(database.exec(`
      insert into withdrawal_actions (
        id, tenant_id, withdrawal_id, action, from_status, to_status,
        actor_type, actor_id, proof_media_asset_id, bank_reference
      ) values (
        '${uuidV7()}', '${tenantA}', '${paid.rows[0]?.id}', 'confirm_transfer',
        'approved', 'paid', 'platform_staff', '${confirmer}',
        '${paid.rows[0]?.proof_media_asset_id}', 'MISMATCHED-BANK-REFERENCE'
      )
    `)).rejects.toThrow(/action is invalid/);
  });

  it('forces tenant DB roles to read only their scope and denies every finance write path', async () => {
    const tables = [
      'merchant_balance_accounts',
      'merchant_balance_ledger',
      'merchant_settlements',
      'tenant_settlement_policies',
      'withdrawal_actions',
      'withdrawal_payout_snapshots',
      'withdrawals',
    ];
    const rls = await database.query<{ forced: boolean; row_security: boolean }>(`
      select relation.relrowsecurity as row_security, relation.relforcerowsecurity as forced
      from pg_class as relation
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = any(array[${tables.map((table) => `'${table}'`).join(',')}])
    `);
    expect(rls.rows).toHaveLength(tables.length);
    expect(rls.rows.every((row) => row.row_security && row.forced)).toBe(true);

    const paymentFact = await database.query<{
      amount_minor: string;
      attempt_id: string;
      currency: string;
      order_id: string;
      payment_config_id: string;
      payment_transaction_id: string;
      provider_id: string;
    }>(`
      select payment_transaction.amount_minor::text, payment_transaction.currency,
        payment_transaction.attempt_id, payment_transaction.order_id,
        payment_transaction.id as payment_transaction_id,
        attempt.payment_config_id, payment_transaction.provider_id
      from payment_transactions as payment_transaction
      inner join payment_attempts as attempt on attempt.id = payment_transaction.attempt_id
      where payment_transaction.tenant_id = '${tenantA}'
      order by payment_transaction.created_at
      limit 1
    `);
    const fact = paymentFact.rows[0];
    expect(fact).toBeDefined();

    await database.exec(`
      insert into merchant_balance_accounts (id, tenant_id, currency)
      values ('${uuidV7()}', '${tenantB}', 'USD');
      create role finance_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to finance_tenant_probe;
      grant select, insert, update, delete on
        merchant_balance_accounts, merchant_balance_ledger, merchant_settlements,
        tenant_settlement_policies, withdrawal_actions,
        withdrawal_payout_snapshots, withdrawals, payment_attempts,
        payment_transactions, payment_webhook_inbox, payment_webhook_outbox,
        payment_refunds, point_accounts, point_ledger, entitlements,
        orders, order_items
      to finance_tenant_probe;
      set role finance_tenant_probe;
      begin;
      set local app.access_scope = 'tenant';
      set local app.tenant_id = '${tenantA}'
    `);
    const visible = await database.query<{ tenant_id: string }>(`
      select tenant_id from merchant_balance_accounts order by tenant_id
    `);
    expect(visible.rows).toEqual([{ tenant_id: tenantA }]);
    const snapshots = await database.query(`select * from withdrawal_payout_snapshots`);
    expect(snapshots.rows).toEqual([]);

    await expectRoleUpdateHidden(`
      update merchant_balance_accounts set available_minor = available_minor + 1
      where id = '${balanceAccountId}'
    `);
    await expectRoleWriteDenied(`
      insert into merchant_balance_ledger (
        id, tenant_id, balance_account_id, bucket, entry_type,
        delta_minor, balance_after_minor, currency, reference_type,
        reference_id, idempotency_key
      ) values (
        '${uuidV7()}', '${tenantA}', '${balanceAccountId}', 'available',
        'adjustment', 1, 0, 'USD', 'manual_adjustment', '${uuidV7()}',
        'tenant-forbidden-ledger-write'
      )
    `);
    await expectRoleUpdateHidden(`
      update withdrawals set status = 'approved', reviewed_by = '${reviewer}',
        reviewed_at = transaction_timestamp(), version = version + 1
      where tenant_id = '${tenantA}'
    `);
    await expectRoleWriteDenied(`
      insert into withdrawal_actions (
        id, tenant_id, withdrawal_id, action, from_status, to_status,
        actor_type, actor_id
      ) values (
        '${uuidV7()}', '${tenantA}', '${uuidV7()}', 'approve', 'submitted',
        'approved', 'platform_staff', '${reviewer}'
      )
    `);
    await expectRoleWriteDenied(`
      insert into withdrawal_payout_snapshots (
        withdrawal_id, tenant_id, ciphertext, key_version
      ) values ('${uuidV7()}', '${tenantA}', '${'x'.repeat(50)}', 1)
    `);
    await expectRoleWriteDenied(`
      insert into payment_attempts (
        id, tenant_id, account_id, order_id, provider_id, payment_config_id,
        adapter_code_snapshot, collection_mode, status, currency, amount_minor,
        idempotency_key
      ) values (
        '${uuidV7()}', '${tenantA}', '${customerA}', '${fact?.order_id}',
        '${fact?.provider_id}', '${fact?.payment_config_id}', 'fake',
        'platform_collect', 'initialized', '${fact?.currency}', ${fact?.amount_minor},
        'tenant-forged-attempt-0001'
      )
    `);
    await expectRoleWriteDenied(`
      insert into payment_transactions (
        id, tenant_id, attempt_id, order_id, provider_id, transaction_type,
        status, external_transaction_id, currency, amount_minor, payload_hash,
        occurred_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${fact?.attempt_id}', '${fact?.order_id}',
        '${fact?.provider_id}', 'charge', 'succeeded', 'tenant-forged-charge-0001',
        '${fact?.currency}', ${fact?.amount_minor}, '${'e'.repeat(64)}',
        transaction_timestamp()
      )
    `);
    await expectRoleWriteDenied(`
      insert into payment_webhook_inbox (
        id, tenant_id, provider_id, payment_config_id, external_event_id,
        event_type, payload_hash, payload_json, signature_verified
      ) values (
        '${uuidV7()}', '${tenantA}', '${fact?.provider_id}',
        '${fact?.payment_config_id}', 'tenant-forged-event-0001',
        'payment.succeeded', '${'f'.repeat(64)}', '{"forged":true}'::jsonb, true
      )
    `);
    await expectRoleWriteDenied(`
      insert into payment_refunds (
        id, tenant_id, order_id, attempt_id, payment_transaction_id,
        status, currency, amount_minor, reason, external_refund_id,
        requested_by_type, requested_by, succeeded_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${fact?.order_id}', '${fact?.attempt_id}',
        '${fact?.payment_transaction_id}', 'succeeded', '${fact?.currency}', 1,
        'tenant forged refund', 'tenant-forged-refund-0001',
        'tenant_staff', '${applicantA}', transaction_timestamp()
      )
    `);
    await expectRoleWriteDenied(`
      insert into point_accounts (id, tenant_id, account_id)
      values ('${uuidV7()}', '${tenantA}', '${customerA}')
    `);
    await expectRoleWriteDenied(`
      insert into point_ledger (
        id, tenant_id, account_id, point_account_id, entry_type, delta,
        balance_after, reference_type, reference_id, idempotency_key,
        created_by_type
      ) values (
        '${uuidV7()}', '${tenantA}', '${customerA}', '${uuidV7()}', 'topup',
        1000, 0, 'payment_transaction', '${fact?.payment_transaction_id}',
        'tenant-forged-point-topup-0001', 'system'
      )
    `);
    await expectRoleWriteDenied(`
      insert into entitlements (
        id, tenant_id, account_id, entitlement_type, product_id,
        source_order_id, source_order_item_id, starts_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${customerA}', 'drama', '${uuidV7()}',
        '${fact?.order_id}', '${uuidV7()}', transaction_timestamp()
      )
    `);
    await expectRoleUpdateHidden(`
      update orders set status = 'refunded', version = version + 1
      where id = '${fact?.order_id}' and status = 'paid'
    `);
    await database.exec('rollback; reset role');
  });
});

async function createPaidCharge(
  collectionMode: 'platform_collect' | 'tenant_direct',
  amountMinor: number,
): Promise<string> {
  const orderId = uuidV7();
  const itemId = uuidV7();
  const attemptId = uuidV7();
  const transactionId = uuidV7();
  const orderNo = `ORD${orderId.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
  await database.exec(`
    insert into orders (
      id, tenant_id, account_id, order_no, order_type, currency,
      subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
    ) values (
      '${orderId}', '${tenantA}', '${customerA}', '${orderNo}', 'drama', 'USD',
      ${amountMinor}, ${amountMinor}, 'en-US', '{}'::jsonb,
      transaction_timestamp() + interval '1 day'
    );
    insert into order_items (
      id, tenant_id, order_id, line_no, item_type, product_id, currency,
      unit_amount_minor, total_amount_minor, product_snapshot_json
    ) values (
      '${itemId}', '${tenantA}', '${orderId}', 1, 'drama', '${uuidV7()}',
      'USD', ${amountMinor}, ${amountMinor}, '{}'::jsonb
    );
    insert into payment_attempts (
      id, tenant_id, account_id, order_id, provider_id, payment_config_id,
      adapter_code_snapshot, collection_mode, status, currency, amount_minor,
      idempotency_key
    ) values (
      '${attemptId}', '${tenantA}', '${customerA}', '${orderId}', '${providerId}',
      '${configId}', 'fake', '${collectionMode}', 'pending', 'USD', ${amountMinor},
      'finance-attempt-${attemptId}'
    );
    insert into payment_transactions (
      id, tenant_id, attempt_id, order_id, provider_id, transaction_type,
      status, external_transaction_id, currency, amount_minor, payload_hash,
      occurred_at
    ) values (
      '${transactionId}', '${tenantA}', '${attemptId}', '${orderId}', '${providerId}',
      'charge', 'succeeded', 'finance-charge-${transactionId}', 'USD', ${amountMinor},
      '${'d'.repeat(64)}', transaction_timestamp()
    );
    update payment_attempts
    set status = 'succeeded', succeeded_at = transaction_timestamp(), version = version + 1
    where id = '${attemptId}';
    update orders
    set status = 'paid', paid_at = transaction_timestamp(), version = version + 1
    where id = '${orderId}'
  `);
  return transactionId;
}

async function balances(): Promise<{
  available_minor: string;
  frozen_minor: string;
  pending_minor: string;
  withdrawn_minor: string;
}> {
  const rows = await database.query<{
    available_minor: string;
    frozen_minor: string;
    pending_minor: string;
    withdrawn_minor: string;
  }>(`
    select available_minor::text, frozen_minor::text,
      pending_minor::text, withdrawn_minor::text
    from merchant_balance_accounts where id = '${balanceAccountId}'
  `);
  return rows.rows[0] as {
    available_minor: string;
    frozen_minor: string;
    pending_minor: string;
    withdrawn_minor: string;
  };
}

function payout() {
  return {
    accountHolder: 'Finance Merchant',
    accountNumber: '1234567890123456',
    bankName: 'Finance Security Bank',
    countryCode: 'JP',
    routingCode: 'TOKYO001',
  };
}

async function expectRoleWriteDenied(sql: string): Promise<void> {
  await database.exec('savepoint finance_write_probe');
  await expect(database.exec(sql)).rejects.toThrow();
  await database.exec('rollback to savepoint finance_write_probe');
}

async function expectRoleUpdateHidden(sql: string): Promise<void> {
  await database.exec('savepoint finance_update_probe');
  const result = await database.exec(sql);
  expect(result[0]?.affectedRows).toBe(0);
  await database.exec('rollback to savepoint finance_update_probe');
}
