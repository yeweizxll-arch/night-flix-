import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ContentScheduleWorkerService } from '../src/content/content-schedule-worker.service';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';

let database: PGlite;
let scheduler: ContentScheduleWorkerService;

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773571101';
const dramaId = '018f2f45-7f5e-7e70-b17f-f6e773571102';
const scheduleId = '018f2f45-7f5e-7e70-b17f-f6e773571103';
const mediaId = '018f2f45-7f5e-7e70-b17f-f6e773571104';
const currentEpisodeId = '018f2f45-7f5e-7e70-b17f-f6e773571105';
const futureEpisodeId = '018f2f45-7f5e-7e70-b17f-f6e773571106';
const episodePublishScheduleId = '018f2f45-7f5e-7e70-b17f-f6e773571107';
const blockedEpisodeScheduleId = '018f2f45-7f5e-7e70-b17f-f6e773571108';
const episodeUnpublishScheduleId = '018f2f45-7f5e-7e70-b17f-f6e773571109';
const idempotentUnpublishScheduleId = '018f2f45-7f5e-7e70-b17f-f6e773571110';
const dramaUnpublishScheduleId = '018f2f45-7f5e-7e70-b17f-f6e773571111';
const providerId = '018f2f45-7f5e-7e70-b17f-f6e773571112';

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}

