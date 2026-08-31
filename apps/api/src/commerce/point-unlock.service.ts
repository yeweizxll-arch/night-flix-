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
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { amountNumber, requireUuid } from './commerce-validation';

type PointTargetType = 'drama' | 'episode';

export interface PointUnlockResponse {
  alreadyOwned: boolean;
  balanceAfter: number | null;
  createdAt: string;
  dramaId: string;
  entitlementId: string;
  pointsSpent: number;
  targetId: string;
  targetType: PointTargetType;
  unlockId: string | null;
}

interface UnlockCommandRow {
  id: string;
  request_hash: string;
  response_json: PointUnlockResponse | null;
  status: 'completed' | 'failed' | 'processing';
}

interface LockedTarget {
  drama_id: string;
  owner_type: 'platform' | 'tenant';
}

interface PointPriceRow {
  id: string;
  points_amount: string | number | bigint;
  version: number;
}

@Injectable()
export class PointUnlockService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  unlock(
    principal: CustomerPrincipal,
    targetTypeValue: unknown,
    targetIdValue: unknown,
    rawInput: unknown,
    idempotencyKeyValue: unknown,
    requestId: string,
  ): Promise<PointUnlockResponse> {
    const targetType = requireTargetType(targetTypeValue);
    const targetId = requireUuid(targetIdValue, 'targetId');
    rejectClientPointAmount(rawInput);
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    requireUuid(principal.tenantId, 'tenantId');
    requireUuid(principal.accountId, 'accountId');
    return this.database.inPlatformContext(async (transaction) => {
      await lockCustomerAvailability(transaction, principal);
      const command = await beginCommand(
        transaction,
        principal,
        targetType,
        targetId,
        idempotencyKey,
      );
      if (command.cached) return command.cached;

      const target = await lockSellableTarget(
        transaction,
        principal.tenantId,
        targetType,
        targetId,
      );
      const price = await lockPointPrice(
        transaction,
        principal.tenantId,
        targetType,
        targetId,
      );
      const ownership = await lockExistingOwnership(
        transaction,
        principal,
        targetType,
        targetId,
        target.drama_id,
      );
      if (ownership) {
        const response = await existingOwnershipResponse(
          transaction,
          ownership,
          targetType,
          targetId,
          target.drama_id,
        );
        await completeCommand(
          transaction,
          command.id,
          response,
          ownership.source_point_unlock_id ?? ownership.entitlement_id,
          ownership.source_point_unlock_id ? 'point_unlock' : 'entitlement',
        );
        return response;
      }

      const pointAccounts = await transaction<Array<{
        balance: string | number | bigint;
        id: string;
      }>>`
        select id, balance from point_accounts
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
        for update
      `;
      const pointAccount = pointAccounts[0];
      const pointsAmount = amountNumber(price.points_amount);
      if (!pointAccount || amountNumber(pointAccount.balance) < pointsAmount) {
        throw new ConflictException('Point balance is insufficient');
      }

      const unlockId = uuidV7();
      const entitlementId = uuidV7();
      const ledgerId = uuidV7();
      const unlockRows = await transaction<Array<{ created_at: Date }>>`
        insert into point_unlocks (
          id, tenant_id, account_id, point_account_id, target_type, target_id,
          drama_id, price_id, price_version_snapshot, points_amount_snapshot
        ) values (
          ${unlockId}, ${principal.tenantId}, ${principal.accountId}, ${pointAccount.id},
          ${targetType}, ${targetId}, ${target.drama_id}, ${price.id}, ${price.version},
          ${pointsAmount}
        )
        returning created_at
      `;
      const ledgerRows = await transaction<Array<{
        balance_after: string | number | bigint;
      }>>`
        insert into point_ledger (
          id, tenant_id, account_id, point_account_id, entry_type, delta,
          balance_after, reference_type, reference_id, idempotency_key,
          metadata_json, created_by_type, created_by
        ) values (
          ${ledgerId}, ${principal.tenantId}, ${principal.accountId}, ${pointAccount.id},
          'purchase', ${-pointsAmount}, 0, 'point_unlock', ${unlockId},
          ${`point-unlock:${unlockId}:purchase`},
          ${transaction.json({
            priceId: price.id,
            priceVersion: price.version,
            targetId,
            targetType,
          })}, 'user', ${principal.accountId}
        )
        returning balance_after
      `;
      await transaction`
        insert into entitlements (
          id, tenant_id, account_id, entitlement_type, product_id,
          source_type, source_point_unlock_id, starts_at
        ) values (
          ${entitlementId}, ${principal.tenantId}, ${principal.accountId}, ${targetType},
          ${targetId}, 'point_unlock', ${unlockId}, transaction_timestamp()
        )
      `;
      const createdAt = unlockRows[0]?.created_at;
      const balanceAfter = ledgerRows[0]?.balance_after;
      if (!createdAt || balanceAfter === undefined) {
        throw new Error('Point unlock result is unavailable');
      }
      const response: PointUnlockResponse = {
        alreadyOwned: false,
        balanceAfter: amountNumber(balanceAfter),
        createdAt: createdAt.toISOString(),
        dramaId: target.drama_id,
        entitlementId,
        pointsSpent: pointsAmount,
        targetId,
        targetType,
        unlockId,
      };
      await insertAuditAndOutbox(transaction, principal, response, requestId);
      await completeCommand(transaction, command.id, response, unlockId);
      return response;
    });
  }
}

