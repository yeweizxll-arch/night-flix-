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

describe('tenant publication workflow with PostgreSQL constraints', () => {
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

    await database.exec(`
      create role content_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to content_tenant_probe;
      grant select, insert, update, delete on all tables in schema public to content_tenant_probe;
      grant execute on function app.scope_can_reference(text, uuid, text, uuid),
        app.content_target_matches_scope(text, uuid, text, uuid) to content_tenant_probe;
    `);
    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        contextTenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction(async (transaction) => {
          await transaction.exec('set local role content_tenant_probe');
          await transaction.query("select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)", [contextTenantId]);
          return callback(transactionTag(transaction));
        }),
    } as unknown as DatabaseService;
    content = new ContentService(databaseService);
    media = new MediaService(databaseService);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  const metadata = () => ({ actorId: tenantStaffId, requestId: uuidV7(), idempotencyKey: uuidV7() });
  async function readyDrama(code: string, schedule = false) {
    const drama = await content.createTenantDrama(tenantId, {
      code, coverFileId: coverId,
      ...(schedule ? {
        releaseAt: new Date(Date.now() + 86_400_000).toISOString(),
        unpublishAt: new Date(Date.now() + 172_800_000).toISOString(),
      } : {}),
      translations: [{ locale: 'zh-CN', title: code }],
    }, metadata());
    const episode = await content.addTenantEpisode(tenantId, drama.id, {
      expectedDramaVersion: drama.version, durationSeconds: 60, episodeNo: 1,
      mediaAssetId: videoId, translations: [{ locale: 'zh-CN', title: '第一集' }],
    }, metadata());
    return { ...drama, episode, version: episode.dramaVersion };
  }

  it('publishes directly with tenant audit and no headquarters review, then unpublishes and edits', async () => {
    const drama = await readyDrama('tenant-publish-direct');
    const command = metadata();
    const published = await content.setTenantDramaPublication(tenantId, drama.id, 'publish',
      { expectedVersion: drama.version }, command);
    expect(published).toEqual({ status: 'published', version: 2 });
    expect(await content.setTenantDramaPublication(tenantId, drama.id, 'publish',
      { expectedVersion: drama.version }, command)).toEqual(published);
    await expect(content.setTenantDramaPublication(tenantId, drama.id, 'publish',
      { expectedVersion: drama.version }, metadata())).rejects.toBeInstanceOf(ConflictException);
    let detail = await content.getTenantDrama(tenantId, drama.id);
    expect(detail.episodes[0]?.status).toBe('published');
    await expect(content.updateTenantDrama(tenantId, drama.id,
      { version: detail.version, translations: [{ locale: 'zh-CN', title: '不能原地修改' }] },
      metadata())).rejects.toBeInstanceOf(ConflictException);
    const down = await content.setTenantDramaPublication(tenantId, drama.id, 'unpublish',
      { expectedVersion: published.version }, metadata());
    expect(down).toEqual({ status: 'unpublished', version: 3 });
    detail = await content.getTenantDrama(tenantId, drama.id);
    expect(detail.episodes[0]?.status).toBe('unpublished');
    const edited = await content.updateTenantDrama(tenantId, drama.id,
      { version: down.version, translations: [{ locale: 'zh-CN', title: '下架后编辑' }] },
      metadata());
    expect(edited.status).toBe('unpublished');
    const extra = await content.addTenantEpisode(tenantId, drama.id, {
      expectedDramaVersion: edited.version, durationSeconds: 61, episodeNo: 2,
      mediaAssetId: videoId, translations: [{ locale: 'zh-CN', title: '第二集' }],
    }, metadata());
    expect(extra.episodeNo).toBe(2);
    const republished = await content.setTenantDramaPublication(tenantId, drama.id, 'publish',
      { expectedVersion: extra.dramaVersion }, metadata());
    expect(republished.status).toBe('published');
    const reviews = await database.query('select id from review_requests where target_id = $1', [drama.id]);
    expect(reviews.rows).toHaveLength(0);
    const audit = await database.query<{ scope_type: string }>(
      "select scope_type from audit_logs where resource_id = $1 and action = 'content.drama.publish'", [drama.id]);
    expect(audit.rows).toHaveLength(2);
    expect(audit.rows.every(row => row.scope_type === 'tenant')).toBe(true);
  });

  it('cancels every old schedule and allows re-scheduling the same timestamps', async () => {
    const drama = await readyDrama('tenant-publish-scheduled', true);
    const published = await content.setTenantDramaPublication(tenantId, drama.id, 'publish',
      { expectedVersion: drama.version }, metadata());
    expect(published.status).toBe('approved');
    let jobs = await database.query<{ status: string }>(
      'select status from content_schedule_jobs where target_id = $1', [drama.id]);
    expect(jobs.rows).toHaveLength(2);
    const down = await content.setTenantDramaPublication(tenantId, drama.id, 'unpublish',
      { expectedVersion: published.version }, metadata());
    jobs = await database.query('select status from content_schedule_jobs where target_id = $1', [drama.id]);
    expect(jobs.rows.every(row => row.status === 'cancelled')).toBe(true);
    await content.setTenantDramaPublication(tenantId, drama.id, 'publish',
      { expectedVersion: down.version }, metadata());
    jobs = await database.query('select status from content_schedule_jobs where target_id = $1', [drama.id]);
    expect(jobs.rows.filter(row => row.status === 'pending')).toHaveLength(2);
    expect(jobs.rows.filter(row => row.status === 'cancelled')).toHaveLength(2);
  });

  it('rejects incomplete or unavailable media and expired schedules without changing state', async () => {
    const empty = await content.createTenantDrama(tenantId, {
      code: 'no-episode', coverFileId: coverId, translations: [{ locale: 'zh-CN', title: '空剧' }],
    }, metadata());
    await expect(content.setTenantDramaPublication(tenantId, empty.id, 'publish',
      { expectedVersion: empty.version }, metadata())).rejects.toThrow('At least one episode');
    const drama = await readyDrama('tenant-publish-unready');
    await database.exec(`update storage_providers set status = 'disabled' where id = '${providerId}'`);
    try {
      await expect(content.setTenantDramaPublication(tenantId, drama.id, 'publish',
        { expectedVersion: drama.version }, metadata())).rejects.toThrow('Cover is not ready');
    } finally {
      await database.exec(`update storage_providers set status = 'active' where id = '${providerId}'`);
    }
    await database.exec(`update dramas set release_at = statement_timestamp() - interval '2 days',
      unpublish_at = statement_timestamp() - interval '1 day' where id = '${drama.id}'`);
    await expect(content.setTenantDramaPublication(tenantId, drama.id, 'publish',
      { expectedVersion: drama.version }, metadata())).rejects.toThrow('expired unpublish');
    expect((await content.getTenantDrama(tenantId, drama.id)).status).toBe('draft');
  });

  it('cannot publish or unpublish another tenant content or headquarters public content', async () => {
    const drama = await readyDrama('tenant-scope-probe');
    const otherTenant = uuidV7();
    await database.exec(`insert into tenants (id, code, name, expires_at)
      values ('${otherTenant}', 'other-publisher', 'Other Publisher', statement_timestamp() + interval '1 year')`);
    await expect(content.setTenantDramaPublication(otherTenant, drama.id, 'publish',
      { expectedVersion: drama.version }, metadata())).rejects.toBeInstanceOf(NotFoundException);
    await expect(content.setTenantDramaPublication(otherTenant, drama.id, 'unpublish',
      { expectedVersion: drama.version }, metadata())).rejects.toBeInstanceOf(NotFoundException);
    const publicId = uuidV7();
    await database.exec(`insert into dramas (id, owner_type, code, source_type)
      values ('${publicId}', 'platform', 'headquarters-public-probe', 'upload')`);
    await expect(content.setTenantDramaPublication(tenantId, publicId, 'publish',
      { expectedVersion: 0 }, metadata())).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lets a tenant withdraw legacy pending review without headquarters involvement', async () => {
    const drama = await readyDrama('legacy-pending-withdraw');
    await database.exec(`
      insert into review_requests (id, tenant_id, target_type, target_id, content_version_id, submitted_by)
      select '${uuidV7()}', '${tenantId}', 'drama', '${drama.id}', id, '${tenantStaffId}'
      from content_versions where aggregate_id = '${drama.id}' order by created_at desc, id desc limit 1;
      update dramas set status = 'pending_review', version = version + 1 where id = '${drama.id}';
    `);
    expect(await content.withdrawTenantReview(tenantId, drama.id, metadata()))
      .toMatchObject({ status: 'draft', withdrawn: true });
    const current = await content.getTenantDrama(tenantId, drama.id);
    expect((await content.setTenantDramaPublication(tenantId, drama.id, 'publish',
      { expectedVersion: current.version }, metadata())).status).toBe('published');
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
