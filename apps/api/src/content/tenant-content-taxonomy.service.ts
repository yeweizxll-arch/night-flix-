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
import type { ContentMutationMetadata } from './content.types';

type TaxonomyType = 'category' | 'tag';
type Translation = { locale: string; name: string };
const LOCALES = new Set(['zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

@Injectable()
export class TenantContentTaxonomyService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async list(
    tenantId: string,
    type: TaxonomyType,
    rawQuery: Record<string, unknown>,
  ) {
    assertUuid(tenantId, 'tenantId');
    onlyKeys(rawQuery, ['deleted', 'page', 'pageSize', 'scope']);
    const page = integer(rawQuery.page ?? 1, 'page', 1, 10_000);
    const pageSize = integer(rawQuery.pageSize ?? 20, 'pageSize', 1, 100);
    const deleted = boolean(rawQuery.deleted, 'deleted', false);
    const scope = enumValue(rawQuery.scope ?? 'all', 'scope', ['all', 'tenant', 'platform']);
    const table = tableName(type);
    const translations = translationTable(type);
    const ownerColumn = translationOwnerColumn(type);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const condition = scope === 'tenant'
        ? "item.owner_type = 'tenant' and item.owner_tenant_id = $1"
        : scope === 'platform'
          ? "item.owner_type = 'platform' and item.owner_tenant_id is null"
          : "((item.owner_type = 'tenant' and item.owner_tenant_id = $1) or (item.owner_type = 'platform' and item.owner_tenant_id is null))";
      const rows = await transaction.unsafe<Array<{
        code: string; deleted_at: Date | null; id: string; owner_type: string;
        sort_order?: number; status: string; translations: Translation[]; version: number;
      }>>(`
        select item.id, item.owner_type, item.code::text as code, item.status,
          item.deleted_at, item.version${type === 'category' ? ', item.sort_order' : ''},
          coalesce((select jsonb_agg(jsonb_build_object('locale', t.locale, 'name', t.name)
            order by t.locale) from ${translations} as t
            where t.${ownerColumn} = item.id), '[]'::jsonb) as translations
        from ${table} as item
        where ${condition} and ($2 or item.deleted_at is null)
          and (item.owner_type = 'tenant' or item.status = 'active')
        order by item.owner_type desc${type === 'category' ? ', item.sort_order' : ''}, item.code, item.id
        limit $3 offset $4
      `, [tenantId, deleted, pageSize, (page - 1) * pageSize]);
      const total = await transaction.unsafe<Array<{ count: number }>>(`
        select count(*)::integer as count from ${table} as item
        where ${condition} and ($2 or item.deleted_at is null)
          and (item.owner_type = 'tenant' or item.status = 'active')
      `, [tenantId, deleted]);
      return {
        items: rows.map((row) => ({
          code: row.code,
          deletedAt: row.deleted_at?.toISOString(),
          id: row.id,
          ownerType: row.owner_type,
          ...(type === 'category' ? { sortOrder: row.sort_order ?? 0 } : {}),
          status: row.status,
          translations: row.translations,
          version: row.version,
        })),
        page,
        pageSize,
        total: total[0]?.count ?? 0,
      };
    });
  }

  async create(
    tenantId: string,
    type: TaxonomyType,
    raw: unknown,
    metadata: ContentMutationMetadata,
  ) {
    assertUuid(tenantId, 'tenantId');
    const input = createInput(type, raw);
    assertMetadata(metadata);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<Record<string, unknown>>(
        transaction, tenantId, metadata, `tenant.content.${type}.create`, input,
      );
      if (command.cached) return command.cached;
      const id = uuidV7();
      const table = tableName(type);
      try {
        await transaction.unsafe(`
          insert into ${table} (
            id, owner_type, owner_tenant_id, code${type === 'category' ? ', sort_order' : ''},
            status, created_by, updated_by
          ) values ($1, 'tenant', $2, $3${type === 'category' ? ', $4' : ''},
            $${type === 'category' ? 5 : 4}, $${type === 'category' ? 6 : 5},
            $${type === 'category' ? 6 : 5})
        `, type === 'category'
          ? [id, tenantId, input.code, input.sortOrder, input.status, metadata.actorId]
          : [id, tenantId, input.code, input.status, metadata.actorId]);
      } catch (error) {
        translateUnique(error, `Tenant ${type} code already exists`);
      }
      await this.replaceTranslations(transaction, type, id, input.translations);
      const response = {
        code: input.code, id, ownerType: 'tenant',
        ...(type === 'category' ? { sortOrder: input.sortOrder } : {}),
        status: input.status, translations: input.translations, version: 0,
      };
      await this.record(transaction, tenantId, type, id, `${type}.create`, response, metadata);
      await this.completeCommand(transaction, command.id, response, type, id);
      return response;
    });
  }

  async update(
    tenantId: string,
    type: TaxonomyType,
    id: string,
    raw: unknown,
    metadata: ContentMutationMetadata,
  ) {
    assertUuid(tenantId, 'tenantId'); assertUuid(id, `${type}Id`);
    const input = updateInput(type, raw); assertMetadata(metadata);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<Record<string, unknown>>(
        transaction, tenantId, metadata, `tenant.content.${type}.update`, { id, ...input },
      );
      if (command.cached) return command.cached;
      const table = tableName(type);
      const rows = await transaction.unsafe<Array<{
        code: string; sort_order?: number; status: string; version: number;
      }>>(`select code::text as code, status, version${type === 'category' ? ', sort_order' : ''}
        from ${table} where id = $1 and owner_type = 'tenant' and owner_tenant_id = $2
          and deleted_at is null for update`, [id, tenantId]);
      const current = rows[0];
      if (!current) throw new NotFoundException(`Tenant ${type} not found`);
      if (current.version !== input.expectedVersion) throw new ConflictException(`${type} changed concurrently`);
      try {
        const updated = await transaction.unsafe<Array<{ version: number }>>(`
          update ${table} set code = coalesce($1, code), status = coalesce($2, status),
            ${type === 'category' ? 'sort_order = coalesce($3, sort_order),' : ''}
            version = version + 1, updated_by = $${type === 'category' ? 4 : 3}
          where id = $${type === 'category' ? 5 : 4} and version = $${type === 'category' ? 6 : 5}
          returning version
        `, type === 'category'
          ? [input.code ?? null, input.status ?? null, input.sortOrder ?? null,
              metadata.actorId, id, input.expectedVersion]
          : [input.code ?? null, input.status ?? null, metadata.actorId, id, input.expectedVersion]);
        if (!updated[0]) throw new ConflictException(`${type} changed concurrently`);
        current.version = updated[0].version;
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        translateUnique(error, `Tenant ${type} code already exists`);
      }
      if (input.translations) {
        await transaction.unsafe(
          `delete from ${translationTable(type)} where ${translationOwnerColumn(type)} = $1`, [id],
        );
        await this.replaceTranslations(transaction, type, id, input.translations);
      }
      const translations = input.translations ?? await this.loadTranslations(transaction, type, id);
      const response = {
        code: input.code ?? current.code, id, ownerType: 'tenant',
        ...(type === 'category'
          ? { sortOrder: input.sortOrder ?? current.sort_order ?? 0 } : {}),
        status: input.status ?? current.status, translations, version: current.version,
      };
      await this.record(transaction, tenantId, type, id, `${type}.update`, response, metadata);
      await this.completeCommand(transaction, command.id, response, type, id);
      return response;
    });
  }

  async remove(
    tenantId: string,
    type: TaxonomyType,
    id: string,
    raw: unknown,
    metadata: ContentMutationMetadata,
  ) {
    assertUuid(tenantId, 'tenantId'); assertUuid(id, `${type}Id`);
    const input = deleteInput(raw); assertMetadata(metadata);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<Record<string, unknown>>(
        transaction, tenantId, metadata, `tenant.content.${type}.delete`, { id, ...input },
      );
      if (command.cached) return command.cached;
      const table = tableName(type);
      const rows = await transaction.unsafe<Array<{ status: string; version: number }>>(`
        select status, version from ${table} where id = $1 and owner_type = 'tenant'
          and owner_tenant_id = $2 and deleted_at is null for update
      `, [id, tenantId]);
      const current = rows[0];
      if (!current) throw new NotFoundException(`Tenant ${type} not found`);
      if (current.version !== input.expectedVersion) throw new ConflictException(`${type} changed concurrently`);
      const reference = type === 'category'
        ? await transaction<{ id: string }[]>`select id from dramas where owner_type = 'tenant'
            and owner_tenant_id = ${tenantId} and category_id = ${id} limit 1 for share`
        : await transaction<{ id: string }[]>`select drama_id as id from drama_tags join dramas
            on dramas.id = drama_tags.drama_id where dramas.owner_type = 'tenant'
            and dramas.owner_tenant_id = ${tenantId} and drama_tags.tag_id = ${id} limit 1 for share`;
      if (reference[0]) throw new ConflictException(`Referenced ${type} cannot be deleted`);
      const changed = await transaction.unsafe<Array<{
        deleted_at: Date; restore_until: Date; version: number;
      }>>(`update ${table} set deleted_at = statement_timestamp(), deleted_by = $1,
          delete_reason = $2, restore_until = statement_timestamp() + interval '30 days',
          version = version + 1, updated_by = $1 where id = $3 and version = $4
          returning deleted_at, restore_until, version`,
      [metadata.actorId, input.reason, id, input.expectedVersion]);
      const result = changed[0];
      if (!result) throw new ConflictException(`${type} changed concurrently`);
      await transaction`insert into content_deletion_history (
          id, scope_type, tenant_id, target_type, target_id, action,
          previous_status, resulting_status, reason, restore_until, actor_type, actor_id
        ) values (${uuidV7()}, 'tenant', ${tenantId}, ${type}, ${id}, 'soft_delete',
          ${current.status}, ${current.status}, ${input.reason}, ${result.restore_until},
          'tenant_staff', ${metadata.actorId})`;
      const response = { deletedAt: result.deleted_at.toISOString(),
        restoreUntil: result.restore_until.toISOString(), version: result.version };
      await this.record(transaction, tenantId, type, id, `${type}.delete`, response, metadata);
      await this.completeCommand(transaction, command.id, response, type, id);
      return response;
    });
  }

  async restore(
    tenantId: string,
    type: TaxonomyType,
    id: string,
    raw: unknown,
    metadata: ContentMutationMetadata,
  ) {
    assertUuid(tenantId, 'tenantId'); assertUuid(id, `${type}Id`);
    const input = expectedVersionInput(raw); assertMetadata(metadata);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<Record<string, unknown>>(
        transaction, tenantId, metadata, `tenant.content.${type}.restore`, { id, ...input },
      );
      if (command.cached) return command.cached;
      const table = tableName(type);
      const rows = await transaction.unsafe<Array<{
        code: string; restore_until: Date | null; sort_order?: number; status: string; version: number;
      }>>(`select code::text as code, status, restore_until, version
          ${type === 'category' ? ', sort_order' : ''} from ${table}
        where id = $1 and owner_type = 'tenant' and owner_tenant_id = $2
          and deleted_at is not null for update`, [id, tenantId]);
      const current = rows[0];
      if (!current?.restore_until) throw new ConflictException(`${type} is not restorable`);
      if (current.version !== input.expectedVersion) throw new ConflictException(`${type} changed concurrently`);
      const history = await transaction<{ id: string }[]>`select id from content_deletion_history
        where scope_type = 'tenant' and tenant_id = ${tenantId} and target_type = ${type}
          and target_id = ${id} and action = 'soft_delete'
        order by created_at desc, id desc limit 1 for share`;
      if (!history[0]) throw new ConflictException('Deletion history is unavailable');
      const changed = await transaction.unsafe<Array<{ version: number }>>(`
        update ${table} set deleted_at = null, deleted_by = null, delete_reason = null,
          restore_until = null, version = version + 1, updated_by = $1
        where id = $2 and version = $3 and restore_until > statement_timestamp()
        returning version`, [metadata.actorId, id, input.expectedVersion]);
      if (!changed[0]) throw new ConflictException('Restore window has expired');
      await transaction`insert into content_deletion_history (
          id, scope_type, tenant_id, target_type, target_id, action, restored_from_id,
          previous_status, resulting_status, reason, actor_type, actor_id
        ) values (${uuidV7()}, 'tenant', ${tenantId}, ${type}, ${id}, 'restore',
          ${history[0].id}, ${current.status}, ${current.status},
          'restored within retention window', 'tenant_staff', ${metadata.actorId})`;
      const response = { code: current.code, id, ownerType: 'tenant',
        ...(type === 'category' ? { sortOrder: current.sort_order ?? 0 } : {}),
        status: current.status, translations: await this.loadTranslations(transaction, type, id),
        version: changed[0].version };
      await this.record(transaction, tenantId, type, id, `${type}.restore`, response, metadata);
      await this.completeCommand(transaction, command.id, response, type, id);
      return response;
    });
  }

  private async replaceTranslations(
    transaction: DatabaseTransaction, type: TaxonomyType, id: string, translations: Translation[],
  ) {
    for (const item of translations) {
      await transaction.unsafe(
        `insert into ${translationTable(type)} (id, ${translationOwnerColumn(type)}, locale, name)
          values ($1, $2, $3, $4)`, [uuidV7(), id, item.locale, item.name],
      );
    }
  }

  private loadTranslations(transaction: DatabaseTransaction, type: TaxonomyType, id: string) {
    return transaction.unsafe<Translation[]>(
      `select locale, name from ${translationTable(type)}
        where ${translationOwnerColumn(type)} = $1 order by locale`, [id],
    );
  }

  private async record(
    transaction: DatabaseTransaction, tenantId: string, type: TaxonomyType, id: string,
    action: string, after: unknown, metadata: ContentMutationMetadata,
  ) {
    await transaction`insert into audit_logs (id, scope_type, tenant_id, actor_type,
        actor_id, action, resource_type, resource_id, after_json, ip, request_id)
      values (${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff', ${metadata.actorId},
        ${`content.${action}`}, ${type}, ${id}, ${transaction.json(toJson(after))},
        ${metadata.ip ?? null}, ${metadata.requestId})`;
    const eventId = uuidV7();
    await transaction`insert into outbox_events (id, scope_type, tenant_id, event_key,
        idempotency_key, aggregate_type, aggregate_id, event_type, payload_json)
      values (${eventId}, 'tenant', ${tenantId}, ${`event:${eventId}`}, ${metadata.requestId},
        ${type}, ${id}, ${`Tenant${capitalize(type)}Changed`},
        ${transaction.json(toJson({ action, id, tenantId }))})`;
  }

  private async beginCommand<T>(
    transaction: DatabaseTransaction, tenantId: string, metadata: ContentMutationMetadata,
    route: string, request: unknown,
  ): Promise<{ cached?: T; id?: string }> {
    const key = metadata.idempotencyKey?.trim();
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key is required and invalid');
    }
    const hash = createHash('sha256').update(JSON.stringify(toJson(request))).digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key, idempotency_key,
        request_hash, expires_at
      ) values (${id}, 'tenant', ${tenantId}, 'tenant_staff', ${metadata.actorId},
        ${route}, ${key}, ${hash}, statement_timestamp() + interval '24 hours')
      on conflict do nothing returning id`;
    if (inserted[0]) return { id };
    const rows = await transaction<Array<{
      request_hash: string; response_json: unknown; status: string;
    }>>`select request_hash, response_json, status from command_idempotency
      where scope_type = 'tenant' and tenant_id = ${tenantId} and actor_type = 'tenant_staff'
        and actor_id = ${metadata.actorId} and route_key = ${route} and idempotency_key = ${key}
      for update`;
    const row = rows[0];
    if (!row || row.request_hash !== hash) throw new ConflictException('Idempotency-Key conflict');
    if (row.status === 'completed' && row.response_json !== null) return { cached: row.response_json as T };
    throw new ConflictException('The same command is already processing');
  }

  private async completeCommand(
    transaction: DatabaseTransaction, id: string | undefined, response: unknown,
    type: TaxonomyType, resourceId: string,
  ) {
    if (!id) return;
    await transaction`update command_idempotency set status = 'completed', response_status = 200,
      response_json = ${transaction.json(toJson(response))}, resource_type = ${type},
      resource_id = ${resourceId}, locked_at = null where id = ${id} and status = 'processing'`;
  }
}

function createInput(type: TaxonomyType, value: unknown) {
  const raw = inputRecord(value); onlyKeys(raw, ['code', 'sortOrder', 'status', 'translations']);
  if (type === 'tag' && raw.sortOrder !== undefined) throw new BadRequestException('sortOrder is category-only');
  return { code: codeValue(raw.code), sortOrder: type === 'category'
    ? integer(raw.sortOrder ?? 0, 'sortOrder', -1_000_000, 1_000_000) : 0,
  status: enumValue(raw.status ?? 'active', 'status', ['active', 'disabled']),
  translations: translationValue(raw.translations) };
}

function updateInput(type: TaxonomyType, value: unknown) {
  const raw = inputRecord(value); onlyKeys(raw, ['code', 'expectedVersion', 'sortOrder', 'status', 'translations']);
  if (type === 'tag' && raw.sortOrder !== undefined) throw new BadRequestException('sortOrder is category-only');
  const result = { code: raw.code === undefined ? undefined : codeValue(raw.code),
    expectedVersion: integer(raw.expectedVersion, 'expectedVersion', 0, 1_000_000_000),
    sortOrder: raw.sortOrder === undefined ? undefined
      : integer(raw.sortOrder, 'sortOrder', -1_000_000, 1_000_000),
    status: raw.status === undefined ? undefined
      : enumValue(raw.status, 'status', ['active', 'disabled']),
    translations: raw.translations === undefined ? undefined : translationValue(raw.translations) };
  if (result.code === undefined && result.sortOrder === undefined && result.status === undefined
    && result.translations === undefined) throw new BadRequestException('No fields to update');
  return result;
}

function deleteInput(value: unknown) {
  const raw = inputRecord(value); onlyKeys(raw, ['expectedVersion', 'reason']);
  return { expectedVersion: integer(raw.expectedVersion, 'expectedVersion', 0, 1_000_000_000),
    reason: stringValue(raw.reason, 'reason', 1, 2_000) };
}
function expectedVersionInput(value: unknown) {
  const raw = inputRecord(value); onlyKeys(raw, ['expectedVersion']);
  return { expectedVersion: integer(raw.expectedVersion, 'expectedVersion', 0, 1_000_000_000) };
}
function translationValue(value: unknown): Translation[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new BadRequestException('translations must contain 1 to 6 locales');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const raw = inputRecord(item); onlyKeys(raw, ['locale', 'name']);
    const locale = stringValue(raw.locale, 'locale', 2, 20);
    if (!LOCALES.has(locale) || seen.has(locale)) throw new BadRequestException('Unsupported or duplicate locale');
    seen.add(locale);
    return { locale, name: stringValue(raw.name, 'name', 1, 200) };
  });
}
function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Body is required');
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extra.length) throw new BadRequestException(`Unknown field: ${extra[0]}`);
}
function integer(value: unknown, field: string, minimum: number, maximum: number) {
  const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || Number(parsed) < minimum || Number(parsed) > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return Number(parsed);
}
function boolean(value: unknown, field: string, fallback: boolean) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new BadRequestException(`${field} is invalid`);
}
function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new BadRequestException(`${field} is invalid`);
  return value as T;
}
function stringValue(value: unknown, field: string, minimum: number, maximum: number) {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) throw new BadRequestException(`${field} is invalid`);
  return result;
}
function codeValue(value: unknown) {
  const result = stringValue(value, 'code', 2, 64).toLowerCase();
  if (!CODE.test(result)) throw new BadRequestException('code is invalid');
  return result;
}
function tableName(type: TaxonomyType) { return type === 'category' ? 'categories' : 'tags'; }
function translationTable(type: TaxonomyType) {
  return type === 'category' ? 'category_translations' : 'tag_translations';
}
function translationOwnerColumn(type: TaxonomyType) { return type === 'category' ? 'category_id' : 'tag_id'; }
function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException(`${field} is invalid`);
}
function assertMetadata(value: ContentMutationMetadata) {
  assertUuid(value.actorId, 'actorId'); assertUuid(value.requestId, 'requestId');
}
function translateUnique(error: unknown, message: string): never {
  if (error && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}
function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
function capitalize(value: string) { return value.charAt(0).toUpperCase() + value.slice(1); }
