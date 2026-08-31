import { PGlite, type Transaction } from '@electric-sql/pglite';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import { ContentService } from '../src/content/content.service';
import {
  TenantContentImportWorkerService,
  TenantContentPortabilityService,
} from '../src/content/tenant-content-portability.service';
import { TenantContentTaxonomyService } from '../src/content/tenant-content-taxonomy.service';
import { DatabaseService, type DatabaseTransaction } from '../src/database/database.service';

let database: PGlite;
let content: ContentService;
let portability: TenantContentPortabilityService;
let taxonomy: TenantContentTaxonomyService;
let worker: TenantContentImportWorkerService;

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773571001';
const otherTenantId = '018f2f45-7f5e-7e70-b17f-f6e773571002';
const staffId = '018f2f45-7f5e-7e70-b17f-f6e773571003';
const otherStaffId = '018f2f45-7f5e-7e70-b17f-f6e773571004';
const providerId = '018f2f45-7f5e-7e70-b17f-f6e773571005';
const otherProviderId = '018f2f45-7f5e-7e70-b17f-f6e773571006';
const coverId = '018f2f45-7f5e-7e70-b17f-f6e773571007';
const videoId = '018f2f45-7f5e-7e70-b17f-f6e773571008';
const otherCoverId = '018f2f45-7f5e-7e70-b17f-f6e773571009';
const previewVideoId = '018f2f45-7f5e-7e70-b17f-f6e77357100a';
const otherVideoId = '018f2f45-7f5e-7e70-b17f-f6e77357100b';

function tag(transaction: Transaction): DatabaseTransaction {
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let text = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) text += `$${index + 1}${strings[index + 1] ?? ''}`;
    return (await transaction.query(text, values)).rows;
  };
  Object.assign(sql, {
    json: (value: unknown) => JSON.stringify(value),
    unsafe: async (text: string, values: unknown[] = []) => (await transaction.query(text, values)).rows,
  });
  return sql as unknown as DatabaseTransaction;
}

function metadata(key: string) {
  return { actorId: staffId, idempotencyKey: key, requestId: uuidV7() };
}

