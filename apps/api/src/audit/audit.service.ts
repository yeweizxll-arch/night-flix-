import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import {
  DatabaseService,
} from '../database/database.service';
import { sanitizeAuditJson } from './audit-sanitizer';
import type {
  AuditActorType,
  AuditLogPage,
  AuditLogQueryInput,
  AuditLogRecord,
} from './audit.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const RESOURCE_TYPE_PATTERN = /^[a-z][a-z0-9_]{1,99}$/;
const ACTOR_TYPES = new Set<AuditActorType>([
  'platform_staff',
  'system',
  'tenant_staff',
  'user',
]);
const MAX_TIME_RANGE_MS = 90 * 24 * 60 * 60 * 1_000;
const DEFAULT_TIME_RANGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_PAGE_JSON_BYTES = 512 * 1_024;

interface AuditLogRow {
  action: string;
  actor_id: string | null;
  actor_type: AuditActorType;
  after_json: unknown;
  before_json: unknown;
  created_at: Date;
  id: string;
  ip: string | null;
  request_id: string;
  resource_id: string | null;
  resource_type: string;
  scope_type: 'platform' | 'tenant';
  tenant_id: string | null;
  total_count: number;
}

interface ValidatedAuditQuery {
  action?: string;
  actorId?: string;
  actorType?: AuditActorType;
  from: string;
  page: number;
  pageSize: number;
  qPattern?: string;
  requestId?: string;
  resourceId?: string;
  resourceType?: string;
  tenantId?: string;
  to: string;
}

@Injectable()
export class AuditService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async listPlatform(rawQuery: AuditLogQueryInput): Promise<AuditLogPage> {
    const query = validateQuery(rawQuery, true);
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<AuditLogRow[]>`
        select
          audit.id,
          audit.scope_type,
          audit.tenant_id,
          audit.actor_type,
          audit.actor_id,
          audit.action,
          audit.resource_type,
          audit.resource_id,
          case
            when audit.before_json is null then null
            when pg_column_size(audit.before_json) <= 131072 then audit.before_json
            else '{"_truncated":"source audit JSON exceeded the read limit"}'::jsonb
          end as before_json,
          case
            when audit.after_json is null then null
            when pg_column_size(audit.after_json) <= 131072 then audit.after_json
            else '{"_truncated":"source audit JSON exceeded the read limit"}'::jsonb
          end as after_json,
          audit.ip::text,
          audit.request_id,
          audit.created_at,
          count(*) over()::integer as total_count
        from audit_logs as audit
        where audit.created_at >= ${query.from}::timestamptz
          and audit.created_at <= ${query.to}::timestamptz
          and (${query.tenantId ?? null}::uuid is null or audit.tenant_id = ${query.tenantId ?? null})
          and (${query.actorId ?? null}::uuid is null or audit.actor_id = ${query.actorId ?? null})
          and (${query.actorType ?? null}::text is null or audit.actor_type = ${query.actorType ?? null})
          and (${query.action ?? null}::text is null or audit.action = ${query.action ?? null})
          and (${query.resourceId ?? null}::uuid is null or audit.resource_id = ${query.resourceId ?? null})
          and (${query.resourceType ?? null}::text is null or audit.resource_type = ${query.resourceType ?? null})
          and (${query.requestId ?? null}::text is null or audit.request_id = ${query.requestId ?? null})
          and (
            ${query.qPattern ?? null}::text is null
            or audit.action ilike ${query.qPattern ?? null} escape '!'
            or audit.resource_type ilike ${query.qPattern ?? null} escape '!'
            or audit.request_id ilike ${query.qPattern ?? null} escape '!'
            or coalesce(audit.actor_id::text, '') ilike ${query.qPattern ?? null} escape '!'
            or coalesce(audit.resource_id::text, '') ilike ${query.qPattern ?? null} escape '!'
          )
        order by audit.created_at desc, audit.id desc
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
      `;
      return toPage(rows, query);
    });
  }

  async listTenant(tenantId: string, rawQuery: AuditLogQueryInput): Promise<AuditLogPage> {
    requireUuid(tenantId, 'tenantId');
    const query = validateQuery(rawQuery, false);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<AuditLogRow[]>`
        select
          audit.id,
          audit.scope_type,
          audit.tenant_id,
          audit.actor_type,
          audit.actor_id,
          audit.action,
          audit.resource_type,
          audit.resource_id,
          case
            when audit.before_json is null then null
            when pg_column_size(audit.before_json) <= 131072 then audit.before_json
            else '{"_truncated":"source audit JSON exceeded the read limit"}'::jsonb
          end as before_json,
          case
            when audit.after_json is null then null
            when pg_column_size(audit.after_json) <= 131072 then audit.after_json
            else '{"_truncated":"source audit JSON exceeded the read limit"}'::jsonb
          end as after_json,
          audit.ip::text,
          audit.request_id,
          audit.created_at,
          count(*) over()::integer as total_count
        from audit_logs as audit
        where audit.scope_type = 'tenant'
          and audit.tenant_id = ${tenantId}
          and audit.created_at >= ${query.from}::timestamptz
          and audit.created_at <= ${query.to}::timestamptz
          and (${query.actorId ?? null}::uuid is null or audit.actor_id = ${query.actorId ?? null})
          and (${query.actorType ?? null}::text is null or audit.actor_type = ${query.actorType ?? null})
          and (${query.action ?? null}::text is null or audit.action = ${query.action ?? null})
          and (${query.resourceId ?? null}::uuid is null or audit.resource_id = ${query.resourceId ?? null})
          and (${query.resourceType ?? null}::text is null or audit.resource_type = ${query.resourceType ?? null})
          and (${query.requestId ?? null}::text is null or audit.request_id = ${query.requestId ?? null})
          and (
            ${query.qPattern ?? null}::text is null
            or audit.action ilike ${query.qPattern ?? null} escape '!'
            or audit.resource_type ilike ${query.qPattern ?? null} escape '!'
            or audit.request_id ilike ${query.qPattern ?? null} escape '!'
            or coalesce(audit.actor_id::text, '') ilike ${query.qPattern ?? null} escape '!'
            or coalesce(audit.resource_id::text, '') ilike ${query.qPattern ?? null} escape '!'
          )
        order by audit.created_at desc, audit.id desc
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
      `;
      return toPage(rows, query);
    });
  }
}

