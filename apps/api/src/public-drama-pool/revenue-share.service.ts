import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { uuidV7 } from '../common/uuid-v7';
import { createHash } from 'node:crypto';
import { DatabaseService } from '../database/database.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INCOME_TYPES = ['coin_unlock', 'content_ad', 'membership'] as const;
const CURRENCIES = Intl.supportedValuesOf('currency');

export interface RevenueMutationMetadata { actorId?: string; requestId: string }

export interface RevenueSharePolicyInput {
  contentScope: 'private' | 'public';
  creatorBps: number;
  expectedVersion: number;
  headquartersBps: number;
  incomeType: (typeof INCOME_TYPES)[number];
  status?: 'active' | 'disabled';
  tenantBps: number;
}

export interface RecordRevenueInput {
  currency: (typeof CURRENCIES)[number];
  dramaId: string;
  episodeId?: string;
  grossMinor: number;
  incomeType: (typeof INCOME_TYPES)[number];
  occurredAt: string;
  sourceId: string;
  sourceType: 'ad_revenue' | 'apple_transaction' | 'coin_unlock' | 'google_transaction';
  tenantId: string;
}
export interface CashStatementInput { sourceId: string; currency: string; grossMinor: string; netMinor: string; reportId: string; rowId: string; reportSha256: string }
export interface AdStatementInput { currency: string; grossMinor: string; netMinor?: string; dramaId: string; episodeId?: string; occurredAt: string; reportId: string; rowId: string; reportSha256: string }

