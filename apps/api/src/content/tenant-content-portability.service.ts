import { SUPPORTED_APP_LOCALES } from '@drama/contracts';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE = /^[a-z0-9][a-z0-9_-]{1,127}$/;
const KEY = /^[A-Za-z0-9._:-]{8,200}$/;
const LOCALES = new Set<string>(SUPPORTED_APP_LOCALES);
const MAX_BYTES = 1_048_576;
const MAX_DRAMAS = 200;
const MAX_EPISODES = 1_000;
const MAX_FIELD = 20_000;

interface ImportEpisode {
  durationSeconds: number;
  episodeNo: number;
  mediaAssetId: string;
  previewMediaAssetId?: string;
  previewSeconds: number;
  releaseAt?: string;
  translations: Array<{ locale: string; title: string }>;
  unpublishAt?: string;
}
interface ImportDrama {
  categoryId?: string;
  code: string;
  coverMediaAssetId: string;
  episodes: ImportEpisode[];
  releaseAt?: string;
  tagIds: string[];
  translations: Array<{ locale: string; summary: string; title: string }>;
  unpublishAt?: string;
}

@Injectable()
export class TenantContentPortabilityService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async createImport(
    tenantId: string,
    rawBody: unknown,
    metadata: ContentMutationMetadata,
  ) {
    assertUuid(tenantId, 'tenantId'); assertMetadata(metadata);
    const body = record(rawBody); onlyKeys(body, ['format', 'payload']);
    const format = enumValue(body.format, 'format', ['csv', 'json'] as const);
    const source = typeof body.payload === 'string'
      ? body.payload
      : format === 'json' ? JSON.stringify(body.payload) : '';
    const bytes = Buffer.byteLength(source, 'utf8');
    if (bytes < 2 || bytes > MAX_BYTES) throw new BadRequestException('Import payload must be at most 1 MiB');
    if (source.includes('\0')) throw new BadRequestException('Import payload contains NUL');
    const items = format === 'json' ? parseJsonImport(source) : parseCsvImport(source);
    if (items.length < 1 || items.length > MAX_DRAMAS) {
      throw new BadRequestException(`Import must contain 1 to ${MAX_DRAMAS} dramas`);
    }
    const episodes = items.reduce((count, item) => count + item.episodes.length, 0);
    if (episodes > MAX_EPISODES) throw new BadRequestException('Import exceeds 1000 episodes');
    const key = requiredIdempotencyKey(metadata.idempotencyKey);
    const jobKey = createHash('sha256').update(`${metadata.actorId}\0${key}`).digest('hex');
    const hash = createHash('sha256').update(source).digest('hex');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await beginCommand<Record<string, unknown>>(
        transaction, tenantId, metadata, 'tenant.content.import.create',
        { format, hash, rows: items.length },
      );
      if (command.cached) return command.cached;
      const jobId = uuidV7();
      await transaction`insert into content_import_jobs (
          id, tenant_id, file_id, format, mode, status, summary_json,
          idempotency_key, inline_payload_hash, requested_rows, payload_bytes,
          created_by, updated_by
        ) values (${jobId}, ${tenantId}, null, ${format}, 'create', 'uploaded',
          ${transaction.json(toJson({ episodeCount: episodes, rowCount: items.length, source: 'inline' }))},
          ${jobKey}, ${hash}, ${items.length}, ${bytes}, ${metadata.actorId}, ${metadata.actorId})`;
      for (let index = 0; index < items.length; index += 1) {
        await transaction`insert into content_import_rows (
            id, tenant_id, job_id, row_number, raw_json, normalized_json
          ) values (${uuidV7()}, ${tenantId}, ${jobId}, ${index + 1},
            ${transaction.json(toJson(items[index]))}, ${transaction.json(toJson(items[index]))})`;
      }
      await recordAudit(transaction, tenantId, metadata, 'content.import.create',
        'content_import_job', jobId, { format, rows: items.length });
      await recordOutbox(transaction, tenantId, metadata.requestId,
        'content_import_job', jobId, 'ContentImportRequested', { jobId, tenantId });
      const response = { format, id: jobId, rowCount: items.length, status: 'uploaded', version: 0 };
      await completeCommand(transaction, command.id, response, 'content_import_job', jobId, 202);
      return response;
    });
  }

  async listImports(tenantId: string, rawQuery: Record<string, unknown>) {
    assertUuid(tenantId, 'tenantId'); onlyKeys(rawQuery, ['page', 'pageSize', 'status']);
    const page = integer(rawQuery.page ?? 1, 'page', 1, 10_000);
    const pageSize = integer(rawQuery.pageSize ?? 20, 'pageSize', 1, 100);
    const status = rawQuery.status === undefined ? undefined : enumValue(rawQuery.status, 'status',
      ['uploaded', 'validating', 'ready', 'importing', 'completed', 'failed', 'cancelled'] as const);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<Array<{
        completed_at: Date | null; created_at: Date; format: string; id: string;
        status: string; summary_json: unknown; total_count: number; validated_at: Date | null; version: number;
      }>>`select id, format, status, summary_json, validated_at, completed_at, version,
          created_at, count(*) over()::integer as total_count
        from content_import_jobs where tenant_id = ${tenantId}
          and (${status ?? null}::text is null or status = ${status ?? null})
        order by created_at desc, id desc limit ${pageSize} offset ${(page - 1) * pageSize}`;
      return { items: rows.map(mapJob), page, pageSize, total: rows[0]?.total_count ?? 0 };
    });
  }

  async getImport(tenantId: string, jobId: string, rawQuery: Record<string, unknown>) {
    assertUuid(tenantId, 'tenantId'); assertUuid(jobId, 'jobId');
    onlyKeys(rawQuery, ['page', 'pageSize']);
    const page = integer(rawQuery.page ?? 1, 'page', 1, 10_000);
    const pageSize = integer(rawQuery.pageSize ?? 50, 'pageSize', 1, 100);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const jobs = await transaction<Array<{
        completed_at: Date | null; created_at: Date; format: string; id: string;
        status: string; summary_json: unknown; total_count: number; validated_at: Date | null; version: number;
      }>>`select id, format, status, summary_json, validated_at, completed_at, version,
          created_at, 1::integer as total_count from content_import_jobs
        where id = ${jobId} and tenant_id = ${tenantId}`;
      if (!jobs[0]) throw new NotFoundException('Content import job not found');
      const rows = await transaction<Array<{
        error_json: unknown; imported_drama_id: string | null; row_number: number; status: string;
      }>>`select row_number, status, error_json, imported_drama_id from content_import_rows
        where tenant_id = ${tenantId} and job_id = ${jobId}
        order by row_number limit ${pageSize} offset ${(page - 1) * pageSize}`;
      return { ...mapJob(jobs[0]), rows: rows.map((row) => ({
        errors: row.error_json ?? undefined, importedDramaId: row.imported_drama_id ?? undefined,
        rowNumber: row.row_number, status: row.status,
      })), page, pageSize };
    });
  }

  async exportContent(
    tenantId: string,
    rawQuery: Record<string, unknown>,
    metadata: Omit<ContentMutationMetadata, 'idempotencyKey'>,
  ) {
    assertUuid(tenantId, 'tenantId'); assertMetadata(metadata);
    onlyKeys(rawQuery, ['format']);
    const format = enumValue(rawQuery.format ?? 'json', 'format', ['csv', 'json'] as const);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const invalid = await transaction<{ invalid: number }[]>`select count(*)::integer as invalid
        from dramas as drama where drama.owner_type = 'tenant'
          and drama.owner_tenant_id = ${tenantId} and drama.deleted_at is null
          and (drama.cover_file_id is null
            or not exists (select 1 from drama_translations where drama_id = drama.id)
            or exists (select 1 from episodes where drama_id = drama.id and deleted_at is null
              and not exists (select 1 from episode_translations where episode_id = episodes.id)))`;
      if ((invalid[0]?.invalid ?? 0) > 0) {
        throw new ConflictException(
          `Export contains ${invalid[0]?.invalid ?? 0} incomplete dramas; add covers and translations first`,
        );
      }
      const counts = await transaction<{ episodes: number }[]>`select count(*)::integer as episodes
        from episodes join dramas on dramas.id = episodes.drama_id
        where dramas.owner_type = 'tenant' and dramas.owner_tenant_id = ${tenantId}
          and dramas.deleted_at is null and episodes.deleted_at is null`;
      if ((counts[0]?.episodes ?? 0) > 5_000) {
        throw new ConflictException('Export is limited to 5000 episodes');
      }
      const rows = await transaction<Array<{
        category_id: string | null; code: string; cover_file_id: string | null;
        episodes: ImportEpisode[]; release_at: Date | null; tag_ids: string[];
        translations: ImportDrama['translations']; unpublish_at: Date | null;
      }>>`select drama.code::text as code,
          drama.cover_file_id, drama.category_id, drama.release_at, drama.unpublish_at,
          coalesce((select jsonb_agg(jsonb_build_object('locale', locale, 'title', title,
            'summary', summary) order by locale) from drama_translations
            where drama_id = drama.id), '[]'::jsonb) as translations,
          coalesce((select jsonb_agg(tag_id order by tag_id) from drama_tags
            where drama_id = drama.id), '[]'::jsonb) as tag_ids,
          coalesce((select jsonb_agg(jsonb_build_object(
            'episodeNo', episode.episode_no, 'translations', coalesce((select jsonb_agg(
              jsonb_build_object('locale', locale, 'title', title) order by locale)
              from episode_translations where episode_id = episode.id), '[]'::jsonb),
            'mediaAssetId', episode.media_asset_id, 'durationSeconds', episode.duration_seconds,
            'previewMediaAssetId', episode.preview_media_asset_id,
            'previewSeconds', episode.preview_seconds, 'releaseAt', episode.release_at,
            'unpublishAt', episode.unpublish_at) order by episode.episode_no)
            from episodes as episode where episode.drama_id = drama.id
              and episode.deleted_at is null), '[]'::jsonb) as episodes
        from dramas as drama where drama.owner_type = 'tenant'
          and drama.owner_tenant_id = ${tenantId} and drama.deleted_at is null
        order by drama.created_at, drama.id limit 501`;
      if (rows.length > 500) throw new ConflictException('Export is limited to 500 dramas');
      const safe: ImportDrama[] = rows.map((row) => ({
        categoryId: row.category_id ?? undefined, code: row.code,
        coverMediaAssetId: row.cover_file_id!,
        episodes: row.episodes.map((episode) => ({ ...episode,
          releaseAt: dateIso(episode.releaseAt), unpublishAt: dateIso(episode.unpublishAt) })),
        releaseAt: row.release_at?.toISOString(), tagIds: row.tag_ids,
        translations: row.translations, unpublishAt: row.unpublish_at?.toISOString(),
      }));
      const referenceErrors = await validateDatabaseReferences(transaction, tenantId, safe, false);
      if (referenceErrors.size) {
        throw new ConflictException(
          `Export contains ${referenceErrors.size} dramas whose media or taxonomy is not currently re-importable`,
        );
      }
      const content = format === 'json'
        ? JSON.stringify(safe, null, 2)
        : csvExport(safe);
      if (Buffer.byteLength(content, 'utf8') > 20 * 1024 * 1024) {
        throw new ConflictException('Export exceeds the 20 MiB response limit');
      }
      await recordAudit(transaction, tenantId, metadata, 'content.export',
        'tenant', tenantId, { format, rowCount: rows.length });
      return {
        content,
        contentType: format === 'json' ? 'application/json; charset=utf-8' : 'text/csv; charset=utf-8',
        filename: `content-export.${format}`,
        format,
        rowCount: rows.length,
      };
    });
  }
}

