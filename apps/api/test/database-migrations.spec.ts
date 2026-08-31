import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let database: PGlite;

const contentTables = [
  'categories',
  'category_translations',
  'command_idempotency',
  'content_deletion_history',
  'content_import_jobs',
  'content_import_rows',
  'content_license_items',
  'content_license_package_items',
  'content_license_packages',
  'content_licenses',
  'content_schedule_jobs',
  'content_versions',
  'drama_tags',
  'drama_translations',
  'dramas',
  'episode_translations',
  'episodes',
  'interaction_bullet_comments',
  'interaction_comments',
  'interaction_moderation_actions',
  'interaction_reports',
  'interaction_sensitive_words',
  'media_assets',
  'outbox_consumptions',
  'outbox_events',
  'review_request_actions',
  'review_requests',
  'storage_providers',
  'tag_translations',
  'tags',
] as const;

describe('PostgreSQL migration baseline', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();

    for (let pass = 0; pass < 2; pass += 1) {
      for (const filename of filenames) {
        const source = await readFile(resolve(directory, filename), 'utf8');
        // PGlite does not ship citext. PostgreSQL 16 CI executes the unmodified SQL.
        const compatible = source
          .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
          .replace(/\bcitext\b/g, 'text');
        await database.exec(compatible);
      }
    }
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('is idempotent and creates the expected RLS policies', async () => {
    const tables = await database.query<{ table_name: string }>(`
      select table_name
      from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'
      order by table_name
    `);
    expect(tables.rows.map((row) => row.table_name)).toEqual(
      expect.arrayContaining([
        'audit_logs',
        'auth_sessions',
        'auth_refresh_token_history',
        ...contentTables,
        'permissions',
        'platform_staff',
        'role_permissions',
        'roles',
        'subject_roles',
        'tenant_domains',
        'tenant_staff',
        'tenant_status_history',
        'tenants',
      ]),
    );

    const policies = await database.query<{ count: string }>(`
      select count(*)::text as count from pg_policies where schemaname = 'public'
    `);
    expect(Number(policies.rows[0]?.count)).toBeGreaterThanOrEqual(98);
  });

  it('forces RLS on content and outbox tables with explicit platform policies', async () => {
    const tableList = contentTables.map((name) => `'${name}'`).join(',');
    const tables = await database.query<{
      forcerowsecurity: boolean;
      rowsecurity: boolean;
      tablename: string;
    }>(`
      select
        relation.relname as tablename,
        relation.relrowsecurity as rowsecurity,
        relation.relforcerowsecurity as forcerowsecurity
      from pg_class as relation
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relkind = 'r'
        and relation.relname = any(array[${tableList}])
      order by relation.relname
    `);
    expect(tables.rows).toHaveLength(contentTables.length);
    expect(tables.rows.every((row) => row.rowsecurity && row.forcerowsecurity)).toBe(true);

    const platformPolicies = await database.query<{ tablename: string }>(`
      select distinct tablename
      from pg_policies
      where schemaname = 'public'
        and policyname like '%platform_access'
        and tablename = any(array[${tableList}])
      order by tablename
    `);
    expect(platformPolicies.rows.map((row) => row.tablename)).toEqual(
      [...contentTables].sort(),
    );
  });

  it('resolves only a verified domain and calculates effective expiry', async () => {
    await database.exec(`
      insert into tenants (id, code, name, status, expires_at)
      values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c101',
        'expired-demo',
        'Expired demo',
        'active',
        statement_timestamp() - interval '1 day'
      );
      insert into tenant_domains (
        id, tenant_id, host, type, verification_token, verified_at,
        tls_status, is_primary
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c102',
        '018f2f45-7f5e-7e70-b17f-f6e77357c101',
        'expired.example.com',
        'custom',
        'verification-token-12345',
        statement_timestamp(),
        'active',
        true
      );
    `);
    const resolved = await database.query<{ id: string; status: string }>(`
      select * from app.resolve_tenant_by_host('EXPIRED.EXAMPLE.COM:443')
    `);
    expect(resolved.rows).toEqual([
      {
        id: '018f2f45-7f5e-7e70-b17f-f6e77357c101',
        status: 'expired',
      },
    ]);
    const unknown = await database.query(`
      select * from app.resolve_tenant_by_host('unknown.example.com')
    `);
    expect(unknown.rows).toHaveLength(0);
  });

  it('rejects a session whose absolute lifetime exceeds 30 days', async () => {
    await expect(
      database.exec(`
        insert into auth_sessions (
          id,
          session_family_id,
          subject_type,
          subject_id,
          access_token_hash,
          refresh_token_hash,
          issued_at,
          access_expires_at,
          refresh_expires_at,
          absolute_expires_at
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c110',
          '018f2f45-7f5e-7e70-b17f-f6e77357c110',
          'platform_staff',
          '018f2f45-7f5e-7e70-b17f-f6e77357c111',
          '${'a'.repeat(64)}',
          '${'b'.repeat(64)}',
          statement_timestamp(),
          statement_timestamp() + interval '15 minutes',
          statement_timestamp() + interval '7 days',
          statement_timestamp() + interval '31 days'
        );
      `),
    ).rejects.toThrow();
  });

  it('enforces single-use refresh history and ties it to an existing session', async () => {
    await database.exec(`
      insert into platform_staff (id, username, password_hash)
      values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c120',
        'history-admin',
        '${'p'.repeat(64)}'
      );
      insert into auth_sessions (
        id,
        session_family_id,
        subject_type,
        subject_id,
        access_token_hash,
        refresh_token_hash,
        issued_at,
        access_expires_at,
        refresh_expires_at,
        absolute_expires_at
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c121',
        '018f2f45-7f5e-7e70-b17f-f6e77357c121',
        'platform_staff',
        '018f2f45-7f5e-7e70-b17f-f6e77357c120',
        '${'c'.repeat(64)}',
        '${'d'.repeat(64)}',
        statement_timestamp(),
        statement_timestamp() + interval '15 minutes',
        statement_timestamp() + interval '7 days',
        statement_timestamp() + interval '30 days'
      );
      insert into auth_refresh_token_history (
        id,
        session_id,
        session_family_id,
        subject_type,
        subject_id,
        token_hash,
        used_at,
        expires_at
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c122',
        '018f2f45-7f5e-7e70-b17f-f6e77357c121',
        '018f2f45-7f5e-7e70-b17f-f6e77357c121',
        'platform_staff',
        '018f2f45-7f5e-7e70-b17f-f6e77357c120',
        '${'e'.repeat(64)}',
        statement_timestamp(),
        statement_timestamp() + interval '30 days'
      );
    `);

    const history = await database.query<{
      session_family_id: string;
      session_id: string;
      token_hash: string;
    }>(`
      select session_id, session_family_id, token_hash
      from auth_refresh_token_history
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c122'
    `);
    expect(history.rows).toEqual([
      {
        session_family_id: '018f2f45-7f5e-7e70-b17f-f6e77357c121',
        session_id: '018f2f45-7f5e-7e70-b17f-f6e77357c121',
        token_hash: 'e'.repeat(64),
      },
    ]);

    await expect(
      database.exec(`
        insert into auth_refresh_token_history (
          id,
          session_id,
          session_family_id,
          subject_type,
          subject_id,
          token_hash,
          expires_at
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c123',
          '018f2f45-7f5e-7e70-b17f-f6e77357c121',
          '018f2f45-7f5e-7e70-b17f-f6e77357c121',
          'platform_staff',
          '018f2f45-7f5e-7e70-b17f-f6e77357c120',
          '${'e'.repeat(64)}',
          statement_timestamp() + interval '30 days'
        );
      `),
    ).rejects.toThrow();
    await expect(
      database.exec(`
        insert into auth_refresh_token_history (
          id,
          session_id,
          session_family_id,
          subject_type,
          subject_id,
          token_hash,
          expires_at
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c124',
          '018f2f45-7f5e-7e70-b17f-f6e77357fffff',
          '018f2f45-7f5e-7e70-b17f-f6e77357fffff',
          'platform_staff',
          '018f2f45-7f5e-7e70-b17f-f6e77357c120',
          '${'f'.repeat(64)}',
          statement_timestamp() + interval '30 days'
        );
      `),
    ).rejects.toThrow();

    await expect(
      database.exec(`
        insert into auth_refresh_token_history (
          id,
          session_id,
          session_family_id,
          subject_type,
          subject_id,
          token_hash,
          expires_at
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c125',
          '018f2f45-7f5e-7e70-b17f-f6e77357c121',
          '018f2f45-7f5e-7e70-b17f-f6e77357c999',
          'platform_staff',
          '018f2f45-7f5e-7e70-b17f-f6e77357c120',
          '${'g'.repeat(64)}',
          statement_timestamp() + interval '30 days'
        );
      `),
    ).rejects.toThrow(/identity must match/);
  });

  it('enforces content constraints, one-level restore, and outbox idempotency', async () => {
    const tenantId = '018f2f45-7f5e-7e70-b17f-f6e77357c201';
    const mediaId = '018f2f45-7f5e-7e70-b17f-f6e77357c202';
    const dramaId = '018f2f45-7f5e-7e70-b17f-f6e77357c203';
    const deleteEventId = '018f2f45-7f5e-7e70-b17f-f6e77357c204';
    const previewMediaId = '018f2f45-7f5e-7e70-b17f-f6e77357c2e1';
    const providerId = '018f2f45-7f5e-7e70-b17f-f6e77357c2e2';
    const otherTenantId = '018f2f45-7f5e-7e70-b17f-f6e77357c2e3';
    const otherProviderId = '018f2f45-7f5e-7e70-b17f-f6e77357c2e4';
    const otherPreviewId = '018f2f45-7f5e-7e70-b17f-f6e77357c2e5';

    await database.exec(`
      insert into tenants (id, code, name, expires_at)
      values
        ('${tenantId}', 'content-check', 'Content check', now() + interval '1 year'),
        ('${otherTenantId}', 'content-check-other', 'Content check other', now() + interval '1 year');
      insert into storage_providers (
        id, owner_type, owner_tenant_id, provider, account_label, bucket,
        credential_ciphertext
      ) values
        ('${providerId}', 'tenant', '${tenantId}', 's3', 'preview-a', 'preview-a', '${'x'.repeat(64)}'),
        ('${otherProviderId}', 'tenant', '${otherTenantId}', 's3', 'preview-b', 'preview-b', '${'y'.repeat(64)}');
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, source_url,
        status, transcode_status, duration_seconds, checksum, metadata_json
      ) values (
        '${mediaId}', 'tenant', '${tenantId}', 'video',
        'https://media.example.com/episode.mp4', 'ready', 'not_required', 60,
        '${'a'.repeat(64)}', '{"immutable": true}'::jsonb
      );
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, storage_provider_id, object_key,
        mime_type, size_bytes, checksum, status, transcode_status
      ) values
        ('${previewMediaId}', 'tenant', '${tenantId}', 'video', '${providerId}',
          'preview/a.mp4', 'video/mp4', 100, 'sha256:${'b'.repeat(64)}', 'ready', 'ready'),
        ('${otherPreviewId}', 'tenant', '${otherTenantId}', 'video', '${otherProviderId}',
          'preview/b.mp4', 'video/mp4', 100, 'sha256:${'c'.repeat(64)}', 'ready', 'ready');
      insert into dramas (id, owner_type, owner_tenant_id, code)
      values ('${dramaId}', 'tenant', '${tenantId}', 'constraint-drama');
    `);

    await expect(
      database.exec(`
        insert into media_assets (
          id, owner_type, owner_tenant_id, kind, source_url,
          status, transcode_status
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c217',
          'tenant', '${tenantId}', 'video', 'https://media.example.com/untrusted.mp4',
          'ready', 'not_required'
        )
      `),
    ).rejects.toThrow();

    await database.exec(`
      insert into episodes (
        id, drama_id, episode_no, duration_seconds, media_asset_id,
        preview_media_asset_id, preview_seconds
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c224', '${dramaId}', 1, 60,
        '${mediaId}', '${previewMediaId}', 10
      )
    `);
    await expect(database.exec(`update episodes set preview_media_asset_id = media_asset_id
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c224'`)).rejects.toThrow(/preview/i);
    await expect(database.exec(`update episodes set preview_media_asset_id = '${otherPreviewId}'
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c224'`)).rejects.toThrow(/preview/i);

    await expect(
      database.exec(`
        insert into media_assets (
          id, owner_type, owner_tenant_id, kind, source_url, transcode_status
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c205',
          'tenant', '${tenantId}', 'image', 'https://media.example.com/cover.jpg', 'queued'
        )
      `),
    ).rejects.toThrow();

    await expect(
      database.exec(`
        insert into episodes (
          id, drama_id, episode_no, duration_seconds, media_asset_id, preview_seconds
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c206',
          '${dramaId}', 1, 60, '${mediaId}', 61
        )
      `),
    ).rejects.toThrow();

    await expect(
      database.exec(`
        insert into episodes (
          id, drama_id, episode_no, duration_seconds, media_asset_id, preview_seconds
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c218',
          '${dramaId}', 1001, 60, '${mediaId}', 10
        )
      `),
    ).rejects.toThrow();

    await expect(
      database.exec(`
        insert into content_schedule_jobs (
          id, scope_type, tenant_id, target_type, target_id, action,
          scheduled_at, idempotency_key
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c212', 'tenant', '${tenantId}',
          'drama', '018f2f45-7f5e-7e70-b17f-f6e77357fffff', 'publish',
          now() + interval '1 day', 'missing-target-check'
        )
      `),
    ).rejects.toThrow();

    await database.exec(`
      insert into content_schedule_jobs (
        id, scope_type, tenant_id, target_type, target_id, action,
        scheduled_at, idempotency_key
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c216', 'tenant', '${tenantId}',
        'drama', '${dramaId}', 'publish', now() + interval '1 day',
        'schedule-retry-check'
      );
      update content_schedule_jobs
      set status = 'processing', attempts = 1,
          locked_at = statement_timestamp(), locked_by = 'test-worker'
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c216';
      update content_schedule_jobs
      set status = 'retry', available_at = statement_timestamp() + interval '1 minute',
          locked_at = null, locked_by = null, last_error = 'temporary failure'
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c216';
    `);

    await expect(
      database.exec(`
        insert into content_schedule_jobs (
          id, scope_type, target_type, target_id, action,
          scheduled_at, idempotency_key
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c213', 'platform',
          'drama', '018f2f45-7f5e-7e70-b17f-f6e77357fffe', 'publish',
          now() + interval '1 day', 'platform-missing-target'
        )
      `),
    ).rejects.toThrow();

    await database.exec(`
      insert into content_deletion_history (
        id, scope_type, tenant_id, target_type, target_id, action,
        previous_status, resulting_status, reason, restore_until,
        actor_type, actor_id
      ) values (
        '${deleteEventId}', 'tenant', '${tenantId}', 'drama', '${dramaId}',
        'soft_delete', 'draft', 'deleted', 'test delete', now() + interval '1 day',
        'tenant_staff', '018f2f45-7f5e-7e70-b17f-f6e77357c207'
      );
      insert into content_deletion_history (
        id, scope_type, tenant_id, target_type, target_id, action, restored_from_id,
        previous_status, resulting_status, reason, actor_type, actor_id
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c208', 'tenant', '${tenantId}',
        'drama', '${dramaId}', 'restore', '${deleteEventId}', 'deleted', 'draft',
        'test restore', 'tenant_staff', '018f2f45-7f5e-7e70-b17f-f6e77357c207'
      );
    `);
    await expect(
      database.exec(`
        insert into content_deletion_history (
          id, scope_type, tenant_id, target_type, target_id, action, restored_from_id,
          previous_status, resulting_status, reason, actor_type, actor_id
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c209', 'tenant', '${tenantId}',
          'drama', '${dramaId}', 'restore', '${deleteEventId}', 'deleted', 'draft',
          'duplicate restore', 'tenant_staff', '018f2f45-7f5e-7e70-b17f-f6e77357c207'
        )
      `),
    ).rejects.toThrow();

    await database.exec(`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c219', 'tenant', '${tenantId}',
        'tenant_staff', '018f2f45-7f5e-7e70-b17f-f6e77357c207',
        'POST /v1/content/dramas', 'create-drama-command-1', '${'d'.repeat(64)}',
        statement_timestamp() + interval '1 day'
      );
      update command_idempotency
      set status = 'completed', locked_at = null, response_status = 201,
          response_json = '{"id":"${dramaId}"}'::jsonb,
          resource_type = 'drama', resource_id = '${dramaId}'
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c219';
    `);
    await expect(
      database.exec(`
        insert into command_idempotency (
          id, scope_type, tenant_id, actor_type, actor_id, route_key,
          idempotency_key, request_hash, expires_at
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c21a', 'tenant', '${tenantId}',
          'tenant_staff', '018f2f45-7f5e-7e70-b17f-f6e77357c207',
          'POST /v1/content/dramas', 'create-drama-command-1', '${'e'.repeat(64)}',
          statement_timestamp() + interval '1 day'
        )
      `),
    ).rejects.toThrow();
    await expect(
      database.exec(`
        insert into command_idempotency (
          id, scope_type, tenant_id, actor_type, actor_id, route_key,
          idempotency_key, request_hash, locked_at, expires_at
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c21b', 'tenant', '${tenantId}',
          'tenant_staff', '018f2f45-7f5e-7e70-b17f-f6e77357c207',
          'POST /v1/content/reviews', 'submit-review-command', '${'f'.repeat(64)}',
          null, statement_timestamp() + interval '1 day'
        )
      `),
    ).rejects.toThrow();

    await database.exec(`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c210', 'tenant', '${tenantId}',
        'event:content-check-1', 'content-check-idempotency', 'drama', '${dramaId}',
        'ContentDraftCreated', '{"dramaId":"${dramaId}"}'::jsonb
      );
    `);
    await expect(
      database.exec(`
        insert into outbox_events (
          id, scope_type, tenant_id, event_key, idempotency_key,
          aggregate_type, aggregate_id, event_type, payload_json
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c211', 'tenant', '${tenantId}',
          'event:content-check-2', 'content-check-idempotency', 'drama', '${dramaId}',
          'ContentDraftCreated', '{}'::jsonb
        )
      `),
    ).rejects.toThrow();

    await expect(
      database.exec(`
        insert into outbox_consumptions (
          id, scope_type, tenant_id, event_id, consumer_name, idempotency_key
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c214', 'tenant', '${tenantId}',
          '018f2f45-7f5e-7e70-b17f-f6e77357c210',
          'content.projector', 'content-consumption-lock'
        )
      `),
    ).rejects.toThrow();

    await expect(
      database.exec(`
        insert into outbox_consumptions (
          id, scope_type, event_id, consumer_name, idempotency_key,
          status, completed_at
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c215', 'platform',
          '018f2f45-7f5e-7e70-b17f-f6e77357c210',
          'content.projector', 'content-consumption-scope',
          'completed', statement_timestamp()
        )
      `),
    ).rejects.toThrow();
  });

  it('isolates tenant content while a registered platform role can review all', async () => {
    const tenantA = '018f2f45-7f5e-7e70-b17f-f6e77357c220';
    const tenantB = '018f2f45-7f5e-7e70-b17f-f6e77357c221';
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantA}', 'rls-content-a', 'RLS content A', now() + interval '1 year'),
        ('${tenantB}', 'rls-content-b', 'RLS content B', now() + interval '1 year');
      insert into media_assets (
        id, owner_type, kind, source_url, checksum,
        status, transcode_status, metadata_json
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c22e', 'platform', 'image',
        'https://media.example.com/platform-cover.jpg', '${'c'.repeat(64)}',
        'ready', 'not_required', '{"immutable":true}'::jsonb
      );
      insert into dramas (id, owner_type, owner_tenant_id, code, cover_file_id) values
        ('018f2f45-7f5e-7e70-b17f-f6e77357c222', 'tenant', '${tenantA}', 'rls-drama-a', null),
        ('018f2f45-7f5e-7e70-b17f-f6e77357c223', 'tenant', '${tenantB}', 'rls-drama-b', null),
        (
          '018f2f45-7f5e-7e70-b17f-f6e77357c228', 'platform', null,
          'licensed-platform-drama', '018f2f45-7f5e-7e70-b17f-f6e77357c22e'
        );
      insert into platform_staff (id, username, password_hash)
      values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c227',
        'content-license-reviewer', '${'p'.repeat(64)}'
      );
      insert into content_licenses (
        id, tenant_id, license_type, drama_id, starts_at, expires_at,
        status, granted_by
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c229', '${tenantA}', 'drama',
        '018f2f45-7f5e-7e70-b17f-f6e77357c228', now() - interval '1 hour',
        now() + interval '1 day', 'active', '018f2f45-7f5e-7e70-b17f-f6e77357c227'
      );
      insert into content_license_items (id, tenant_id, license_id, drama_id)
      values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c22a', '${tenantA}',
        '018f2f45-7f5e-7e70-b17f-f6e77357c229',
        '018f2f45-7f5e-7e70-b17f-f6e77357c228'
      );
      insert into tenant_staff (id, tenant_id, username, password_hash)
      values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c22b', '${tenantA}',
        'rls-content-reviewer', '${'p'.repeat(64)}'
      ), (
        '018f2f45-7f5e-7e70-b17f-f6e77357c232', '${tenantB}',
        'rls-content-reviewer-b', '${'p'.repeat(64)}'
      );
      insert into categories (id, owner_type, owner_tenant_id, code) values
        ('018f2f45-7f5e-7e70-b17f-f6e77357c233', 'tenant', '${tenantA}', 'rls-category-a'),
        ('018f2f45-7f5e-7e70-b17f-f6e77357c234', 'tenant', '${tenantB}', 'rls-category-b');
      insert into tags (id, owner_type, owner_tenant_id, code) values
        ('018f2f45-7f5e-7e70-b17f-f6e77357c235', 'tenant', '${tenantA}', 'rls-tag-a'),
        ('018f2f45-7f5e-7e70-b17f-f6e77357c236', 'tenant', '${tenantB}', 'rls-tag-b');
      insert into content_import_jobs (id, tenant_id, format, idempotency_key,
        inline_payload_hash, requested_rows, payload_bytes, created_by) values
        ('018f2f45-7f5e-7e70-b17f-f6e77357c237', '${tenantA}', 'json',
          'rls-import-job-a', '${'3'.repeat(64)}', 1, 2,
          '018f2f45-7f5e-7e70-b17f-f6e77357c22b'),
        ('018f2f45-7f5e-7e70-b17f-f6e77357c238', '${tenantB}', 'json',
          'rls-import-job-b', '${'4'.repeat(64)}', 1, 2,
          '018f2f45-7f5e-7e70-b17f-f6e77357c232');
      insert into content_import_rows (id, tenant_id, job_id, row_number, raw_json) values
        ('018f2f45-7f5e-7e70-b17f-f6e77357c239', '${tenantA}',
          '018f2f45-7f5e-7e70-b17f-f6e77357c237', 1, '{}'::jsonb),
        ('018f2f45-7f5e-7e70-b17f-f6e77357c23a', '${tenantB}',
          '018f2f45-7f5e-7e70-b17f-f6e77357c238', 1, '{}'::jsonb);
      insert into content_versions (
        id, scope_type, tenant_id, aggregate_type, aggregate_id,
        version_no, snapshot_json, change_level, created_by
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c22c', 'tenant', '${tenantA}',
        'drama', '018f2f45-7f5e-7e70-b17f-f6e77357c222', 1, '{}'::jsonb,
        'critical', '018f2f45-7f5e-7e70-b17f-f6e77357c22b'
      );
      insert into review_requests (
        id, tenant_id, target_type, target_id, content_version_id, submitted_by
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c22d', '${tenantA}', 'drama',
        '018f2f45-7f5e-7e70-b17f-f6e77357c222',
        '018f2f45-7f5e-7e70-b17f-f6e77357c22c',
        '018f2f45-7f5e-7e70-b17f-f6e77357c22b'
      );
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e77357c230', 'tenant', '${tenantA}',
        'tenant_staff', '018f2f45-7f5e-7e70-b17f-f6e77357c22b',
        'POST /v1/content/dramas', 'rls-command-tenant-a', '${'1'.repeat(64)}',
        statement_timestamp() + interval '1 day'
      );
      create role content_tenant_probe nosuperuser nobypassrls;
      create role content_platform_probe nosuperuser nobypassrls;
      grant usage on schema app, public to content_tenant_probe, content_platform_probe;
      grant select, insert on dramas to content_tenant_probe;
      grant select on media_assets to content_tenant_probe;
      grant select, insert on command_idempotency to content_tenant_probe;
      grant select, insert, update on categories, tags to content_tenant_probe;
      grant select, insert, update on content_import_jobs, content_import_rows to content_tenant_probe;
      grant insert on content_schedule_jobs to content_tenant_probe;
      grant select, update on review_requests to content_tenant_probe;
      grant select on command_idempotency, dramas, review_requests to content_platform_probe;
      insert into app.database_access_principals (role_name, access_scope)
      values ('content_platform_probe', 'platform');
    `);

    await expect(
      database.exec(`
        update content_versions set snapshot_json = '{"tampered":true}'::jsonb
        where id = '018f2f45-7f5e-7e70-b17f-f6e77357c22c'
      `),
    ).rejects.toThrow(/append-only/);
    await expect(
      database.exec(`
        delete from content_versions
        where id = '018f2f45-7f5e-7e70-b17f-f6e77357c22c'
      `),
    ).rejects.toThrow(/append-only/);

    await database.exec(`
      set role content_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    const tenantRows = await database.query<{ code: string }>(`
      select code::text as code from dramas order by code
    `);
    expect(tenantRows.rows).toEqual([
      { code: 'licensed-platform-drama' },
      { code: 'rls-drama-a' },
    ]);
    const licensedMedia = await database.query<{ id: string }>(`
      select id from media_assets
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c22e'
    `);
    expect(licensedMedia.rows).toEqual([
      { id: '018f2f45-7f5e-7e70-b17f-f6e77357c22e' },
    ]);
    const tenantCommands = await database.query<{ id: string }>(`
      select id from command_idempotency
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c230'
    `);
    expect(tenantCommands.rows).toEqual([
      { id: '018f2f45-7f5e-7e70-b17f-f6e77357c230' },
    ]);
    const tenantContentManagementRows = await database.query<{ categories: string; imports: string; tags: string }>(`
      select (select count(*)::text from categories) as categories,
        (select count(*)::text from tags) as tags,
        (select count(*)::text from content_import_jobs) as imports
    `);
    expect(tenantContentManagementRows.rows).toEqual([
      { categories: '1', imports: '1', tags: '1' },
    ]);
    await expect(
      database.exec(`
        insert into dramas (id, owner_type, owner_tenant_id, code)
        values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c226',
          'tenant', '${tenantA}', 'own-tenant-write'
        )
      `),
    ).resolves.not.toThrow();
    await database.exec('rollback; reset role');

    await database.exec(`set role content_tenant_probe; begin;
      set local app.tenant_id = '${tenantA}'`);
    await expect(database.exec(`insert into categories (id, owner_type, owner_tenant_id, code)
      values ('018f2f45-7f5e-7e70-b17f-f6e77357c23b', 'tenant', '${tenantB}',
        'rls-cross-category')`)).rejects.toThrow();
    await database.exec('rollback; reset role');

    await database.exec(`
      set role content_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantB}'
    `);
    const unlicensedRows = await database.query<{ code: string }>(`
      select code::text as code from dramas order by code
    `);
    expect(unlicensedRows.rows).toEqual([{ code: 'rls-drama-b' }]);
    const unlicensedMedia = await database.query<{ id: string }>(`
      select id from media_assets
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c22e'
    `);
    expect(unlicensedMedia.rows).toHaveLength(0);
    const otherTenantCommands = await database.query<{ id: string }>(`
      select id from command_idempotency
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c230'
    `);
    expect(otherTenantCommands.rows).toHaveLength(0);
    await database.exec('rollback; reset role');

    await database.exec(`
      set role content_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    await expect(
      database.exec(`
        update review_requests
        set status = 'withdrawn', version = version + 1
        where id = '018f2f45-7f5e-7e70-b17f-f6e77357c22d'
      `),
    ).resolves.not.toThrow();
    await database.exec('rollback; reset role');

    await database.exec(`
      set role content_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    await expect(
      database.exec(`
        update review_requests
        set status = 'approved', reviewed_at = statement_timestamp(),
            reviewer_id = '018f2f45-7f5e-7e70-b17f-f6e77357c227',
            version = version + 1
        where id = '018f2f45-7f5e-7e70-b17f-f6e77357c22d'
      `),
    ).rejects.toThrow();
    await database.exec('rollback; reset role');

    await database.exec(`
      set role content_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    await expect(
      database.exec(`
        insert into dramas (id, owner_type, owner_tenant_id, code)
        values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c224',
          'tenant', '${tenantB}', 'cross-tenant-write'
        )
      `),
    ).rejects.toThrow();
    await database.exec('rollback; reset role');

    await database.exec(`
      set role content_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    await expect(
      database.exec(`
        insert into content_schedule_jobs (
          id, scope_type, tenant_id, target_type, target_id, action,
          scheduled_at, idempotency_key
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c225', 'tenant', '${tenantA}',
          'drama', '018f2f45-7f5e-7e70-b17f-f6e77357c223', 'publish',
          now() + interval '1 day', 'cross-target-check'
        )
      `),
    ).rejects.toThrow();
    await database.exec('rollback; reset role');

    await database.exec(`
      set role content_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    await expect(
      database.exec(`
        insert into command_idempotency (
          id, scope_type, tenant_id, actor_type, actor_id, route_key,
          idempotency_key, request_hash, expires_at
        ) values (
          '018f2f45-7f5e-7e70-b17f-f6e77357c231', 'tenant', '${tenantB}',
          'tenant_staff', '018f2f45-7f5e-7e70-b17f-f6e77357c22b',
          'POST /v1/content/dramas', 'cross-tenant-command', '${'2'.repeat(64)}',
          statement_timestamp() + interval '1 day'
        )
      `),
    ).rejects.toThrow();
    await database.exec('rollback; reset role');

    await database.exec('set role content_platform_probe');
    const platformRows = await database.query<{ code: string }>(`
      select code::text as code from dramas
      where code in ('rls-drama-a', 'rls-drama-b')
      order by code
    `);
    await database.exec('reset role');
    expect(platformRows.rows).toEqual([
      { code: 'rls-drama-a' },
      { code: 'rls-drama-b' },
    ]);

    await database.exec('set role content_platform_probe');
    const platformCommands = await database.query<{ id: string }>(`
      select id from command_idempotency
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c230'
    `);
    await database.exec('reset role');
    expect(platformCommands.rows).toEqual([
      { id: '018f2f45-7f5e-7e70-b17f-f6e77357c230' },
    ]);

    await database.exec('set role content_platform_probe');
    const platformReviews = await database.query<{ id: string }>(`
      select id from review_requests
      where id = '018f2f45-7f5e-7e70-b17f-f6e77357c22d'
    `);
    await database.exec('reset role');
    expect(platformReviews.rows).toEqual([
      { id: '018f2f45-7f5e-7e70-b17f-f6e77357c22d' },
    ]);
  });
});
