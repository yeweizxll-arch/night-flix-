import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { amountNumber, requireUuid, signedAmountNumber } from '../commerce/commerce-validation';

const ORDER_TYPES = ['membership', 'drama', 'episode', 'points_topup'] as const;
type ReferralOrderType = (typeof ORDER_TYPES)[number];

export interface ReferralConfigResponse {
  applicableOrderTypes: ReferralOrderType[];
  commissionBps: number;
  enabled: boolean;
  settlementDays: number;
  version: number;
}

export interface ReferralCodeResponse {
  code: string;
  createdAt: string;
}

export interface ReferralBindingResponse {
  boundAt: string;
  inviterAccountId: string;
}

interface CommandRow<T> {
  id: string;
  request_hash: string;
  response_json: T | null;
  status: 'completed' | 'failed' | 'processing';
}

interface CommissionSourceRow {
  applicable_order_types: ReferralOrderType[];
  commission_bps: number;
  config_version: number;
  currency: string;
  inviter_account_id: string;
  order_total_minor: string | number | bigint;
  order_type: ReferralOrderType;
  referral_id: string;
  settlement_days: number;
}

@Injectable()
export class ReferralService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  getTenantConfig(tenantId: string): Promise<ReferralConfigResponse> {
    requireUuid(tenantId, 'tenantId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<Array<{
        applicable_order_types: ReferralOrderType[];
        commission_bps: number;
        enabled: boolean;
        settlement_days: number;
        version: number;
      }>>`
        select enabled, commission_bps, settlement_days,
          applicable_order_types, version
        from tenant_referral_configs
        where tenant_id = ${tenantId}
      `;
      return rows[0] ? mapConfig(rows[0]) : defaultConfig();
    });
  }

  upsertTenantConfig(
    tenantId: string,
    actorId: string,
    rawInput: unknown,
    requestId: string,
  ): Promise<ReferralConfigResponse> {
    requireUuid(tenantId, 'tenantId');
    requireUuid(actorId, 'actorId');
    const input = parseConfig(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const existing = await transaction<Array<{ version: number }>>`
        select version from tenant_referral_configs
        where tenant_id = ${tenantId}
        for update
      `;
      if (existing[0] && existing[0].version !== input.version) {
        throw new ConflictException('Referral config was changed by another operator');
      }
      if (!existing[0] && input.version !== 0) {
        throw new ConflictException('Referral config version must start at zero');
      }
      const rows = existing[0]
        ? await transaction<Array<{
            applicable_order_types: ReferralOrderType[];
            commission_bps: number;
            enabled: boolean;
            settlement_days: number;
            version: number;
          }>>`
            update tenant_referral_configs
            set enabled = ${input.enabled}, commission_bps = ${input.commissionBps},
              settlement_days = ${input.settlementDays},
              applicable_order_types = ${input.applicableOrderTypes},
              version = version + 1, updated_by = ${actorId}
            where tenant_id = ${tenantId} and version = ${input.version}
            returning enabled, commission_bps, settlement_days,
              applicable_order_types, version
          `
        : await transaction<Array<{
            applicable_order_types: ReferralOrderType[];
            commission_bps: number;
            enabled: boolean;
            settlement_days: number;
            version: number;
          }>>`
            insert into tenant_referral_configs (
              tenant_id, enabled, commission_bps, settlement_days,
              applicable_order_types, created_by, updated_by
            ) values (
              ${tenantId}, ${input.enabled}, ${input.commissionBps},
              ${input.settlementDays}, ${input.applicableOrderTypes},
              ${actorId}, ${actorId}
            )
            returning enabled, commission_bps, settlement_days,
              applicable_order_types, version
          `;
      const updated = rows[0];
      if (!updated) throw new ConflictException('Referral config update lost its lock');
      const response = mapConfig(updated);
      await transaction`
        insert into audit_logs (
          id, scope_type, tenant_id, actor_type, actor_id, action,
          resource_type, resource_id, after_json, request_id
        ) values (
          ${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff', ${actorId},
          'commerce.referral.config.update', 'tenant', ${tenantId},
          ${transaction.json(toJsonValue(response))}, ${requestId}
        )
      `;
      const eventId = uuidV7();
      await transaction`
        insert into outbox_events (
          id, scope_type, tenant_id, event_key, idempotency_key,
          aggregate_type, aggregate_id, event_type, payload_json
        ) values (
          ${eventId}, 'tenant', ${tenantId}, ${`event:${eventId}`},
          ${`ReferralConfigUpdated:${tenantId}:v${response.version}`},
          'tenant_referral_config', ${tenantId}, 'ReferralConfigUpdated',
          ${transaction.json(toJsonValue({ ...response, tenantId }))}
        )
      `;
      return response;
    });
  }

  getCustomerSummary(principal: CustomerPrincipal) {
    assertPrincipal(principal);
    return this.database.inPlatformContext(async (transaction) => {
      await assertCustomerAvailable(transaction, principal, false);
      const codes = await transaction<Array<{ code: string; created_at: Date }>>`
        select code, created_at from customer_referral_codes
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
      `;
      const bindings = await transaction<Array<{
        bound_at: Date;
        inviter_account_id: string;
      }>>`
        select bound_at, inviter_account_id from customer_referrals
        where tenant_id = ${principal.tenantId}
          and invitee_account_id = ${principal.accountId}
      `;
      const balances = await transaction<Array<{
        available_minor: string | number | bigint;
        currency: string;
        pending_minor: string | number | bigint;
        withdrawn_minor: string | number | bigint;
      }>>`
        select currency, pending_minor, available_minor, withdrawn_minor
        from referral_commission_accounts
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
        order by currency
      `;
      return {
        balances: balances.map((row) => ({
          availableMinor: amountNumber(row.available_minor),
          currency: row.currency,
          pendingMinor: amountNumber(row.pending_minor),
          withdrawnMinor: amountNumber(row.withdrawn_minor),
        })),
        binding: bindings[0]
          ? {
              boundAt: bindings[0].bound_at.toISOString(),
              inviterAccountId: bindings[0].inviter_account_id,
            }
          : null,
        inviteCode: codes[0]
          ? { code: codes[0].code, createdAt: codes[0].created_at.toISOString() }
          : null,
      };
    });
  }

  createInviteCode(
    principal: CustomerPrincipal,
    idempotencyKeyValue: unknown,
    requestId: string,
  ): Promise<ReferralCodeResponse> {
    assertPrincipal(principal);
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    return this.database.inPlatformContext(async (transaction) => {
      await assertCustomerAvailable(transaction, principal, true);
      const command = await beginCommand<ReferralCodeResponse>(
        transaction,
        principal,
        'customer.referral.invite_code.create',
        idempotencyKey,
        hashRequest({}),
      );
      if (command.cached) return command.cached;
      const existing = await transaction<Array<{ code: string; created_at: Date; id: string }>>`
        select id, code, created_at from customer_referral_codes
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
        for update
      `;
      let row = existing[0];
      for (let attempt = 0; !row && attempt < 5; attempt += 1) {
        const inserted = await transaction<Array<{ code: string; created_at: Date; id: string }>>`
          insert into customer_referral_codes (id, tenant_id, account_id, code)
          values (
            ${uuidV7()}, ${principal.tenantId}, ${principal.accountId},
            ${generateReferralCode()}
          )
          on conflict do nothing
          returning id, code, created_at
        `;
        row = inserted[0];
      }
      if (!row) throw new ConflictException('A unique invite code could not be allocated');
      const response = { code: row.code, createdAt: row.created_at.toISOString() };
      await completeCommand(transaction, command.id, response, row.id, 'referral_code');
      await insertCustomerAuditAndOutbox(
        transaction,
        principal,
        'commerce.referral.invite_code.create',
        'referral_code',
        row.id,
        'ReferralInviteCodeCreated',
        response,
        requestId,
      );
      return response;
    });
  }

  bindReferral(
    principal: CustomerPrincipal,
    rawInput: unknown,
    idempotencyKeyValue: unknown,
    requestId: string,
  ): Promise<ReferralBindingResponse> {
    assertPrincipal(principal);
    const code = parseReferralCode(rawInput);
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    return this.database.inPlatformContext(async (transaction) => {
      await assertCustomerAvailable(transaction, principal, true);
      const command = await beginCommand<ReferralBindingResponse>(
        transaction,
        principal,
        'customer.referral.bind',
        idempotencyKey,
        hashRequest({ code }),
      );
      if (command.cached) return command.cached;
      const codeRows = await transaction<Array<{
        account_id: string;
        id: string;
      }>>`
        select id, account_id from customer_referral_codes
        where tenant_id = ${principal.tenantId} and code = ${code}
        for share
      `;
      const selectedCode = codeRows[0];
      if (!selectedCode) throw new NotFoundException('Invite code was not found');
      if (selectedCode.account_id === principal.accountId) {
        throw new ConflictException('Customers cannot invite themselves');
      }
      const existing = await transaction<Array<{
        bound_at: Date;
        id: string;
        inviter_account_id: string;
      }>>`
        select id, inviter_account_id, bound_at from customer_referrals
        where tenant_id = ${principal.tenantId}
          and invitee_account_id = ${principal.accountId}
        for update
      `;
      if (existing[0]?.inviter_account_id !== undefined) {
        if (existing[0].inviter_account_id !== selectedCode.account_id) {
          throw new ConflictException('A referral relationship is already bound');
        }
        const response = {
          boundAt: existing[0].bound_at.toISOString(),
          inviterAccountId: existing[0].inviter_account_id,
        };
        await completeCommand(
          transaction,
          command.id,
          response,
          existing[0].id,
          'customer_referral',
        );
        return response;
      }
      const rows = await transaction<Array<{
        bound_at: Date;
        id: string;
        inviter_account_id: string;
      }>>`
        insert into customer_referrals (
          id, tenant_id, invitee_account_id, inviter_account_id, referral_code_id
        ) values (
          ${uuidV7()}, ${principal.tenantId}, ${principal.accountId},
          ${selectedCode.account_id}, ${selectedCode.id}
        )
        returning id, inviter_account_id, bound_at
      `;
      const relationship = rows[0];
      if (!relationship) throw new ConflictException('Referral binding was not created');
      const response = {
        boundAt: relationship.bound_at.toISOString(),
        inviterAccountId: relationship.inviter_account_id,
      };
      await completeCommand(
        transaction,
        command.id,
        response,
        relationship.id,
        'customer_referral',
      );
      await insertCustomerAuditAndOutbox(
        transaction,
        principal,
        'commerce.referral.bind',
        'customer_referral',
        relationship.id,
        'CustomerReferralBound',
        response,
        requestId,
      );
      return response;
    });
  }

  listCustomerLedger(
    principal: CustomerPrincipal,
    rawQuery: Record<string, unknown>,
  ) {
    assertPrincipal(principal);
    const page = pageNumber(rawQuery.page, 1);
    const pageSize = pageNumber(rawQuery.pageSize, 20, 100);
    const offset = (page - 1) * pageSize;
    return this.database.inPlatformContext(async (transaction) => {
      await assertCustomerAvailable(transaction, principal, false);
      const rows = await transaction<Array<{
        bucket: string;
        commission_id: string;
        created_at: Date;
        currency: string;
        delta_minor: string | number | bigint;
        entry_type: string;
        id: string;
      }>>`
        select ledger.id, ledger.commission_id, ledger.bucket, ledger.entry_type,
          ledger.currency, ledger.delta_minor, ledger.created_at
        from referral_commission_ledger as ledger
        inner join referral_commission_accounts as account
          on account.id = ledger.commission_account_id
          and account.tenant_id = ledger.tenant_id
        where ledger.tenant_id = ${principal.tenantId}
          and account.account_id = ${principal.accountId}
        order by ledger.created_at desc, ledger.id desc
        limit ${pageSize} offset ${offset}
      `;
      return {
        items: rows.map((row) => ({
          bucket: row.bucket,
          commissionId: row.commission_id,
          createdAt: row.created_at.toISOString(),
          currency: row.currency,
          deltaMinor: signedAmountNumber(row.delta_minor),
          entryType: row.entry_type,
          id: row.id,
        })),
        page,
        pageSize,
      };
    });
  }

  listTenantCommissions(tenantId: string, rawQuery: Record<string, unknown>) {
    requireUuid(tenantId, 'tenantId');
    const page = pageNumber(rawQuery.page, 1);
    const pageSize = pageNumber(rawQuery.pageSize, 20, 100);
    const offset = (page - 1) * pageSize;
    const status = rawQuery.status === undefined ? null : rawQuery.status;
    if (status !== null && !['pending', 'available', 'reversed'].includes(String(status))) {
      throw new BadRequestException('status is invalid');
    }
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<Array<{
        commission_bps_snapshot: number;
        commission_minor: string | number | bigint;
        created_at: Date;
        currency: string;
        eligible_at: Date;
        id: string;
        invitee_account_id: string;
        inviter_account_id: string;
        order_id: string;
        order_total_minor_snapshot: string | number | bigint;
        order_type_snapshot: string;
        status: string;
      }>>`
        select id, invitee_account_id, inviter_account_id, order_id,
          order_type_snapshot, currency, order_total_minor_snapshot,
          commission_bps_snapshot, commission_minor, eligible_at, status, created_at
        from referral_commissions
        where tenant_id = ${tenantId}
          and (${status === null} or status = ${status === null ? '' : String(status)})
        order by created_at desc, id desc
        limit ${pageSize} offset ${offset}
      `;
      return {
        items: rows.map((row) => ({
          commissionBps: row.commission_bps_snapshot,
          commissionMinor: amountNumber(row.commission_minor),
          createdAt: row.created_at.toISOString(),
          currency: row.currency,
          eligibleAt: row.eligible_at.toISOString(),
          id: row.id,
          inviteeAccountId: row.invitee_account_id,
          inviterAccountId: row.inviter_account_id,
          orderId: row.order_id,
          orderTotalMinor: amountNumber(row.order_total_minor_snapshot),
          orderType: row.order_type_snapshot,
          status: row.status,
        })),
        page,
        pageSize,
      };
    });
  }

  async recordPaidOrderCommission(
    transaction: DatabaseTransaction,
    input: {
      accountId: string;
      orderId: string;
      paymentTransactionId: string;
      tenantId: string;
    },
  ): Promise<string | null> {
    const sources = await transaction<CommissionSourceRow[]>`
      select
        config.version as config_version,
        config.commission_bps,
        config.settlement_days,
        config.applicable_order_types,
        relationship.id as referral_id,
        relationship.inviter_account_id,
        commerce_order.order_type,
        commerce_order.currency,
        commerce_order.total_minor as order_total_minor
      from orders as commerce_order
      inner join tenant_referral_configs as config
        on config.tenant_id = commerce_order.tenant_id
        and config.enabled
        and commerce_order.order_type = any(config.applicable_order_types)
      inner join customer_referrals as relationship
        on relationship.tenant_id = commerce_order.tenant_id
        and relationship.invitee_account_id = commerce_order.account_id
        and relationship.bound_at <= commerce_order.paid_at
      where commerce_order.id = ${input.orderId}
        and commerce_order.tenant_id = ${input.tenantId}
        and commerce_order.account_id = ${input.accountId}
        and commerce_order.status = 'paid'
      for share of config, relationship
    `;
    const source = sources[0];
    if (!source) return null;
    const total = BigInt(source.order_total_minor);
    const commission = total * BigInt(source.commission_bps) / 10_000n;
    if (commission === 0n) return null;
    if (commission > 9_000_000_000_000_000n) {
      throw new Error('Referral commission amount overflow');
    }
    const commissionMinor = Number(commission);
    const newAccountId = uuidV7();
    await transaction`
      insert into referral_commission_accounts (
        id, tenant_id, account_id, currency
      ) values (
        ${newAccountId}, ${input.tenantId}, ${source.inviter_account_id},
        ${source.currency}
      ) on conflict (tenant_id, account_id, currency) do nothing
    `;
    const accounts = await transaction<Array<{ id: string }>>`
      select id from referral_commission_accounts
      where tenant_id = ${input.tenantId}
        and account_id = ${source.inviter_account_id}
        and currency = ${source.currency}
      for update
    `;
    const commissionAccountId = accounts[0]?.id;
    if (!commissionAccountId) throw new Error('Referral commission account is unavailable');
    const commissionId = uuidV7();
    const rows = await transaction<Array<{ id: string }>>`
      insert into referral_commissions (
        id, tenant_id, referral_id, invitee_account_id, inviter_account_id,
        commission_account_id, order_id, payment_transaction_id,
        config_version_snapshot, commission_bps_snapshot,
        settlement_days_snapshot, order_type_snapshot, currency,
        order_total_minor_snapshot, commission_minor, eligible_at
      ) values (
        ${commissionId}, ${input.tenantId}, ${source.referral_id}, ${input.accountId},
        ${source.inviter_account_id}, ${commissionAccountId}, ${input.orderId},
        ${input.paymentTransactionId}, ${source.config_version},
        ${source.commission_bps}, ${source.settlement_days}, ${source.order_type},
        ${source.currency}, ${Number(total)}, ${commissionMinor},
        transaction_timestamp() + ${source.settlement_days} * interval '1 day'
      )
      on conflict (order_id) do nothing
      returning id
    `;
    if (!rows[0]) {
      const existing = await transaction<Array<{
        id: string;
        payment_transaction_id: string;
      }>>`
        select id, payment_transaction_id from referral_commissions
        where order_id = ${input.orderId} and tenant_id = ${input.tenantId}
      `;
      if (existing[0]?.payment_transaction_id !== input.paymentTransactionId) {
        throw new ConflictException('Paid order already has a different commission fact');
      }
      return existing[0]?.id ?? null;
    }
    await transaction`
      insert into referral_commission_ledger (
        id, tenant_id, commission_account_id, commission_id, bucket,
        entry_type, currency, delta_minor, balance_after_minor, idempotency_key
      ) values (
        ${uuidV7()}, ${input.tenantId}, ${commissionAccountId}, ${commissionId},
        'pending', 'commission_pending', ${source.currency}, ${commissionMinor}, 0,
        ${`referral:${commissionId}:pending`}
      )
    `;
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, action, resource_type,
        resource_id, after_json, request_id
      ) values (
        ${uuidV7()}, 'tenant', ${input.tenantId}, 'system',
        'commerce.referral.commission.create', 'referral_commission',
        ${commissionId}, ${transaction.json({
          commissionMinor,
          currency: source.currency,
          inviteeAccountId: input.accountId,
          inviterAccountId: source.inviter_account_id,
          orderId: input.orderId,
        })}, ${`payment:${input.paymentTransactionId}`}
      )
    `;
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, 'tenant', ${input.tenantId}, ${`event:${eventId}`},
        ${`ReferralCommissionCreated:${commissionId}`}, 'referral_commission',
        ${commissionId}, 'ReferralCommissionCreated',
        ${transaction.json({
          commissionId,
          commissionMinor,
          currency: source.currency,
          inviterAccountId: source.inviter_account_id,
          orderId: input.orderId,
          tenantId: input.tenantId,
        })}
      )
    `;
    return commissionId;
  }
}