@Injectable()
export class TenantContentImportWorkerService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  async processAvailable(limitValue = 5) {
    const limit = integer(limitValue, 'limit', 1, 20);
    let completed = 0; let failed = 0;
    for (let index = 0; index < limit; index += 1) {
      const outcome = await this.processOne();
      if (outcome === 'skipped') break;
      if (outcome === 'completed') completed += 1; else failed += 1;
    }
    return { claimed: completed + failed, completed, failed };
  }

  private async processOne(): Promise<'completed' | 'failed' | 'skipped'> {
    let claimedJobId: string | undefined;
    try {
      return await this.database.inPlatformContext(async (transaction) => {
      const jobs = await transaction<Array<{
        created_by: string; id: string; status: string; tenant_id: string;
      }>>`select id, tenant_id, created_by, status from content_import_jobs
        where status = 'uploaded' order by created_at, id limit 1 for update skip locked`;
      const job = jobs[0];
      if (!job) return 'skipped';
      const jobId = job.id;
      claimedJobId = jobId;
      await transaction`update content_import_jobs set status = 'validating', version = version + 1,
        updated_by = ${job.created_by} where id = ${jobId}`;
      const tenants = await transaction<{ available: boolean }[]>`select
        (status = 'active' and expires_at > statement_timestamp()) as available
        from tenants where id = ${job.tenant_id} for share`;
      const rows = await transaction<Array<{
        id: string; normalized_json: ImportDrama; row_number: number;
      }>>`select id, normalized_json, row_number from content_import_rows
        where job_id = ${jobId} and tenant_id = ${job.tenant_id} order by row_number for update`;
      const errors = await validateDatabaseReferences(transaction, job.tenant_id,
        rows.map((row) => row.normalized_json));
      if (!tenants[0]?.available) errors.set(0, ['Tenant is unavailable']);
      if (errors.size) {
        for (const row of rows) {
          const rowErrors = errors.get(row.row_number) ?? errors.get(0);
          await transaction`update content_import_rows set status = ${rowErrors ? 'error' : 'valid'},
            error_json = ${rowErrors ? transaction.json(toJson(rowErrors)) : null}
            where id = ${row.id}`;
        }
        await transaction`update content_import_jobs set status = 'failed',
          validated_at = statement_timestamp(), summary_json = ${transaction.json(toJson({
            errorRows: errors.has(0) ? rows.length : errors.size, importedRows: 0, source: 'inline',
          }))}, version = version + 1, updated_by = ${job.created_by} where id = ${jobId}`;
        await transaction`insert into audit_logs (id, scope_type, tenant_id, actor_type,
            actor_id, action, resource_type, resource_id, after_json, request_id)
          values (${uuidV7()}, 'tenant', ${job.tenant_id}, 'system', null,
            'content.import.fail', 'content_import_job', ${jobId},
            ${transaction.json(toJson({ errorRows: errors.has(0) ? rows.length : errors.size }))},
            ${`import-worker:${jobId}`})`;
        return 'failed';
      }
      await transaction`update content_import_jobs set status = 'importing',
        validated_at = statement_timestamp(), confirmed_at = statement_timestamp(),
        version = version + 1, updated_by = ${job.created_by} where id = ${jobId}`;
      for (const row of rows) {
        const dramaId = await importDrama(transaction, job.tenant_id, job.created_by, row.normalized_json);
        await transaction`update content_import_rows set status = 'imported', error_json = null,
          imported_drama_id = ${dramaId} where id = ${row.id}`;
      }
      await transaction`update content_import_jobs set status = 'completed',
        completed_at = statement_timestamp(), summary_json = ${transaction.json(toJson({
          errorRows: 0, importedRows: rows.length, source: 'inline',
        }))}, version = version + 1, updated_by = ${job.created_by} where id = ${jobId}`;
      await transaction`insert into audit_logs (id, scope_type, tenant_id, actor_type,
          actor_id, action, resource_type, resource_id, after_json, request_id)
        values (${uuidV7()}, 'tenant', ${job.tenant_id}, 'system', null,
          'content.import.complete', 'content_import_job', ${jobId},
          ${transaction.json(toJson({ importedRows: rows.length }))}, ${`import-worker:${jobId}`})`;
      const eventId = uuidV7();
      await transaction`insert into outbox_events (id, scope_type, tenant_id, event_key,
          idempotency_key, aggregate_type, aggregate_id, event_type, payload_json)
        values (${eventId}, 'tenant', ${job.tenant_id}, ${`event:${eventId}`}, ${`import:${jobId}`},
          'content_import_job', ${jobId}, 'ContentImportCompleted',
          ${transaction.json(toJson({ importedRows: rows.length, jobId, tenantId: job.tenant_id }))})`;
      return 'completed';
      });
    } catch (error) {
      if (!claimedJobId) throw error;
      await this.failUnexpected(claimedJobId, error);
      return 'failed';
    }
  }

  private failUnexpected(jobId: string, error: unknown) {
    const databaseCode = error && typeof error === 'object' && 'code' in error
      && typeof (error as { code?: unknown }).code === 'string'
      ? (error as { code: string }).code.slice(0, 16) : undefined;
    return this.database.inPlatformContext(async (transaction) => {
      const jobs = await transaction<{ tenant_id: string }[]>`select tenant_id
        from content_import_jobs where id = ${jobId} for update`;
      await transaction`update content_import_jobs set status = 'failed',
        validated_at = coalesce(validated_at, statement_timestamp()),
        summary_json = ${transaction.json(toJson({
          code: 'IMPORT_PROCESSING_FAILED', databaseCode, source: 'inline',
        }))},
        version = version + 1 where id = ${jobId} and status <> 'completed'`;
      if (jobs[0]) await transaction`insert into audit_logs (id, scope_type, tenant_id,
          actor_type, actor_id, action, resource_type, resource_id, after_json, request_id)
        values (${uuidV7()}, 'tenant', ${jobs[0].tenant_id}, 'system', null,
          'content.import.fail', 'content_import_job', ${jobId},
          ${transaction.json(toJson({ code: 'IMPORT_PROCESSING_FAILED', databaseCode }))},
          ${`import-worker:${jobId}`})`;
    });
  }
}