async function lockCustomerAvailability(
  transaction: DatabaseTransaction,
  principal: CustomerPrincipal,
): Promise<void> {
  const tenants = await transaction<{ id: string }[]>`
    select id from tenants
    where id = ${principal.tenantId}
      and status = 'active'
      and expires_at > transaction_timestamp()
      and user_site_enabled
      and platform_site_enabled
    for share
  `;
  if (!tenants[0]) throw new ConflictException('Tenant or customer is not available');
  const customers = await transaction<{ id: string }[]>`
    select id from customer_accounts
    where tenant_id = ${principal.tenantId}
      and id = ${principal.accountId}
      and status = 'active'
    for update
  `;
  if (!customers[0]) throw new ConflictException('Tenant or customer is not available');
}

async function lockSellableTarget(
  transaction: DatabaseTransaction,
  tenantId: string,
  targetType: PointTargetType,
  targetId: string,
): Promise<LockedTarget> {
  const targets = targetType === 'drama'
    ? await transaction<LockedTarget[]>`
        select drama.id as drama_id, drama.owner_type
        from dramas as drama
        where drama.id = ${targetId}
          and drama.status = 'published'
          and drama.deleted_at is null
          and (
            (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
            or drama.owner_type = 'platform'
          )
        for share of drama
      `
    : await transaction<LockedTarget[]>`
        select drama.id as drama_id, drama.owner_type
        from episodes as episode
        inner join dramas as drama on drama.id = episode.drama_id
        where episode.id = ${targetId}
          and episode.status = 'published'
          and episode.deleted_at is null
          and drama.status = 'published'
          and drama.deleted_at is null
          and (
            (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
            or drama.owner_type = 'platform'
          )
        for share of episode, drama
      `;
  const target = targets[0];
  if (!target) throw new NotFoundException('Point-unlockable content not found');
  if (target.owner_type === 'platform') {
    const licenses = await transaction<{ id: string }[]>`
      select license.id
      from content_licenses as license
      inner join content_license_items as item
        on item.license_id = license.id and item.tenant_id = license.tenant_id
      where license.tenant_id = ${tenantId}
        and item.drama_id = ${target.drama_id}
        and license.status in ('scheduled', 'active')
        and license.starts_at <= transaction_timestamp()
        and license.expires_at > transaction_timestamp()
      order by license.id limit 1
      for share of license, item
    `;
    if (!licenses[0]) throw new NotFoundException('Point-unlockable content not found');
  }
  return target;
}

async function lockPointPrice(
  transaction: DatabaseTransaction,
  tenantId: string,
  targetType: PointTargetType,
  targetId: string,
): Promise<PointPriceRow> {
  const prices = await transaction<PointPriceRow[]>`
    select id, points_amount, version from content_point_prices
    where tenant_id = ${tenantId}
      and target_type = ${targetType}
      and target_id = ${targetId}
      and status = 'active'
    for share
  `;
  const price = prices[0];
  if (!price) throw new NotFoundException('Active point price not found');
  return price;
}

async function lockExistingOwnership(
  transaction: DatabaseTransaction,
  principal: CustomerPrincipal,
  targetType: PointTargetType,
  targetId: string,
  dramaId: string,
): Promise<{
  entitlement_id: string;
  source_point_unlock_id: string | null;
} | undefined> {
  const rows = await transaction<Array<{
    entitlement_id: string;
    source_point_unlock_id: string | null;
  }>>`
    select id as entitlement_id, source_point_unlock_id
    from entitlements
    where tenant_id = ${principal.tenantId}
      and account_id = ${principal.accountId}
      and revoked_at is null
      and starts_at <= transaction_timestamp()
      and (expires_at is null or expires_at > transaction_timestamp())
      and (
        entitlement_type = 'membership'
        or (entitlement_type = 'drama' and product_id = ${dramaId})
        or (
          ${targetType} = 'episode'
          and entitlement_type = 'episode'
          and product_id = ${targetId}
        )
      )
    order by
      case entitlement_type when 'membership' then 1 when 'drama' then 2 else 3 end,
      id
    limit 1
    for share
  `;
  return rows[0];
}