@Injectable()
export class RevenueShareService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async cashStatus(tenantId: string) {
    uuid(tenantId, 'tenantId');
    return this.database.inPlatformContext(async tx => {
      const basis = await tx<{ basis: 'gross' | 'net' }[]>`select basis from content_revenue_basis where tenant_id = ${tenantId}`;
      const pending = await tx<{ count: number }[]>`select count(*)::integer as count from content_revenue_events
        where tenant_id = ${tenantId} and state = 'unvalued'`;
      const legacy = await tx<{ reason: string }[]>`select reason from content_revenue_legacy_review where tenant_id = ${tenantId} and resolved_at is null`;
      return { basis: basis[0]?.basis ?? null, unvalued: pending[0]?.count ?? 0, legacyReview: legacy[0]?.reason ?? null };
    });
  }

  async acknowledgeLegacyReview(tenantId: string, input: { reportId: string; reportSha256: string }, metadata: RevenueMutationMetadata) {
    uuid(tenantId, 'tenantId'); uuid(metadata.actorId, 'actorId');
    if (!input || typeof input.reportId !== 'string' || !input.reportId.trim() || input.reportId.length > 200
      || !/^[a-f0-9]{64}$/.test(input.reportSha256 ?? '')) throw new BadRequestException('Signed-off reconciliation report required');
    return this.database.inPlatformContext(async tx => {
      await tx`select id from tenants where id = ${tenantId} for update`;
      const pending = await tx`select id from content_revenue_events where tenant_id = ${tenantId} and state = 'unvalued' limit 1`;
      if (pending.length) throw new ConflictException('Value historical cash events before signing off the reconciliation');
      const rows = await tx<{ report_id: string | null; report_sha256: string | null; resolved_at: Date | null }[]>`
        select report_id, report_sha256, resolved_at from content_revenue_legacy_review where tenant_id = ${tenantId} for update`;
      if (!rows[0]) throw new ConflictException('No historical review required');
      if (rows[0].resolved_at) {
        if (rows[0].report_id !== input.reportId || rows[0].report_sha256 !== input.reportSha256) throw new ConflictException('Historical sign-off is immutable');
        return { duplicate: true };
      }
      await tx`update content_revenue_legacy_review set resolved_at = statement_timestamp(), resolved_by = ${metadata.actorId!},
        report_id = ${input.reportId}, report_sha256 = ${input.reportSha256} where tenant_id = ${tenantId}`;
      await tx`insert into audit_logs(id, scope_type, actor_type, actor_id, action, resource_type, resource_id, request_id, after_json)
        values (${uuidV7()}, 'platform', 'platform_staff', ${metadata.actorId!}, 'finance.content_revenue.legacy_review', 'tenant', ${tenantId},
          ${metadata.requestId}, ${tx.json(input)})`;
      return { duplicate: false };
    });
  }

  async sources(tenantId: string) {
    uuid(tenantId, 'tenantId');
    return this.database.inPlatformContext(async tx => ({ items: await tx`select id, source_type, currency,
      gross_minor::text, net_minor::text, refunded_minor::text, sandbox, occurred_at
      from content_cash_sources where tenant_id = ${tenantId} order by occurred_at desc, id desc limit 100` }));
  }

  async attachNetStatement(tenantId: string, input: CashStatementInput, metadata: RevenueMutationMetadata) {
    uuid(tenantId, 'tenantId'); uuid(metadata.actorId, 'actorId'); uuid(input?.sourceId, 'sourceId'); statement(input);
    const net = moneyString(input.netMinor); const gross = moneyString(input.grossMinor);
    if (net > gross) throw new BadRequestException('Net revenue exceeds original paid amount');
    return this.database.inPlatformContext(async tx => {
      const sources = await tx<{ currency: string; gross_minor: string; net_minor: string | null }[]>`select currency, gross_minor::text, net_minor::text
        from content_cash_sources where tenant_id = ${tenantId} and id = ${input.sourceId} for update`;
      const source = sources[0];
      if (!source || source.currency !== input.currency || BigInt(source.gross_minor) !== gross)
        throw new ConflictException('Statement does not match the verified original payment');
      const existing = await tx<{ report_id: string; row_id: string; report_sha256: string; net_minor: string }[]>`select report_id, row_id, report_sha256, net_minor::text
        from content_cash_statements where source_id = ${input.sourceId}`;
      if (existing[0]) {
        if (existing[0].report_id !== input.reportId || existing[0].row_id !== input.rowId || existing[0].report_sha256 !== input.reportSha256
          || BigInt(existing[0].net_minor) !== net) throw new ConflictException('Statement facts are immutable');
        return { duplicate: true };
      }
      if (source.net_minor !== null && BigInt(source.net_minor) !== net) throw new ConflictException('Verified net revenue is already fixed');
      await tx`insert into content_cash_statements(id, tenant_id, source_id, report_id, row_id, report_sha256, net_minor, created_by)
        values (${uuidV7()}, ${tenantId}, ${input.sourceId}, ${input.reportId}, ${input.rowId}, ${input.reportSha256}, ${net.toString()}, ${metadata.actorId!})`;
      await tx`update content_cash_sources set net_minor = ${net.toString()} where tenant_id = ${tenantId} and id = ${input.sourceId}`;
      return { duplicate: false };
    });
  }

  // Only finance-authorized headquarters can import a reconciled report. Client ILRD/SSV is never cash.
  async importAdStatement(tenantId: string, input: AdStatementInput, metadata: RevenueMutationMetadata) {
    uuid(tenantId, 'tenantId'); uuid(metadata.actorId, 'actorId'); uuid(input?.dramaId, 'dramaId'); statement(input);
    if (input.episodeId) uuid(input.episodeId, 'episodeId');
    const gross = moneyString(input.grossMinor); const net = input.netMinor === undefined ? null : moneyString(input.netMinor);
    if (net !== null && net > gross) throw new BadRequestException('Net revenue exceeds gross revenue');
    const at = new Date(input.occurredAt);
    if (!CURRENCIES.includes(input.currency) || !Number.isFinite(at.getTime()) || at.toISOString() !== input.occurredAt
      || at.getTime() > Date.now()) throw new BadRequestException('Invalid report currency or date');
    const hash = createHash('sha256').update(JSON.stringify([tenantId, input.dramaId, input.episodeId ?? null, input.currency,
      gross.toString(), net?.toString() ?? null, input.occurredAt, input.reportId, input.rowId, input.reportSha256])).digest('hex');
    return this.database.inPlatformContext(async tx => {
      await tx`select id from tenants where id = ${tenantId} for update`;
      const existing = await tx<{ id: string; request_hash: string }[]>`select id, request_hash from content_ad_report_rows
        where tenant_id = ${tenantId} and report_id = ${input.reportId} and row_id = ${input.rowId}`;
      if (existing[0]) {
        if (existing[0].request_hash !== hash) throw new ConflictException('Ad report row was reused with different facts');
        return { id: existing[0].id, duplicate: true };
      }
      const dramas = await tx<{ scope: string; creator: string | null }[]>`select case owner_type when 'platform' then 'public' else 'private' end as scope,
        case owner_type when 'platform' then shanchuang_creator_id else null end as creator
        from dramas where id = ${input.dramaId} and (owner_type = 'platform' or owner_tenant_id = ${tenantId}) for share`;
      const drama = dramas[0];
      if (!drama || (drama.scope === 'public' && !drama.creator)) throw new NotFoundException('Report content is unavailable');
      if (input.episodeId) {
        const episodes = await tx`select id from episodes where id = ${input.episodeId} and drama_id = ${input.dramaId}`;
        if (!episodes[0]) throw new BadRequestException('Report episode mismatch');
      }
      const id = uuidV7();
      await tx`insert into content_cash_sources(id, tenant_id, source_type, currency, gross_minor, net_minor, occurred_at)
        values (${id}, ${tenantId}, 'ad_report', ${input.currency}, ${gross.toString()}, ${net?.toString() ?? null}, ${at})`;
      await tx`insert into content_ad_report_rows(id, tenant_id, report_id, row_id, report_sha256, request_hash, created_by)
        values (${id}, ${tenantId}, ${input.reportId}, ${input.rowId}, ${input.reportSha256}, ${hash}, ${metadata.actorId!})`;
      await tx`insert into content_revenue_events(id, tenant_id, source_id, drama_id, episode_id, creator_id, content_scope, income_type, denominator, points, occurred_at)
        values (${id}, ${tenantId}, ${id}, ${input.dramaId}, ${input.episodeId ?? null}, ${drama.creator}, ${drama.scope}, 'content_ad', 1, 1, ${at})`;
      await tx`select app.post_cash_event(${id}::uuid)`;
      return { id, duplicate: false };
    });
  }

  async configureBasis(tenantId: string, basis: unknown, metadata: RevenueMutationMetadata) {
    uuid(tenantId, 'tenantId'); uuid(metadata.actorId, 'actorId');
    if (basis !== 'gross' && basis !== 'net') throw new BadRequestException('Choose gross or net explicitly');
    return this.database.inPlatformContext(async tx => {
      await tx`select id from tenants where id = ${tenantId} for update`;
      await tx`insert into content_revenue_basis(tenant_id, basis, updated_by) values (${tenantId}, ${basis}, ${metadata.actorId!})
        on conflict (tenant_id) do update set basis = excluded.basis, updated_by = excluded.updated_by, updated_at = statement_timestamp()`;
      await tx`insert into audit_logs(id, scope_type, actor_type, actor_id, action, resource_type, resource_id, after_json, request_id)
        values (${uuidV7()}, 'platform', 'platform_staff', ${metadata.actorId!}, 'finance.content_revenue.basis', 'tenant',
          ${tenantId}, ${tx.json({ basis, affects: 'future_and_unconfigured_events_only' })}, ${metadata.requestId})`;
      return { tenantId, basis };
    });
  }

  async reconcile(tenantId: string, metadata: RevenueMutationMetadata) {
    uuid(tenantId, 'tenantId'); uuid(metadata.actorId, 'actorId');
    return this.database.inPlatformContext(async tx => {
      const events = await tx<{ id: string }[]>`select id from content_revenue_events where tenant_id = ${tenantId}
        and state = 'unvalued' order by occurred_at, id limit 500 for update skip locked`;
      for (const event of events) await tx`select app.post_cash_event(${event.id}::uuid, true)`;
      await tx`insert into audit_logs(id, scope_type, actor_type, actor_id, action, resource_type, resource_id, after_json, request_id)
        values (${uuidV7()}, 'platform', 'platform_staff', ${metadata.actorId!}, 'finance.content_revenue.reconcile', 'tenant',
          ${tenantId}, ${tx.json({ attempted: events.length, acceptsCurrentPolicyForPreviouslyUnconfiguredEvents: true })}, ${metadata.requestId})`;
      return { attempted: events.length };
    });
  }

  async upsertPolicy(
    tenantId: string,
    rawInput: RevenueSharePolicyInput,
    metadata: RevenueMutationMetadata,
  ) {
    uuid(tenantId, 'tenantId');
    uuid(metadata.actorId, 'actorId');
    const actorId = metadata.actorId;
    const input = policyInput(rawInput);
    return this.database.inPlatformContext(async (transaction) => {
      const id = uuidV7();
      const rows = await transaction<Array<{ id: string; version: number }>>`
        insert into content_revenue_share_policies (
          id, tenant_id, content_scope, income_type,
          headquarters_bps, tenant_bps, creator_bps, status,
          version, created_by, updated_by
        ) values (
          ${id}, ${tenantId}, ${input.contentScope}, ${input.incomeType},
          ${input.headquartersBps}, ${input.tenantBps}, ${input.creatorBps},
          ${input.status}, 0, ${actorId}, ${actorId}
        ) on conflict (tenant_id, content_scope, income_type) do update set
          headquarters_bps = excluded.headquarters_bps,
          tenant_bps = excluded.tenant_bps,
          creator_bps = excluded.creator_bps,
          status = excluded.status,
          version = content_revenue_share_policies.version + 1,
          updated_by = excluded.updated_by
        where content_revenue_share_policies.version = ${input.expectedVersion}
        returning id, version
      `;
      const saved = rows[0];
      if (!saved) throw new ConflictException('Revenue share policy has changed');
      return { id: saved.id, tenantId, ...input, version: saved.version };
    });
  }

  async listPolicies(tenantId?: string) {
    if (tenantId) uuid(tenantId, 'tenantId');
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{
        content_scope: 'private' | 'public';
        creator_bps: number;
        headquarters_bps: number;
        id: string;
        income_type: (typeof INCOME_TYPES)[number];
        status: 'active' | 'disabled';
        tenant_bps: number;
        tenant_id: string;
        updated_at: Date;
        version: number;
      }>>`
        select id, tenant_id, content_scope, income_type, headquarters_bps,
          tenant_bps, creator_bps, status, version, updated_at
        from content_revenue_share_policies
        where (${tenantId ?? null}::uuid is null or tenant_id = ${tenantId ?? null})
        order by tenant_id, content_scope, income_type
        limit 1000
      `;
      return {
        items: rows.map((row) => ({
          contentScope: row.content_scope,
          creatorBps: row.creator_bps,
          headquartersBps: row.headquarters_bps,
          id: row.id,
          incomeType: row.income_type,
          status: row.status,
          tenantBps: row.tenant_bps,
          tenantId: row.tenant_id,
          updatedAt: row.updated_at.toISOString(),
          version: row.version,
        })),
      };
    });
  }

  async record(rawInput: RecordRevenueInput, metadata: RevenueMutationMetadata) {
    const input = recordInput(rawInput);
    return this.database.inPlatformContext(async (transaction) => {
      const dramas = await transaction<Array<{
        creator_id: string | null; id: string; scope: 'private' | 'public';
      }>>`
        select drama.id,
          case when drama.owner_type = 'platform' then 'public' else 'private' end as scope,
          drama.shanchuang_creator_id as creator_id
        from dramas as drama
        where drama.id = ${input.dramaId}
          and drama.deleted_at is null
          and (
            (drama.owner_type = 'platform' and drama.owner_tenant_id is null)
            or (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${input.tenantId})
          )
        for share of drama
      `;
      const drama = dramas[0];
      if (!drama) throw new NotFoundException('Revenue drama is unavailable');
      if (drama.scope === 'public' && !drama.creator_id) {
        throw new ConflictException('Public drama is missing its Shanchuang creator identifier');
      }
      if (input.episodeId) {
        const episodes = await transaction<{ id: string }[]>`
          select id from episodes where id = ${input.episodeId}
            and drama_id = ${input.dramaId} and deleted_at is null for share
        `;
        if (!episodes[0]) throw new BadRequestException('episodeId does not belong to dramaId');
      }
      const policies = await transaction<Array<{
        creator_bps: number; headquarters_bps: number; tenant_bps: number;
      }>>`
        select headquarters_bps, tenant_bps, creator_bps
        from content_revenue_share_policies
        where tenant_id = ${input.tenantId}
          and content_scope = ${drama.scope}
          and income_type = ${input.incomeType}
          and status = 'active'
        for share
      `;
      const policy = policies[0];
      if (!policy) throw new ConflictException('Active revenue share policy is not configured');
      const headquartersMinor = Number(BigInt(input.grossMinor) * BigInt(policy.headquarters_bps) / 10_000n);
      const creatorMinor = Number(BigInt(input.grossMinor) * BigInt(policy.creator_bps) / 10_000n);
      const tenantMinor = input.grossMinor - headquartersMinor - creatorMinor;
      const id = uuidV7();
      const occurredAt = new Date(input.occurredAt);
      const inserted = await transaction<{ id: string }[]>`
          insert into content_revenue_ledger (
            id, tenant_id, drama_id, episode_id, creator_id_snapshot,
            content_scope, income_type, currency, gross_minor,
            headquarters_minor, tenant_minor, creator_minor,
            headquarters_bps_snapshot, tenant_bps_snapshot, creator_bps_snapshot,
            source_type, source_id, settlement_month, occurred_at, created_by
          ) values (
            ${id}, ${input.tenantId}, ${input.dramaId}, ${input.episodeId ?? null},
            ${drama.creator_id}, ${drama.scope}, ${input.incomeType}, ${input.currency},
            ${input.grossMinor}, ${headquartersMinor}, ${tenantMinor}, ${creatorMinor},
            ${policy.headquarters_bps}, ${policy.tenant_bps}, ${policy.creator_bps},
            ${input.sourceType}, ${input.sourceId},
            ${new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth(), 1))},
            ${occurredAt}, ${metadata.actorId ?? null}
          )
          on conflict (tenant_id, source_type, source_id) do nothing
          returning id
        `;
      if (!inserted[0]) {
        const existing = await transaction<{ id: string }[]>`
          select id from content_revenue_ledger where tenant_id = ${input.tenantId}
            and source_type = ${input.sourceType} and source_id = ${input.sourceId}
        `;
        if (!existing[0]) throw new ConflictException('Revenue source changed concurrently');
        return { duplicate: true as const, id: existing[0].id };
      }
      return {
        creatorMinor, currency: input.currency, duplicate: false as const,
        grossMinor: input.grossMinor, headquartersMinor, id, tenantMinor,
      };
    });
  }

  async reverse(tenantId: string, ledgerId: string) {
    uuid(tenantId, 'tenantId'); uuid(ledgerId, 'ledgerId');
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<{ id: string }[]>`
        update content_revenue_ledger
        set status = 'reversed', reversal_of_id = id
        where id = ${ledgerId} and tenant_id = ${tenantId} and status = 'pending'
        returning id
      `;
      if (!rows[0]) throw new ConflictException('Revenue entry cannot be reversed');
      return { id: ledgerId, status: 'reversed' as const };
    });
  }

  async list(tenantId: string | undefined, month: string | undefined) {
    if (tenantId) uuid(tenantId, 'tenantId');
    if (month && !/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException('month is invalid');
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{
        content_scope: string; creator_id_snapshot: string | null; creator_minor: string;
        currency: string; drama_id: string; episode_id: string | null; gross_minor: string;
        headquarters_minor: string; id: string; income_type: string; occurred_at: Date;
        settlement_month: Date | string; source_id: string; source_type: string; status: string;
        tenant_id: string; tenant_minor: string;
      }>>`
        select id, tenant_id, drama_id, episode_id, creator_id_snapshot,
          content_scope, income_type, currency, gross_minor::text,
          headquarters_minor::text, tenant_minor::text, creator_minor::text,
          source_type, source_id, settlement_month, occurred_at, status
        from content_revenue_ledger
        where (${tenantId ?? null}::uuid is null or tenant_id = ${tenantId ?? null})
          and (${month ?? null}::text is null
            or settlement_month = (${`${month ?? '2000-01'}-01`})::date)
        order by occurred_at desc, id desc limit 1000
      `;
      const totals = await transaction<Array<{ currency: string; gross: string; headquarters: string; tenant: string; creator: string; count: string }>>`
        select currency, sum(gross_minor)::text as gross, sum(headquarters_minor)::text as headquarters,
          sum(tenant_minor)::text as tenant, sum(creator_minor)::text as creator, count(*)::text as count
        from content_revenue_ledger
        where (${tenantId ?? null}::uuid is null or tenant_id = ${tenantId ?? null})
          and (${month ?? null}::text is null or settlement_month = (${`${month ?? '2000-01'}-01`})::date)
          and status <> 'reversed' group by currency`;
      return { totals, items: rows.map((row) => ({
        contentScope: row.content_scope,
        creatorId: row.creator_id_snapshot ?? undefined,
        creatorMinor: row.creator_minor,
        currency: row.currency,
        dramaId: row.drama_id,
        episodeId: row.episode_id ?? undefined,
        grossMinor: row.gross_minor,
        headquartersMinor: row.headquarters_minor,
        id: row.id,
        incomeType: row.income_type,
        occurredAt: row.occurred_at.toISOString(),
        settlementMonth: typeof row.settlement_month === 'string'
          ? row.settlement_month
          : row.settlement_month.toISOString().slice(0, 10),
        sourceId: row.source_id,
        sourceType: row.source_type,
        status: row.status,
        tenantId: row.tenant_id,
        tenantMinor: row.tenant_minor,
      })) };
    });
  }

  async settleMonth(
    tenantId: string,
    month: string,
    currencyValue: string,
    metadata: RevenueMutationMetadata,
  ) {
    uuid(tenantId, 'tenantId');
    uuid(metadata.actorId, 'actorId');
    const actorId = metadata.actorId;
    const settlementMonth = closedSettlementMonth(month);
    const currency = currencyValue.toUpperCase();
    if (!CURRENCIES.includes(currency as (typeof CURRENCIES)[number])) {
      throw new BadRequestException('currency is invalid');
    }
    return this.database.inPlatformContext(async (transaction) => {
      // Serialize closing with other statements for this tenant. Unvalued cash is never silently omitted.
      await transaction`select id from tenants where id = ${tenantId} for update`;
      const closed = await transaction<{ entry_count: number }[]>`select entry_count from content_revenue_closures
        where tenant_id = ${tenantId} and currency = ${currency} and settlement_month = ${settlementMonth}::date`;
      if (closed[0]) return { alreadySettled: true, count: closed[0].entry_count, currency, month, tenantId };
      const unresolved = await transaction<{ blocked: boolean }[]>`select
        exists(select 1 from content_revenue_legacy_review where tenant_id = ${tenantId} and resolved_at is null)
        or exists(select 1 from content_revenue_events e join content_cash_sources s on s.id = e.source_id
          where e.tenant_id = ${tenantId} and s.currency = ${currency} and e.state = 'unvalued'
            and e.occurred_at < (${settlementMonth}::date + interval '1 month')) as blocked`;
      if (unresolved[0]?.blocked) throw new ConflictException('Unvalued revenue or legacy cash reconciliation blocks settlement');
      const rows = await transaction<Array<{
        creator_minor: string; gross_minor: string; headquarters_minor: string;
        id: string; tenant_minor: string;
      }>>`
        select id, gross_minor::text, headquarters_minor::text,
          tenant_minor::text, creator_minor::text
        from content_revenue_ledger
        where tenant_id = ${tenantId}
          and settlement_month = ${settlementMonth}::date
          and currency = ${currency}
          and status = 'pending'
        order by id
        for update
      `;
      if (rows.length === 0) {
        const existing = await transaction<Array<{ count: number }>>`
          select count(*)::integer as count from content_revenue_ledger
          where tenant_id = ${tenantId}
            and settlement_month = ${settlementMonth}::date
            and currency = ${currency}
            and status = 'settled'
        `;
        await transaction`insert into content_revenue_closures(tenant_id, currency, settlement_month, entry_count, created_by)
          values (${tenantId}, ${currency}, ${settlementMonth}::date, ${existing[0]?.count ?? 0}, ${actorId})`;
        return {
          alreadySettled: (existing[0]?.count ?? 0) > 0,
          count: existing[0]?.count ?? 0,
          currency,
          month,
          tenantId,
        };
      }
      await transaction`
        update content_revenue_ledger set status = 'settled'
        where id = any(${rows.map((row) => row.id)}::uuid[])
          and status = 'pending'
      `;
      const totals = rows.reduce((sum, row) => ({
        creatorMinor: sum.creatorMinor + BigInt(row.creator_minor),
        grossMinor: sum.grossMinor + BigInt(row.gross_minor),
        headquartersMinor: sum.headquartersMinor + BigInt(row.headquarters_minor),
        tenantMinor: sum.tenantMinor + BigInt(row.tenant_minor),
      }), { creatorMinor: 0n, grossMinor: 0n, headquartersMinor: 0n, tenantMinor: 0n });
      await transaction`insert into content_revenue_closures(tenant_id, currency, settlement_month, entry_count, created_by)
        values (${tenantId}, ${currency}, ${settlementMonth}::date, ${rows.length}, ${actorId})`;
      await transaction`
        insert into audit_logs (
          id, scope_type, actor_type, actor_id, action, resource_type,
          resource_id, after_json, request_id
        ) values (
          ${uuidV7()}, 'platform', 'platform_staff', ${actorId},
          'finance.content_revenue.settle', 'content_revenue_month',
          ${tenantId},
          ${transaction.json({ count: rows.length, currency, month, tenantId })},
          ${metadata.requestId}
        )
      `;
      return {
        alreadySettled: false,
        count: rows.length,
        creatorMinor: totals.creatorMinor.toString(),
        currency,
        grossMinor: totals.grossMinor.toString(),
        headquartersMinor: totals.headquartersMinor.toString(),
        month,
        tenantId,
        tenantMinor: totals.tenantMinor.toString(),
      };
    });
  }
}