function toPage(rows: AuditLogRow[], query: ValidatedAuditQuery): AuditLogPage {
  let jsonBytes = 0;
  return {
    items: rows.map((row) => {
      let before = sanitizeAuditJson(row.before_json);
      let after = sanitizeAuditJson(row.after_json);
      const detailBytes = Buffer.byteLength(JSON.stringify([before, after]), 'utf8');
      if (jsonBytes + detailBytes > MAX_PAGE_JSON_BYTES) {
        before = { _truncated: 'audit page JSON response limit reached' };
        after = { _truncated: 'audit page JSON response limit reached' };
      } else {
        jsonBytes += detailBytes;
      }
      return toRecord(row, before, after);
    }),
    page: query.page,
    pageSize: query.pageSize,
    total: rows[0]?.total_count ?? 0,
  };
}

function toRecord(row: AuditLogRow, before: unknown, after: unknown): AuditLogRecord {
  return {
    action: row.action,
    actor: { id: row.actor_id, type: row.actor_type },
    after,
    before,
    createdAt: row.created_at.toISOString(),
    id: row.id,
    ip: row.ip,
    requestId: row.request_id,
    resource: { id: row.resource_id, type: row.resource_type },
    scope: row.scope_type,
    tenantId: row.tenant_id,
  };
}