async function validateDatabaseReferences(
  transaction: DatabaseTransaction, tenantId: string, items: ImportDrama[],
  checkExisting = true,
) {
  const errors = new Map<number, string[]>();
  const codes = items.map((item) => item.code);
  const existing = checkExisting ? await transaction<{ code: string }[]>`
    select code::text as code from dramas where owner_type = 'tenant'
      and owner_tenant_id = ${tenantId} and code = any(${codes})` : [];
  const existingCodes = new Set(existing.map((row) => row.code));
  const duplicateCodes = new Set(codes.filter((code, index) => codes.indexOf(code) !== index));
  const mediaIds = [...new Set(items.flatMap((item) => [item.coverMediaAssetId,
    ...item.episodes.flatMap((episode) => [episode.mediaAssetId,
      ...(episode.previewMediaAssetId ? [episode.previewMediaAssetId] : [])])]))];
  const media = await transaction<Array<{ id: string; kind: string }>>`select asset.id, asset.kind
    from media_assets as asset join storage_providers as provider on provider.id = asset.storage_provider_id
    where asset.id = any(${mediaIds}) and asset.owner_type = 'tenant'
      and asset.owner_tenant_id = ${tenantId} and asset.source_url is null
      and asset.object_key is not null and asset.status = 'ready' and asset.deleted_at is null
      and (asset.kind <> 'video' or asset.transcode_status in ('ready', 'not_required'))
      and provider.status = 'active' and (provider.owner_type = 'platform'
        or (provider.owner_type = 'tenant' and provider.owner_tenant_id = ${tenantId}))`;
  const mediaMap = new Map(media.map((row) => [row.id, row.kind]));
  const categoryIds = [...new Set(items.flatMap((item) => item.categoryId ? [item.categoryId] : []))];
  const categories = categoryIds.length ? await transaction<{ id: string }[]>`select id from categories
    where id = any(${categoryIds}) and deleted_at is null and status = 'active'
      and ((owner_type = 'tenant' and owner_tenant_id = ${tenantId})
        or (owner_type = 'platform' and owner_tenant_id is null))` : [];
  const categorySet = new Set(categories.map((row) => row.id));
  const tagIds = [...new Set(items.flatMap((item) => item.tagIds))];
  const tags = tagIds.length ? await transaction<{ id: string }[]>`select id from tags
    where id = any(${tagIds}) and deleted_at is null and status = 'active'
      and ((owner_type = 'tenant' and owner_tenant_id = ${tenantId})
        or (owner_type = 'platform' and owner_tenant_id is null))` : [];
  const tagSet = new Set(tags.map((row) => row.id));
  items.forEach((item, index) => {
    const rowErrors: string[] = [];
    if ((checkExisting && existingCodes.has(item.code)) || duplicateCodes.has(item.code)) {
      rowErrors.push('Drama code already exists');
    }
    if (mediaMap.get(item.coverMediaAssetId) !== 'image') rowErrors.push('Cover must be a ready tenant S3 image');
    if (item.categoryId && !categorySet.has(item.categoryId)) rowErrors.push('Category is unavailable');
    if (item.tagIds.some((id) => !tagSet.has(id))) rowErrors.push('One or more tags are unavailable');
    const episodeNos = item.episodes.map((episode) => episode.episodeNo);
    if (new Set(episodeNos).size !== episodeNos.length) rowErrors.push('Episode numbers must be unique');
    if (item.episodes.some((episode) => mediaMap.get(episode.mediaAssetId) !== 'video')) {
      rowErrors.push('Episodes must use ready tenant S3 video');
    }
    if (item.episodes.some((episode) => episode.previewMediaAssetId
      && (mediaMap.get(episode.previewMediaAssetId) !== 'video'
        || episode.previewMediaAssetId === episode.mediaAssetId))) {
      rowErrors.push('Preview media must be a separate ready tenant S3 video');
    }
    if (rowErrors.length) errors.set(index + 1, rowErrors);
  });
  return errors;
}

