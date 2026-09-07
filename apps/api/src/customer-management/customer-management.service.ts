import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  CustomerActorContext,
  CustomerListResponse,
  CustomerMutationMetadata,
  ManagedCustomerRecord,
} from './customer-management.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

interface CustomerRow {
  created_at: Date | string;
  devices: unknown;
  email: string | null;
  email_verified_at: Date | string | null;
  entitlements: unknown;
  id: string;
  orders: unknown;
  phone: string | null;
  phone_verified_at: Date | string | null;
  points_balance: string;
  status: ManagedCustomerRecord['status'];
  tenant_id: string;
  updated_at: Date | string;
  username: string;
  version: number;
}

interface ParsedListQuery {
  cursor?: { createdAt: string; id: string };
  from?: string;
  pageSize: number;
  q?: { kind: 'email' | 'phone' | 'username'; value: string };
  queryHash: string;
  status?: ManagedCustomerRecord['status'];
  tenantId: string;
  to?: string;
}

interface CommandRow {
  id: string;
  request_hash: string;
  response_json: unknown;
  status: 'completed' | 'failed' | 'processing';
}

@Injectable()
export class CustomerManagementService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  list(
    context: CustomerActorContext,
    rawQuery: Record<string, unknown>,
  ): Promise<CustomerListResponse> {
    assertContext(context);
    const query = parseListQuery(context, rawQuery);
    return this.inContext(context, async (transaction) => {
      const usernameSearch = query.q?.kind === 'username'
        ? `%${escapeLike(query.q.value)}%` : undefined;
      const emailSearch = query.q?.kind === 'email' ? query.q.value : undefined;
      const phoneSearch = query.q?.kind === 'phone' ? query.q.value : undefined;
      const rows = await transaction<CustomerRow[]>`
        select
          account.id,
          account.tenant_id,
          account.username::text,
          account.email::text,
          account.phone,
          account.email_verified_at,
          account.phone_verified_at,
          account.status,
          account.version,
          account.created_at,
          account.updated_at,
          coalesce(point_account.balance::text, '0') as points_balance,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', recent.id,
              'platform', recent.platform,
              'label', recent.label,
              'status', recent.status,
              'lastSeenAt', recent.last_seen_at,
              'activeSessions', recent.active_sessions
            ) order by (recent.status = 'active') desc, recent.last_seen_at desc, recent.id)
            from (
              select device.id, device.platform, device.label, device.status,
                device.last_seen_at,
                (select count(*)::integer from customer_sessions as session
                  where session.tenant_id = account.tenant_id
                    and session.account_id = account.id
                    and session.device_id = device.id
                    and session.revoked_at is null
                    and session.absolute_expires_at > statement_timestamp()) as active_sessions
              from customer_devices as device
              where device.tenant_id = account.tenant_id and device.account_id = account.id
              order by (device.status = 'active') desc, device.last_seen_at desc, device.id
              limit 3
            ) as recent
          ), '[]'::jsonb) as devices,
          jsonb_build_object(
            'total', count(entitlement.id),
            'membership', count(entitlement.id) filter (where entitlement.entitlement_type = 'membership'),
            'drama', count(entitlement.id) filter (where entitlement.entitlement_type = 'drama'),
            'episode', count(entitlement.id) filter (where entitlement.entitlement_type = 'episode')
          ) as entitlements,
          jsonb_build_object(
            'total', (select count(*) from orders as commerce_order
              where commerce_order.tenant_id = account.tenant_id and commerce_order.account_id = account.id),
            'paid', (select count(*) from orders as commerce_order
              where commerce_order.tenant_id = account.tenant_id and commerce_order.account_id = account.id
                and commerce_order.status in ('paid', 'refunded')),
            'refunded', (select count(*) from orders as commerce_order
              where commerce_order.tenant_id = account.tenant_id and commerce_order.account_id = account.id
                and commerce_order.status = 'refunded')
          ) as orders
        from customer_accounts as account
        left join point_accounts as point_account
          on point_account.tenant_id = account.tenant_id and point_account.account_id = account.id
        left join entitlements as entitlement
          on entitlement.tenant_id = account.tenant_id and entitlement.account_id = account.id
          and entitlement.revoked_at is null
          and entitlement.starts_at <= statement_timestamp()
          and (entitlement.expires_at is null or entitlement.expires_at > statement_timestamp())
        where account.tenant_id = ${query.tenantId}
          and (${query.status ?? null}::text is null or account.status = ${query.status ?? null})
          and (${query.from ?? null}::date is null or account.created_at >= ${query.from ?? null}::date)
          and (${query.to ?? null}::date is null or account.created_at < (${query.to ?? null}::date + 1))
          and (${usernameSearch ?? null}::text is null
            or account.username::text ilike ${usernameSearch ?? ''} escape '!')
          and (${emailSearch ?? null}::text is null or account.email = ${emailSearch ?? null})
          and (${phoneSearch ?? null}::text is null or account.phone = ${phoneSearch ?? null})
          and (${query.cursor?.createdAt ?? null}::timestamptz is null
            or (account.created_at, account.id) <
              (${query.cursor?.createdAt ?? null}::timestamptz, ${query.cursor?.id ?? null}::uuid))
        group by account.id, point_account.balance
        order by account.created_at desc, account.id desc
        limit ${query.pageSize + 1}
      `;
      const hasMore = rows.length > query.pageSize;
      const visible = rows.slice(0, query.pageSize);
      const last = visible.at(-1);
      return {
        items: visible.map(mapCustomer),
        nextCursor: hasMore && last
          ? encodeCursor({ createdAt: iso(last.created_at), id: last.id, queryHash: query.queryHash })
          : null,
        pageSize: query.pageSize,
      };
    });
  }

  detail(
    context: CustomerActorContext,
    tenantIdValue: unknown,
    accountIdValue: unknown,
  ): Promise<ManagedCustomerRecord> {
    assertContext(context);
    const tenantId = targetTenantId(context, tenantIdValue);
    const accountId = uuid(accountIdValue, 'accountId');
    return this.inContext(context, async (transaction) => {
      const row = await loadCustomer(transaction, tenantId, accountId, false);
      if (!row) throw new NotFoundException('Customer account was not found');
      return mapCustomer(row);
    });
  }

  updateStatus(
    context: CustomerActorContext,
    tenantIdValue: unknown,
    accountIdValue: unknown,
    rawInput: unknown,
    metadata: CustomerMutationMetadata,
  ): Promise<ManagedCustomerRecord> {
    assertContext(context);
    if (context.scope !== 'tenant') {
      throw new ForbiddenException('用户状态由所属代理商管理');
    }
    const tenantId = targetTenantId(context, tenantIdValue);
    const accountId = uuid(accountIdValue, 'accountId');
    const input = statusInput(rawInput);
    const idempotencyKey = requireIdempotencyKey(metadata.idempotencyKey);
    return this.inContext(context, async (transaction) => {
      const command = await beginCommand<ManagedCustomerRecord>(transaction, context, {
        idempotencyKey,
        request: { accountId, expectedVersion: input.expectedVersion, reason: input.reason,
          status: input.status, tenantId },
        routeKey: `${context.scope}.customer.status`,
      });
      if (command.cached) return command.cached;
      const current = await loadCustomer(transaction, tenantId, accountId, true);
      if (!current) throw new NotFoundException('Customer account was not found');
      if (current.status === 'erasure_pending' || current.status === 'erased') {
        throw new ConflictException('注销中或已注销的账号不能启用或停用');
      }
      if (current.version !== input.expectedVersion) {
        throw new ConflictException('Customer account version changed');
      }
      if (current.status === input.status) {
        throw new ConflictException(`Customer account is already ${input.status}`);
      }
      const updated = await transaction<{ id: string }[]>`
        update customer_accounts
        set status = ${input.status},
          disabled_at = case when ${input.status} = 'disabled' then statement_timestamp() else null end,
          disabled_by = case when ${input.status} = 'disabled' then ${context.actorId}::uuid else null end,
          disable_reason = case when ${input.status} = 'disabled' then ${input.reason} else null end,
          version = version + 1
        where tenant_id = ${tenantId} and id = ${accountId} and version = ${input.expectedVersion}
        returning id
      `;
      if (!updated[0]) throw new ConflictException('Customer account version changed');
      let sessionsRevoked = 0;
      let pushTokensRevoked = 0;
      if (input.status === 'disabled') {
        const sessions = await transaction<{ id: string }[]>`
          update customer_sessions
          set revoked_at = statement_timestamp(), revoked_reason = 'account_disabled_by_staff'
          where tenant_id = ${tenantId} and account_id = ${accountId} and revoked_at is null
          returning id
        `;
        const pushTokens = await transaction<{ id: string }[]>`
          update customer_push_tokens
          set status = 'revoked', revoked_at = statement_timestamp(),
            revoke_reason = 'account_disabled_by_staff'
          where tenant_id = ${tenantId} and account_id = ${accountId} and status = 'active'
          returning id
        `;
        sessionsRevoked = sessions.length;
        pushTokensRevoked = pushTokens.length;
      }
      const next = await loadCustomer(transaction, tenantId, accountId, false);
      if (!next) throw new Error('Updated customer account could not be loaded');
      const response = mapCustomer(next);
      await recordMutation(transaction, context, metadata, {
        action: `${context.scope}.customer.status`,
        after: { accountId, pushTokensRevoked, sessionsRevoked, status: response.status,
          tenantId, version: response.version },
        before: { accountId, status: current.status, tenantId, version: current.version },
        eventType: input.status === 'disabled' ? 'CustomerDisabledByStaff' : 'CustomerEnabledByStaff',
        resourceId: accountId,
      });
      await completeCommand(transaction, command.id, response, accountId);
      return response;
    });
  }

  revokeSessions(
    context: CustomerActorContext,
    tenantIdValue: unknown,
    accountIdValue: unknown,
    rawInput: unknown,
    metadata: CustomerMutationMetadata,
  ): Promise<{
    accountId: string;
    deviceId?: string;
    deviceRevoked?: boolean;
    pushTokensRevoked?: number;
    sessionsRevoked: number;
  }> {
    assertContext(context);
    if (context.scope !== 'tenant') {
      throw new ForbiddenException('用户登录设备由所属代理商管理');
    }
    const tenantId = targetTenantId(context, tenantIdValue);
    const accountId = uuid(accountIdValue, 'accountId');
    const input = revokeInput(rawInput);
    const idempotencyKey = requireIdempotencyKey(metadata.idempotencyKey);
    return this.inContext(context, async (transaction) => {
      const command = await beginCommand<{
        accountId: string;
        deviceId?: string;
        deviceRevoked?: boolean;
        pushTokensRevoked?: number;
        sessionsRevoked: number;
      }>(
        transaction, context, {
          idempotencyKey,
          request: { accountId, deviceId: input.deviceId ?? null, reason: input.reason, tenantId },
          routeKey: `${context.scope}.customer.sessions.revoke`,
        },
      );
      if (command.cached) return command.cached;
      const accounts = await transaction<{ id: string }[]>`
        select id from customer_accounts
        where tenant_id = ${tenantId} and id = ${accountId} for update
      `;
      if (!accounts[0]) throw new NotFoundException('Customer account was not found');
      if (input.deviceId) {
        const devices = await transaction<{ id: string; status: 'active' | 'revoked' }[]>`
          select id, status from customer_devices
          where tenant_id = ${tenantId} and account_id = ${accountId} and id = ${input.deviceId}
          for update
        `;
        if (!devices[0]) throw new NotFoundException('Customer device was not found');
        if (devices[0].status === 'revoked') {
          throw new ConflictException('Customer device is already revoked');
        }
      }
      const sessions = await transaction<{ id: string }[]>`
        update customer_sessions
        set revoked_at = statement_timestamp(),
          revoked_reason = ${input.deviceId ? 'device_revoked_by_staff' : 'sessions_revoked_by_staff'}
        where tenant_id = ${tenantId} and account_id = ${accountId}
          and (${input.deviceId ?? null}::uuid is null or device_id = ${input.deviceId ?? null})
          and revoked_at is null
        returning id
      `;
      let pushTokensRevoked: number | undefined;
      if (input.deviceId) {
        const activePushTokens = await transaction<{ id: string }[]>`
          select id from customer_push_tokens
          where tenant_id = ${tenantId} and account_id = ${accountId}
            and device_id = ${input.deviceId} and status = 'active'
          for update
        `;
        await transaction`
          update customer_devices
          set status = 'revoked', revoked_at = statement_timestamp(), revoke_reason = ${input.reason}
          where tenant_id = ${tenantId} and account_id = ${accountId}
            and id = ${input.deviceId} and status = 'active'
        `;
        pushTokensRevoked = activePushTokens.length;
      }
      const response = {
        accountId,
        ...(input.deviceId ? {
          deviceId: input.deviceId,
          deviceRevoked: true as const,
          pushTokensRevoked: pushTokensRevoked ?? 0,
        } : {}),
        sessionsRevoked: sessions.length,
      };
      await recordMutation(transaction, context, metadata, {
        action: `${context.scope}.customer.session_revoke`,
        after: { ...response, tenantId },
        eventType: 'CustomerSessionsRevokedByStaff',
        resourceId: accountId,
      });
      await completeCommand(transaction, command.id, response, accountId);
      return response;
    });
  }

  private inContext<T>(
    context: CustomerActorContext,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return context.scope === 'platform'
      ? this.database.inPlatformContext(callback)
      : this.database.inTenantContext(context.tenantId!, callback);
  }
}