function validateQuery(
  rawQuery: AuditLogQueryInput,
  allowTenantFilter: boolean,
): ValidatedAuditQuery {
  if (!rawQuery || typeof rawQuery !== 'object' || Array.isArray(rawQuery)) {
    throw new BadRequestException('Query is invalid');
  }
  if (!allowTenantFilter && rawQuery.tenantId !== undefined) {
    throw new BadRequestException('tenantId is not allowed on the tenant audit route');
  }
  const now = Date.now();
  const explicitTo = optionalTimestamp(rawQuery.to, 'to');
  const toMs = explicitTo?.getTime() ?? now;
  if (toMs > now + MAX_FUTURE_SKEW_MS) {
    throw new BadRequestException('to cannot be in the future');
  }
  const explicitFrom = optionalTimestamp(rawQuery.from, 'from');
  const fromMs = explicitFrom?.getTime() ?? toMs - DEFAULT_TIME_RANGE_MS;
  if (fromMs > toMs || toMs - fromMs > MAX_TIME_RANGE_MS) {
    throw new BadRequestException('Audit time range must be between 0 and 90 days');
  }

  let actorId = optionalUuid(rawQuery.actorId, 'actorId');
  let actorType = optionalActorType(rawQuery.actorType);
  if (rawQuery.actor !== undefined) {
    if (actorId || actorType) throw new BadRequestException('actor is ambiguous');
    if (typeof rawQuery.actor === 'string' && UUID_PATTERN.test(rawQuery.actor)) {
      actorId = rawQuery.actor;
    } else {
      actorType = optionalActorType(rawQuery.actor, true);
    }
  }

  let resourceId = optionalUuid(rawQuery.resourceId, 'resourceId');
  let resourceType = optionalResourceType(rawQuery.resourceType);
  if (rawQuery.resource !== undefined) {
    if (resourceId || resourceType) throw new BadRequestException('resource is ambiguous');
    if (typeof rawQuery.resource === 'string' && UUID_PATTERN.test(rawQuery.resource)) {
      resourceId = rawQuery.resource;
    } else {
      resourceType = optionalResourceType(rawQuery.resource, true);
    }
  }

  const q = optionalBoundedString(rawQuery.q, 'q', 2, 100);
  return {
    action: optionalPatternString(rawQuery.action, 'action', ACTION_PATTERN, 200),
    actorId,
    actorType,
    from: new Date(fromMs).toISOString(),
    page: boundedInteger(rawQuery.page, 'page', 1, 10_000, 1),
    pageSize: boundedInteger(rawQuery.pageSize, 'pageSize', 1, 100, 20),
    qPattern: q ? `%${escapeLike(q)}%` : undefined,
    requestId: optionalBoundedString(rawQuery.requestId, 'requestId', 8, 128),
    resourceId,
    resourceType,
    tenantId: allowTenantFilter ? optionalUuid(rawQuery.tenantId, 'tenantId') : undefined,
    to: new Date(toMs).toISOString(),
  };
}

function optionalTimestamp(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (
    typeof value !== 'string'
    || value.length > 50
    || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  ) {
    throw new BadRequestException(`${field} must be an ISO-8601 timestamp with timezone`);
  }
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) {
    throw new BadRequestException(`${field} must be a valid timestamp`);
  }
  return result;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requireUuid(value, field);
}

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function optionalActorType(value: unknown, required = false): AuditActorType | undefined {
  if (!required && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string' || !ACTOR_TYPES.has(value as AuditActorType)) {
    throw new BadRequestException('actorType is invalid');
  }
  return value as AuditActorType;
}

function optionalResourceType(value: unknown, required = false): string | undefined {
  if (!required && (value === undefined || value === null || value === '')) return undefined;
  return optionalPatternString(value, 'resourceType', RESOURCE_TYPE_PATTERN, 100, true);
}

function optionalPatternString(
  value: unknown,
  field: string,
  pattern: RegExp,
  maximum: number,
  required = false,
): string | undefined {
  if (!required && (value === undefined || value === null || value === '')) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} is invalid`);
  const result = value.trim();
  if (result.length > maximum || !pattern.test(result)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return result;
}

function optionalBoundedString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} is invalid`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return result;
}

function boundedInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
  fallback: number,
): number {
  if (value === undefined || value === null || value === '') return fallback;
  if (Array.isArray(value) || !/^\d+$/.test(String(value))) {
    throw new BadRequestException(`${field} is invalid`);
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return result;
}

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, (character) => `!${character}`);
}