async function importDrama(
  transaction: DatabaseTransaction, tenantId: string, actorId: string, item: ImportDrama,
) {
  const dramaId = uuidV7();
  await transaction`insert into dramas (id, owner_type, owner_tenant_id, code, source_type,
      status, release_at, unpublish_at, cover_file_id, category_id, created_by, updated_by)
    values (${dramaId}, 'tenant', ${tenantId}, ${item.code}, 'import', 'draft',
      ${item.releaseAt ? new Date(item.releaseAt) : null},
      ${item.unpublishAt ? new Date(item.unpublishAt) : null}, ${item.coverMediaAssetId},
      ${item.categoryId ?? null}, ${actorId}, ${actorId})`;
  for (const translation of item.translations) {
    await transaction`insert into drama_translations (id, drama_id, locale, title, summary)
      values (${uuidV7()}, ${dramaId}, ${translation.locale}, ${translation.title},
        ${translation.summary})`;
  }
  for (const tagId of item.tagIds) {
    await transaction`insert into drama_tags (drama_id, tag_id, created_by)
      values (${dramaId}, ${tagId}, ${actorId})`;
  }
  for (const itemEpisode of item.episodes) {
    const episodeId = uuidV7();
    await transaction`insert into episodes (id, drama_id, episode_no, status, release_at,
        unpublish_at, media_asset_id, preview_media_asset_id,
        duration_seconds, preview_seconds, created_by, updated_by)
      values (${episodeId}, ${dramaId}, ${itemEpisode.episodeNo}, 'draft',
        ${itemEpisode.releaseAt ? new Date(itemEpisode.releaseAt) : null},
        ${itemEpisode.unpublishAt ? new Date(itemEpisode.unpublishAt) : null},
        ${itemEpisode.mediaAssetId}, ${itemEpisode.previewMediaAssetId ?? null},
        ${itemEpisode.durationSeconds},
        ${itemEpisode.previewSeconds}, ${actorId}, ${actorId})`;
    for (const translation of itemEpisode.translations) {
      await transaction`insert into episode_translations (id, episode_id, locale, title)
        values (${uuidV7()}, ${episodeId}, ${translation.locale}, ${translation.title})`;
    }
  }
  await transaction`update dramas set total_episodes = ${item.episodes.length}, updated_by = ${actorId}
    where id = ${dramaId}`;
  await transaction`insert into content_versions (id, scope_type, tenant_id, aggregate_type,
      aggregate_id, version_no, snapshot_json, change_level, created_by)
    values (${uuidV7()}, 'tenant', ${tenantId}, 'drama', ${dramaId}, 1,
      ${transaction.json(toJson({ ...item, id: dramaId, status: 'draft' }))},
      'critical', ${actorId})`;
  return dramaId;
}