async function loadCustomer(
  transaction: DatabaseTransaction,
  tenantId: string,
  accountId: string,
  lock: boolean,
): Promise<CustomerRow | undefined> {
  if (lock) {
    const locked = await transaction<{ id: string }[]>`
      select id from customer_accounts
      where tenant_id = ${tenantId} and id = ${accountId} for update
    `;
    if (!locked[0]) return undefined;
  }
  const rows = await transaction<CustomerRow[]>`
    select
      account.id, account.tenant_id, account.username::text, account.email::text,
      account.phone, account.email_verified_at, account.phone_verified_at,
      account.status, account.version, account.created_at, account.updated_at,
      coalesce(point_account.balance::text, '0') as points_balance,
      coalesce((select jsonb_agg(jsonb_build_object(
        'id', recent.id, 'platform', recent.platform, 'label', recent.label,
        'status', recent.status, 'lastSeenAt', recent.last_seen_at,
        'activeSessions', recent.active_sessions
      ) order by (recent.status = 'active') desc, recent.last_seen_at desc, recent.id)
      from (
        select device.id, device.platform, device.label, device.status, device.last_seen_at,
          (select count(*)::integer from customer_sessions as session
            where session.tenant_id = account.tenant_id and session.account_id = account.id
              and session.device_id = device.id and session.revoked_at is null
              and session.absolute_expires_at > statement_timestamp()) as active_sessions
        from customer_devices as device
        where device.tenant_id = account.tenant_id and device.account_id = account.id
        order by (device.status = 'active') desc, device.last_seen_at desc, device.id
        limit 3
      ) as recent), '[]'::jsonb) as devices,
      jsonb_build_object(
        'total', count(entitlement.id),
        'membership', count(entitlement.id) filter (where entitlement.entitlement_type = 'membership'),
        'drama', count(entitlement.id) filter (where entitlement.entitlement_type = 'drama'),
        'episode', count(entitlement.id) filter (where entitlement.entitlement_type = 'episode')
      ) as entitlements,
      jsonb_build_object(
        'total', (select count(*) from orders as commerce_order
          where commerce_order.tenant_id = account.tenant_id and commerce_order.account_id = account.id),
        'paid', (select count(*) from orders as commerce_order
          where commerce_order.tenant_id = account.tenant_id and commerce_order.account_id = account.id
            and commerce_order.status in ('paid', 'refunded')),
        'refunded', (select count(*) from orders as commerce_order
          where commerce_order.tenant_id = account.tenant_id and commerce_order.account_id = account.id
            and commerce_order.status = 'refunded')
      ) as orders
    from customer_accounts as account
    left join point_accounts as point_account
      on point_account.tenant_id = account.tenant_id and point_account.account_id = account.id
    left join entitlements as entitlement
      on entitlement.tenant_id = account.tenant_id and entitlement.account_id = account.id
      and entitlement.revoked_at is null and entitlement.starts_at <= statement_timestamp()
      and (entitlement.expires_at is null or entitlement.expires_at > statement_timestamp())
    where account.tenant_id = ${tenantId} and account.id = ${accountId}
    group by account.id, point_account.balance
  `;
  return rows[0];
}