describe('tenant content management, taxonomy, import, and export', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const filename of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(source.replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
        .replace(/\bcitext\b/g, 'text'));
    }
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantId}', 'tenant-content-management', 'Tenant A', statement_timestamp() + interval '1 year'),
        ('${otherTenantId}', 'tenant-content-other', 'Tenant B', statement_timestamp() + interval '1 year');
      insert into tenant_staff (id, tenant_id, username, password_hash) values
        ('${staffId}', '${tenantId}', 'tenant-content-owner', '${'p'.repeat(64)}'),
        ('${otherStaffId}', '${otherTenantId}', 'tenant-content-other', '${'p'.repeat(64)}');
      insert into storage_providers (id, owner_type, owner_tenant_id, provider,
        account_label, bucket, credential_ciphertext) values
        ('${providerId}', 'tenant', '${tenantId}', 's3', 'tenant-a', 'tenant-a', '${'x'.repeat(64)}'),
        ('${otherProviderId}', 'tenant', '${otherTenantId}', 's3', 'tenant-b', 'tenant-b', '${'y'.repeat(64)}');
      insert into media_assets (id, owner_type, owner_tenant_id, kind, storage_provider_id,
        object_key, mime_type, size_bytes, checksum, status, transcode_status) values
        ('${coverId}', 'tenant', '${tenantId}', 'image', '${providerId}', 'covers/a.webp',
          'image/webp', 100, 'sha256:${'a'.repeat(64)}', 'ready', 'not_required'),
        ('${videoId}', 'tenant', '${tenantId}', 'video', '${providerId}', 'videos/a.mp4',
          'video/mp4', 200, 'sha256:${'b'.repeat(64)}', 'ready', 'ready'),
        ('${previewVideoId}', 'tenant', '${tenantId}', 'video', '${providerId}', 'videos/a-preview.mp4',
          'video/mp4', 80, 'sha256:${'d'.repeat(64)}', 'ready', 'ready'),
        ('${otherCoverId}', 'tenant', '${otherTenantId}', 'image', '${otherProviderId}', 'covers/b.webp',
          'image/webp', 100, 'sha256:${'c'.repeat(64)}', 'ready', 'not_required'),
        ('${otherVideoId}', 'tenant', '${otherTenantId}', 'video', '${otherProviderId}', 'videos/b.mp4',
          'video/mp4', 200, 'sha256:${'e'.repeat(64)}', 'ready', 'ready');
    `);
    const databaseService = {
      inTenantContext: <T>(_tenantId: string, callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction((transaction) => callback(tag(transaction))),
      inPlatformContext: <T>(callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction((transaction) => callback(tag(transaction))),
    } as unknown as DatabaseService;
    content = new ContentService(databaseService);
    portability = new TenantContentPortabilityService(databaseService);
    taxonomy = new TenantContentTaxonomyService(databaseService);
    worker = new TenantContentImportWorkerService(databaseService);
  }, 30_000);

  afterAll(async () => database?.close());

  it('manages tenant taxonomy and binds editable drama and episode details with CAS', async () => {
    const category = await taxonomy.create(tenantId, 'category', {
      code: 'romance', sortOrder: 10, translations: [{ locale: 'en-US', name: 'Romance' }],
    }, metadata('tenant-category-create-001'));
    const tagRecord = await taxonomy.create(tenantId, 'tag', {
      code: 'featured', translations: [{ locale: 'en-US', name: 'Featured' }],
    }, metadata('tenant-tag-create-001'));
    const drama = await content.createTenantDrama(tenantId, {
      categoryId: String(category.id), code: 'tenant-managed-drama', coverFileId: coverId,
      tagIds: [String(tagRecord.id)], translations: [{ locale: 'en-US', title: 'Managed' }],
    }, metadata('tenant-drama-create-001'));
    const episode = await content.addTenantEpisode(tenantId, drama.id, {
      durationSeconds: 120, episodeNo: 1, expectedDramaVersion: drama.version,
      mediaAssetId: videoId, previewMediaAssetId: previewVideoId, previewSeconds: 10,
      translations: [{ locale: 'en-US', title: 'One' }],
    }, metadata('tenant-episode-create-001'));
    const updated = await content.updateTenantEpisode(tenantId, drama.id, episode.id, {
      durationSeconds: 121, expectedVersion: episode.version, previewSeconds: 10,
      translations: [{ locale: 'en-US', title: 'One Updated' }],
    }, metadata('tenant-episode-update-001'));
    expect(updated).toMatchObject({
      durationSeconds: 121,
      dramaVersion: 2,
      previewMediaAssetId: previewVideoId,
      previewSeconds: 10,
    });
    const detail = await content.getTenantDrama(tenantId, drama.id);
    expect(detail).toMatchObject({ categoryId: category.id, tagIds: [tagRecord.id] });
    expect(detail.episodes).toEqual([expect.objectContaining({ version: 1 })]);
    expect(detail.episodes[0]?.translations[0]?.title).toBe('One Updated');
    await expect(content.updateTenantEpisode(tenantId, drama.id, episode.id, {
      expectedVersion: updated.version,
      previewMediaAssetId: otherVideoId,
    }, metadata('tenant-episode-cross-preview-001'))).rejects.toBeInstanceOf(BadRequestException);

    await database.exec(`update storage_providers set status = 'disabled', version = version + 1
      where id = '${providerId}'`);
    await expect(content.submitTenantDrama(
      tenantId,
      drama.id,
      metadata('tenant-drama-submit-disabled-preview-001'),
    )).rejects.toBeInstanceOf(BadRequestException);
    await database.exec(`update storage_providers set status = 'active', version = version + 1
      where id = '${providerId}'`);
    const submitted = await content.submitTenantDrama(
      tenantId,
      drama.id,
      metadata('tenant-drama-submit-preview-001'),
    );
    const snapshot = await database.query<{ snapshot_json: {
      episodes: Array<{ previewMedia: { checksum: string; id: string } }>;
    } }>(`select snapshot_json from content_versions where id = (
      select content_version_id from review_requests where id = '${submitted.reviewRequestId}'
    )`);
    expect(snapshot.rows[0]?.snapshot_json.episodes[0]?.previewMedia).toMatchObject({
      checksum: `sha256:${'d'.repeat(64)}`,
      id: previewVideoId,
    });
    await expect(database.exec(`update episodes set preview_media_asset_id = null
      where id = '${episode.id}'`)).rejects.toThrow(/cannot change after submission/i);
    await expect(database.exec(`update content_versions set snapshot_json = '{}'::jsonb
      where id = (select content_version_id from review_requests
        where id = '${submitted.reviewRequestId}')`)).rejects.toThrow(/append-only/i);

    await expect(taxonomy.remove(tenantId, 'tag', String(tagRecord.id), {
      expectedVersion: 0, reason: 'still referenced',
    }, metadata('tenant-tag-delete-referenced-001'))).rejects.toBeInstanceOf(ConflictException);
    await expect(taxonomy.update(otherTenantId, 'category', String(category.id), {
      expectedVersion: 0, status: 'disabled',
    }, { ...metadata('cross-tenant-category-001'), actorId: otherStaffId }))
      .rejects.toBeInstanceOf(NotFoundException);

    const unused = await taxonomy.create(tenantId, 'tag', {
      code: 'unused', translations: [{ locale: 'en-US', name: 'Unused' }],
    }, metadata('tenant-unused-tag-create-001'));
    const deleted = await taxonomy.remove(tenantId, 'tag', String(unused.id), {
      expectedVersion: 0, reason: 'cleanup',
    }, metadata('tenant-unused-tag-delete-001'));
    await expect(taxonomy.restore(tenantId, 'tag', String(unused.id), {
      expectedVersion: deleted.version,
    }, metadata('tenant-unused-tag-restore-001'))).resolves.toMatchObject({ version: 2 });
  });

  it('imports bounded JSON asynchronously, replays idempotently, and exports safe CSV/JSON', async () => {
    const title = '=SUM(1,1) "中文"\nnext';
    const payload = [{
      code: 'safe-import', coverMediaAssetId: coverId,
      episodes: [{ durationSeconds: 60, episodeNo: 1, mediaAssetId: videoId,
        previewMediaAssetId: previewVideoId, previewSeconds: 12,
        translations: [{ locale: 'en-US', title: 'Episode, "One"' }] }],
      tagIds: [], translations: [{ locale: 'en-US', summary: 'line one\nline two', title },
        { locale: 'ja-JP', summary: '', title: '安全な輸入' },
        { locale: 'fr-FR', summary: '', title: "'apostrophe" }],
    }];
    const first = await portability.createImport(tenantId, { format: 'json', payload },
      metadata('tenant-import-json-001'));
    const replay = await portability.createImport(tenantId, { format: 'json', payload },
      metadata('tenant-import-json-001'));
    expect(replay).toEqual(first);
    const outcomes = await Promise.all([worker.processAvailable(1), worker.processAvailable(1)]);
    const outcome = outcomes.reduce((total, item) => ({
      claimed: total.claimed + item.claimed,
      completed: total.completed + item.completed,
      failed: total.failed + item.failed,
    }), { claimed: 0, completed: 0, failed: 0 });
    const detail = await portability.getImport(tenantId, String(first.id), {});
    expect(detail.summary).toEqual({ errorRows: 0, importedRows: 1, source: 'inline' });
    expect({ detail, outcome }).toMatchObject({
      detail: { status: 'completed' },
      outcome: { claimed: 1, completed: 1, failed: 0 },
    });
    expect(detail).toMatchObject({ status: 'completed', summary: { errorRows: 0, importedRows: 1, source: 'inline' } });
    expect(detail.rows[0]).toMatchObject({ status: 'imported' });
    await expect(database.exec(`update content_import_rows set row_number = 2
      where job_id = '${first.id}' and status = 'imported'`))
      .rejects.toThrow(/Imported content row result is immutable/);

    const csv = await portability.exportContent(tenantId, { format: 'csv' }, {
      actorId: staffId, requestId: uuidV7(),
    });
    expect(csv.content).toMatch(/^\uFEFF/);
    expect(csv.content).toContain('"\'=SUM(1,1) ""中文""\nnext"');
    expect(csv.content).toContain('"\'\'apostrophe"');
    expect(csv.content).toContain('"Episode, ""One"""');
    const json = await portability.exportContent(tenantId, { format: 'json' }, {
      actorId: staffId, requestId: uuidV7(),
    });
    expect(json.content).not.toMatch(/objectKey|sourceUrl|checksum|credential/i);
    expect(JSON.parse(json.content)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'safe-import', episodes: [expect.objectContaining({
        previewMediaAssetId: previewVideoId,
      })], translations: expect.arrayContaining([
        expect.objectContaining({ locale: 'ja-JP', title: '安全な輸入' }),
      ]) }),
    ]));
    const roundTripPayload = (JSON.parse(json.content) as Array<Record<string, unknown>>)
      .filter((item) => item.code === 'safe-import')
      .map((item) => ({ ...item, code: 'safe-import-roundtrip' }));
    await portability.createImport(tenantId, { format: 'json', payload: roundTripPayload },
      metadata('tenant-import-roundtrip-001'));
    await expect(worker.processAvailable()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
    const csvJob = await portability.createImport(tenantId, { format: 'csv', payload: csv.content },
      metadata('tenant-import-csv-roundtrip-001'));
    expect(csvJob).toMatchObject({ status: 'uploaded' });
    const csvNormalized = await database.query<{ normalized_json: {
      episodes: Array<{ previewMediaAssetId?: string }>;
      translations: Array<{ locale: string; title: string }>;
    } }>(`select normalized_json from content_import_rows
      where job_id = '${csvJob.id}' and normalized_json->>'code' = 'safe-import'`);
    expect(csvNormalized.rows[0]?.normalized_json.translations).toEqual(expect.arrayContaining([
      expect.objectContaining({ locale: 'en-US', title }),
      expect.objectContaining({ locale: 'fr-FR', title: "'apostrophe" }),
    ]));
    expect(csvNormalized.rows[0]?.normalized_json.episodes[0]?.previewMediaAssetId)
      .toBe(previewVideoId);
    await database.exec(`update storage_providers set status = 'disabled', version = version + 1
      where id = '${providerId}'`);
    await expect(portability.exportContent(tenantId, { format: 'json' }, {
      actorId: staffId, requestId: uuidV7(),
    })).rejects.toThrow(/not currently re-importable/);
    await database.exec(`update storage_providers set status = 'active', version = version + 1
      where id = '${providerId}'`);
  });

  it('refuses to label incomplete draft metadata as a round-trippable export', async () => {
    await content.createTenantDrama(tenantId, {
      code: 'incomplete-export-draft', translations: [{ locale: 'en-US', title: 'Incomplete' }],
    }, metadata('tenant-incomplete-export-001'));
    await expect(portability.exportContent(tenantId, { format: 'json' }, {
      actorId: staffId, requestId: uuidV7(),
    })).rejects.toThrow(/incomplete dramas/);
  });

  it('rejects malformed CSV and cross-tenant imported row bindings', async () => {
    await expect(portability.createImport(tenantId, {
      format: 'csv', payload: 'code,code,locale,title,coverMediaAssetId\r\na,a,en-US,A,x',
    }, metadata('tenant-import-csv-duplicate-001'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(portability.createImport(tenantId, {
      format: 'csv', payload: 'code,locale,title,coverMediaAssetId,unknown\r\na,en-US,A,x,no',
    }, metadata('tenant-import-csv-unknown-001'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(portability.createImport(tenantId, {
      format: 'csv', payload: 'code,coverMediaAssetId\r\na"b,x',
    }, metadata('tenant-import-csv-unquoted-001'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(portability.createImport(tenantId, {
      format: 'csv', payload: 'code,coverMediaAssetId\r\n"a"junk,x',
    }, metadata('tenant-import-csv-after-quote-001'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(portability.createImport(tenantId, {
      format: 'csv', payload: 'code,coverMediaAssetId\r\na,\0x',
    }, metadata('tenant-import-csv-nul-001'))).rejects.toBeInstanceOf(BadRequestException);

    const jobId = uuidV7();
    const otherDramaId = uuidV7();
    await database.exec(`
      insert into dramas (id, owner_type, owner_tenant_id, code, source_type, created_by)
      values ('${otherDramaId}', 'tenant', '${otherTenantId}', 'foreign-import-target', 'import', '${otherStaffId}');
      insert into content_import_jobs (id, tenant_id, file_id, format, idempotency_key,
        inline_payload_hash, requested_rows, payload_bytes, created_by)
      values ('${jobId}', '${tenantId}', null, 'json', 'cross-tenant-import-row-001',
        '${'d'.repeat(64)}', 1, 2, '${staffId}');
    `);
    await expect(database.exec(`insert into content_import_rows (id, tenant_id, job_id,
      row_number, raw_json, normalized_json, status, imported_drama_id)
      values ('${uuidV7()}', '${tenantId}', '${jobId}', 1, '{}'::jsonb, '{}'::jsonb,
        'imported', '${otherDramaId}')`)).rejects.toThrow(/Imported drama must belong/);
  });
});