@Injectable()
export class ReferralSettlementWorkerService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  settleDue(limitValue: unknown = 100): Promise<{ settled: number }> {
    const limit = pageNumber(limitValue, 100, 500);
    return this.database.inPlatformContext(async (transaction) => {
      const due = await transaction<Array<{
        commission_account_id: string;
        commission_minor: string | number | bigint;
        currency: string;
        id: string;
        tenant_id: string;
      }>>`
        select id, tenant_id, commission_account_id, currency, commission_minor
        from referral_commissions
        where status = 'pending' and eligible_at <= transaction_timestamp()
        order by eligible_at, created_at, id
        limit ${limit}
        for update skip locked
      `;
      for (const commission of due) {
        const amount = amountNumber(commission.commission_minor);
        const updated = await transaction<Array<{ id: string }>>`
          update referral_commissions
          set status = 'available', available_at = transaction_timestamp()
          where id = ${commission.id} and status = 'pending'
            and eligible_at <= transaction_timestamp()
          returning id
        `;
        if (!updated[0]) continue;
        await transaction`
          insert into referral_commission_ledger (
            id, tenant_id, commission_account_id, commission_id, bucket,
            entry_type, currency, delta_minor, balance_after_minor, idempotency_key
          ) values (
            ${uuidV7()}, ${commission.tenant_id}, ${commission.commission_account_id},
            ${commission.id}, 'pending', 'settlement_pending_debit',
            ${commission.currency}, ${-amount}, 0,
            ${`referral:${commission.id}:settle:pending`}
          )
        `;
        await transaction`
          insert into referral_commission_ledger (
            id, tenant_id, commission_account_id, commission_id, bucket,
            entry_type, currency, delta_minor, balance_after_minor, idempotency_key
          ) values (
            ${uuidV7()}, ${commission.tenant_id}, ${commission.commission_account_id},
            ${commission.id}, 'available', 'settlement_available_credit',
            ${commission.currency}, ${amount}, 0,
            ${`referral:${commission.id}:settle:available`}
          )
        `;
        const eventId = uuidV7();
        await transaction`
          insert into outbox_events (
            id, scope_type, tenant_id, event_key, idempotency_key,
            aggregate_type, aggregate_id, event_type, payload_json
          ) values (
            ${eventId}, 'tenant', ${commission.tenant_id}, ${`event:${eventId}`},
            ${`ReferralCommissionAvailable:${commission.id}`},
            'referral_commission', ${commission.id}, 'ReferralCommissionAvailable',
            ${transaction.json({
              commissionId: commission.id,
              currency: commission.currency,
              tenantId: commission.tenant_id,
            })}
          )
        `;
        await transaction`
          insert into audit_logs (
            id, scope_type, tenant_id, actor_type, action,
            resource_type, resource_id, after_json, request_id
          ) values (
            ${uuidV7()}, 'tenant', ${commission.tenant_id}, 'system',
            'commerce.referral.commission.settle', 'referral_commission',
            ${commission.id}, ${transaction.json({
              currency: commission.currency,
              status: 'available',
            })}, ${`referral-settlement:${commission.id}`}
          )
        `;
      }
      return { settled: due.length };
    });
  }
}