function parseListQuery(
  context: CustomerActorContext,
  raw: Record<string, unknown>,
): ParsedListQuery {
  const tenantId = targetTenantId(context, raw.tenantId);
  if ('tenant_id' in raw) throw new BadRequestException('tenant_id is not supported');
  const pageSize = integer(raw.pageSize, 'pageSize', 20, 1, 100);
  const status = raw.status === undefined || raw.status === ''
    ? undefined : raw.status === 'erasure_pending' || raw.status === 'erased'
      ? raw.status : customerStatus(raw.status);
  const from = optionalDate(raw.registeredFrom, 'registeredFrom');
  const to = optionalDate(raw.registeredTo, 'registeredTo');
  if (from && to && from > to) throw new BadRequestException('Registration date range is invalid');
  const q = parseSearch(raw.q);
  const queryHash = createHash('sha256').update(JSON.stringify({
    from: from ?? null,
    q: q ?? null,
    status: status ?? null,
    tenantId,
    to: to ?? null,
  })).digest('hex');
  return {
    cursor: parseCursor(raw.cursor, queryHash), from, pageSize, q, queryHash, status, tenantId, to,
  };
}

function parseSearch(value: unknown): ParsedListQuery['q'] {
  if (value === undefined || value === '') return undefined;
  const normalized = text(value, 'q', 1, 100).toLowerCase();
  if (normalized.includes('@')) {
    if (!EMAIL_PATTERN.test(normalized)) throw new BadRequestException('Email search must be exact');
    return { kind: 'email', value: normalized };
  }
  if (normalized.startsWith('+')) {
    if (!PHONE_PATTERN.test(normalized)) throw new BadRequestException('Phone search must be exact');
    return { kind: 'phone', value: normalized };
  }
  if (!/^[a-z0-9_.-]+$/.test(normalized)) {
    throw new BadRequestException('Username search is invalid');
  }
  return { kind: 'username', value: normalized };
}