function closedSettlementMonth(value: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    throw new BadRequestException('month is invalid');
  }
  const month = new Date(`${value}-01T00:00:00.000Z`);
  const current = new Date();
  const currentMonth = new Date(Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), 1));
  if (month >= currentMonth) {
    throw new BadRequestException('Only a closed UTC month can be settled');
  }
  return `${value}-01`;
}

function moneyString(value: unknown): bigint {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value) || BigInt(value) > 9_000_000_000_000_000n)
    throw new BadRequestException('Money must be an integer minor-unit string');
  return BigInt(value);
}
function statement(input: { reportId: string; rowId: string; reportSha256: string }) {
  if (!input || !/^[a-f0-9]{64}$/.test(input.reportSha256 ?? '')
    || [input.reportId, input.rowId].some(v => typeof v !== 'string' || !v.trim() || v.length > 200 || /[\r\n\0]/.test(v)))
    throw new BadRequestException('An identified headquarters-verified report is required');
}

function policyInput(input: RevenueSharePolicyInput) {
  if (!input || !['public', 'private'].includes(input.contentScope)
      || !INCOME_TYPES.includes(input.incomeType)) throw new BadRequestException('Policy target is invalid');
  const headquartersBps = bps(input.headquartersBps);
  const tenantBps = bps(input.tenantBps);
  const creatorBps = bps(input.creatorBps);
  if (headquartersBps + tenantBps + creatorBps !== 10_000) {
    throw new BadRequestException('Revenue shares must add to 10000 basis points');
  }
  if ((input.incomeType === 'membership' || input.contentScope === 'private') && creatorBps !== 0) {
    throw new BadRequestException('Creator share is not allowed for this policy');
  }
  return { ...input, creatorBps, expectedVersion: version(input.expectedVersion), headquartersBps,
    status: input.status ?? 'active', tenantBps };
}