async function assertCustomerAvailable(
  transaction: DatabaseTransaction,
  principal: CustomerPrincipal,
  lock: boolean,
): Promise<void> {
  const tenants = await transaction<{ id: string }[]>`
    select id from tenants
    where id = ${principal.tenantId} and status = 'active'
      and expires_at > transaction_timestamp()
      and user_site_enabled
      and platform_site_enabled
    for share
  `;
  if (!tenants[0]) throw new ConflictException('Tenant or customer is not available');
  const customers = lock
    ? await transaction<{ id: string }[]>`
        select id from customer_accounts
        where tenant_id = ${principal.tenantId} and id = ${principal.accountId}
          and status = 'active'
        for update
      `
    : await transaction<{ id: string }[]>`
        select id from customer_accounts
        where tenant_id = ${principal.tenantId} and id = ${principal.accountId}
          and status = 'active'
      `;
  if (!customers[0]) throw new ConflictException('Tenant or customer is not available');
}

async function beginCommand<T>(
  transaction: DatabaseTransaction,
  principal: CustomerPrincipal,
  routeKey: string,
  idempotencyKey: string,
  requestHash: string,
): Promise<{ cached?: T; id: string }> {
  const id = uuidV7();
  await transaction`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, status, locked_at, expires_at
    ) values (
      ${id}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
      ${routeKey}, ${idempotencyKey}, ${requestHash}, 'processing',
      transaction_timestamp(), transaction_timestamp() + interval '24 hours'
    ) on conflict do nothing
  `;
  const rows = await transaction<CommandRow<T>[]>`
    select id, request_hash, response_json, status from command_idempotency
    where scope_type = 'tenant' and tenant_id = ${principal.tenantId}
      and actor_type = 'user' and actor_id = ${principal.accountId}
      and route_key = ${routeKey} and idempotency_key = ${idempotencyKey}
    for update
  `;
  const command = rows[0];
  if (!command) throw new ConflictException('Idempotency command is unavailable');
  if (command.request_hash !== requestHash) {
    throw new ConflictException('Idempotency-Key was already used for another request');
  }
  if (command.status === 'completed') {
    if (!command.response_json) throw new Error('Completed command response is unavailable');
    return { cached: command.response_json, id: command.id };
  }
  if (command.id !== id) {
    throw new ConflictException('Idempotent command is already processing');
  }
  return { id: command.id };
}