function statusInput(raw: unknown): {
  expectedVersion: number;
  reason: string;
  status: 'active' | 'disabled';
} {
  const record = body(raw);
  rejectUnknown(record, ['expectedVersion', 'reason', 'status']);
  rejectTenantId(record);
  return {
    expectedVersion: integer(record.expectedVersion, 'expectedVersion', undefined, 0),
    reason: text(record.reason, 'reason', 2, 1000),
    status: customerStatus(record.status),
  };
}

function revokeInput(raw: unknown): { deviceId?: string; reason: string } {
  const record = body(raw);
  rejectUnknown(record, ['deviceId', 'reason']);
  rejectTenantId(record);
  return {
    deviceId: record.deviceId === undefined ? undefined : uuid(record.deviceId, 'deviceId'),
    reason: text(record.reason, 'reason', 2, 1000),
  };
}

function targetTenantId(context: CustomerActorContext, value: unknown): string {
  if (context.scope === 'tenant') {
    if (value !== undefined) throw new BadRequestException('tenantId cannot be supplied by tenant requests');
    return uuid(context.tenantId, 'tenantId');
  }
  return uuid(value, 'tenantId');
}

function mapCustomer(row: CustomerRow): ManagedCustomerRecord {
  const entitlements = object(row.entitlements);
  const orders = object(row.orders);
  return {
    activeEntitlements: {
      drama: safeCount(entitlements.drama),
      episode: safeCount(entitlements.episode),
      membership: safeCount(entitlements.membership),
      total: safeCount(entitlements.total),
    },
    createdAt: iso(row.created_at),
    devices: Array.isArray(row.devices) ? row.devices.map((raw) => {
      const device = object(raw);
      return {
        activeSessions: safeCount(device.activeSessions),
        id: uuid(device.id, 'device.id'),
        ...(typeof device.label === 'string' && device.label ? { label: device.label } : {}),
        lastSeenAt: iso(String(device.lastSeenAt)),
        platform: devicePlatform(device.platform),
        status: device.status === 'revoked' ? 'revoked' as const : 'active' as const,
      };
    }) : [],
    ...(row.email ? { email: maskEmail(row.email) } : {}),
    emailVerified: row.email_verified_at !== null,
    id: row.id,
    orders: {
      paid: safeCount(orders.paid),
      refunded: safeCount(orders.refunded),
      total: safeCount(orders.total),
    },
    ...(row.phone ? { phone: maskPhone(row.phone) } : {}),
    phoneVerified: row.phone_verified_at !== null,
    pointsBalance: decimalString(row.points_balance),
    status: row.status,
    tenantId: row.tenant_id,
    updatedAt: iso(row.updated_at),
    username: row.username,
    version: row.version,
  };
}

