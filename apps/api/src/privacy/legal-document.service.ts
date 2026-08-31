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
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { assertCustomerTenantActive } from '../customer-auth/customer-site-policy';
import {
  CUSTOMER_LEGAL_LOCALES,
  LEGAL_DOCUMENT_TYPES,
  type CustomerLegalLocale,
  type LegalActorContext,
  type LegalCommandMetadata,
  type LegalDocumentType,
} from './privacy.types';

interface LegalDocumentRow {
  body_markdown: string;
  created_at: Date;
  document_type: LegalDocumentType;
  effective_at: Date | null;
  id: string;
  locale: CustomerLegalLocale;
  published_at: Date | null;
  required_for_registration: boolean;
  row_version: number;
  status: 'draft' | 'published';
  title: string;
  updated_at: Date;
  version_no: number;
}

@Injectable()
export class LegalDocumentService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  current(tenantId: string, rawQuery: Record<string, unknown>) {
    const locale = legalLocale(rawQuery.locale);
    rejectUnknown(rawQuery, ['locale']);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await assertCustomerTenantActive(transaction, tenantId);
      const rows = await transaction<LegalDocumentRow[]>`
        with tenant_settings as (
          select default_locale from tenants where id = ${tenantId}
        ), ranked as (
          select document.*,
            row_number() over (
              partition by document.document_type
              order by
                case document.locale
                  when ${locale} then 0
                  when (select default_locale from tenant_settings) then 1
                  when 'en-US' then 2
                  else 3
                end,
                document.effective_at desc,
                document.version_no desc
            ) as locale_rank
          from tenant_legal_document_versions as document
          where document.tenant_id = ${tenantId}
            and document.status = 'published'
            and document.effective_at <= transaction_timestamp()
        )
        select id, document_type, locale, version_no, status, title,
          body_markdown, effective_at, required_for_registration,
          row_version, published_at, created_at, updated_at
        from ranked where locale_rank = 1
        order by document_type
      `;
      return {
        documents: rows.map(publicDocument),
        requestedLocale: locale,
      };
    });
  }

  detail(tenantId: string, documentId: string) {
    requireUuid(documentId, 'documentId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await assertCustomerTenantActive(transaction, tenantId);
      const rows = await transaction<LegalDocumentRow[]>`
        select id, document_type, locale, version_no, status, title,
          body_markdown, effective_at, required_for_registration,
          row_version, published_at, created_at, updated_at
        from tenant_legal_document_versions
        where tenant_id = ${tenantId} and id = ${documentId}
          and status = 'published' and effective_at <= transaction_timestamp()
        limit 1
      `;
      if (!rows[0]) throw new NotFoundException('Legal document was not found');
      return publicDocument(rows[0]);
    });
  }

  list(actor: LegalActorContext, rawQuery: Record<string, unknown>) {
    const page = boundedInteger(rawQuery.page, 1, 1, 10_000, 'page');
    const pageSize = boundedInteger(rawQuery.pageSize, 20, 1, 100, 'pageSize');
    const status = rawQuery.status === undefined ? undefined : String(rawQuery.status);
    const type = rawQuery.type === undefined ? undefined : String(rawQuery.type);
    const locale = rawQuery.locale === undefined
      ? undefined
      : legalLocale(rawQuery.locale);
    rejectUnknown(rawQuery, ['locale', 'page', 'pageSize', 'status', 'type']);
    if (status !== undefined && !['draft', 'published'].includes(status)) {
      throw new BadRequestException('status is invalid');
    }
    if (type !== undefined && !LEGAL_DOCUMENT_TYPES.includes(type as LegalDocumentType)) {
      throw new BadRequestException('type is invalid');
    }
    return this.database.inTenantContext(actor.tenantId, async (transaction) => {
      const rows = await transaction<LegalDocumentRow[]>`
        select id, document_type, locale, version_no, status, title,
          body_markdown, effective_at, required_for_registration,
          row_version, published_at, created_at, updated_at
        from tenant_legal_document_versions
        where tenant_id = ${actor.tenantId}
          and (${status ?? null}::text is null or status = ${status ?? null})
          and (${type ?? null}::text is null or document_type = ${type ?? null})
          and (${locale ?? null}::text is null or locale = ${locale ?? null})
        order by updated_at desc, id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return { items: rows.map(adminDocument), page, pageSize };
    });
  }

  create(
    actor: LegalActorContext,
    rawInput: unknown,
    metadata: LegalCommandMetadata,
  ) {
    const input = parseCreate(rawInput);
    const key = idempotencyKey(metadata.idempotencyKey);
    return this.database.inTenantContext(actor.tenantId, async (transaction) => {
      const command = await beginCommand<ReturnType<typeof adminDocument>>(
        transaction,
        actor,
        'tenant.legal.document.create',
        key,
        hashRequest(input),
      );
      if (command.cached) return command.cached;
      const versions = await transaction<Array<{ version_no: number }>>`
        select version_no
        from tenant_legal_document_versions
        where tenant_id = ${actor.tenantId}
          and document_type = ${input.documentType}
          and locale = ${input.locale}
        order by version_no desc limit 1 for update
      `;
      const id = uuidV7();
      let rows: LegalDocumentRow[];
      try {
        rows = await transaction<LegalDocumentRow[]>`
          insert into tenant_legal_document_versions (
            id, tenant_id, document_type, locale, version_no, title,
            body_markdown, required_for_registration, created_by
          ) values (
            ${id}, ${actor.tenantId}, ${input.documentType}, ${input.locale},
            ${(versions[0]?.version_no ?? 0) + 1}, ${input.title}, ${input.bodyMarkdown},
            ${input.requiredForRegistration}, ${actor.actorId}
          )
          returning id, document_type, locale, version_no, status, title,
            body_markdown, effective_at, required_for_registration,
            row_version, published_at, created_at, updated_at
        `;
      } catch (error) {
        if (databaseCode(error) === '23505') {
          throw new ConflictException('A draft already exists for this document and locale');
        }
        throw error;
      }
      const response = adminDocument(requiredRow(rows[0]));
      await auditAndOutbox(transaction, actor, metadata.requestId, {
        action: 'tenant.legal.document.create',
        document: response,
        eventType: 'TenantLegalDocumentDraftCreated',
      });
      await completeCommand(transaction, command.id, response, id);
      return response;
    });
  }

  update(
    actor: LegalActorContext,
    documentId: string,
    rawInput: unknown,
    metadata: LegalCommandMetadata,
  ) {
    requireUuid(documentId, 'documentId');
    const input = parseUpdate(rawInput);
    const key = idempotencyKey(metadata.idempotencyKey);
    return this.database.inTenantContext(actor.tenantId, async (transaction) => {
      const command = await beginCommand<ReturnType<typeof adminDocument>>(
        transaction, actor, 'tenant.legal.document.update', key,
        hashRequest({ documentId, ...input }),
      );
      if (command.cached) return command.cached;
      const rows = await transaction<LegalDocumentRow[]>`
        update tenant_legal_document_versions
        set title = ${input.title}, body_markdown = ${input.bodyMarkdown},
          required_for_registration = ${input.requiredForRegistration},
          row_version = row_version + 1
        where tenant_id = ${actor.tenantId} and id = ${documentId}
          and status = 'draft' and row_version = ${input.expectedVersion}
        returning id, document_type, locale, version_no, status, title,
          body_markdown, effective_at, required_for_registration,
          row_version, published_at, created_at, updated_at
      `;
      if (!rows[0]) throw new ConflictException('Draft version is stale or unavailable');
      const response = adminDocument(rows[0]);
      await auditAndOutbox(transaction, actor, metadata.requestId, {
        action: 'tenant.legal.document.update', document: response,
        eventType: 'TenantLegalDocumentDraftUpdated',
      });
      await completeCommand(transaction, command.id, response, documentId);
      return response;
    });
  }

  publish(
    actor: LegalActorContext,
    documentId: string,
    rawInput: unknown,
    metadata: LegalCommandMetadata,
  ) {
    requireUuid(documentId, 'documentId');
    const input = parsePublish(rawInput);
    const key = idempotencyKey(metadata.idempotencyKey);
    return this.database.inTenantContext(actor.tenantId, async (transaction) => {
      const command = await beginCommand<ReturnType<typeof adminDocument>>(
        transaction, actor, 'tenant.legal.document.publish', key,
        hashRequest({ documentId, ...input, effectiveAt: input.effectiveAt.toISOString() }),
      );
      if (command.cached) return command.cached;
      const rows = await transaction<LegalDocumentRow[]>`
        update tenant_legal_document_versions
        set status = 'published', effective_at = ${input.effectiveAt},
          published_by = ${actor.actorId}, published_at = transaction_timestamp(),
          row_version = row_version + 1
        where tenant_id = ${actor.tenantId} and id = ${documentId}
          and status = 'draft' and row_version = ${input.expectedVersion}
        returning id, document_type, locale, version_no, status, title,
          body_markdown, effective_at, required_for_registration,
          row_version, published_at, created_at, updated_at
      `;
      if (!rows[0]) throw new ConflictException('Draft version is stale or unavailable');
      const response = adminDocument(rows[0]);
      await auditAndOutbox(transaction, actor, metadata.requestId, {
        action: 'tenant.legal.document.publish', document: response,
        eventType: 'TenantLegalDocumentPublished',
      });
      await completeCommand(transaction, command.id, response, documentId);
      return response;
    });
  }

  removeDraft(
    actor: LegalActorContext,
    documentId: string,
    rawInput: unknown,
    metadata: LegalCommandMetadata,
  ) {
    requireUuid(documentId, 'documentId');
    const input = expectedVersionInput(rawInput);
    const key = idempotencyKey(metadata.idempotencyKey);
    return this.database.inTenantContext(actor.tenantId, async (transaction) => {
      const command = await beginCommand<{ deleted: true; id: string }>(
        transaction, actor, 'tenant.legal.document.delete_draft', key,
        hashRequest({ documentId, ...input }),
      );
      if (command.cached) return command.cached;
      const rows = await transaction<Array<{
        document_type: LegalDocumentType; id: string; locale: CustomerLegalLocale;
        version_no: number;
      }>>`
        delete from tenant_legal_document_versions
        where tenant_id = ${actor.tenantId} and id = ${documentId}
          and status = 'draft' and row_version = ${input.expectedVersion}
        returning id, document_type, locale, version_no
      `;
      if (!rows[0]) throw new ConflictException('Draft version is stale or unavailable');
      const response = { deleted: true as const, id: documentId };
      await auditAndOutbox(transaction, actor, metadata.requestId, {
        action: 'tenant.legal.document.delete_draft',
        document: { ...rows[0], rowVersion: input.expectedVersion },
        eventType: 'TenantLegalDocumentDraftDeleted',
      });
      await completeCommand(transaction, command.id, response, documentId);
      return response;
    });
  }
}

function publicDocument(row: LegalDocumentRow) {
  return {
    bodyMarkdown: row.body_markdown,
    documentType: row.document_type,
    effectiveAt: row.effective_at?.toISOString(),
    id: row.id,
    locale: row.locale,
    requiredForRegistration: row.required_for_registration,
    title: row.title,
    version: row.version_no,
  };
}

function adminDocument(row: LegalDocumentRow) {
  return {
    ...publicDocument(row),
    createdAt: row.created_at.toISOString(),
    publishedAt: row.published_at?.toISOString(),
    rowVersion: row.row_version,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
  };
}

function parseCreate(value: unknown) {
  const record = object(value);
  rejectUnknown(record, [
    'bodyMarkdown', 'documentType', 'locale', 'requiredForRegistration', 'title',
  ]);
  return {
    bodyMarkdown: markdown(record.bodyMarkdown),
    documentType: documentType(record.documentType),
    locale: legalLocale(record.locale),
    requiredForRegistration: booleanValue(
      record.requiredForRegistration, 'requiredForRegistration',
    ),
    title: text(record.title, 'title', 1, 200),
  };
}

function parseUpdate(value: unknown) {
  const record = object(value);
  rejectUnknown(record, [
    'bodyMarkdown', 'expectedVersion', 'requiredForRegistration', 'title',
  ]);
  return {
    bodyMarkdown: markdown(record.bodyMarkdown),
    expectedVersion: integer(record.expectedVersion, 'expectedVersion', 0, 2147483647),
    requiredForRegistration: booleanValue(
      record.requiredForRegistration, 'requiredForRegistration',
    ),
    title: text(record.title, 'title', 1, 200),
  };
}

function parsePublish(value: unknown) {
  const record = object(value);
  rejectUnknown(record, ['effectiveAt', 'expectedVersion']);
  const effectiveAt = new Date(text(record.effectiveAt, 'effectiveAt', 20, 64));
  if (Number.isNaN(effectiveAt.getTime())) {
    throw new BadRequestException('effectiveAt is invalid');
  }
  return {
    effectiveAt,
    expectedVersion: integer(record.expectedVersion, 'expectedVersion', 0, 2147483647),
  };
}

function expectedVersionInput(value: unknown) {
  const record = object(value);
  rejectUnknown(record, ['expectedVersion']);
  return {
    expectedVersion: integer(record.expectedVersion, 'expectedVersion', 0, 2147483647),
  };
}

export function legalLocale(value: unknown): CustomerLegalLocale {
  if (typeof value !== 'string'
    || !CUSTOMER_LEGAL_LOCALES.includes(value as CustomerLegalLocale)) {
    throw new BadRequestException('locale is invalid');
  }
  return value as CustomerLegalLocale;
}

function documentType(value: unknown): LegalDocumentType {
  if (typeof value !== 'string'
    || !LEGAL_DOCUMENT_TYPES.includes(value as LegalDocumentType)) {
    throw new BadRequestException('documentType is invalid');
  }
  return value as LegalDocumentType;
}

function markdown(value: unknown): string {
  const result = text(value, 'bodyMarkdown', 1, 200000);
  if (result.includes('<') || result.includes('>') || result.includes('\0')) {
    throw new BadRequestException('bodyMarkdown must not contain raw HTML');
  }
  return result;
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Body is required');
  }
  return value as Record<string, unknown>;
}

export function rejectUnknown(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new BadRequestException(`Unknown field: ${unknown[0]}`);
}

export function text(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum || result.includes('\0')) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return result;
}

export function integer(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  const result = typeof value === 'string' && /^\d+$/.test(value)
    ? Number(value)
    : value;
  if (!Number.isInteger(result) || Number(result) < minimum || Number(result) > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return Number(result);
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  return value === undefined ? fallback : integer(value, field, minimum, maximum);
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new BadRequestException(`${field} is required`);
  return value;
}

export function requireUuid(value: unknown, field: string): string {
  if (typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

export function idempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.trim())) {
    throw new BadRequestException('A valid Idempotency-Key header is required');
  }
  return value.trim();
}

function hashRequest(value: object): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function beginCommand<T>(
  transaction: DatabaseTransaction,
  actor: LegalActorContext,
  routeKey: string,
  key: string,
  requestHash: string,
): Promise<{ cached?: T; id: string }> {
  const id = uuidV7();
  await transaction`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, expires_at
    ) values (
      ${id}, 'tenant', ${actor.tenantId}, 'tenant_staff', ${actor.actorId},
      ${routeKey}, ${key}, ${requestHash}, transaction_timestamp() + interval '24 hours'
    ) on conflict do nothing
  `;
  const rows = await transaction<Array<{
    id: string; request_hash: string; response_json: T | null; status: string;
  }>>`
    select id, request_hash, response_json, status from command_idempotency
    where tenant_id = ${actor.tenantId} and actor_type = 'tenant_staff'
      and actor_id = ${actor.actorId} and route_key = ${routeKey}
      and idempotency_key = ${key}
    for update
  `;
  const row = requiredRow(rows[0]);
  if (row.request_hash !== requestHash) {
    throw new ConflictException('Idempotency-Key was reused with a different request');
  }
  if (row.status === 'completed' && row.response_json) {
    return { cached: row.response_json, id: row.id };
  }
  if (row.id !== id && row.status === 'processing') {
    throw new ConflictException('The idempotent command is still processing');
  }
  return { id: row.id };
}

async function completeCommand(
  transaction: DatabaseTransaction,
  commandId: string,
  response: object,
  resourceId: string,
): Promise<void> {
  await transaction`
    update command_idempotency set status = 'completed', response_status = 200,
      response_json = ${transaction.json(toJsonValue(response))},
      resource_type = 'legal_document',
      resource_id = ${resourceId}, locked_at = null
    where id = ${commandId} and status = 'processing'
  `;
}

async function auditAndOutbox(
  transaction: DatabaseTransaction,
  actor: LegalActorContext,
  requestId: string,
  input: {
    action: string;
    document: Record<string, unknown>;
    eventType: string;
  },
): Promise<void> {
  const documentId = String(input.document.id);
  const safe = {
    documentType: input.document.documentType ?? input.document.document_type,
    locale: input.document.locale,
    status: input.document.status,
    version: input.document.version ?? input.document.version_no,
  };
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, request_id
    ) values (
      ${uuidV7()}, 'tenant', ${actor.tenantId}, 'tenant_staff', ${actor.actorId},
      ${input.action}, 'legal_document', ${documentId},
      ${transaction.json(toJsonValue(safe))}, ${requestId}
    )
  `;
  const eventId = uuidV7();
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key,
      aggregate_type, aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, 'tenant', ${actor.tenantId}, ${`event:${eventId}`},
      ${`${requestId}:${input.eventType}`}, 'legal_document', ${documentId},
      ${input.eventType}, ${transaction.json(toJsonValue({
        ...safe, documentId, tenantId: actor.tenantId,
      }))}
    )
  `;
}

function requiredRow<T>(value: T | undefined): T {
  if (!value) throw new Error('Expected database row was not returned');
  return value;
}

function databaseCode(value: unknown): string | undefined {
  return value && typeof value === 'object' && 'code' in value
    ? String((value as { code?: unknown }).code)
    : undefined;
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
