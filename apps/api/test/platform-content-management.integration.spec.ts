import { PGlite, type Transaction } from '@electric-sql/pglite';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import { ContentScheduleWorkerService } from '../src/content/content-schedule-worker.service';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';
import { PlatformContentLibraryService } from '../src/platform-content-library/platform-content-library.service';

let database: PGlite;
let library: PlatformContentLibraryService;
let scheduler: ContentScheduleWorkerService;

const platformStaffId = '018f2f45-7f5e-7e70-b17f-f6e773590101';
const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773590102';
const platformProviderId = '018f2f45-7f5e-7e70-b17f-f6e773590103';
const tenantProviderId = '018f2f45-7f5e-7e70-b17f-f6e773590104';
const coverId = '018f2f45-7f5e-7e70-b17f-f6e773590105';
const videoId = '018f2f45-7f5e-7e70-b17f-f6e773590106';
const tenantCoverId = '018f2f45-7f5e-7e70-b17f-f6e773590107';
const previewVideoId = '018f2f45-7f5e-7e70-b17f-f6e773590108';
const tenantVideoId = '018f2f45-7f5e-7e70-b17f-f6e773590109';
const previewProviderId = '018f2f45-7f5e-7e70-b17f-f6e77359010a';

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, {
    json: (value: unknown) => JSON.stringify(value),
    unsafe: async (sql: string, values: unknown[] = []) =>
      (await transaction.query(sql, values)).rows,
  });
  return tag as unknown as DatabaseTransaction;
}

function metadata(key: string) {
  return {
    actorId: platformStaffId,
    idempotencyKey: key,
    ip: '203.0.113.20',
    requestId: uuidV7(),
  };
}