describe('content schedule worker PostgreSQL workflow', () => {
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
      values ('${tenantId}', 'schedule-test', 'Schedule Test', statement_timestamp() + interval '1 year');
      insert into storage_providers (
        id, owner_type, owner_tenant_id, provider, account_label, bucket,
        credential_ciphertext
      ) values (
        '${providerId}', 'tenant', '${tenantId}', 's3', 'schedule-test',
        'schedule-test', '${'x'.repeat(64)}'
      );
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, storage_provider_id, object_key,
        mime_type, size_bytes, checksum, status, transcode_status, duration_seconds
      ) values (
        '${mediaId}', 'tenant', '${tenantId}', 'video',
        '${providerId}', 'schedule/episode.mp4', 'video/mp4', 100,
        'sha256:${'c'.repeat(64)}', 'ready', 'ready', 120
      );
      insert into dramas (
        id, owner_type, owner_tenant_id, code, status, release_at
      ) values (
        '${dramaId}', 'tenant', '${tenantId}', 'scheduled-drama', 'approved',
        statement_timestamp() - interval '1 minute'
      );
      insert into episodes (
        id, drama_id, episode_no, status, release_at, unpublish_at,
        duration_seconds, media_asset_id
      ) values (
        '${currentEpisodeId}', '${dramaId}', 1, 'approved',
        statement_timestamp() - interval '2 minutes',
        statement_timestamp() + interval '2 hours', 120, '${mediaId}'
      ), (
        '${futureEpisodeId}', '${dramaId}', 2, 'approved',
        statement_timestamp() + interval '1 hour',
        statement_timestamp() + interval '2 hours', 120, '${mediaId}'
      );
      insert into content_schedule_jobs (
        id, scope_type, tenant_id, target_type, target_id, action,
        scheduled_at, idempotency_key
      ) values (
        '${scheduleId}', 'tenant', '${tenantId}', 'drama', '${dramaId}',
        'publish', statement_timestamp() - interval '1 minute',
        'schedule-test-drama-publish'
      );
    `);

    const service = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
    } as unknown as DatabaseService;
    scheduler = new ContentScheduleWorkerService(service);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('publishes a drama and only the episodes whose release time has arrived', async () => {
    await expect(scheduler.processDue()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    const result = await database.query<{
      audit_count: string;
      current_episode_status: string;
      drama_status: string;
      event_count: string;
      future_episode_status: string;
      job_status: string;
    }>(`
      select
        (select status from dramas where id = '${dramaId}') as drama_status,
        (select status from episodes where id = '${currentEpisodeId}') as current_episode_status,
        (select status from episodes where id = '${futureEpisodeId}') as future_episode_status,
        (select status from content_schedule_jobs where id = '${scheduleId}') as job_status,
        (select count(*)::text from outbox_events
          where aggregate_type = 'drama' and aggregate_id = '${dramaId}') as event_count,
        (select count(*)::text from audit_logs
          where resource_type = 'drama' and resource_id = '${dramaId}') as audit_count
    `);
    expect(result.rows[0]).toEqual({
      audit_count: '1',
      current_episode_status: 'published',
      drama_status: 'published',
      event_count: '1',
      future_episode_status: 'approved',
      job_status: 'completed',
    });
  });

  it('publishes a due episode while its same-time parent publish is still approved', async () => {
    await database.exec(`
      update dramas set status = 'approved' where id = '${dramaId}';
      update episodes
      set status = 'approved', release_at = statement_timestamp() - interval '1 minute'
      where id = '${futureEpisodeId}';
      insert into content_schedule_jobs (
        id, scope_type, tenant_id, target_type, target_id, action,
        scheduled_at, idempotency_key
      ) values (
        '${episodePublishScheduleId}', 'tenant', '${tenantId}', 'episode',
        '${futureEpisodeId}', 'publish', statement_timestamp() - interval '1 minute',
        'schedule-test-episode-publish'
      );
    `);

    await expect(scheduler.processDue()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    const result = await database.query<{
      action: string;
      aggregate_type: string;
      episode_status: string;
      event_type: string;
      job_status: string;
      resource_type: string;
    }>(`
      select
        (select status from episodes where id = '${futureEpisodeId}') as episode_status,
        (select status from content_schedule_jobs
          where id = '${episodePublishScheduleId}') as job_status,
        event.aggregate_type,
        event.event_type,
        audit.action,
        audit.resource_type
      from outbox_events as event
      inner join audit_logs as audit
        on audit.resource_id = event.aggregate_id
        and audit.request_id = 'schedule:${episodePublishScheduleId}'
      where event.aggregate_id = '${futureEpisodeId}'
        and event.idempotency_key = 'schedule:${episodePublishScheduleId}:publish'
    `);
    expect(result.rows[0]).toEqual({
      action: 'content.schedule.episode.publish',
      aggregate_type: 'episode',
      episode_status: 'published',
      event_type: 'EpisodePublished',
      job_status: 'completed',
      resource_type: 'episode',
    });
  });

  it('refuses to publish an episode when its parent drama is unavailable', async () => {
    await database.exec(`
      update dramas set status = 'unpublished' where id = '${dramaId}';
      update episodes set status = 'approved' where id = '${futureEpisodeId}';
      insert into content_schedule_jobs (
        id, scope_type, tenant_id, target_type, target_id, action,
        scheduled_at, idempotency_key
      ) values (
        '${blockedEpisodeScheduleId}', 'tenant', '${tenantId}', 'episode',
        '${futureEpisodeId}', 'publish', statement_timestamp() - interval '1 minute',
        'schedule-test-parent-boundary'
      );
    `);

    await expect(scheduler.processDue()).resolves.toEqual({
      claimed: 1,
      completed: 0,
      failed: 1,
    });
    const result = await database.query<{
      episode_status: string;
      job_status: string;
      last_error: string;
    }>(`
      select
        (select status from episodes where id = '${futureEpisodeId}') as episode_status,
        status as job_status,
        last_error
      from content_schedule_jobs
      where id = '${blockedEpisodeScheduleId}'
    `);
    expect(result.rows[0]).toMatchObject({
      episode_status: 'approved',
      job_status: 'failed',
    });
    expect(result.rows[0]?.last_error).toContain('parent drama state unpublished');
  });

  it('unpublishes an episode idempotently even after its parent is unpublished', async () => {
    await database.exec(`
      update episodes set status = 'published' where id = '${futureEpisodeId}';
      insert into content_schedule_jobs (
        id, scope_type, tenant_id, target_type, target_id, action,
        scheduled_at, idempotency_key
      ) values (
        '${episodeUnpublishScheduleId}', 'tenant', '${tenantId}', 'episode',
        '${futureEpisodeId}', 'unpublish', statement_timestamp() - interval '1 minute',
        'schedule-test-episode-unpublish'
      );
    `);
    await expect(scheduler.processDue()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });

    await database.exec(`
      insert into content_schedule_jobs (
        id, scope_type, tenant_id, target_type, target_id, action,
        scheduled_at, idempotency_key
      ) values (
        '${idempotentUnpublishScheduleId}', 'tenant', '${tenantId}', 'episode',
        '${futureEpisodeId}', 'unpublish', statement_timestamp() - interval '1 minute',
        'schedule-test-idempotent-unpublish'
      );
    `);
    await expect(scheduler.processDue()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });

    const result = await database.query<{
      completed_jobs: string;
      episode_status: string;
      event_count: string;
    }>(`
      select
        (select status from episodes where id = '${futureEpisodeId}') as episode_status,
        (select count(*)::text from content_schedule_jobs
          where id in ('${episodeUnpublishScheduleId}', '${idempotentUnpublishScheduleId}')
            and status = 'completed') as completed_jobs,
        (select count(*)::text from outbox_events
          where aggregate_type = 'episode'
            and aggregate_id = '${futureEpisodeId}'
            and event_type = 'EpisodeUnpublished') as event_count
    `);
    expect(result.rows[0]).toEqual({
      completed_jobs: '2',
      episode_status: 'unpublished',
      event_count: '2',
    });
  });

  it('unpublishes all currently published episodes when their drama is unpublished', async () => {
    await database.exec(`
      update dramas set status = 'published' where id = '${dramaId}';
      update episodes set status = 'published' where drama_id = '${dramaId}';
      insert into content_schedule_jobs (
        id, scope_type, tenant_id, target_type, target_id, action,
        scheduled_at, idempotency_key
      ) values (
        '${dramaUnpublishScheduleId}', 'tenant', '${tenantId}', 'drama',
        '${dramaId}', 'unpublish', statement_timestamp() - interval '1 minute',
        'schedule-test-drama-unpublish'
      );
    `);

    await expect(scheduler.processDue()).resolves.toEqual({
      claimed: 1,
      completed: 1,
      failed: 0,
    });
    const result = await database.query<{
      drama_status: string;
      published_episodes: string;
      unpublished_episodes: string;
    }>(`
      select
        (select status from dramas where id = '${dramaId}') as drama_status,
        count(*) filter (where status = 'published')::text as published_episodes,
        count(*) filter (where status = 'unpublished')::text as unpublished_episodes
      from episodes
      where drama_id = '${dramaId}'
    `);
    expect(result.rows[0]).toEqual({
      drama_status: 'unpublished',
      published_episodes: '0',
      unpublished_episodes: '2',
    });
    await expect(scheduler.processDue()).resolves.toEqual({
      claimed: 0,
      completed: 0,
      failed: 0,
    });
  });
});