function parseJsonImport(source: string): ImportDrama[] {
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new BadRequestException('Invalid JSON import payload'); }
  if (!Array.isArray(value)) throw new BadRequestException('JSON payload must be an array');
  return value.map((item) => importDramaValue(item));
}

const CSV_HEADERS = [
  'code', 'coverMediaAssetId', 'categoryId', 'tagIds', 'releaseAt', 'unpublishAt',
  'dramaLocale', 'dramaTitle', 'dramaSummary', 'episodeNo', 'episodeLocale',
  'episodeTitle', 'episodeMediaAssetId', 'durationSeconds', 'previewSeconds',
  'episodePreviewMediaAssetId',
  'episodeReleaseAt', 'episodeUnpublishAt',
] as const;
function parseCsvImport(source: string): ImportDrama[] {
  const table = parseRfc4180(source);
  if (table.length < 2) throw new BadRequestException('CSV must contain a header and data');
  const headers = table[0]!.map((header) => header.replace(/^\uFEFF/, '').trim());
  if (headers.length > CSV_HEADERS.length || new Set(headers).size !== headers.length) {
    throw new BadRequestException('CSV has duplicate or excessive headers');
  }
  if (headers.some((header) => !(CSV_HEADERS as readonly string[]).includes(header))) {
    throw new BadRequestException('CSV has unknown headers');
  }
  for (const required of ['code', 'coverMediaAssetId']) {
    if (!headers.includes(required)) throw new BadRequestException(`CSV header ${required} is required`);
  }
  const grouped = new Map<string, {
    drama: Record<string, unknown>;
    episodes: Map<number, Record<string, unknown>>;
  }>();
  for (let line = 1; line < table.length; line += 1) {
    const values = table[line]!;
    if (values.length !== headers.length) throw new BadRequestException(`CSV row ${line + 1} has wrong column count`);
    if (values.every((item) => item === '')) continue;
    const row = Object.fromEntries(headers.map((header, index) => [
      header, decodeCsvCell(values[index] ?? ''),
    ]));
    const code = String(row.code ?? '').trim().toLowerCase();
    let current = grouped.get(code);
    const episodePresent = ['episodeNo', 'episodeLocale', 'episodeTitle',
      'episodeMediaAssetId', 'episodePreviewMediaAssetId', 'durationSeconds']
      .some((key) => String(row[key] ?? '').trim() !== '');
    if (!current) {
      current = { drama: {
        categoryId: emptyUndefined(row.categoryId), code, coverMediaAssetId: row.coverMediaAssetId,
        episodes: [], releaseAt: emptyUndefined(row.releaseAt),
        tagIds: String(row.tagIds ?? '').split(';').filter(Boolean), translations: [],
        unpublishAt: emptyUndefined(row.unpublishAt),
      }, episodes: new Map() };
      grouped.set(code, current);
    } else {
      for (const key of ['coverMediaAssetId', 'categoryId', 'tagIds', 'releaseAt', 'unpublishAt']) {
        const original = key === 'tagIds' ? (current.drama.tagIds as string[]).join(';')
          : String(current.drama[key] ?? '');
        if (original !== String(row[key] ?? '')) throw new BadRequestException(`CSV drama ${code} metadata differs across rows`);
      }
    }
    const dramaLocale = String(row.dramaLocale ?? '').trim();
    const dramaTitle = String(row.dramaTitle ?? '').trim();
    if (dramaLocale || dramaTitle || String(row.dramaSummary ?? '') !== '') {
      if (!dramaLocale || !dramaTitle) throw new BadRequestException('CSV drama locale and title must be provided together');
      const translations = current.drama.translations as Array<{ locale: string; summary: string; title: string }>;
      if (translations.some((item) => item.locale === dramaLocale)) {
        throw new BadRequestException(`CSV drama ${code} repeats locale ${dramaLocale}`);
      }
      translations.push({ locale: dramaLocale, summary: String(row.dramaSummary ?? ''), title: dramaTitle });
    }
    if (episodePresent) {
      const episodeNo = numberText(row.episodeNo, 'episodeNo');
      const episodeLocale = String(row.episodeLocale ?? '').trim();
      const episodeTitle = String(row.episodeTitle ?? '').trim();
      if (!episodeLocale || !episodeTitle) {
        throw new BadRequestException('CSV episode locale and title must be provided together');
      }
      const candidate: Record<string, unknown> = {
        durationSeconds: numberText(row.durationSeconds, 'durationSeconds'),
        episodeNo,
        mediaAssetId: row.episodeMediaAssetId,
        previewMediaAssetId: emptyUndefined(row.episodePreviewMediaAssetId),
        previewSeconds: row.previewSeconds === '' || row.previewSeconds === undefined
          ? 0 : numberText(row.previewSeconds, 'previewSeconds'),
        releaseAt: emptyUndefined(row.episodeReleaseAt), translations: [],
        unpublishAt: emptyUndefined(row.episodeUnpublishAt),
      };
      let episode = current.episodes.get(episodeNo);
      if (!episode) { episode = candidate; current.episodes.set(episodeNo, episode); }
      else {
        for (const key of ['durationSeconds', 'mediaAssetId', 'previewMediaAssetId',
          'previewSeconds', 'releaseAt', 'unpublishAt']) {
          if (String(episode[key] ?? '') !== String(candidate[key] ?? '')) {
            throw new BadRequestException(`CSV episode ${episodeNo} metadata differs across rows`);
          }
        }
      }
      const translations = episode.translations as Array<{ locale: string; title: string }>;
      if (translations.some((item) => item.locale === episodeLocale)) {
        throw new BadRequestException(`CSV episode ${episodeNo} repeats locale ${episodeLocale}`);
      }
      translations.push({ locale: episodeLocale, title: episodeTitle });
    }
  }
  return [...grouped.values()].map((item) => importDramaValue({
    ...item.drama, episodes: [...item.episodes.values()],
  }));
}

