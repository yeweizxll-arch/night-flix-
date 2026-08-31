import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Buffer } from 'node:buffer';

import { requireUuid } from '../commerce/commerce-validation';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';

const CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'KRW'] as const;
type Currency = (typeof CURRENCIES)[number];
type RefundBacklogStatus = 'manual_reconciliation' | 'processing';

const WITHDRAWAL_STATUSES = [
  'submitted',
  'reviewing',
  'approved',
  'rejected',
  'cancelled',
  'paying',
  'paid',
  'failed',
] as const;

interface AnalyticsRange {
  from: string;
  timeZone: string;
  to: string;
}

interface BoundRange extends AnalyticsRange {
  fromInclusive: Date;
  toExclusive: Date;
}

interface AmountRow {
  currency: Currency;
  gross_minor: bigint | number | string;
  net_minor: bigint | number | string;
  refund_minor: bigint | number | string;
}

interface CountRow {
  total: bigint | number | string;
}

interface DailyRow extends AmountRow {
  day: Date | string;
  new_customers: bigint | number | string;
  paid_orders: bigint | number | string;
  refunds: bigint | number | string;
}

@Injectable()
export class AnalyticsService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async getTenantOverview(tenantIdValue: unknown, query: Record<string, unknown>) {
    const tenantId = requireUuid(tenantIdValue, 'tenantId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const tenants = await transaction<Array<{ timezone: string }>>`
        select timezone from tenants where id = ${tenantId}
      `;
      if (!tenants[0]) throw new NotFoundException('Tenant not found');
      const range = parseRange(query, tenants[0].timezone, false);
      const bounded = await resolveBoundaries(transaction, range);
      return loadOverview(transaction, tenantId, bounded, false);
    });
  }

  async getPlatformOverview(query: Record<string, unknown>) {
    const range = parseRange(query, query.timeZone ?? 'UTC', true);
    return this.database.inPlatformContext(async (transaction) => {
      const bounded = await resolveBoundaries(transaction, range);
      return loadOverview(transaction, null, bounded, true);
    });
  }

  async getPlatformTenantRanking(query: Record<string, unknown>) {
    const range = parseRange(query, query.timeZone ?? 'UTC', true);
    const currency = parseCurrency(query.currency, true);
    const tenantId = query.tenantId === undefined
      ? undefined
      : requireUuid(query.tenantId, 'tenantId');
    const pageSize = positiveInteger(query.pageSize, 20, 100);
    const cursor = parseRankingCursor(query.cursor, { currency, ...range });
    return this.database.inPlatformContext(async (transaction) => {
      const bounded = await resolveBoundaries(transaction, range);
      const rows = await transaction<Array<{
        gross_minor: bigint | number | string;
        name: string;
        paid_orders: bigint | number | string;
        status: 'active' | 'expired' | 'suspended';
        tenant_id: string;
      }>>`
        with tenant_paid as (
          select commerce_order.tenant_id,
            count(*)::bigint as paid_orders,
            coalesce(sum(commerce_order.total_minor), 0)::numeric as gross_minor
          from orders as commerce_order
          where commerce_order.status in ('paid', 'refunded')
            and commerce_order.currency = ${currency}
            and commerce_order.paid_at >= ${bounded.fromInclusive}
            and commerce_order.paid_at < ${bounded.toExclusive}
          group by commerce_order.tenant_id
        ), ranked as (
          select tenant.id as tenant_id, tenant.name, tenant.status,
            coalesce(tenant_paid.paid_orders, 0)::bigint as paid_orders,
            coalesce(tenant_paid.gross_minor, 0)::numeric as gross_minor
          from tenants as tenant
          left join tenant_paid on tenant_paid.tenant_id = tenant.id
          where (${tenantId ?? null}::uuid is null or tenant.id = ${tenantId ?? null})
        )
        select tenant_id, name, status, paid_orders, gross_minor
        from ranked
        where (
          ${cursor?.grossMinor ?? null}::numeric is null
          or gross_minor < ${cursor?.grossMinor ?? null}::numeric
          or (
            gross_minor = ${cursor?.grossMinor ?? null}::numeric
            and tenant_id > ${cursor?.tenantId ?? null}::uuid
          )
        )
        order by gross_minor desc, tenant_id
        limit ${pageSize + 1}
      `;
      const hasMore = rows.length > pageSize;
      const visible = rows.slice(0, pageSize);
      const last = visible.at(-1);
      return {
        currency,
        definitions: {
          gross:
            'Sum of original order totalMinor for paid/refunded orders whose paidAt is in range.',
          paidOrders:
            'Paid/refunded orders whose paidAt is in range; later refunds do not remove them.',
          ranking: 'Descending gross within the selected currency only.',
        },
        items: visible.map((row) => ({
          grossMinor: decimalString(row.gross_minor),
          name: row.name,
          paidOrders: safeCount(row.paid_orders),
          status: row.status,
          tenantId: row.tenant_id,
        })),
        nextCursor: hasMore && last
          ? encodeRankingCursor({
              grossMinor: decimalString(last.gross_minor),
              currency,
              from: range.from,
              tenantId: last.tenant_id,
              timeZone: range.timeZone,
              to: range.to,
            })
          : null,
        pageSize,
        range: rangeResponse(bounded),
      };
    });
  }
}

async function loadOverview(
  transaction: DatabaseTransaction,
  tenantId: string | null,
  range: BoundRange,
  includeTenantStates: boolean,
) {
  const customerRows = await transaction<Array<{
    new_customers: bigint | number | string;
    total_customers: bigint | number | string;
  }>>`
    select count(*)::bigint as total_customers,
      count(*) filter (
        where created_at >= ${range.fromInclusive} and created_at < ${range.toExclusive}
      )::bigint as new_customers
    from customer_accounts
    where (${tenantId}::uuid is null or tenant_id = ${tenantId})
  `;
  const orderRows = await transaction<Array<{
    paid_customers: bigint | number | string;
    paid_orders: bigint | number | string;
    refunded_orders: bigint | number | string;
  }>>`
    select
      count(*) filter (
        where status in ('paid', 'refunded')
          and paid_at >= ${range.fromInclusive} and paid_at < ${range.toExclusive}
      )::bigint as paid_orders,
      count(distinct account_id) filter (
        where status in ('paid', 'refunded')
          and paid_at >= ${range.fromInclusive} and paid_at < ${range.toExclusive}
      )::bigint as paid_customers,
      count(*) filter (
        where status = 'refunded'
          and refunded_at >= ${range.fromInclusive} and refunded_at < ${range.toExclusive}
      )::bigint as refunded_orders
    from orders
    where (${tenantId}::uuid is null or tenant_id = ${tenantId})
      and (
        (
          status in ('paid', 'refunded')
          and paid_at >= ${range.fromInclusive} and paid_at < ${range.toExclusive}
        )
        or (
          status = 'refunded'
          and refunded_at >= ${range.fromInclusive} and refunded_at < ${range.toExclusive}
        )
      )
  `;
  const contentRows = await transaction<Array<{
    draft: bigint | number | string;
    pending: bigint | number | string;
    published: bigint | number | string;
  }>>`
    select
      count(*) filter (where status = 'draft')::bigint as draft,
      count(*) filter (where status = 'pending_review')::bigint as pending,
      count(*) filter (where status = 'published')::bigint as published
    from dramas
    where deleted_at is null
      and status in ('draft', 'pending_review', 'published')
      and (
        ${tenantId}::uuid is null
        or (owner_type = 'tenant' and owner_tenant_id = ${tenantId})
      )
  `;
  const moneyRows = await transaction<AmountRow[]>`
    with gross as (
      select currency, sum(total_minor)::numeric as gross_minor
      from orders
      where (${tenantId}::uuid is null or tenant_id = ${tenantId})
        and status in ('paid', 'refunded')
        and paid_at >= ${range.fromInclusive} and paid_at < ${range.toExclusive}
      group by currency
    ), refunded as (
      select currency, sum(amount_minor)::numeric as refund_minor
      from payment_refunds
      where (${tenantId}::uuid is null or tenant_id = ${tenantId})
        and status in ('succeeded', 'manual_reconciliation')
        and succeeded_at >= ${range.fromInclusive} and succeeded_at < ${range.toExclusive}
      group by currency
    )
    select coalesce(gross.currency, refunded.currency) as currency,
      coalesce(gross.gross_minor, 0)::numeric as gross_minor,
      coalesce(refunded.refund_minor, 0)::numeric as refund_minor,
      (coalesce(gross.gross_minor, 0) - coalesce(refunded.refund_minor, 0))::numeric
        as net_minor
    from gross full join refunded on refunded.currency = gross.currency
    order by currency
  `;
  const refundBacklogRows = await transaction<Array<{
    status: RefundBacklogStatus;
    total: bigint | number | string;
  }>>`
    select status, count(*)::bigint as total
    from payment_refunds
    where (${tenantId}::uuid is null or tenant_id = ${tenantId})
      and status in ('processing', 'manual_reconciliation')
    group by status
  `;
  const dailyRows = await transaction<DailyRow[]>`
    with days as (
      select generate_series(${range.from}::date, ${range.to}::date, interval '1 day')::date
        as day
    ), customers_daily as (
      select (created_at at time zone ${range.timeZone})::date as day,
        count(*)::bigint as new_customers
      from customer_accounts
      where (${tenantId}::uuid is null or tenant_id = ${tenantId})
        and created_at >= ${range.fromInclusive} and created_at < ${range.toExclusive}
      group by day
    ), orders_daily as (
      select (paid_at at time zone ${range.timeZone})::date as day, currency,
        count(*)::bigint as paid_orders, sum(total_minor)::numeric as gross_minor
      from orders
      where (${tenantId}::uuid is null or tenant_id = ${tenantId})
        and status in ('paid', 'refunded')
        and paid_at >= ${range.fromInclusive} and paid_at < ${range.toExclusive}
      group by day, currency
    ), refunds_daily as (
      select (succeeded_at at time zone ${range.timeZone})::date as day, currency,
        count(*)::bigint as refunds, sum(amount_minor)::numeric as refund_minor
      from payment_refunds
      where (${tenantId}::uuid is null or tenant_id = ${tenantId})
        and status in ('succeeded', 'manual_reconciliation')
        and succeeded_at >= ${range.fromInclusive} and succeeded_at < ${range.toExclusive}
      group by day, currency
    ), money_keys as (
      select day, currency from orders_daily
      union
      select day, currency from refunds_daily
    )
    select days.day,
      coalesce(customers_daily.new_customers, 0)::bigint as new_customers,
      coalesce(orders_daily.paid_orders, 0)::bigint as paid_orders,
      coalesce(refunds_daily.refunds, 0)::bigint as refunds,
      money_keys.currency,
      coalesce(orders_daily.gross_minor, 0)::numeric as gross_minor,
      coalesce(refunds_daily.refund_minor, 0)::numeric as refund_minor,
      (
        coalesce(orders_daily.gross_minor, 0) - coalesce(refunds_daily.refund_minor, 0)
      )::numeric as net_minor
    from days
    left join customers_daily on customers_daily.day = days.day
    left join money_keys on money_keys.day = days.day
    left join orders_daily
      on orders_daily.day = money_keys.day and orders_daily.currency = money_keys.currency
    left join refunds_daily
      on refunds_daily.day = money_keys.day and refunds_daily.currency = money_keys.currency
    order by days.day, money_keys.currency
  `;

  const customers = customerRows[0];
  const orders = orderRows[0];
  const content = contentRows[0];
  const response: Record<string, unknown> = {
    content: {
      draft: safeCount(content?.draft ?? 0),
      pending: safeCount(content?.pending ?? 0),
      published: safeCount(content?.published ?? 0),
    },
    customers: {
      new: safeCount(customers?.new_customers ?? 0),
      paid: safeCount(orders?.paid_customers ?? 0),
      total: safeCount(customers?.total_customers ?? 0),
    },
    daily: mapDaily(dailyRows, range),
    definitions: {
      gross:
        'Orders with paidAt in range. Refunded orders retain their original gross amount.',
      net: 'grossMinor minus refundMinor independently for each currency; no FX conversion.',
      paidOrders:
        'Orders whose paidAt is in range; later-refunded orders remain counted as paid.',
      refund:
        'Succeeded/manual-reconciliation full refunds with succeededAt in range.',
      refundedOrders: 'Orders whose refundedAt is in range.',
    },
    moneyByCurrency: moneyRows.map(mapAmount),
    orders: {
      paid: safeCount(orders?.paid_orders ?? 0),
      refunded: safeCount(orders?.refunded_orders ?? 0),
    },
    range: rangeResponse(range),
    refundBacklog: {
      manualReconciliation: backlogCount(refundBacklogRows, 'manual_reconciliation'),
      processing: backlogCount(refundBacklogRows, 'processing'),
    },
  };

  if (includeTenantStates) {
    const rows = await transaction<Array<{
      status: 'active' | 'expired' | 'suspended';
      total: bigint | number | string;
    }>>`
      select status, count(*)::bigint as total from tenants group by status
    `;
    response.tenants = {
      active: groupedCount(rows, 'active'),
      expired: groupedCount(rows, 'expired'),
      suspended: groupedCount(rows, 'suspended'),
      total: rows.reduce((total, row) => total + safeCount(row.total), 0),
    };
  }
  Object.assign(response, await loadFinancials(transaction, tenantId));
  return response;
}

async function loadFinancials(
  transaction: DatabaseTransaction,
  tenantId: string | null,
): Promise<Record<string, unknown>> {
  const balanceRows = await transaction<Array<{
    available_minor: bigint | number | string;
    currency: Currency;
    frozen_minor: bigint | number | string;
    pending_minor: bigint | number | string;
    withdrawn_minor: bigint | number | string;
  }>>`
    select currency, sum(pending_minor)::numeric as pending_minor,
      sum(available_minor)::numeric as available_minor,
      sum(frozen_minor)::numeric as frozen_minor,
      sum(withdrawn_minor)::numeric as withdrawn_minor
    from merchant_balance_accounts
    where (${tenantId}::uuid is null or tenant_id = ${tenantId})
    group by currency order by currency
  `;
  const commissionRows = await transaction<Array<{
    available_minor: bigint | number | string;
    currency: Currency;
    pending_minor: bigint | number | string;
  }>>`
    select currency, sum(pending_minor)::numeric as pending_minor,
      sum(available_minor)::numeric as available_minor
    from referral_commission_accounts
    where (${tenantId}::uuid is null or tenant_id = ${tenantId})
    group by currency order by currency
  `;
  const withdrawalRows = await transaction<Array<{
    amount_minor: bigint | number | string;
    currency: Currency;
    status: (typeof WITHDRAWAL_STATUSES)[number];
    total: bigint | number | string;
  }>>`
    select status, currency, count(*)::bigint as total,
      sum(amount_minor)::numeric as amount_minor
    from withdrawals where (${tenantId}::uuid is null or tenant_id = ${tenantId})
    group by status, currency order by status, currency
  `;
  return {
    commissionBalances: commissionRows.map((row) => ({
      availableMinor: decimalString(row.available_minor),
      currency: row.currency,
      pendingMinor: decimalString(row.pending_minor),
    })),
    merchantBalances: balanceRows.map((row) => ({
      availableMinor: decimalString(row.available_minor),
      currency: row.currency,
      frozenMinor: decimalString(row.frozen_minor),
      pendingMinor: decimalString(row.pending_minor),
      withdrawnMinor: decimalString(row.withdrawn_minor),
    })),
    withdrawals: WITHDRAWAL_STATUSES.map((status) => {
      const rows = withdrawalRows.filter((row) => row.status === status);
      return {
        amounts: rows.map((row) => ({
          amountMinor: decimalString(row.amount_minor),
          currency: row.currency,
        })),
        count: rows.reduce((total, row) => total + safeCount(row.total), 0),
        status,
      };
    }),
  };
}

async function resolveBoundaries(
  transaction: DatabaseTransaction,
  range: AnalyticsRange,
): Promise<BoundRange> {
  const rows = await transaction<Array<{
    from_inclusive: Date;
    to_exclusive: Date;
  }>>`
    select (${range.from}::date::timestamp at time zone ${range.timeZone}) as from_inclusive,
      ((${range.to}::date + 1)::timestamp at time zone ${range.timeZone}) as to_exclusive
  `;
  const row = rows[0];
  if (!row) throw new Error('Analytics range boundaries could not be resolved');
  return { ...range, fromInclusive: row.from_inclusive, toExclusive: row.to_exclusive };
}

function parseRange(
  query: Record<string, unknown>,
  timeZoneValue: unknown,
  allowTimeZone: boolean,
): AnalyticsRange {
  if (!allowTimeZone && query.timeZone !== undefined) {
    throw new BadRequestException('Tenant analytics uses the configured tenant time zone');
  }
  const timeZone = canonicalTimeZone(timeZoneValue);
  const today = localDate(new Date(), timeZone);
  const to = query.to === undefined ? today : parseDate(query.to, 'to');
  const from = query.from === undefined ? addDays(to, -6) : parseDate(query.from, 'from');
  if (from > to) throw new BadRequestException('from must not be later than to');
  if (to > today) throw new BadRequestException('Analytics date range cannot be in the future');
  const days = daysBetween(from, to) + 1;
  if (days > 90) throw new BadRequestException('Analytics date range cannot exceed 90 days');
  return { from, timeZone, to };
}

function canonicalTimeZone(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) {
    throw new BadRequestException('timeZone must be a valid IANA time zone');
  }
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    throw new BadRequestException('timeZone must be a valid IANA time zone');
  }
}

function localDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function parseDate(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new BadRequestException(`${field} must use YYYY-MM-DD`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 0) - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) throw new BadRequestException(`${field} is not a valid calendar date`);
  return value;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000,
  );
}

function mapAmount(row: AmountRow) {
  return {
    currency: row.currency,
    grossMinor: decimalString(row.gross_minor),
    netMinor: decimalString(row.net_minor),
    refundMinor: decimalString(row.refund_minor),
  };
}

function mapDaily(rows: DailyRow[], range: AnalyticsRange) {
  const byDay = new Map<string, {
    amounts: ReturnType<typeof mapAmount>[];
    date: string;
    newCustomers: number;
    paidOrders: number;
    refunds: number;
  }>();
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    byDay.set(day, { amounts: [], date: day, newCustomers: 0, paidOrders: 0, refunds: 0 });
  }
  for (const row of rows) {
    const day = dateString(row.day);
    const target = byDay.get(day);
    if (!target) continue;
    target.newCustomers = safeCount(row.new_customers);
    target.paidOrders += safeCount(row.paid_orders);
    target.refunds += safeCount(row.refunds);
    if (row.currency) target.amounts.push(mapAmount(row));
  }
  return [...byDay.values()];
}

function dateString(value: Date | string): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

function rangeResponse(range: BoundRange) {
  return {
    from: range.from,
    fromInclusive: range.fromInclusive.toISOString(),
    timeZone: range.timeZone,
    to: range.to,
    toExclusive: range.toExclusive.toISOString(),
  };
}

function backlogCount(
  rows: Array<{ status: RefundBacklogStatus; total: bigint | number | string }>,
  status: RefundBacklogStatus,
): number {
  return safeCount(rows.find((row) => row.status === status)?.total ?? 0);
}

function groupedCount<T extends string>(
  rows: Array<{ status: T; total: bigint | number | string }>,
  status: T,
): number {
  return safeCount(rows.find((row) => row.status === status)?.total ?? 0);
}

function decimalString(value: bigint | number | string): string {
  const normalized = String(value);
  if (!/^-?\d+$/.test(normalized)) {
    throw new Error('Database returned an invalid decimal aggregate');
  }
  return normalized;
}

function safeCount(value: bigint | number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error('Database count is outside the safe integer range');
  }
  return parsed;
}

function parseCurrency(value: unknown, required: boolean): Currency {
  if (value === undefined && !required) return 'USD';
  if (typeof value !== 'string' || !CURRENCIES.some((currency) => currency === value)) {
    throw new BadRequestException('currency must be one of CNY, USD, EUR, JPY, KRW');
  }
  return value as Currency;
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1 || Number(parsed) > maximum) {
    throw new BadRequestException('pageSize is invalid');
  }
  return Number(parsed);
}

function parseRankingCursor(
  value: unknown,
  expected: AnalyticsRange & { currency: Currency },
): { grossMinor: string; tenantId: string } | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 8 || value.length > 1000) {
    throw new BadRequestException('cursor is invalid');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const record = parsed as Record<string, unknown>;
    if (
      Object.keys(record).sort().join(',')
        !== 'currency,from,grossMinor,tenantId,timeZone,to'
      || typeof record.grossMinor !== 'string'
      || !/^\d{1,40}$/.test(record.grossMinor)
      || typeof record.tenantId !== 'string'
      || record.currency !== expected.currency
      || record.from !== expected.from
      || record.to !== expected.to
      || record.timeZone !== expected.timeZone
    ) throw new Error();
    return {
      grossMinor: record.grossMinor,
      tenantId: requireUuid(record.tenantId, 'cursor.tenantId'),
    };
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('cursor is invalid');
  }
}

function encodeRankingCursor(value: {
  currency: Currency;
  from: string;
  grossMinor: string;
  tenantId: string;
  timeZone: string;
  to: string;
}): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