describe('platform content management PostgreSQL workflow', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of filenames) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(
        source
          .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
          .replace(/\bcitext\b/g, 'text'),
      );
    }
    await database.exec(`
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaffId}', 'platform-content-admin', '${'p'.repeat(64)}');
      insert into tenants (id, code, name, expires_at)
      values ('${tenantId}', 'platform-content-tenant', 'Tenant', statement_timestamp() + interval '1 year');
      insert into storage_providers (
        id, owner_type, owner_tenant_id, provider, account_label, bucket,
        credential_ciphertext
      ) values (
        '${platformProviderId}', 'platform', null, 's3', 'platform-content',
        'platform-content-bucket', '${'x'.repeat(64)}'
      ), (
        '${previewProviderId}', 'platform', null, 's3', 'platform-preview',
        'platform-preview-bucket', '${'z'.repeat(64)}'
      ), (
        '${tenantProviderId}', 'tenant', '${tenantId}', 's3', 'tenant-content',
        'tenant-content-bucket', '${'y'.repeat(64)}'
      );
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, storage_provider_id, object_key,
        mime_type, size_bytes, checksum, status, transcode_status
      ) values (
        '${coverId}', 'platform', null, 'image', '${platformProviderId}',
        'platform/cover.webp', 'image/webp', 1000, 'sha256:${'a'.repeat(64)}',
        'ready', 'not_required'
      ), (
        '${videoId}', 'platform', null, 'video', '${platformProviderId}',
        'platform/episode.mp4', 'video/mp4', 2000, 'sha256:${'b'.repeat(64)}',
        'ready', 'ready'
      ), (
        '${previewVideoId}', 'platform', null, 'video', '${previewProviderId}',
        'platform/episode-preview.mp4', 'video/mp4', 700, 'sha256:${'d'.repeat(64)}',
        'ready', 'ready'
      ), (
        '${tenantCoverId}', 'tenant', '${tenantId}', 'image', '${tenantProviderId}',
        'tenant/cover.webp', 'image/webp', 1000, 'sha256:${'c'.repeat(64)}',
        'ready', 'not_required'
      ), (
        '${tenantVideoId}', 'tenant', '${tenantId}', 'video', '${tenantProviderId}',
        'tenant/episode.mp4', 'video/mp4', 2000, 'sha256:${'e'.repeat(64)}',
        'ready', 'ready'
      );
    `);
    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction((transaction) => callback(transactionTag(transaction))),
    } as unknown as DatabaseService;
    library = new PlatformContentLibraryService(databaseService);
    scheduler = new ContentScheduleWorkerService(databaseService);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('creates platform taxonomy and content idempotently, then publishes a complete snapshot', async () => {
    const category = await library.createTaxonomy('category', {
      code: 'action',
      sortOrder: 10,
      translations: [{ locale: 'en-US', name: 'Action' }],
    }, metadata('platform-category-create-0001'));
    const tag = await library.createTaxonomy('tag', {
      code: 'featured',
      translations: [{ locale: 'en-US', name: 'Featured' }],
    }, metadata('platform-tag-create-0001'));
    const dramaInput = {
      categoryId: category.id as string,
      code: 'platform-drama-one',
      coverMediaAssetId: coverId,
      tagIds: [tag.id as string],
      translations: [{
        locale: 'en-US' as const,
        searchKeywords: ['platform', 'drama'],
        summary: 'Public drama',
        title: 'Platform Drama',
      }],
    };
    const key = 'platform-drama-create-0001';
    const drama = await library.createDrama(dramaInput, metadata(key));
    const replay = await library.createDrama(dramaInput, metadata(key));
    expect(replay.id).toBe(drama.id);
    await expect(library.createDrama(
      { ...dramaInput, code: 'different-code' },
      metadata(key),
    )).rejects.toBeInstanceOf(ConflictException);

    const episode = await library.addEpisode(drama.id, {
      durationSeconds: 120,
      episodeNo: 1,
      expectedDramaVersion: drama.version,
      mediaAssetId: videoId,
      previewMediaAssetId: previewVideoId,
      previewSeconds: 15,
      translations: [{ locale: 'en-US', title: 'Episode One' }],
    }, metadata('platform-episode-create-0001'));
    const published = await library.publishDrama(
      drama.id,
      { expectedVersion: episode.dramaVersion },
      metadata('platform-drama-publish-0001'),
    );
    expect(published.status).toBe('published');
    expect(published.publication).toBe('published');
    const facts = await database.query<{
      audit_count: string;
      episode_status: string;
      event_count: string;
      snapshot_json: {
        episodes: Array<{
          media: { checksum: string; mimeType: string; sizeBytes: number };
          previewMedia: { checksum: string; mimeType: string; sizeBytes: number };
          translations: Array<{ locale: string; title: string }>;
        }>;
      };
    }>(`
      select
        (select status from episodes where id = '${episode.id}') as episode_status,
        (select count(*)::text from audit_logs where scope_type = 'platform'
          and resource_id = '${drama.id}') as audit_count,
        (select count(*)::text from outbox_events where scope_type = 'platform'
          and aggregate_id = '${drama.id}') as event_count,
        (select snapshot_json from content_versions where scope_type = 'platform'
          and aggregate_id = '${drama.id}' order by version_no desc limit 1) as snapshot_json
    `);
    expect(facts.rows[0]?.episode_status).toBe('published');
    expect(Number(facts.rows[0]?.audit_count)).toBeGreaterThanOrEqual(2);
    expect(Number(facts.rows[0]?.event_count)).toBeGreaterThanOrEqual(2);
    expect(facts.rows[0]?.snapshot_json.episodes[0]).toMatchObject({
      media: {
        checksum: `sha256:${'b'.repeat(64)}`,
        mimeType: 'video/mp4',
        sizeBytes: 2000,
      },
      previewMedia: {
        checksum: `sha256:${'d'.repeat(64)}`,
        mimeType: 'video/mp4',
        sizeBytes: 700,
      },
      translations: [{ locale: 'en-US', title: 'Episode One' }],
    });
  });

  it('rejects cross-owner media and disabled providers at publication time', async () => {
    await expect(library.createDrama({
      code: 'cross-owner-cover',
      coverMediaAssetId: tenantCoverId,
      translations: [{ locale: 'en-US', title: 'Cross owner' }],
    }, metadata('cross-owner-create-0001'))).rejects.toBeInstanceOf(BadRequestException);

    const crossPreviewDrama = await library.createDrama({
      code: 'cross-owner-preview',
      coverMediaAssetId: coverId,
      translations: [{ locale: 'en-US', title: 'Cross preview' }],
    }, metadata('cross-owner-preview-drama-0001'));
    await expect(library.addEpisode(crossPreviewDrama.id, {
      durationSeconds: 60,
      episodeNo: 1,
      expectedDramaVersion: crossPreviewDrama.version,
      mediaAssetId: videoId,
      previewMediaAssetId: tenantVideoId,
      previewSeconds: 10,
      translations: [{ locale: 'en-US', title: 'Episode' }],
    }, metadata('cross-owner-preview-episode-0001')))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(library.addEpisode(crossPreviewDrama.id, {
      durationSeconds: 60,
      episodeNo: 1,
      expectedDramaVersion: crossPreviewDrama.version,
      mediaAssetId: videoId,
      previewMediaAssetId: videoId,
      previewSeconds: 10,
      translations: [{ locale: 'en-US', title: 'Episode' }],
    }, metadata('same-preview-episode-0001')))
      .rejects.toBeInstanceOf(BadRequestException);

    const drama = await library.createDrama({
      code: 'disabled-provider-drama',
      coverMediaAssetId: coverId,
      translations: [{ locale: 'en-US', title: 'Disabled provider' }],
    }, metadata('disabled-provider-drama-create'));
    const episode = await library.addEpisode(drama.id, {
      durationSeconds: 60,
      episodeNo: 1,
      expectedDramaVersion: drama.version,
      mediaAssetId: videoId,
      translations: [{ locale: 'en-US', title: 'Episode' }],
    }, metadata('disabled-provider-episode-create'));
    await database.exec(`update storage_providers set status = 'disabled' where id = '${platformProviderId}'`);
    await expect(library.publishDrama(
      drama.id,
      { expectedVersion: episode.dramaVersion },
      metadata('disabled-provider-publish-1'),
    )).rejects.toBeInstanceOf(BadRequestException);
    await database.exec(`update storage_providers set status = 'active' where id = '${platformProviderId}'`);

    const previewDrama = await library.createDrama({
      code: 'disabled-preview-provider-drama',
      coverMediaAssetId: coverId,
      translations: [{ locale: 'en-US', title: 'Disabled preview provider' }],
    }, metadata('disabled-preview-provider-drama-create'));
    const previewEpisode = await library.addEpisode(previewDrama.id, {
      durationSeconds: 60,
      episodeNo: 1,
      expectedDramaVersion: previewDrama.version,
      mediaAssetId: videoId,
      previewMediaAssetId: previewVideoId,
      previewSeconds: 10,
      translations: [{ locale: 'en-US', title: 'Episode' }],
    }, metadata('disabled-preview-provider-episode-create'));
    await database.exec(`update storage_providers set status = 'disabled'
      where id = '${previewProviderId}'`);
    await expect(library.publishDrama(
      previewDrama.id,
      { expectedVersion: previewEpisode.dramaVersion },
      metadata('disabled-preview-provider-publish'),
    )).rejects.toThrow(/preview media/);
    await database.exec(`update storage_providers set status = 'active'
      where id = '${previewProviderId}'`);
  });

  it('rejects publication when every episode publication window has elapsed', async () => {
    const episodeRelease = new Date(Date.now() - 7_200_000).toISOString();
    const episodeUnpublish = new Date(Date.now() - 3_600_000).toISOString();
    const drama = await library.createDrama({
      code: 'elapsed-episodes-drama', coverMediaAssetId: coverId,
      translations: [{ locale: 'en-US', title: 'Elapsed episodes' }],
    }, metadata('elapsed-episodes-drama-create'));
    const episode = await library.addEpisode(drama.id, {
      durationSeconds: 60, episodeNo: 1, expectedDramaVersion: drama.version,
      mediaAssetId: videoId, releaseAt: episodeRelease, unpublishAt: episodeUnpublish,
      translations: [{ locale: 'en-US', title: 'Already elapsed' }],
    }, metadata('elapsed-episodes-episode-create'));
    await expect(library.publishDrama(
      drama.id,
      { expectedVersion: episode.dramaVersion },
      metadata('elapsed-episodes-publish'),
    )).rejects.toThrow(/publication window/);
  });

  it('schedules platform drama and episode transitions and can rearm a cancelled schedule', async () => {
    const releaseAt = new Date(Date.now() + 3_600_000).toISOString();
    const unpublishAt = new Date(Date.now() + 7_200_000).toISOString();
    const drama = await library.createDrama({
      code: 'scheduled-platform-drama', coverMediaAssetId: coverId,
      releaseAt, unpublishAt,
      translations: [{ locale: 'en-US', title: 'Scheduled platform drama' }],
    }, metadata('scheduled-platform-create-01'));
    const episode = await library.addEpisode(drama.id, {
      durationSeconds: 80, episodeNo: 1, expectedDramaVersion: drama.version,
      mediaAssetId: videoId, previewMediaAssetId: previewVideoId,
      previewSeconds: 12, releaseAt, unpublishAt,
      translations: [{ locale: 'en-US', title: 'Scheduled episode' }],
    }, metadata('scheduled-platform-episode-1'));
    const first = await library.publishDrama(
      drama.id, { expectedVersion: episode.dramaVersion },
      metadata('scheduled-platform-publish-01'),
    );
    expect(first.status).toBe('approved');
    const unpublished = await library.unpublishDrama(
      drama.id, { expectedVersion: first.version },
      metadata('scheduled-platform-unpublish'),
    );
    const second = await library.publishDrama(
      drama.id, { expectedVersion: unpublished.version },
      metadata('scheduled-platform-publish-02'),
    );
    expect(second.status).toBe('approved');
    const jobCounts = await database.query<{ cancelled: string; pending: string }>(`
      select
        count(*) filter (where status = 'cancelled')::text as cancelled,
        count(*) filter (where status = 'pending')::text as pending
      from content_schedule_jobs where scope_type = 'platform'
        and target_id in ('${drama.id}', '${episode.id}')
    `);
    expect(Number(jobCounts.rows[0]?.cancelled)).toBeGreaterThanOrEqual(2);
    expect(Number(jobCounts.rows[0]?.pending)).toBeGreaterThanOrEqual(2);

    await database.exec(`
      update episodes set release_at = statement_timestamp() - interval '1 minute'
      where id = '${episode.id}';
      update content_schedule_jobs set scheduled_at = statement_timestamp() - interval '1 minute',
        available_at = statement_timestamp() - interval '1 minute'
      where scope_type = 'platform' and target_type = 'episode' and target_id = '${episode.id}'
        and action = 'publish' and status = 'pending';
    `);
    const episodePublishResult = await scheduler.processDue();
    expect(episodePublishResult.completed).toBeGreaterThanOrEqual(1);
    const episodeBeforeParent = await database.query<{
      drama_status: string; episode_status: string;
    }>(`
      select
        (select status from dramas where id = '${drama.id}') as drama_status,
        (select status from episodes where id = '${episode.id}') as episode_status
    `);
    expect(episodeBeforeParent.rows[0]).toEqual({
      drama_status: 'approved',
      episode_status: 'published',
    });

    await database.exec(`
      update dramas set release_at = statement_timestamp() - interval '1 minute'
      where id = '${drama.id}';
      update content_schedule_jobs set scheduled_at = statement_timestamp() - interval '1 minute',
        available_at = statement_timestamp() - interval '1 minute'
      where scope_type = 'platform' and target_type = 'drama' and target_id = '${drama.id}'
        and action = 'publish' and status = 'pending';
    `);
    const result = await scheduler.processDue();
    expect(result.completed).toBeGreaterThanOrEqual(1);
    const published = await database.query<{ status: string }>(
      `select status from dramas where id = '${drama.id}'`,
    );
    expect(published.rows[0]?.status).toBe('published');

    await database.exec(`
      update content_schedule_jobs set scheduled_at = statement_timestamp() - interval '1 minute',
        available_at = statement_timestamp() - interval '1 minute'
      where scope_type = 'platform' and target_type = 'episode' and target_id = '${episode.id}'
        and action = 'unpublish' and status = 'pending';
    `);
    const episodeUnpublishResult = await scheduler.processDue();
    expect(episodeUnpublishResult.completed).toBeGreaterThanOrEqual(1);
    const episodeAfterUnpublish = await database.query<{ status: string }>(
      `select status from episodes where id = '${episode.id}'`,
    );
    expect(episodeAfterUnpublish.rows[0]?.status).toBe('unpublished');

    await database.exec(`
      update content_schedule_jobs set scheduled_at = statement_timestamp() - interval '1 minute',
        available_at = statement_timestamp() - interval '1 minute'
      where scope_type = 'platform' and target_type = 'drama' and target_id = '${drama.id}'
        and action = 'unpublish' and status = 'pending';
    `);
    const unpublishResult = await scheduler.processDue();
    expect(unpublishResult.completed).toBeGreaterThanOrEqual(1);
    const unpublishedState = await database.query<{
      drama_status: string; episode_status: string; platform_audits: string;
    }>(`
      select
        (select status from dramas where id = '${drama.id}') as drama_status,
        (select status from episodes where id = '${episode.id}') as episode_status,
        (select count(*)::text from audit_logs where scope_type = 'platform'
          and resource_id = '${drama.id}' and actor_type = 'system') as platform_audits
    `);
    expect(unpublishedState.rows[0]).toEqual({
      drama_status: 'unpublished',
      episode_status: 'unpublished',
      platform_audits: '2',
    });
  });

  it('blocks deleting licensed content, then supports 30-day delete and one restore without republishing', async () => {
    const list = await library.listDramas({ page: '1', pageSize: '20' });
    const drama = list.items.find((item) => item.code === 'platform-drama-one');
    expect(drama).toBeDefined();
    if (!drama) return;
    const unpublished = await library.unpublishDrama(
      drama.id, { expectedVersion: drama.version }, metadata('licensed-drama-unpublish'),
    );
    const licenseId = uuidV7();
    await database.exec(`
      insert into content_licenses (
        id, tenant_id, license_type, drama_id, starts_at, expires_at,
        status, scope_snapshot_json, granted_by
      ) values (
        '${licenseId}', '${tenantId}', 'drama', '${drama.id}',
        statement_timestamp() - interval '1 day', statement_timestamp() + interval '30 days',
        'active', '{}'::jsonb, '${platformStaffId}'
      );
      insert into content_license_items (id, tenant_id, license_id, drama_id, created_by)
      values ('${uuidV7()}', '${tenantId}', '${licenseId}', '${drama.id}', '${platformStaffId}');
    `);
    await expect(library.deleteDrama(
      drama.id,
      { expectedVersion: unpublished.version, reason: 'retire public title' },
      metadata('licensed-drama-delete-block'),
    )).rejects.toBeInstanceOf(ConflictException);
    await database.exec(`
      update content_licenses set status = 'revoked', revoked_at = statement_timestamp(),
        revoked_by = '${platformStaffId}', revoke_reason = 'catalog retired', version = version + 1
      where id = '${licenseId}';
    `);
    const deleted = await library.deleteDrama(
      drama.id,
      { expectedVersion: unpublished.version, reason: 'retire public title' },
      metadata('licensed-drama-delete-ok'),
    );
    const restored = await library.restoreDrama(
      drama.id, { expectedVersion: deleted.version }, metadata('licensed-drama-restore'),
    );
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.status).toBe('unpublished');
    await expect(library.restoreDrama(
      drama.id, { expectedVersion: restored.version }, metadata('licensed-drama-restore-again'),
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('blocks referenced taxonomy deletion and restores unreferenced taxonomy once', async () => {
    const categories = await library.listTaxonomy('category', {});
    const category = categories.items.find((item) => item.code === 'action');
    expect(category).toBeDefined();
    if (!category) return;
    await expect(library.deleteTaxonomy(
      'category', category.id,
      { expectedVersion: category.version, reason: 'still referenced' },
      metadata('referenced-category-delete'),
    )).rejects.toBeInstanceOf(ConflictException);

    const spare = await library.createTaxonomy('tag', {
      code: 'spare-tag', translations: [{ locale: 'en-US', name: 'Spare' }],
    }, metadata('spare-tag-create'));
    const deleted = await library.deleteTaxonomy(
      'tag', spare.id as string,
      { expectedVersion: spare.version as number, reason: 'temporarily unused' },
      metadata('spare-tag-delete'),
    );
    const restored = await library.restoreTaxonomy(
      'tag', spare.id as string, { expectedVersion: deleted.version as number },
      metadata('spare-tag-restore'),
    );
    expect(restored.version).toBe(2);
    await expect(library.restoreTaxonomy(
      'tag', spare.id as string, { expectedVersion: 2 }, metadata('spare-tag-restore-again'),
    )).rejects.toBeInstanceOf(ConflictException);
  });
});