function recordInput(input: RecordRevenueInput) {
  if (!input || !INCOME_TYPES.includes(input.incomeType) || !CURRENCIES.includes(input.currency)) {
    throw new BadRequestException('Revenue input is invalid');
  }
  uuid(input.tenantId, 'tenantId'); uuid(input.dramaId, 'dramaId');
  if (input.episodeId) uuid(input.episodeId, 'episodeId');
  if (!Number.isSafeInteger(input.grossMinor) || input.grossMinor < 0) {
    throw new BadRequestException('grossMinor is invalid');
  }
  const occurredAt = new Date(input.occurredAt);
  if (Number.isNaN(occurredAt.getTime()) || occurredAt.toISOString() !== input.occurredAt) {
    throw new BadRequestException('occurredAt must be a canonical ISO timestamp');
  }
  if (typeof input.sourceId !== 'string' || input.sourceId.trim().length < 1
      || input.sourceId.trim().length > 500) throw new BadRequestException('sourceId is invalid');
  return { ...input, sourceId: input.sourceId.trim() };
}

function bps(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 10_000) {
    throw new BadRequestException('Revenue basis points are invalid');
  }
  return Number(value);
}

function version(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > 1_000_000_000) {
    throw new BadRequestException('expectedVersion is invalid');
  }
  return Number(value);
}

function uuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}