async function recordMutation(
  transaction: DatabaseTransaction,
  context: CustomerActorContext,
  metadata: CustomerMutationMetadata,
  input: {
    action: string;
    after: object;
    before?: object;
    eventType: string;
    resourceId: string;
  },
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, before_json, after_json, ip, request_id
    ) values (
      ${uuidV7()}, ${context.scope}, ${context.tenantId ?? null},
      ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'},
      ${context.actorId}, ${input.action}, 'customer_account', ${input.resourceId},
      ${input.before ? transaction.json(input.before as never) : null},
      ${transaction.json(input.after as never)}, ${metadata.ip ?? null}, ${metadata.requestId}
    )
  `;
  const eventId = uuidV7();
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key,
      aggregate_type, aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, ${context.scope}, ${context.tenantId ?? null},
      ${`customer-management:${eventId}`}, ${`customer-management:${eventId}`},
      'customer_account', ${input.resourceId}, ${input.eventType},
      ${transaction.json(input.after as never)}
    )
  `;
}

async function beginCommand<T>(
  transaction: DatabaseTransaction,
  context: CustomerActorContext,
  input: { idempotencyKey: string; request: unknown; routeKey: string },
): Promise<{ cached?: T; id?: string }> {
  const requestHash = createHash('sha256').update(JSON.stringify(input.request)).digest('hex');
  const id = uuidV7();
  const inserted = await transaction<{ id: string }[]>`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, expires_at
    ) values (
      ${id}, ${context.scope}, ${context.tenantId ?? null},
      ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'},
      ${context.actorId}, ${input.routeKey}, ${input.idempotencyKey}, ${requestHash},
      statement_timestamp() + interval '24 hours'
    ) on conflict do nothing returning id
  `;
  if (inserted[0]) return { id };
  const rows = await transaction<CommandRow[]>`
    select id, request_hash, response_json, status from command_idempotency
    where scope_type = ${context.scope}
      and tenant_id is not distinct from ${context.tenantId ?? null}
      and actor_type = ${context.scope === 'platform' ? 'platform_staff' : 'tenant_staff'}
      and actor_id = ${context.actorId} and route_key = ${input.routeKey}
      and idempotency_key = ${input.idempotencyKey}
    for update
  `;
  const existing = rows[0];
  if (!existing) throw new ConflictException('Idempotency record is unavailable');
  if (existing.request_hash !== requestHash) {
    throw new ConflictException('Idempotency-Key was already used for another request');
  }
  if (existing.status === 'completed' && existing.response_json !== null) {
    return { cached: existing.response_json as T };
  }
  throw new ConflictException('The same command is already processing');
}