async function existingOwnershipResponse(
  transaction: DatabaseTransaction,
  ownership: { entitlement_id: string; source_point_unlock_id: string | null },
  targetType: PointTargetType,
  targetId: string,
  dramaId: string,
): Promise<PointUnlockResponse> {
  let balanceAfter: number | null = null;
  let createdAt = new Date(0).toISOString();
  if (ownership.source_point_unlock_id) {
    const rows = await transaction<Array<{
      balance_after: string | number | bigint;
      created_at: Date;
    }>>`
      select ledger.balance_after, unlock.created_at
      from point_unlocks as unlock
      inner join point_ledger as ledger
        on ledger.tenant_id = unlock.tenant_id
        and ledger.account_id = unlock.account_id
        and ledger.reference_type = 'point_unlock'
        and ledger.reference_id = unlock.id
        and ledger.entry_type = 'purchase'
      where unlock.id = ${ownership.source_point_unlock_id}
      for share of unlock, ledger
    `;
    if (rows[0]) {
      balanceAfter = amountNumber(rows[0].balance_after);
      createdAt = rows[0].created_at.toISOString();
    }
  } else {
    const rows = await transaction<{ created_at: Date }[]>`
      select created_at from entitlements where id = ${ownership.entitlement_id}
    `;
    if (rows[0]) createdAt = rows[0].created_at.toISOString();
  }
  return {
    alreadyOwned: true,
    balanceAfter,
    createdAt,
    dramaId,
    entitlementId: ownership.entitlement_id,
    pointsSpent: 0,
    targetId,
    targetType,
    unlockId: ownership.source_point_unlock_id,
  };
}

async function beginCommand(
  transaction: DatabaseTransaction,
  principal: CustomerPrincipal,
  targetType: PointTargetType,
  targetId: string,
  idempotencyKey: string,
): Promise<{ cached?: PointUnlockResponse; id: string }> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ targetId, targetType }))
    .digest('hex');
  const id = uuidV7();
  const inserted = await transaction<{ id: string }[]>`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, expires_at
    ) values (
      ${id}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
      'customer.commerce.point_unlock.create', ${idempotencyKey}, ${requestHash},
      transaction_timestamp() + interval '24 hours'
    ) on conflict do nothing returning id
  `;
  if (inserted[0]) return { id };
  const rows = await transaction<UnlockCommandRow[]>`
    select id, request_hash, response_json, status from command_idempotency
    where scope_type = 'tenant'
      and tenant_id = ${principal.tenantId}
      and actor_type = 'user'
      and actor_id = ${principal.accountId}
      and route_key = 'customer.commerce.point_unlock.create'
      and idempotency_key = ${idempotencyKey}
    for update
  `;
  const row = rows[0];
  if (!row || row.request_hash !== requestHash) {
    throw new ConflictException('Idempotency-Key was used for another point unlock');
  }
  if (row.status === 'completed' && row.response_json) {
    return { cached: row.response_json, id: row.id };
  }
  throw new ConflictException('The same point unlock is already processing');
}

async function completeCommand(
  transaction: DatabaseTransaction,
  commandId: string,
  response: PointUnlockResponse,
  resourceId: string,
  resourceType = 'point_unlock',
): Promise<void> {
  await transaction`
    update command_idempotency
    set status = 'completed', response_status = 201,
      response_json = ${transaction.json(toJsonValue(response))},
      resource_type = ${resourceType}, resource_id = ${resourceId}, locked_at = null
    where id = ${commandId} and status = 'processing'
  `;
}

async function insertAuditAndOutbox(
  transaction: DatabaseTransaction,
  principal: CustomerPrincipal,
  response: PointUnlockResponse,
  requestId: string,
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, request_id
    ) values (
      ${uuidV7()}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
      'commerce.point_unlock.create', 'point_unlock', ${response.unlockId},
      ${transaction.json({
        dramaId: response.dramaId,
        pointsSpent: response.pointsSpent,
        targetId: response.targetId,
        targetType: response.targetType,
      })}, ${requestId}
    )
  `;
  const eventId = uuidV7();
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key,
      aggregate_type, aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, 'tenant', ${principal.tenantId}, ${`event:${eventId}`},
      ${`PointContentUnlocked:${response.unlockId}`}, 'point_unlock',
      ${response.unlockId}, 'PointContentUnlocked',
      ${transaction.json({
        accountId: principal.accountId,
        dramaId: response.dramaId,
        entitlementId: response.entitlementId,
        pointsSpent: response.pointsSpent,
        targetId: response.targetId,
        targetType: response.targetType,
        tenantId: principal.tenantId,
        unlockId: response.unlockId,
      })}
    ) on conflict do nothing
  `;
}

function requireTargetType(value: unknown): PointTargetType {
  if (value !== 'drama' && value !== 'episode') {
    throw new BadRequestException('targetType is invalid');
  }
  return value;
}

function rejectClientPointAmount(rawInput: unknown): void {
  if (rawInput === undefined || rawInput === null) return;
  if (typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new BadRequestException('Point unlock body is invalid');
  }
  const value = rawInput as Record<string, unknown>;
  const forbidden = ['amount', 'amountMinor', 'points', 'pointsAmount', 'price'];
  if (forbidden.some((field) => Object.hasOwn(value, field))) {
    throw new BadRequestException('Client-provided point amounts are not allowed');
  }
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.trim())) {
    throw new BadRequestException('A valid Idempotency-Key header is required');
  }
  return value.trim();
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