function parseRfc4180(source: string): string[][] {
  if (source.startsWith('\uFEFF')) source = source.slice(1);
  const rows: string[][] = []; let row: string[] = []; let field = '';
  let state: 'afterQuote' | 'quoted' | 'start' | 'unquoted' = 'start';
  const finishField = () => { row.push(field); field = ''; state = 'start'; };
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (state === 'quoted') {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') state = 'afterQuote';
      else field += char;
    } else if (state === 'afterQuote') {
      if (char === ',') finishField();
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && source[index + 1] === '\n') index += 1;
        finishField(); rows.push(row); row = [];
      } else throw new BadRequestException('CSV has characters after a closing quote');
    } else if (char === '"') {
      if (state !== 'start') throw new BadRequestException('CSV quote must begin a quoted field');
      state = 'quoted';
    } else if (char === ',') finishField();
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      finishField(); rows.push(row); row = [];
      if (rows.length > 7_202) throw new BadRequestException('CSV has too many rows');
    } else { state = 'unquoted'; field += char; }
    if (field.length > MAX_FIELD) throw new BadRequestException('CSV field is too long');
  }
  if (state === 'quoted') throw new BadRequestException('CSV contains an unterminated quoted field');
  if (field !== '' || row.length || state === 'afterQuote') { finishField(); rows.push(row); }
  return rows;
}

