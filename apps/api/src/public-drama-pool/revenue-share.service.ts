import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService } from '../database/database.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const INCOME_TYPES = ['coin_unlock', 'content_ad', 'membership'] as const;
const CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'KRW'] as const;

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

@Injectable()
export class RevenueShareService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

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
      const headquartersMinor = Math.floor(input.grossMinor * policy.headquarters_bps / 10_000);
      const creatorMinor = Math.floor(input.grossMinor * policy.creator_bps / 10_000);
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
      const rows = await transaction<any[]>`
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
      return { items: rows };
    });
  }
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