async function completeCommand(
  transaction: DatabaseTransaction,
  commandId: string | undefined,
  response: unknown,
  accountId: string,
): Promise<void> {
  if (!commandId) return;
  await transaction`
    update command_idempotency
    set status = 'completed', response_status = 200,
      response_json = ${transaction.json(response as never)},
      resource_type = 'customer_account', resource_id = ${accountId}, locked_at = null
    where id = ${commandId} and status = 'processing'
  `;
}

function parseCursor(value: unknown, queryHash: string): ParsedListQuery['cursor'] {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || value.length < 8 || value.length > 1000) {
    throw new BadRequestException('cursor is invalid');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const record = object(parsed);
    if (Object.keys(record).sort().join(',') !== 'createdAt,id,queryHash'
      || record.queryHash !== queryHash || typeof record.createdAt !== 'string') throw new Error();
    const createdAt = new Date(record.createdAt);
    if (!Number.isFinite(createdAt.getTime()) || createdAt.toISOString() !== record.createdAt) throw new Error();
    return { createdAt: record.createdAt, id: uuid(record.id, 'cursor.id') };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('cursor is invalid');
  }
}

function encodeCursor(value: { createdAt: string; id: string; queryHash: string }): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function assertContext(context: CustomerActorContext): void {
  uuid(context.actorId, 'actorId');
  if (context.scope === 'tenant') uuid(context.tenantId, 'tenantId');
  else if (context.tenantId !== undefined) throw new BadRequestException('Platform context cannot have tenantId');
}