function importDramaValue(value: unknown): ImportDrama {
  const raw = record(value); onlyKeys(raw, ['categoryId', 'code', 'coverMediaAssetId', 'episodes',
    'releaseAt', 'tagIds', 'translations', 'unpublishAt']);
  const code = stringValue(raw.code, 'code', 2, 128).toLowerCase();
  if (!CODE.test(code)) throw new BadRequestException('code is invalid');
  assertUuid(raw.coverMediaAssetId, 'coverMediaAssetId');
  const categoryId = optionalUuid(raw.categoryId, 'categoryId');
  const tagIds = uuidArray(raw.tagIds ?? [], 'tagIds', 50);
  const releaseAt = optionalIso(raw.releaseAt, 'releaseAt');
  const unpublishAt = optionalIso(raw.unpublishAt, 'unpublishAt');
  assertInterval(releaseAt, unpublishAt, 'drama');
  const translations = dramaTranslations(raw.translations);
  if (!Array.isArray(raw.episodes) || raw.episodes.length > MAX_EPISODES) {
    throw new BadRequestException('episodes must be an array of at most 1000 items');
  }
  const episodes = raw.episodes.map((valueEpisode) => {
    const episode = record(valueEpisode); onlyKeys(episode, ['durationSeconds', 'episodeNo',
      'mediaAssetId', 'previewMediaAssetId', 'previewSeconds', 'releaseAt',
      'translations', 'unpublishAt']);
    assertUuid(episode.mediaAssetId, 'episode.mediaAssetId');
    const previewMediaAssetId = optionalUuid(
      episode.previewMediaAssetId,
      'episode.previewMediaAssetId',
    );
    if (previewMediaAssetId === episode.mediaAssetId) {
      throw new BadRequestException('episode.previewMediaAssetId must differ from mediaAssetId');
    }
    const durationSeconds = integer(episode.durationSeconds, 'durationSeconds', 1, 86_400);
    const previewSeconds = integer(episode.previewSeconds ?? 0, 'previewSeconds', 0, durationSeconds);
    const episodeRelease = optionalIso(episode.releaseAt, 'episode.releaseAt');
    const episodeUnpublish = optionalIso(episode.unpublishAt, 'episode.unpublishAt');
    assertInterval(episodeRelease, episodeUnpublish, 'episode');
    return { durationSeconds, episodeNo: integer(episode.episodeNo, 'episodeNo', 1, 1_000),
      mediaAssetId: episode.mediaAssetId, previewMediaAssetId,
      previewSeconds, releaseAt: episodeRelease,
      translations: episodeTranslations(episode.translations), unpublishAt: episodeUnpublish };
  });
  return { categoryId, code, coverMediaAssetId: raw.coverMediaAssetId, episodes,
    releaseAt, tagIds, translations, unpublishAt };
}