async function completeCommand<T>(
  transaction: DatabaseTransaction,
  commandId: string,
  response: T,
  resourceId: string | null,
  resourceType: string,
): Promise<void> {
  await transaction`
    update command_idempotency
    set status = 'completed', response_status = 200,
      response_json = ${transaction.json(toJsonValue(response))},
      resource_type = ${resourceType}, resource_id = ${resourceId}, locked_at = null
    where id = ${commandId} and status = 'processing'
  `;
}

async function insertCustomerAuditAndOutbox(
  transaction: DatabaseTransaction,
  principal: CustomerPrincipal,
  action: string,
  resourceType: string,
  resourceId: string | null,
  eventType: string,
  payload: unknown,
  requestId: string,
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, request_id
    ) values (
      ${uuidV7()}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
      ${action}, ${resourceType}, ${resourceId},
      ${transaction.json(toJsonValue(payload))}, ${requestId}
    )
  `;
  const eventId = uuidV7();
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key,
      aggregate_type, aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, 'tenant', ${principal.tenantId}, ${`event:${eventId}`},
      ${`${eventType}:${resourceId ?? principal.accountId}`}, ${resourceType},
      ${resourceId ?? principal.accountId}, ${eventType},
      ${transaction.json(toJsonValue({
        accountId: principal.accountId,
        ...asRecord(payload),
        tenantId: principal.tenantId,
      }))}
    ) on conflict do nothing
  `;
}