function rejectTenantId(record: Record<string, unknown>): void {
  if ('tenantId' in record || 'tenant_id' in record) {
    throw new BadRequestException('tenantId cannot be supplied in the request body');
  }
}

function rejectUnknown(record: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    throw new BadRequestException('Body contains unsupported fields');
  }
}

function customerStatus(value: unknown): 'active' | 'disabled' {
  if (value !== 'active' && value !== 'disabled') throw new BadRequestException('status is invalid');
  return value;
}

function devicePlatform(value: unknown): 'android' | 'h5' | 'ios' | 'web' {
  if (value !== 'android' && value !== 'h5' && value !== 'ios' && value !== 'web') {
    throw new Error('Database returned an invalid device platform');
  }
  return value;
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_PATTERN.test(value)) {
    throw new BadRequestException('A valid Idempotency-Key header is required');
  }
  return value;
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === '') return undefined;
  const result = text(value, field, 10, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new BadRequestException(`${field} is invalid`);
  const date = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== result) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return result;
}

function integer(
  value: unknown,
  field: string,
  fallback: number | undefined,
  minimum: number,
  maximum = 2_147_483_647,
): number {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)
    || parsed < minimum || parsed > maximum) throw new BadRequestException(`${field} is invalid`);
  return parsed;
}

function text(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string' || value !== value.trim()
    || value.length < minimum || value.length > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Body is required');
  }
  return value as Record<string, unknown>;
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, any>;
}

function escapeLike(value: string): string {
  return value.replace(/!/g, '!!').replace(/%/g, '!%').replace(/_/g, '!_');
}

function safeCount(value: unknown): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Database count is invalid');
  return parsed;
}

function decimalString(value: unknown): string {
  const result = String(value ?? '0');
  if (!/^\d+$/.test(result)) throw new Error('Database decimal is invalid');
  return result;
}

function maskEmail(value: string): string {
  const at = value.indexOf('@');
  return at <= 0 ? '***' : `${value.slice(0, 1)}***${value.slice(at)}`;
}

function maskPhone(value: string): string {
  return value.length <= 6 ? '***' : `${value.slice(0, 3)}****${value.slice(-4)}`;
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