function csvExport(items: ImportDrama[]) {
  const header = [...CSV_HEADERS];
  const rows: string[][] = [header];
  for (const item of items) {
    const common = [String(item.code ?? ''), String(item.coverMediaAssetId ?? ''),
      String(item.categoryId ?? ''), item.tagIds.join(';'),
      String(item.releaseAt ?? ''), String(item.unpublishAt ?? '')];
    for (const translation of item.translations) {
      rows.push([...common, translation.locale, translation.title, translation.summary,
        '', '', '', '', '', '', '', '', '']);
    }
    const episodes = item.episodes;
    for (const episode of episodes) {
      for (const translation of episode.translations) rows.push([
        ...common, '', '', '', String(episode.episodeNo), translation.locale,
        translation.title, episode.mediaAssetId, String(episode.durationSeconds),
        String(episode.previewSeconds), String(episode.previewMediaAssetId ?? ''),
        String(episode.releaseAt ?? ''),
        String(episode.unpublishAt ?? ''),
      ]);
    }
  }
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

function dramaTranslations(value: unknown): ImportDrama['translations'] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new BadRequestException('translations must contain 1 to 6 locales');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const raw = record(item); onlyKeys(raw, ['locale', 'summary', 'title']);
    const locale = localeValue(raw.locale, seen);
    return { locale, summary: stringValue(raw.summary ?? '', 'summary', 0, MAX_FIELD),
      title: stringValue(raw.title, 'title', 1, 300) };
  });
}
function episodeTranslations(value: unknown): ImportEpisode['translations'] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new BadRequestException('episode translations must contain 1 to 6 locales');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    const raw = record(item); onlyKeys(raw, ['locale', 'title']);
    return { locale: localeValue(raw.locale, seen),
      title: stringValue(raw.title, 'episode.title', 1, 300) };
  });
}
function localeValue(value: unknown, seen: Set<string>) {
  const locale = stringValue(value, 'locale', 2, 20);
  if (!LOCALES.has(locale) || seen.has(locale)) throw new BadRequestException('Unsupported or duplicate locale');
  seen.add(locale); return locale;
}
function csvCell(input: string) {
  const safe = /^[=+\-@\t\r']/.test(input) ? `'${input}` : input;
  return `"${safe.replace(/"/g, '""')}"`;
}
function decodeCsvCell(input: string) {
  if (input.startsWith("''") || /^'[=+\-@\t\r]/.test(input)) return input.slice(1);
  return input;
}

async function beginCommand<T>(transaction: DatabaseTransaction, tenantId: string,
  metadata: ContentMutationMetadata, route: string, request: unknown): Promise<{ cached?: T; id?: string }> {
  const key = requiredIdempotencyKey(metadata.idempotencyKey);
  const hash = createHash('sha256').update(JSON.stringify(toJson(request))).digest('hex');
  const id = uuidV7();
  const inserted = await transaction<{ id: string }[]>`insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key, idempotency_key,
      request_hash, expires_at) values (${id}, 'tenant', ${tenantId}, 'tenant_staff',
      ${metadata.actorId}, ${route}, ${key}, ${hash}, statement_timestamp() + interval '24 hours')
    on conflict do nothing returning id`;
  if (inserted[0]) return { id };
  const rows = await transaction<Array<{ request_hash: string; response_json: unknown; status: string }>>`
    select request_hash, response_json, status from command_idempotency
    where scope_type = 'tenant' and tenant_id = ${tenantId} and actor_type = 'tenant_staff'
      and actor_id = ${metadata.actorId} and route_key = ${route} and idempotency_key = ${key}
    for update`;
  const row = rows[0];
  if (!row || row.request_hash !== hash) throw new ConflictException('Idempotency-Key conflict');
  if (row.status === 'completed' && row.response_json !== null) return { cached: row.response_json as T };
  throw new ConflictException('The same command is already processing');
}
async function completeCommand(transaction: DatabaseTransaction, id: string | undefined,
  response: unknown, resourceType: string, resourceId: string, status: number) {
  if (!id) return;
  await transaction`update command_idempotency set status = 'completed', response_status = ${status},
    response_json = ${transaction.json(toJson(response))}, resource_type = ${resourceType},
    resource_id = ${resourceId}, locked_at = null where id = ${id} and status = 'processing'`;
}
async function recordAudit(transaction: DatabaseTransaction, tenantId: string,
  metadata: Omit<ContentMutationMetadata, 'idempotencyKey'>, action: string,
  resourceType: string, resourceId: string, after: unknown) {
  await transaction`insert into audit_logs (id, scope_type, tenant_id, actor_type, actor_id,
      action, resource_type, resource_id, after_json, ip, request_id)
    values (${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff', ${metadata.actorId}, ${action},
      ${resourceType}, ${resourceId}, ${transaction.json(toJson(after))},
      ${metadata.ip ?? null}, ${metadata.requestId})`;
}
async function recordOutbox(transaction: DatabaseTransaction, tenantId: string,
  idempotencyKey: string, aggregateType: string, aggregateId: string,
  eventType: string, payload: unknown) {
  const id = uuidV7();
  await transaction`insert into outbox_events (id, scope_type, tenant_id, event_key,
      idempotency_key, aggregate_type, aggregate_id, event_type, payload_json)
    values (${id}, 'tenant', ${tenantId}, ${`event:${id}`}, ${idempotencyKey},
      ${aggregateType}, ${aggregateId}, ${eventType}, ${transaction.json(toJson(payload))})`;
}
function mapJob(row: { completed_at: Date | null; created_at: Date; format: string; id: string;
  status: string; summary_json: unknown; validated_at: Date | null; version: number }) {
  return { completedAt: row.completed_at?.toISOString(), createdAt: row.created_at.toISOString(),
    format: row.format, id: row.id, status: row.status, summary: row.summary_json,
    validatedAt: row.validated_at?.toISOString(), version: row.version };
}
function dateIso(value: unknown) {
  if (!value) return undefined;
  return value instanceof Date ? value.toISOString() : String(value);
}
function emptyUndefined(value: unknown) { return value === '' || value === undefined ? undefined : value; }
function numberText(value: unknown, field: string) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new BadRequestException(`${field} is invalid`);
  return Number(value);
}
function optionalIso(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} is invalid`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException(`${field} is invalid`);
  return date.toISOString();
}
function assertInterval(release: string | undefined, unpublish: string | undefined, field: string) {
  if (unpublish && (!release || unpublish <= release)) {
    throw new BadRequestException(`${field} unpublishAt must be after releaseAt`);
  }
}
function optionalUuid(value: unknown, field: string) {
  if (value === undefined || value === null || value === '') return undefined;
  assertUuid(value, field); return value;
}
function uuidArray(value: unknown, field: string, max: number) {
  if (!Array.isArray(value) || value.length > max) throw new BadRequestException(`${field} is invalid`);
  const result = value.map((item) => { assertUuid(item, field); return item; });
  if (new Set(result).size !== result.length) throw new BadRequestException(`${field} has duplicates`);
  return result;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BadRequestException('Object is required');
  return value as Record<string, unknown>;
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new BadRequestException(`Unknown field: ${extra}`);
}
function stringValue(value: unknown, field: string, minimum: number, maximum: number) {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) throw new BadRequestException(`${field} is invalid`);
  return result;
}
function integer(value: unknown, field: string, minimum: number, maximum: number) {
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(parsed) || Number(parsed) < minimum || Number(parsed) > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return Number(parsed);
}
function enumValue<T extends string>(value: unknown, field: string, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) throw new BadRequestException(`${field} is invalid`);
  return value as T;
}
function requiredIdempotencyKey(value: string | undefined) {
  const key = value?.trim();
  if (!key || !KEY.test(key)) throw new BadRequestException('Idempotency-Key is required and invalid');
  return key;
}
function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException(`${field} is invalid`);
}
function assertMetadata(value: Omit<ContentMutationMetadata, 'idempotencyKey'>) {
  assertUuid(value.actorId, 'actorId'); assertUuid(value.requestId, 'requestId');
}
function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