function parseConfig(rawInput: unknown): ReferralConfigResponse {
  const input = asRecord(rawInput);
  if (typeof input.enabled !== 'boolean') {
    throw new BadRequestException('enabled must be a boolean');
  }
  const commissionBps = integer(input.commissionBps, 'commissionBps', 0, 10_000);
  const settlementDays = integer(input.settlementDays, 'settlementDays', 0, 90);
  const version = integer(input.version, 'version', 0, 2_147_483_647);
  if (!Array.isArray(input.applicableOrderTypes)) {
    throw new BadRequestException('applicableOrderTypes must be an array');
  }
  const applicableOrderTypes = [...new Set(input.applicableOrderTypes.map((value) => {
    if (!ORDER_TYPES.includes(value as ReferralOrderType)) {
      throw new BadRequestException('applicableOrderTypes contains an invalid product type');
    }
    return value as ReferralOrderType;
  }))].sort() as ReferralOrderType[];
  if (input.enabled && (commissionBps === 0 || applicableOrderTypes.length === 0)) {
    throw new BadRequestException('Enabled referral config needs a rate and product type');
  }
  return { applicableOrderTypes, commissionBps, enabled: input.enabled, settlementDays, version };
}

function parseReferralCode(rawInput: unknown): string {
  const input = asRecord(rawInput);
  if (typeof input.code !== 'string') throw new BadRequestException('code is required');
  const code = input.code.trim().toUpperCase();
  if (!/^[A-Z2-9]{10}$/.test(code)) throw new BadRequestException('code is invalid');
  return code;
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.trim())) {
    throw new BadRequestException('A valid Idempotency-Key header is required');
  }
  return value.trim();
}

function generateReferralCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(10);
  return [...bytes].map((value) => alphabet[value % alphabet.length]).join('');
}

function pageNumber(value: unknown, fallback: number, max = 1_000_000): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1 || Number(parsed) > max) {
    throw new BadRequestException('Pagination value is invalid');
  }
  return Number(parsed);
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return Number(value);
}

function defaultConfig(): ReferralConfigResponse {
  return {
    applicableOrderTypes: [],
    commissionBps: 0,
    enabled: false,
    settlementDays: 7,
    version: 0,
  };
}

function mapConfig(row: {
  applicable_order_types: ReferralOrderType[];
  commission_bps: number;
  enabled: boolean;
  settlement_days: number;
  version: number;
}): ReferralConfigResponse {
  return {
    applicableOrderTypes: row.applicable_order_types,
    commissionBps: row.commission_bps,
    enabled: row.enabled,
    settlementDays: row.settlement_days,
    version: row.version,
  };
}

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function assertPrincipal(principal: CustomerPrincipal): void {
  requireUuid(principal.tenantId, 'tenantId');
  requireUuid(principal.accountId, 'accountId');
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Request body is invalid');
  }
  return value as Record<string, unknown>;
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
