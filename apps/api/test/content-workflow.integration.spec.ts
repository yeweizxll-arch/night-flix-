import { PGlite, type Transaction } from '@electric-sql/pglite';
import { ConflictException, GoneException, NotFoundException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import { ContentService } from '../src/content/content.service';
import { MediaService } from '../src/content/media.service';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../src/database/database.service';

let database: PGlite;
let content: ContentService;
let media: MediaService;

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773570101';
const tenantStaffId = '018f2f45-7f5e-7e70-b17f-f6e773570102';
const platformStaffId = '018f2f45-7f5e-7e70-b17f-f6e773570103';
const coverId = '018f2f45-7f5e-7e70-b17f-f6e773570104';
const videoId = '018f2f45-7f5e-7e70-b17f-f6e773570105';
const providerId = '018f2f45-7f5e-7e70-b17f-f6e773570106';

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    const result = await transaction.query(sql, values);
    return result.rows;
  };
  Object.assign(tag, {
    json: (value: unknown) => JSON.stringify(value),
  });
  return tag as unknown as DatabaseTransaction;
}

describe('content review workflow with PostgreSQL constraints', () => {
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
      insert into tenants (id, code, name, expires_at)
      values ('${tenantId}', 'content-test', 'Content Test', statement_timestamp() + interval '1 year');
      insert into tenant_staff (id, tenant_id, username, password_hash)
      values ('${tenantStaffId}', '${tenantId}', 'content-owner', '${'p'.repeat(64)}');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaffId}', 'content-reviewer', '${'p'.repeat(64)}');
      insert into storage_providers (
        id, owner_type, owner_tenant_id, provider, account_label, bucket,
        credential_ciphertext
      ) values (
        '${providerId}', 'tenant', '${tenantId}', 's3', 'content-test',
        'content-test-bucket', '${'x'.repeat(64)}'
      );
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, storage_provider_id, object_key,
        mime_type, size_bytes, checksum, status, transcode_status
      ) values (
        '${coverId}', 'tenant', '${tenantId}', 'image',
        '${providerId}', 'tenant/cover.jpg', 'image/jpeg', 1000,
        'sha256:${'a'.repeat(64)}', 'ready', 'not_required'
      ), (
        '${videoId}', 'tenant', '${tenantId}', 'video',
        '${providerId}', 'tenant/episode-1.mp4', 'video/mp4', 2000,
        'sha256:${'b'.repeat(64)}', 'ready', 'ready'
      );
    `);

    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        _tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
    } as unknown as DatabaseService;
    content = new ContentService(databaseService);
    media = new MediaService(databaseService);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('creates a drama and episode, submits it, and publishes only after review', async () => {
    const createRequestId = uuidV7();
    const drama = await content.createTenantDrama(
      tenantId,
      {
        code: 'workflow-drama',
        coverFileId: coverId,
        translations: [
          { locale: 'en-US', summary: 'A test drama', title: 'Workflow Drama' },
          { locale: 'ja-JP', title: 'ワークフロードラマ' },
        ],
      },
      { actorId: tenantStaffId, requestId: createRequestId },
    );
    expect(drama.status).toBe('draft');
    expect(drama.translations).toHaveLength(2);

    await content.addTenantEpisode(
      tenantId,
      drama.id,
      {
        durationSeconds: 120,
        episodeNo: 1,
        expectedDramaVersion: drama.version,
        mediaAssetId: videoId,
        previewSeconds: 15,
        translations: [{ locale: 'en-US', title: 'Episode 1' }],
      },
      { actorId: tenantStaffId, requestId: uuidV7() },
    );
    const submitted = await content.submitTenantDrama(
      tenantId,
      drama.id,
      { actorId: tenantStaffId, requestId: uuidV7() },
    );

    const pending = await database.query<{ status: string }>(`
      select status from dramas where id = '${drama.id}'
    `);
    expect(submitted.status).toBe('pending_review');
    expect(pending.rows[0]?.status).toBe('pending_review');
    const submittedSnapshot = await database.query<{
      snapshot_json: {
        episodes: Array<{
          media: { checksum: string; id: string };
          translations: unknown[];
        }>;
      };
    }>(`
      select version.snapshot_json
      from review_requests as request
      inner join content_versions as version on version.id = request.content_version_id
      where request.id = '${submitted.reviewRequestId}'
    `);
    expect(submittedSnapshot.rows[0]?.snapshot_json.episodes[0]?.translations).toEqual([
      expect.objectContaining({ locale: 'en-US', title: 'Episode 1' }),
    ]);
    expect(submittedSnapshot.rows[0]?.snapshot_json.episodes[0]).toMatchObject({
      media: { checksum: `sha256:${'b'.repeat(64)}`, id: videoId },
    });
    const reviewDetail = await content.getPlatformReview(submitted.reviewRequestId);
    expect(reviewDetail).toEqual(expect.objectContaining({
      id: submitted.reviewRequestId,
      status: 'submitted',
      tenantId,
    }));
    expect(reviewDetail.drama.episodes).toEqual([
      expect.objectContaining({ episodeNo: 1, mediaAssetId: videoId }),
    ]);

    await database.exec(`update dramas set status = 'draft' where id = '${drama.id}'`);
    await expect(content.decidePlatformReview(
      submitted.reviewRequestId,
      'approve',
      { version: 0 },
      { actorId: platformStaffId, requestId: uuidV7() },
    )).rejects.toBeInstanceOf(ConflictException);
    const unchangedReview = await database.query<{ status: string }>(`
      select status from review_requests where id = '${submitted.reviewRequestId}'
    `);
    expect(unchangedReview.rows[0]?.status).toBe('submitted');
    await database.exec(`update dramas set status = 'pending_review' where id = '${drama.id}'`);

    const decision = await content.decidePlatformReview(
      submitted.reviewRequestId,
      'approve',
      { version: 0 },
      { actorId: platformStaffId, requestId: uuidV7() },
    );
    expect(decision).toEqual({ dramaStatus: 'published', status: 'approved' });

    await expect(content.decidePlatformReview(
      submitted.reviewRequestId,
      'approve',
      { version: 0 },
      { actorId: platformStaffId, requestId: uuidV7() },
    )).rejects.toBeInstanceOf(ConflictException);

    const facts = await database.query<{
      audits: string;
      episode_status: string;
      events: string;
      platform_audits: string;
      versions: string;
    }>(`
      select
        (select count(*)::text from audit_logs where resource_id = '${drama.id}') as audits,
        (select status from episodes where drama_id = '${drama.id}' and episode_no = 1)
          as episode_status,
        (select count(*)::text from outbox_events where aggregate_id = '${drama.id}') as events,
        (select count(*)::text from audit_logs
          where resource_id = '${submitted.reviewRequestId}'
            and scope_type = 'platform' and tenant_id is null) as platform_audits,
        (select count(*)::text from content_versions where aggregate_id = '${drama.id}') as versions
    `);
    expect(Number(facts.rows[0]?.audits)).toBeGreaterThanOrEqual(2);
    expect(facts.rows[0]?.episode_status).toBe('published');
    expect(Number(facts.rows[0]?.events)).toBe(3);
    expect(Number(facts.rows[0]?.platform_audits)).toBe(1);
    expect(Number(facts.rows[0]?.versions)).toBeGreaterThanOrEqual(2);
  });

  it('approves future episodes without publishing them and creates both schedules', async () => {
    const releaseAt = new Date(Date.now() + 60 * 60 * 1_000).toISOString();
    const unpublishAt = new Date(Date.now() + 2 * 60 * 60 * 1_000).toISOString();
    const drama = await content.createTenantDrama(
      tenantId,
      {
        code: 'future-episode-workflow-drama',
        coverFileId: coverId,
        translations: [{ locale: 'en-US', title: 'Future Episode Workflow' }],
      },
      { actorId: tenantStaffId, requestId: uuidV7() },
    );
    const episode = await content.addTenantEpisode(
      tenantId,
      drama.id,
      {
        durationSeconds: 120,
        episodeNo: 1,
        expectedDramaVersion: drama.version,
        mediaAssetId: videoId,
        releaseAt,
        translations: [{ locale: 'en-US', title: 'Future Episode' }],
        unpublishAt,
      },
      { actorId: tenantStaffId, requestId: uuidV7() },
    );
    const submitted = await content.submitTenantDrama(
      tenantId,
      drama.id,
      { actorId: tenantStaffId, requestId: uuidV7() },
    );

    await expect(content.decidePlatformReview(
      submitted.reviewRequestId,
      'approve',
      { version: 0 },
      { actorId: platformStaffId, requestId: uuidV7() },
    )).resolves.toEqual({ dramaStatus: 'published', status: 'approved' });

    const episodeState = await database.query<{ status: string }>(`
      select status from episodes where id = '${episode.id}'
    `);
    expect(episodeState.rows[0]?.status).toBe('approved');
    const schedules = await database.query<{
      action: string;
      scheduled_at: Date;
      target_type: string;
    }>(`
      select target_type, action, scheduled_at
      from content_schedule_jobs
      where target_id = '${episode.id}'
      order by action
    `);
    expect(schedules.rows).toEqual([
      { action: 'publish', scheduled_at: new Date(releaseAt), target_type: 'episode' },
      { action: 'unpublish', scheduled_at: new Date(unpublishAt), target_type: 'episode' },
    ]);
  });

  it('keeps episodes unpublished when a review is rejected', async () => {
    const drama = await content.createTenantDrama(
      tenantId,
      {
        code: 'rejected-episode-workflow-drama',
        coverFileId: coverId,
        translations: [{ locale: 'en-US', title: 'Rejected Episode Workflow' }],
      },
      { actorId: tenantStaffId, requestId: uuidV7() },
    );
    const episode = await content.addTenantEpisode(
      tenantId,
      drama.id,
      {
        durationSeconds: 120,
        episodeNo: 1,
        expectedDramaVersion: drama.version,
        mediaAssetId: videoId,
        translations: [{ locale: 'en-US', title: 'Rejected Episode' }],
      },
      { actorId: tenantStaffId, requestId: uuidV7() },
    );
    const submitted = await content.submitTenantDrama(
      tenantId,
      drama.id,
      { actorId: tenantStaffId, requestId: uuidV7() },
    );

    await expect(content.decidePlatformReview(
      submitted.reviewRequestId,
      'reject',
      { reason: 'Episode metadata needs revision', version: 0 },
      { actorId: platformStaffId, requestId: uuidV7() },
    )).resolves.toEqual({ dramaStatus: 'rejected', status: 'rejected' });

    const facts = await database.query<{
      episode_status: string;
      schedules: string;
    }>(`
      select
        (select status from episodes where id = '${episode.id}') as episode_status,
        (select count(*)::text from content_schedule_jobs
          where target_type = 'episode' and target_id = '${episode.id}') as schedules
    `);
    expect(facts.rows[0]).toEqual({ episode_status: 'draft', schedules: '0' });
  });

  it('restores a soft-deleted drama only once and keeps linked history', async () => {
    const drama = await content.createTenantDrama(
      tenantId,
      {
        code: 'restore-workflow-drama',
        translations: [{ locale: 'en-US', title: 'Restore Workflow' }],
      },
      { actorId: tenantStaffId, requestId: uuidV7() },
    );

    const deleted = await content.softDeleteTenantDrama(
      tenantId,
      drama.id,
      { expectedVersion: drama.version, reason: 'integration test' },
      { actorId: tenantStaffId, requestId: uuidV7() },
    );
    expect(Date.parse(deleted.restoreUntil)).toBeGreaterThan(Date.now());
    await expect(content.restoreTenantDrama(
      tenantId,
      drama.id,
      { expectedVersion: deleted.version },
      { actorId: tenantStaffId, requestId: uuidV7() },
    )).resolves.toEqual({ restored: true, version: 2 });
    await expect(content.restoreTenantDrama(
      tenantId,
      drama.id,
      { expectedVersion: 2 },
      { actorId: tenantStaffId, requestId: uuidV7() },
    )).rejects.toBeInstanceOf(NotFoundException);

    const facts = await database.query<{
      deletes: string;
      restores: string;
      unlinked_restores: string;
    }>(`
      select
        count(*) filter (where action = 'soft_delete')::text as deletes,
        count(*) filter (where action = 'restore')::text as restores,
        count(*) filter (
          where action = 'restore' and restored_from_id is null
        )::text as unlinked_restores
      from content_deletion_history
      where target_type = 'drama' and target_id = '${drama.id}'
    `);
    expect(facts.rows[0]).toEqual({ deletes: '1', restores: '1', unlinked_restores: '0' });
  });

  it('edits a rejected/draft version and lets the merchant withdraw a pending review', async () => {
    const drama = await content.createTenantDrama(
      tenantId,
      {
        code: 'withdraw-workflow-drama',
        coverFileId: coverId,
        translations: [{ locale: 'en-US', title: 'Before Edit' }],
      },
      { actorId: tenantStaffId, requestId: uuidV7() },
    );
    await content.addTenantEpisode(
      tenantId,
      drama.id,
      {
        durationSeconds: 90,
        episodeNo: 1,
        expectedDramaVersion: drama.version,
        mediaAssetId: videoId,
        translations: [{ locale: 'en-US', title: 'Episode 1' }],
      },
      { actorId: tenantStaffId, requestId: uuidV7() },
    );
    const edited = await content.updateTenantDrama(
      tenantId,
      drama.id,
      {
        translations: [{ locale: 'en-US', title: 'After Edit' }],
        version: 1,
      },
      { actorId: tenantStaffId, requestId: uuidV7() },
    );
    expect(edited.version).toBe(2);
    expect(edited.translations[0]?.title).toBe('After Edit');

    const submitted = await content.submitTenantDrama(
      tenantId,
      drama.id,
      { actorId: tenantStaffId, requestId: uuidV7() },
    );
    await expect(content.withdrawTenantReview(
      tenantId,
      drama.id,
      { actorId: tenantStaffId, requestId: uuidV7() },
    )).resolves.toEqual({ status: 'draft', withdrawn: true });

    const states = await database.query<{ drama_status: string; review_status: string }>(`
      select
        (select status from dramas where id = '${drama.id}') as drama_status,
        (select status from review_requests where id = '${submitted.reviewRequestId}') as review_status
    `);
    expect(states.rows[0]).toEqual({ drama_status: 'draft', review_status: 'withdrawn' });
  });

  it('returns the original command result for a matching idempotency key', async () => {
    const idempotencyKey = 'content-create-integration-001';
    const input = {
      code: 'idempotent-workflow-drama',
      translations: [{ locale: 'en-US', title: 'Idempotent Drama' }],
    };
    const first = await content.createTenantDrama(
      tenantId,
      input,
      { actorId: tenantStaffId, idempotencyKey, requestId: uuidV7() },
    );
    const replay = await content.createTenantDrama(
      tenantId,
      input,
      { actorId: tenantStaffId, idempotencyKey, requestId: uuidV7() },
    );
    expect(replay).toEqual(first);

    await expect(content.createTenantDrama(
      tenantId,
      { ...input, code: 'idempotency-key-reused-with-other-body' },
      { actorId: tenantStaffId, idempotencyKey, requestId: uuidV7() },
    )).rejects.toBeInstanceOf(ConflictException);

    const counts = await database.query<{ commands: string; dramas: string }>(`
      select
        (select count(*)::text from command_idempotency
          where tenant_id = '${tenantId}' and idempotency_key = '${idempotencyKey}') as commands,
        (select count(*)::text from dramas
          where owner_tenant_id = '${tenantId}' and code = '${input.code}') as dramas
    `);
    expect(counts.rows[0]).toEqual({ commands: '1', dramas: '1' });
  });

  it('retires external URL registration without creating permanent pending media', async () => {
    const input = {
      durationSeconds: 60,
      kind: 'video' as const,
      mimeType: 'video/mp4',
      sourceUrl: 'https://third-party.example.com/source/video.mp4',
    };
    await expect(media.registerExternal(
      tenantId,
      input,
      { actorId: tenantStaffId, idempotencyKey: 'retired-external-001', requestId: uuidV7() },
    )).rejects.toBeInstanceOf(GoneException);

    const counts = await database.query<{ assets: string }>(`
      select count(*)::text as assets from media_assets where source_url is not null
    `);
    expect(counts.rows[0]).toEqual({ assets: '0' });
  });
});
