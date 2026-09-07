import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { amountNumber, requireUuid, signedAmountNumber } from '../commerce/commerce-validation';
import { FinancePayoutCipher, type PayoutAccountSnapshot } from './finance-payout-cipher';

type Currency = 'CNY' | 'USD' | 'EUR' | 'JPY' | 'KRW';

interface WithdrawalRow {
  amount_minor: string | number | bigint;
  applicant_staff_id: string;
  balance_account_id: string;
  bank_reference: string | null;
  cancelled_at: Date | null;
  completed_at: Date | null;
  created_at: Date;
  currency: Currency;
  fee_minor: string | number | bigint;
  id: string;
  payout_account_fingerprint: string;
  proof_media_asset_id: string | null;
  review_reason: string | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
  status: string;
  submitted_at: Date;
  tenant_id: string;
  version: number;
  withdrawal_no: string;
}

export interface WithdrawalSubmissionResponse {
  amountMinor: number;
  currency: Currency;
  id: string;
  payoutAccountFingerprint: string;
  status: 'submitted';
  version: number;
  withdrawalNo: string;
}

@Injectable()
export class FinanceService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(FinancePayoutCipher)
    private readonly payoutCipher: FinancePayoutCipher,
  ) {}

  getTenantBalances(tenantId: string) {
    requireUuid(tenantId, 'tenantId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await assertTenantAvailable(transaction, tenantId);
      const rows = await transaction<Array<{
        available_minor: string | number | bigint;
        currency: Currency;
        frozen_minor: string | number | bigint;
        pending_minor: string | number | bigint;
        updated_at: Date;
        withdrawn_minor: string | number | bigint;
      }>>`
        select currency, pending_minor, available_minor, frozen_minor,
          withdrawn_minor, updated_at
        from merchant_balance_accounts
        where tenant_id = ${tenantId}
        order by currency
      `;
      return rows.map((row) => ({
        availableMinor: amountNumber(row.available_minor),
        currency: row.currency,
        frozenMinor: amountNumber(row.frozen_minor),
        pendingMinor: amountNumber(row.pending_minor),
        updatedAt: row.updated_at.toISOString(),
        withdrawnMinor: amountNumber(row.withdrawn_minor),
      }));
    });
  }

  listTenantLedger(tenantId: string, rawQuery: Record<string, unknown>) {
    requireUuid(tenantId, 'tenantId');
    const currency = optionalCurrency(rawQuery.currency);
    const limit = listLimit(rawQuery.limit);
    const before = optionalDate(rawQuery.before);
    const beforeId = rawQuery.beforeId === undefined ? undefined : requireUuid(rawQuery.beforeId, 'beforeId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<Array<{
        balance_after_minor: string | number | bigint;
        bucket: string;
        created_at: Date;
        currency: Currency;
        delta_minor: string | number | bigint;
        entry_type: string;
        id: string;
        reference_id: string;
        reference_type: string;
      }>>`
        select id, bucket, entry_type, delta_minor, balance_after_minor,
          currency, reference_type, reference_id, created_at
        from merchant_balance_ledger
        where tenant_id = ${tenantId}
          and (${currency ?? null}::text is null or currency = ${currency ?? null})
          and (${beforeId ?? null}::uuid is not null or ${before ?? null}::timestamptz is null or created_at < ${before ?? null})
          and (${beforeId ?? null}::uuid is null or (created_at, id) < (
            select created_at, id from merchant_balance_ledger
            where id = ${beforeId ?? null}::uuid and tenant_id = ${tenantId}
          ))
        order by created_at desc, id desc
        limit ${limit}
      `;
      return rows.map((row) => ({
        balanceAfterMinor: amountNumber(row.balance_after_minor),
        bucket: row.bucket,
        createdAt: row.created_at.toISOString(),
        currency: row.currency,
        deltaMinor: signedAmountNumber(row.delta_minor),
        entryType: row.entry_type,
        id: row.id,
        referenceId: row.reference_id,
        referenceType: row.reference_type,
      }));
    });
  }

  submitWithdrawal(
    tenantId: string,
    actorId: string,
    rawInput: unknown,
    idempotencyKeyValue: unknown,
    requestId: string,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(actorId, 'actorId');
    const input = withdrawalInput(rawInput);
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    const withdrawalId = uuidV7();
    let encrypted;
    try {
      encrypted = this.payoutCipher.encrypt(input.payoutAccount, {
        tenantId,
        withdrawalId,
      });
    } catch (error) {
      if (error instanceof TypeError) throw new BadRequestException(error.message);
      throw error;
    }
    const requestHash = hashJson({
      amountMinor: input.amountMinor,
      currency: input.currency,
      payoutAccount: input.payoutAccount,
    });
    return this.database.inPlatformContext(async (transaction) => {
      await assertTenantAvailable(transaction, tenantId);
      const command = await beginCommand<WithdrawalSubmissionResponse>(
        transaction,
        tenantId,
        actorId,
        'tenant.finance.withdrawal.submit',
        idempotencyKey,
        requestHash,
      );
      if (command.cached) return command.cached;
      const staff = await transaction<{ status: string }[]>`
        select status from tenant_staff
        where tenant_id = ${tenantId} and id = ${actorId}
        for share
      `;
      if (staff[0]?.status !== 'active') throw new ConflictException('Applicant is not active');
      const accounts = await transaction<Array<{
        available_minor: string | number | bigint;
        id: string;
      }>>`
        select id, available_minor from merchant_balance_accounts
        where tenant_id = ${tenantId} and currency = ${input.currency}
        for update
      `;
      const account = accounts[0];
      if (!account || amountNumber(account.available_minor) < input.amountMinor) {
        throw new ConflictException('Available balance is insufficient');
      }
      const withdrawalNo = `WDR${withdrawalId.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
      await transaction`
        insert into withdrawals (
          id, tenant_id, balance_account_id, withdrawal_no, currency,
          amount_minor, payout_account_fingerprint, applicant_staff_id
        ) values (
          ${withdrawalId}, ${tenantId}, ${account.id}, ${withdrawalNo},
          ${input.currency}, ${input.amountMinor}, ${encrypted.fingerprint}, ${actorId}
        )
      `;
      await transaction`
        insert into withdrawal_payout_snapshots (
          withdrawal_id, tenant_id, ciphertext, key_version
        ) values (
          ${withdrawalId}, ${tenantId}, ${encrypted.ciphertext}, ${encrypted.keyVersion}
        )
      `;
      await insertBalanceEntry(transaction, {
        accountId: account.id,
        bucket: 'frozen',
        currency: input.currency,
        delta: input.amountMinor,
        entryType: 'freeze',
        idempotencyKey: `withdrawal:${withdrawalId}:freeze:frozen`,
        referenceId: withdrawalId,
        tenantId,
      });
      await insertBalanceEntry(transaction, {
        accountId: account.id,
        bucket: 'available',
        currency: input.currency,
        delta: -input.amountMinor,
        entryType: 'freeze',
        idempotencyKey: `withdrawal:${withdrawalId}:freeze:available`,
        referenceId: withdrawalId,
        tenantId,
      });
      await insertWithdrawalAction(transaction, {
        action: 'submit', actorId, actorType: 'tenant_staff', fromStatus: null,
        tenantId, toStatus: 'submitted', withdrawalId,
      });
      const response: WithdrawalSubmissionResponse = {
        amountMinor: input.amountMinor,
        currency: input.currency,
        id: withdrawalId,
        payoutAccountFingerprint: encrypted.fingerprint,
        status: 'submitted',
        version: 0,
        withdrawalNo,
      };
      await completeCommand(transaction, command.id, response, withdrawalId, 201);
      await auditAndOutbox(transaction, {
        action: 'commerce.withdrawal.submit',
        actorId,
        actorType: 'tenant_staff',
        eventType: 'WithdrawalSubmitted',
        requestId,
        tenantId,
        withdrawalId,
      });
      return response;
    });
  }

  cancelWithdrawal(
    tenantId: string,
    withdrawalId: string,
    actorId: string,
    versionValue: unknown,
    requestId: string,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(withdrawalId, 'withdrawalId');
    requireUuid(actorId, 'actorId');
    const version = requireVersion(versionValue);
    return this.database.inPlatformContext(async (transaction) => {
      const withdrawal = await lockWithdrawal(transaction, withdrawalId, tenantId);
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');
      if (
        withdrawal.status !== 'submitted'
        || withdrawal.version !== version
        || withdrawal.applicant_staff_id !== actorId
      ) {
        throw new ConflictException('Only the applicant can cancel this submitted version');
      }
      await insertBalanceEntry(transaction, {
        accountId: withdrawal.balance_account_id,
        bucket: 'available',
        currency: withdrawal.currency,
        delta: amountNumber(withdrawal.amount_minor),
        entryType: 'unfreeze',
        idempotencyKey: `withdrawal:${withdrawalId}:cancel:available`,
        referenceId: withdrawalId,
        tenantId,
      });
      await insertBalanceEntry(transaction, {
        accountId: withdrawal.balance_account_id,
        bucket: 'frozen',
        currency: withdrawal.currency,
        delta: -amountNumber(withdrawal.amount_minor),
        entryType: 'unfreeze',
        idempotencyKey: `withdrawal:${withdrawalId}:cancel:frozen`,
        referenceId: withdrawalId,
        tenantId,
      });
      await transaction`
        update withdrawals
        set status = 'cancelled', cancelled_at = transaction_timestamp(),
          version = version + 1
        where id = ${withdrawalId} and status = 'submitted' and version = ${version}
      `;
      await insertWithdrawalAction(transaction, {
        action: 'cancel', actorId, actorType: 'tenant_staff', fromStatus: 'submitted',
        tenantId, toStatus: 'cancelled', withdrawalId,
      });
      await auditAndOutbox(transaction, {
        action: 'commerce.withdrawal.cancel', actorId, actorType: 'tenant_staff',
        eventType: 'WithdrawalCancelled', requestId, tenantId, withdrawalId,
      });
      return { id: withdrawalId, status: 'cancelled' as const, version: version + 1 };
    });
  }

  listTenantWithdrawals(tenantId: string, rawQuery: Record<string, unknown>) {
    requireUuid(tenantId, 'tenantId');
    const limit = listLimit(rawQuery.limit);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<WithdrawalRow[]>`
        select * from withdrawals where tenant_id = ${tenantId}
        order by created_at desc, id desc limit ${limit}
      `;
      return rows.map(publicWithdrawal);
    });
  }

  getTenantWithdrawal(tenantId: string, withdrawalId: string) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(withdrawalId, 'withdrawalId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<WithdrawalRow[]>`
        select * from withdrawals where tenant_id = ${tenantId} and id = ${withdrawalId}
      `;
      if (!rows[0]) throw new NotFoundException('Withdrawal not found');
      const actions = await withdrawalActions(transaction, tenantId, withdrawalId);
      return { ...publicWithdrawal(rows[0]), actions };
    });
  }

  listPlatformWithdrawals(rawQuery: Record<string, unknown>) {
    const status = optionalWithdrawalStatus(rawQuery.status);
    const tenantId = optionalUuid(rawQuery.tenantId, 'tenantId');
    const limit = listLimit(rawQuery.limit);
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<WithdrawalRow[]>`
        select * from withdrawals
        where (${status ?? null}::text is null or status = ${status ?? null})
          and (${tenantId ?? null}::uuid is null or tenant_id = ${tenantId ?? null})
        order by submitted_at asc, id asc limit ${limit}
      `;
      return rows.map(publicWithdrawal);
    });
  }

  getPlatformWithdrawal(withdrawalId: string) {
    requireUuid(withdrawalId, 'withdrawalId');
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<WithdrawalRow[]>`
        select * from withdrawals where id = ${withdrawalId}
      `;
      const withdrawal = rows[0];
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');
      return {
        ...publicWithdrawal(withdrawal),
        actions: await withdrawalActions(transaction, withdrawal.tenant_id, withdrawalId),
      };
    });
  }

  getPlatformPayoutAccount(withdrawalId: string, actorId: string, requestId: string) {
    requireUuid(withdrawalId, 'withdrawalId');
    requireUuid(actorId, 'actorId');
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<WithdrawalRow[]>`
        select * from withdrawals where id = ${withdrawalId} for share
      `;
      const withdrawal = rows[0];
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');
      const snapshots = await transaction<Array<{
        ciphertext: string;
        key_version: number;
      }>>`
        select ciphertext, key_version from withdrawal_payout_snapshots
        where withdrawal_id = ${withdrawalId} and tenant_id = ${withdrawal.tenant_id}
      `;
      const snapshot = snapshots[0];
      if (!snapshot) throw new Error('Withdrawal payout snapshot is unavailable');
      const payoutAccount = this.payoutCipher.decrypt(
        snapshot.ciphertext,
        snapshot.key_version,
        { tenantId: withdrawal.tenant_id, withdrawalId },
      );
      await transaction`
        insert into audit_logs (
          id, scope_type, tenant_id, actor_type, actor_id, action,
          resource_type, resource_id, after_json, request_id
        ) values (
          ${uuidV7()}, 'platform', null, 'platform_staff', ${actorId},
          'finance.withdrawal.payout_account.view', 'withdrawal', ${withdrawalId},
          ${transaction.json({ viewed: true })}, ${requestId}
        )
      `;
      return { id: withdrawalId, payoutAccount };
    });
  }

  reviewWithdrawal(
    withdrawalId: string,
    actorId: string,
    rawInput: unknown,
    requestId: string,
  ) {
    requireUuid(withdrawalId, 'withdrawalId');
    requireUuid(actorId, 'actorId');
    const input = reviewInput(rawInput);
    return this.database.inPlatformContext(async (transaction) => {
      const withdrawal = await lockWithdrawal(transaction, withdrawalId);
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');
      if (
        !['submitted', 'reviewing'].includes(withdrawal.status)
        || withdrawal.version !== input.version
      ) throw new ConflictException('Withdrawal review version is stale');
      if (withdrawal.applicant_staff_id === actorId) {
        throw new ConflictException('The applicant cannot review their own withdrawal');
      }
      if (input.decision === 'reject') {
        await insertBalanceEntry(transaction, {
          accountId: withdrawal.balance_account_id,
          bucket: 'available',
          currency: withdrawal.currency,
          delta: amountNumber(withdrawal.amount_minor),
          entryType: 'unfreeze',
          idempotencyKey: `withdrawal:${withdrawalId}:reject:available`,
          referenceId: withdrawalId,
          tenantId: withdrawal.tenant_id,
        });
        await insertBalanceEntry(transaction, {
          accountId: withdrawal.balance_account_id,
          bucket: 'frozen',
          currency: withdrawal.currency,
          delta: -amountNumber(withdrawal.amount_minor),
          entryType: 'unfreeze',
          idempotencyKey: `withdrawal:${withdrawalId}:reject:frozen`,
          referenceId: withdrawalId,
          tenantId: withdrawal.tenant_id,
        });
      }
      const target = input.decision === 'approve' ? 'approved' : 'rejected';
      await transaction`
        update withdrawals
        set status = ${target}, reviewed_by = ${actorId},
          reviewed_at = transaction_timestamp(), review_reason = ${input.reason},
          version = version + 1
        where id = ${withdrawalId} and version = ${input.version}
      `;
      await insertWithdrawalAction(transaction, {
        action: input.decision, actorId, actorType: 'platform_staff',
        fromStatus: withdrawal.status, reason: input.reason,
        tenantId: withdrawal.tenant_id, toStatus: target, withdrawalId,
      });
      await auditAndOutbox(transaction, {
        action: `finance.withdrawal.${input.decision}`,
        actorId, actorType: 'platform_staff',
        eventType: input.decision === 'approve' ? 'WithdrawalApproved' : 'WithdrawalRejected',
        requestId, tenantId: withdrawal.tenant_id, withdrawalId,
      });
      return { id: withdrawalId, status: target, version: input.version + 1 };
    });
  }

  confirmTransfer(
    withdrawalId: string,
    actorId: string,
    rawInput: unknown,
    requestId: string,
  ) {
    requireUuid(withdrawalId, 'withdrawalId');
    requireUuid(actorId, 'actorId');
    const input = transferInput(rawInput);
    return this.database.inPlatformContext(async (transaction) => {
      const withdrawal = await lockWithdrawal(transaction, withdrawalId);
      if (!withdrawal) throw new NotFoundException('Withdrawal not found');
      if (
        !['approved', 'paying', 'failed'].includes(withdrawal.status)
        || withdrawal.version !== input.version
      ) throw new ConflictException('Withdrawal transfer version is stale');
      const proof = await transaction<Array<{
        kind: string;
        owner_tenant_id: string | null;
        owner_type: string;
        status: string;
      }>>`
        select kind, owner_type, owner_tenant_id, status from media_assets
        where id = ${input.mediaAssetId} and deleted_at is null
        for share
      `;
      const asset = proof[0];
      if (
        !asset || asset.status !== 'ready' || !['image', 'file'].includes(asset.kind)
        || (asset.owner_type === 'tenant' && asset.owner_tenant_id !== withdrawal.tenant_id)
      ) throw new BadRequestException('Transfer proof media asset is invalid');
      await insertBalanceEntry(transaction, {
        accountId: withdrawal.balance_account_id,
        bucket: 'frozen',
        currency: withdrawal.currency,
        delta: -amountNumber(withdrawal.amount_minor),
        entryType: 'withdrawal',
        idempotencyKey: `withdrawal:${withdrawalId}:paid:frozen`,
        referenceId: withdrawalId,
        tenantId: withdrawal.tenant_id,
      });
      await insertBalanceEntry(transaction, {
        accountId: withdrawal.balance_account_id,
        bucket: 'withdrawn',
        currency: withdrawal.currency,
        delta: amountNumber(withdrawal.amount_minor),
        entryType: 'withdrawal',
        idempotencyKey: `withdrawal:${withdrawalId}:paid:withdrawn`,
        referenceId: withdrawalId,
        tenantId: withdrawal.tenant_id,
      });
      await transaction`
        update withdrawals set status = 'paid', proof_media_asset_id = ${input.mediaAssetId},
          bank_reference = ${input.bankReference}, confirmed_by = ${actorId},
          completed_at = transaction_timestamp(), version = version + 1
        where id = ${withdrawalId} and version = ${input.version}
      `;
      await insertWithdrawalAction(transaction, {
        action: 'confirm_transfer', actorId, actorType: 'platform_staff',
        bankReference: input.bankReference, fromStatus: withdrawal.status,
        proofMediaAssetId: input.mediaAssetId, tenantId: withdrawal.tenant_id,
        toStatus: 'paid', withdrawalId,
      });
      await auditAndOutbox(transaction, {
        action: 'finance.withdrawal.confirm_transfer', actorId,
        actorType: 'platform_staff', eventType: 'WithdrawalPaid', requestId,
        tenantId: withdrawal.tenant_id, withdrawalId,
      });
      return { id: withdrawalId, status: 'paid' as const, version: input.version + 1 };
    });
  }

  settleDue(actorId: string, rawInput: unknown, requestId: string) {
    requireUuid(actorId, 'actorId');
    const input = settlementRunInput(rawInput);
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{
        amount_minor: string | number | bigint;
        balance_account_id: string;
        currency: Currency;
        id: string;
        tenant_id: string;
      }>>`
        select id, tenant_id, balance_account_id, currency, amount_minor
        from merchant_settlements
        where status = 'pending' and eligible_at <= transaction_timestamp()
          and (${input.tenantId ?? null}::uuid is null or tenant_id = ${input.tenantId ?? null})
          and (${input.currency ?? null}::text is null or currency = ${input.currency ?? null})
        order by eligible_at, id
        limit ${input.limit}
        for update skip locked
      `;
      for (const settlement of rows) {
        const amount = amountNumber(settlement.amount_minor);
        await insertBalanceEntry(transaction, {
          accountId: settlement.balance_account_id, bucket: 'pending',
          currency: settlement.currency, delta: -amount,
          entryType: 'settlement_available',
          idempotencyKey: `settlement:${settlement.id}:pending`,
          referenceId: settlement.id, referenceType: 'merchant_settlement',
          tenantId: settlement.tenant_id,
        });
        await insertBalanceEntry(transaction, {
          accountId: settlement.balance_account_id, bucket: 'available',
          currency: settlement.currency, delta: amount,
          entryType: 'settlement_available',
          idempotencyKey: `settlement:${settlement.id}:available`,
          referenceId: settlement.id, referenceType: 'merchant_settlement',
          tenantId: settlement.tenant_id,
        });
        await transaction`
          update merchant_settlements
          set status = 'settled', settled_at = transaction_timestamp(), version = version + 1
          where id = ${settlement.id} and status = 'pending'
        `;
        await auditAndOutbox(transaction, {
          action: 'finance.settlement.complete', actorId, actorType: 'platform_staff',
          eventType: 'MerchantSettlementCompleted', requestId,
          resourceId: settlement.id, resourceType: 'merchant_settlement',
          tenantId: settlement.tenant_id,
        });
      }
      return { settled: rows.length };
    });
  }

  upsertSettlementPolicy(
    tenantId: string,
    actorId: string,
    rawInput: unknown,
    requestId: string,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(actorId, 'actorId');
    const input = policyInput(rawInput);
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<{ version: number }[]>`
        insert into tenant_settlement_policies (
          tenant_id, currency, delay_days, created_by, updated_by
        ) values (
          ${tenantId}, ${input.currency}, ${input.delayDays}, ${actorId}, ${actorId}
        )
        on conflict (tenant_id, currency) do update
        set delay_days = excluded.delay_days, status = 'active',
          updated_by = excluded.updated_by,
          version = tenant_settlement_policies.version + 1
        returning version
      `;
      await transaction`
        insert into audit_logs (
          id, scope_type, tenant_id, actor_type, actor_id, action,
          resource_type, resource_id, after_json, request_id
        ) values (
          ${uuidV7()}, 'platform', null, 'platform_staff', ${actorId},
          'finance.settlement.policy.update', 'tenant', ${tenantId},
          ${transaction.json({ currency: input.currency, delayDays: input.delayDays })},
          ${requestId}
        )
      `;
      return { ...input, tenantId, version: rows[0]?.version ?? 0 };
    });
  }
}

async function lockWithdrawal(
  transaction: DatabaseTransaction,
  withdrawalId: string,
  tenantId?: string,
): Promise<WithdrawalRow | undefined> {
  const rows = await transaction<WithdrawalRow[]>`
    select * from withdrawals where id = ${withdrawalId}
      and (${tenantId ?? null}::uuid is null or tenant_id = ${tenantId ?? null})
    for update
  `;
  const row = rows[0];
  if (row) {
    await transaction`
      select id from merchant_balance_accounts
      where id = ${row.balance_account_id} and tenant_id = ${row.tenant_id}
      for update
    `;
  }
  return row;
}

async function insertBalanceEntry(
  transaction: DatabaseTransaction,
  input: {
    accountId: string;
    bucket: string;
    currency: Currency;
    delta: number;
    entryType: string;
    idempotencyKey: string;
    referenceId: string;
    referenceType?: string;
    tenantId: string;
  },
): Promise<void> {
  await transaction`
    insert into merchant_balance_ledger (
      id, tenant_id, balance_account_id, bucket, entry_type,
      delta_minor, balance_after_minor, currency, reference_type,
      reference_id, idempotency_key
    ) values (
      ${uuidV7()}, ${input.tenantId}, ${input.accountId}, ${input.bucket},
      ${input.entryType}, ${input.delta}, 0, ${input.currency},
      ${input.referenceType ?? 'withdrawal'}, ${input.referenceId}, ${input.idempotencyKey}
    )
    on conflict (tenant_id, idempotency_key) do nothing
  `;
}

async function insertWithdrawalAction(
  transaction: DatabaseTransaction,
  input: {
    action: string;
    actorId: string;
    actorType: string;
    bankReference?: string;
    fromStatus: string | null;
    proofMediaAssetId?: string;
    reason?: string | null;
    tenantId: string;
    toStatus: string;
    withdrawalId: string;
  },
): Promise<void> {
  await transaction`
    insert into withdrawal_actions (
      id, tenant_id, withdrawal_id, action, from_status, to_status,
      actor_type, actor_id, reason, proof_media_asset_id, bank_reference
    ) values (
      ${uuidV7()}, ${input.tenantId}, ${input.withdrawalId}, ${input.action},
      ${input.fromStatus}, ${input.toStatus}, ${input.actorType}, ${input.actorId},
      ${input.reason ?? null}, ${input.proofMediaAssetId ?? null},
      ${input.bankReference ?? null}
    )
  `;
}

async function auditAndOutbox(
  transaction: DatabaseTransaction,
  input: {
    action: string;
    actorId: string;
    actorType: 'platform_staff' | 'tenant_staff';
    eventType: string;
    requestId: string;
    resourceId?: string;
    resourceType?: 'merchant_settlement' | 'withdrawal';
    tenantId: string;
    withdrawalId?: string;
  },
): Promise<void> {
  const resourceId = input.resourceId ?? input.withdrawalId;
  const resourceType = input.resourceType ?? 'withdrawal';
  if (!resourceId) throw new Error('Finance audit resource is required');
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, request_id
    ) values (
      ${uuidV7()}, ${input.actorType === 'platform_staff' ? 'platform' : 'tenant'},
      ${input.actorType === 'platform_staff' ? null : input.tenantId},
      ${input.actorType}, ${input.actorId}, ${input.action}, ${resourceType},
      ${resourceId}, ${transaction.json({ statusChanged: true })},
      ${input.requestId}
    )
  `;
  const eventId = uuidV7();
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key,
      aggregate_type, aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, 'tenant', ${input.tenantId}, ${`event:${eventId}`},
      ${`${input.eventType}:${resourceId}`}, ${resourceType},
      ${resourceId}, ${input.eventType},
      ${transaction.json({ resourceId, resourceType, tenantId: input.tenantId })}
    ) on conflict do nothing
  `;
}

async function assertTenantAvailable(
  transaction: DatabaseTransaction,
  tenantId: string,
): Promise<void> {
  const rows = await transaction<{ available: boolean }[]>`
    select status = 'active' and expires_at > transaction_timestamp() as available
    from tenants where id = ${tenantId} for share
  `;
  if (!rows[0]?.available) throw new ConflictException('Tenant is not available');
}

async function beginCommand<T>(
  transaction: DatabaseTransaction,
  tenantId: string,
  actorId: string,
  routeKey: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ cached?: T; id: string }> {
  const id = uuidV7();
  const inserted = await transaction<{ id: string }[]>`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, expires_at
    ) values (
      ${id}, 'tenant', ${tenantId}, 'tenant_staff', ${actorId}, ${routeKey},
      ${idempotencyKey}, ${requestHash}, transaction_timestamp() + interval '24 hours'
    ) on conflict do nothing returning id
  `;
  if (inserted[0]) return { id };
  const rows = await transaction<Array<{
    id: string;
    request_hash: string;
    response_json: Record<string, unknown> | null;
    status: string;
  }>>`
    select id, request_hash, response_json, status from command_idempotency
    where scope_type = 'tenant' and tenant_id = ${tenantId}
      and actor_type = 'tenant_staff' and actor_id = ${actorId}
      and route_key = ${routeKey} and idempotency_key = ${idempotencyKey}
    for update
  `;
  const row = rows[0];
  if (!row || row.request_hash !== requestHash) {
    throw new ConflictException('Idempotency-Key was used for another request');
  }
  if (row.status === 'completed' && row.response_json) {
    return { cached: row.response_json as T, id: row.id };
  }
  throw new ConflictException('The same withdrawal is already processing');
}

async function completeCommand(
  transaction: DatabaseTransaction,
  id: string,
  response: unknown,
  resourceId: string,
  status: number,
): Promise<void> {
  await transaction`
    update command_idempotency set status = 'completed', response_status = ${status},
      response_json = ${transaction.json(toJson(response))}, resource_type = 'withdrawal',
      resource_id = ${resourceId}, locked_at = null
    where id = ${id} and status = 'processing'
  `;
}

async function withdrawalActions(
  transaction: DatabaseTransaction,
  tenantId: string,
  withdrawalId: string,
) {
  const rows = await transaction<Array<{
    action: string;
    actor_id: string;
    actor_type: string;
    bank_reference: string | null;
    created_at: Date;
    from_status: string | null;
    proof_media_asset_id: string | null;
    reason: string | null;
    to_status: string;
  }>>`
    select action, from_status, to_status, actor_type, actor_id, reason,
      proof_media_asset_id, bank_reference, created_at
    from withdrawal_actions where tenant_id = ${tenantId} and withdrawal_id = ${withdrawalId}
    order by created_at, id
  `;
  return rows.map((row) => ({
    action: row.action,
    actorId: row.actor_id,
    actorType: row.actor_type,
    bankReference: row.bank_reference,
    createdAt: row.created_at.toISOString(),
    fromStatus: row.from_status,
    proofMediaAssetId: row.proof_media_asset_id,
    reason: row.reason,
    toStatus: row.to_status,
  }));
}

function publicWithdrawal(row: WithdrawalRow) {
  return {
    amountMinor: amountNumber(row.amount_minor),
    applicantStaffId: row.applicant_staff_id,
    bankReference: row.bank_reference,
    cancelledAt: row.cancelled_at?.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    currency: row.currency,
    feeMinor: amountNumber(row.fee_minor),
    id: row.id,
    payoutAccountFingerprint: row.payout_account_fingerprint,
    proofMediaAssetId: row.proof_media_asset_id,
    reviewReason: row.review_reason,
    reviewedAt: row.reviewed_at?.toISOString(),
    reviewedBy: row.reviewed_by,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    tenantId: row.tenant_id,
    version: row.version,
    withdrawalNo: row.withdrawal_no,
  };
}

function withdrawalInput(raw: unknown): {
  amountMinor: number;
  currency: Currency;
  payoutAccount: PayoutAccountSnapshot;
} {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Body is required');
  }
  const value = raw as Record<string, unknown>;
  return {
    amountMinor: positiveAmount(value.amountMinor),
    currency: requireCurrency(value.currency),
    payoutAccount: value.payoutAccount as PayoutAccountSnapshot,
  };
}

function reviewInput(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Body is required');
  }
  const value = raw as Record<string, unknown>;
  if (value.decision !== 'approve' && value.decision !== 'reject') {
    throw new BadRequestException('decision is invalid');
  }
  const reason = value.decision === 'reject' ? boundedText(value.reason, 'reason', 2, 2000) : null;
  return { decision: value.decision, reason, version: requireVersion(value.version) };
}

function transferInput(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Body is required');
  }
  const value = raw as Record<string, unknown>;
  const mediaAssetId = boundedText(value.mediaAssetId, 'mediaAssetId', 36, 36);
  requireUuid(mediaAssetId, 'mediaAssetId');
  return {
    bankReference: boundedText(value.bankReference, 'bankReference', 3, 200),
    mediaAssetId,
    version: requireVersion(value.version),
  };
}

function settlementRunInput(raw: unknown) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    currency: optionalCurrency(value.currency),
    limit: listLimit(value.limit),
    tenantId: optionalUuid(value.tenantId, 'tenantId'),
  };
}

function policyInput(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Body is required');
  }
  const value = raw as Record<string, unknown>;
  if (!Number.isInteger(value.delayDays) || Number(value.delayDays) < 0 || Number(value.delayDays) > 90) {
    throw new BadRequestException('delayDays is invalid');
  }
  return { currency: requireCurrency(value.currency), delayDays: Number(value.delayDays) };
}

function positiveAmount(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 9_000_000_000_000_000) {
    throw new BadRequestException('amountMinor is invalid');
  }
  return Number(value);
}

function requireCurrency(value: unknown): Currency {
  if (!['CNY', 'USD', 'EUR', 'JPY', 'KRW'].includes(String(value))) {
    throw new BadRequestException('currency is invalid');
  }
  return value as Currency;
}

function optionalCurrency(value: unknown): Currency | undefined {
  return value === undefined ? undefined : requireCurrency(value);
}

function requireVersion(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new BadRequestException('version is invalid');
  }
  return Number(value);
}

function listLimit(value: unknown): number {
  if (value === undefined) return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new BadRequestException('limit is invalid');
  }
  return parsed;
}

function optionalDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequestException('before is invalid');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException('before is invalid');
  return date;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} is invalid`);
  requireUuid(value, field);
  return value;
}

function optionalWithdrawalStatus(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const statuses = ['submitted', 'reviewing', 'approved', 'rejected', 'cancelled', 'paying', 'paid', 'failed'];
  if (!statuses.includes(String(value))) throw new BadRequestException('status is invalid');
  return String(value);
}

function boundedText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is invalid`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum || /[\u0000\r\n]/.test(normalized)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return normalized;
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.trim())) {
    throw new BadRequestException('A valid Idempotency-Key header is required');
  }
  return value.trim();
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
