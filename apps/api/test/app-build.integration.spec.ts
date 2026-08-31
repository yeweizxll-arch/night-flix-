import { PGlite, type Transaction } from '@electric-sql/pglite';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';

import { AppBuildService } from '../src/app-builds/app-build.service';
import { AppBuildAssetService } from '../src/app-builds/app-build-asset.service';
import {
  AppBuildExecutionError,
  DisabledAppBuildExecutor,
  type AppBuildExecutor,
} from '../src/app-builds/app-build-executor';
import { AppBuildWorkerService } from '../src/app-builds/app-build-worker.service';
import { uuidV7 } from '../src/common/uuid-v7';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import type { S3CompatibleStorageAdapter } from '../src/storage/s3-compatible.adapter';
import type { StorageCredentialCipher } from '../src/storage/storage-credentials';

let database: PGlite;
let service: AppBuildService;
let assetService: AppBuildAssetService;
let databaseService: DatabaseService;
let storageAdapter: {
  headObject: ReturnType<typeof vi.fn>;
  presignConditionalPut: ReturnType<typeof vi.fn>;
  presignGetObject: ReturnType<typeof vi.fn>;
};

const actorId = '018f2f45-7f5e-7e70-b17f-f6e7735b0101';
const tenantA = '018f2f45-7f5e-7e70-b17f-f6e7735b0102';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e7735b0103';
const domainActiveA = '018f2f45-7f5e-7e70-b17f-f6e7735b0104';
const domainPendingA = '018f2f45-7f5e-7e70-b17f-f6e7735b0105';
const domainActiveB = '018f2f45-7f5e-7e70-b17f-f6e7735b0106';
const providerA = '018f2f45-7f5e-7e70-b17f-f6e7735b0107';
const providerB = '018f2f45-7f5e-7e70-b17f-f6e7735b0108';
const platformArtifactProvider = '018f2f45-7f5e-7e70-b17f-f6e7735b010c';
const iconA = '018f2f45-7f5e-7e70-b17f-f6e7735b0109';
const splashA = '018f2f45-7f5e-7e70-b17f-f6e7735b010a';
const iconB = '018f2f45-7f5e-7e70-b17f-f6e7735b010b';

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}

function metadata(key: string) {
  return {
    actorId,
    idempotencyKey: key,
    ip: '203.0.113.84',
    requestId: uuidV7(),
  };
}

describe('platform tenant app-build workflow', () => {
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
      values ('${actorId}', 'app-builder-admin', '${'p'.repeat(64)}');
      insert into tenants (id, code, name, site_name, expires_at) values
        ('${tenantA}', 'build-a', 'Build A', 'Build A Video', statement_timestamp() + interval '1 year'),
        ('${tenantB}', 'build-b', 'Build B', 'Build B Video', statement_timestamp() + interval '1 year');
      insert into tenant_domains (
        id, tenant_id, host, type, verification_token, verified_at, tls_status, is_primary
      ) values
        ('${domainActiveA}', '${tenantA}', 'a.apps.example.test', 'subdomain',
          '${'a'.repeat(24)}', statement_timestamp(), 'active', true),
        ('${domainPendingA}', '${tenantA}', 'pending-a.apps.example.test', 'subdomain',
          '${'b'.repeat(24)}', statement_timestamp(), 'pending', false),
        ('${domainActiveB}', '${tenantB}', 'b.apps.example.test', 'subdomain',
          '${'c'.repeat(24)}', statement_timestamp(), 'active', true);
      insert into storage_providers (
        id, owner_type, owner_tenant_id, provider, account_label, bucket,
        credential_ciphertext, status
      ) values
        ('${providerA}', 'tenant', '${tenantA}', 's3', 'app-assets-a',
          'app-assets-a-bucket', '${'x'.repeat(64)}', 'active'),
        ('${providerB}', 'tenant', '${tenantB}', 's3', 'app-assets-b',
          'app-assets-b-bucket', '${'y'.repeat(64)}', 'active'),
        ('${platformArtifactProvider}', 'platform', null, 's3', 'app-build-artifacts',
          'app-build-artifacts-bucket', '${'z'.repeat(64)}', 'active');
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, storage_provider_id, object_key,
        mime_type, size_bytes, checksum, status, transcode_status
      ) values
        ('${iconA}', 'tenant', '${tenantA}', 'image', '${providerA}',
          'app-assets/icon-a.png', 'image/png', 4096, 'sha256:${'a'.repeat(64)}',
          'ready', 'not_required'),
        ('${splashA}', 'tenant', '${tenantA}', 'image', '${providerA}',
          'app-assets/splash-a.webp', 'image/webp', 8192, 'sha256:${'b'.repeat(64)}',
          'ready', 'not_required'),
        ('${iconB}', 'tenant', '${tenantB}', 'image', '${providerB}',
          'app-assets/icon-b.png', 'image/png', 4096, 'sha256:${'c'.repeat(64)}',
          'ready', 'not_required');
      update media_assets set metadata_json =
        '{"appBuildAsset":{"purpose":"app_icon","width":1024,"height":1024,"hasAlpha":false}}'
        where id in ('${iconA}', '${iconB}');
      update media_assets set metadata_json =
        '{"appBuildAsset":{"purpose":"launch_image","width":1920,"height":1080,"hasAlpha":false}}'
        where id = '${splashA}';
      insert into app_build_worker_heartbeats (
        worker_id, artifact_storage_provider_id, capabilities
      ) values (
        'app-build-integration-worker', '${platformArtifactProvider}',
        array['android_debug', 'ios_simulator']
      );
    `);
    databaseService = {
      inPlatformContext: <T>(callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
    } as unknown as DatabaseService;
    service = new AppBuildService(databaseService);
    storageAdapter = {
      headObject: vi.fn(),
      presignConditionalPut: vi.fn(async (input: {
        checksumSha256Base64: string; contentLength: number; contentType: string; uploadId: string;
      }) => ({
        contentLengthRequiresHeadVerification: true,
        expiresAt: new Date(Date.now() + 600_000),
        requiredHeaders: {
          'content-length': String(input.contentLength),
          'content-type': input.contentType,
          'if-none-match': '*',
          'x-amz-checksum-sha256': input.checksumSha256Base64,
          'x-amz-meta-upload-id': input.uploadId,
        },
        signedHeaders: ['content-length', 'content-type', 'if-none-match',
          'x-amz-checksum-sha256', 'x-amz-meta-upload-id'],
        url: 'https://objects.example.test/build-asset-put',
      })),
      presignGetObject: vi.fn(async () => ({
        cacheControl: 'private, no-store, max-age=0',
        contentDisposition: 'inline',
        expiresAt: new Date(Date.now() + 180_000),
        url: 'https://objects.example.test/build-asset-get',
      })),
    };
    assetService = new AppBuildAssetService(
      databaseService,
      { decrypt: vi.fn(() => ({
        accessKeyId: 'access-key', region: 'us-east-1', secretAccessKey: 'secret-key-value',
      })) } as unknown as StorageCredentialCipher,
      storageAdapter as unknown as S3CompatibleStorageAdapter,
    );
  }, 30_000);

  afterAll(async () => {
    vi.unstubAllGlobals();
    await database?.close();
  });

  it('returns bounded safe prerequisites without storage locations', async () => {
    const result = await service.getPrerequisites(tenantA);
    expect(result.effectiveSiteEnabled).toBe(true);
    expect(result.assetProviders).toEqual(expect.arrayContaining([
      { id: providerA, label: 'app-assets-a', ownerType: 'tenant' },
      { id: platformArtifactProvider, label: 'app-build-artifacts', ownerType: 'platform' },
    ]));
    expect(result.domains).toEqual(expect.arrayContaining([
      expect.objectContaining({ eligible: true, host: 'a.apps.example.test' }),
      expect.objectContaining({ eligible: false, reasons: ['tls_not_active'] }),
    ]));
    expect(result.assets.items).toHaveLength(2);
    expect(result.targets.androidDebug.available).toBe(true);
    expect(result.targets.androidStore).toEqual({
      available: false, reason: 'signing_not_configured',
    });
    expect(JSON.stringify(result)).not.toContain('object_key');
    expect(JSON.stringify(result)).not.toContain('credential');
  });

  it('lets platform staff create a tenant-owned build asset only after real image probing', async () => {
    const icon = await sharp({
      create: { background: '#2563eb', channels: 3, height: 1024, width: 1024 },
    }).png().toBuffer();
    const checksum = createHash('sha256').update(icon).digest('hex');
    const created = await assetService.create(tenantA, {
      checksumSha256: checksum,
      contentType: 'image/png',
      providerId: platformArtifactProvider,
      purpose: 'app_icon',
      sizeBytes: icon.length,
    }, metadata('app-build-asset-create-0001'));
    storageAdapter.headObject.mockResolvedValueOnce({
      checksumSha256Base64: Buffer.from(checksum, 'hex').toString('base64'),
      contentLength: icon.length,
      contentType: 'image/png',
      etag: 'build-asset-etag',
      exists: true,
      objectKey: 'server-trusted-object-key',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(icon, { status: 200 })));
    const completed = await assetService.complete(
      tenantA, created.id, metadata('app-build-asset-complete-0002'),
    );
    expect(completed).toMatchObject({
      hasAlpha: false,
      height: 1024,
      id: created.id,
      purpose: 'app_icon',
      status: 'ready',
      width: 1024,
    });
    const facts = await database.query<{
      created_by: string; metadata_json: Record<string, unknown>; owner_tenant_id: string;
      owner_type: string; status: string;
    }>(`select owner_type, owner_tenant_id, status, created_by, metadata_json
        from media_assets where id = '${created.id}'`);
    expect(facts.rows[0]).toMatchObject({
      created_by: actorId,
      owner_tenant_id: tenantA,
      owner_type: 'tenant',
      status: 'ready',
    });
    expect(facts.rows[0]?.metadata_json).toMatchObject({
      appBuildAsset: {
        hasAlpha: false, height: 1024, purpose: 'app_icon', width: 1024,
      },
    });
    expect(JSON.stringify(completed)).not.toContain('objectKey');
    expect(JSON.stringify(completed)).not.toContain('uploadUrl');
    const prerequisites = await service.getPrerequisites(tenantA);
    expect(prerequisites.assets.items).toContainEqual(expect.objectContaining({
      buildReady: true, iconCandidate: true, id: created.id, purpose: 'app_icon',
    }));
  });

  it('keeps invalid or cross-tenant build assets out of profiles', async () => {
    await expect(assetService.create(tenantA, {
      checksumSha256: 'f'.repeat(64),
      contentType: 'image/png',
      providerId: providerB,
      purpose: 'app_icon',
      sizeBytes: 1024,
    }, metadata('app-build-asset-cross-provider-0003'))).rejects.toBeInstanceOf(NotFoundException);

    const alphaIcon = await sharp({
      create: {
        background: { alpha: 0.5, b: 3, g: 2, r: 1 },
        channels: 4, height: 1024, width: 1024,
      },
    }).png().toBuffer();
    const checksum = createHash('sha256').update(alphaIcon).digest('hex');
    const created = await assetService.create(tenantA, {
      checksumSha256: checksum,
      contentType: 'image/png',
      providerId: providerA,
      purpose: 'app_icon',
      sizeBytes: alphaIcon.length,
    }, metadata('app-build-asset-alpha-create-0004'));
    storageAdapter.headObject.mockResolvedValueOnce({
      checksumSha256Base64: Buffer.from(checksum, 'hex').toString('base64'),
      contentLength: alphaIcon.length,
      contentType: 'image/png',
      etag: 'alpha-etag',
      exists: true,
      objectKey: 'server-trusted-object-key',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(alphaIcon, { status: 200 })));
    await expect(assetService.complete(
      tenantA, created.id, metadata('app-build-asset-alpha-complete-0005'),
    )).rejects.toBeInstanceOf(BadRequestException);
    const row = await database.query<{ status: string }>(
      `select status from media_assets where id = '${created.id}'`,
    );
    expect(row.rows[0]?.status).toBe('uploading');
  });

  it('creates a versioned profile idempotently and rejects unsafe tenant boundaries', async () => {
    const input = {
      androidApplicationId: 'com.example.builda',
      appName: 'Build A App',
      expectedVersion: null,
      h5DomainId: domainActiveA,
      iconMediaAssetId: iconA,
      iosBundleId: 'com.example.builda',
      splashMediaAssetId: splashA,
    };
    const key = 'app-profile-create-0001';
    const profile = await service.upsertProfile(tenantA, input, metadata(key));
    const replay = await service.upsertProfile(tenantA, input, metadata(key));
    expect(replay).toEqual(profile);
    expect(profile.h5Host).toBe('a.apps.example.test');
    await expect(service.upsertProfile(tenantA, {
      ...input, expectedVersion: profile.version, h5DomainId: domainPendingA,
    }, metadata('app-profile-pending-domain-0002'))).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.upsertProfile(tenantA, {
      ...input, expectedVersion: profile.version, iconMediaAssetId: iconB,
    }, metadata('app-profile-cross-media-0003'))).rejects.toBeInstanceOf(BadRequestException);
  });

  it('advertises only workers with an active platform artifact provider and removes heartbeats',
    async () => {
      const previousProvider = process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID;
      const worker = new AppBuildWorkerService(databaseService, new DisabledAppBuildExecutor());
      try {
        process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID = platformArtifactProvider;
        await worker.registerHeartbeat(['ios_simulator', 'android_debug'], 'heartbeat-worker-1');
        const registered = await database.query<{ capabilities: string[] }>(`
          select capabilities from app_build_worker_heartbeats
          where worker_id = 'heartbeat-worker-1'
        `);
        expect(registered.rows[0]?.capabilities).toEqual(['android_debug', 'ios_simulator']);
        await worker.unregisterHeartbeat('heartbeat-worker-1');
        const removed = await database.query<{ count: string }>(`
          select count(*)::text as count from app_build_worker_heartbeats
          where worker_id = 'heartbeat-worker-1'
        `);
        expect(removed.rows[0]?.count).toBe('0');

        process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID = providerB;
        await expect(worker.registerHeartbeat(['android_debug'], 'heartbeat-worker-2'))
          .rejects.toThrow('active platform S3 provider');
      } finally {
        if (previousProvider === undefined) {
          delete process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID;
        } else {
          process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID = previousProvider;
        }
      }
    });

  it('refuses to queue work when the compatible builder heartbeat is stale', async () => {
    const profile = (await service.getProfile(tenantA)).profile!;
    await database.exec(`
      update app_build_worker_heartbeats
      set started_at = statement_timestamp() - interval '1 minute',
        last_seen_at = statement_timestamp() - interval '31 seconds'
      where worker_id = 'app-build-integration-worker'
    `);
    try {
      const prerequisites = await service.getPrerequisites(tenantA);
      expect(prerequisites.targets.androidDebug).toEqual({
        available: false, reason: 'builder_unavailable',
      });
      await expect(service.createJob(tenantA, {
        expectedProfileVersion: profile.version,
        target: 'android_debug',
      }, metadata('app-build-offline-worker-0001'))).rejects.toBeInstanceOf(ConflictException);
    } finally {
      await database.exec(`
        update app_build_worker_heartbeats set
          started_at = statement_timestamp(), last_seen_at = statement_timestamp()
        where worker_id = 'app-build-integration-worker'
      `);
    }
  });

  it('queues an immutable tenant-bound snapshot idempotently and supports queued cancellation', async () => {
    const profile = (await service.getProfile(tenantA)).profile!;
    const input = { expectedProfileVersion: profile.version, target: 'android_debug' as const };
    const key = 'app-build-create-0001';
    const job = await service.createJob(tenantA, input, metadata(key));
    const replay = await service.createJob(tenantA, input, metadata(key));
    expect(replay.id).toBe(job.id);
    expect(job.status).toBe('queued');
    await expect(service.getJob(tenantB, job.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.createJob(tenantA, {
      ...input, expectedProfileVersion: profile.version + 1,
    }, metadata('app-build-stale-profile-0002'))).rejects.toBeInstanceOf(ConflictException);

    const cancelled = await service.cancelJob(
      tenantA, job.id, { expectedVersion: job.version }, metadata('app-build-cancel-0003'),
    );
    expect(cancelled.status).toBe('cancelled');
    await expect(service.cancelJob(
      tenantA, job.id, { expectedVersion: cancelled.version }, metadata('app-build-cancel-0004'),
    )).rejects.toBeInstanceOf(ConflictException);

    const facts = await database.query<{
      audit_count: string; event_count: string; snapshot: Record<string, unknown>;
    }>(`
      select
        (select count(*)::text from audit_logs where action like 'platform.app_build.%') as audit_count,
        (select count(*)::text from outbox_events where event_type like 'AppBuild%') as event_count,
        (select snapshot_json from tenant_app_build_jobs where id = '${job.id}') as snapshot
    `);
    expect(Number(facts.rows[0]?.audit_count)).toBeGreaterThanOrEqual(3);
    expect(Number(facts.rows[0]?.event_count)).toBeGreaterThanOrEqual(3);
    expect(facts.rows[0]?.snapshot).toMatchObject({
      h5Origin: 'https://a.apps.example.test', tenantId: tenantA,
    });
  });

  it('does not let an Android-only worker claim an iOS Simulator job', async () => {
    const profile = (await service.getProfile(tenantA)).profile!;
    const job = await service.createJob(tenantA, {
      expectedProfileVersion: profile.version,
      target: 'ios_simulator',
    }, metadata('app-build-capability-isolation-0001'));
    const previousEnabled = process.env.APP_BUILD_WORKER_ENABLED;
    const previousProvider = process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID;
    process.env.APP_BUILD_WORKER_ENABLED = 'true';
    process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID = platformArtifactProvider;
    const worker = new AppBuildWorkerService(databaseService, new DisabledAppBuildExecutor());
    try {
      await worker.registerHeartbeat(['android_debug'], 'android-only-worker');
      await expect(worker.processAvailable(1, 'android-only-worker')).resolves.toEqual({
        claimed: 0,
      });
      await expect(service.getJob(tenantA, job.id)).resolves.toMatchObject({ status: 'queued' });
      await service.cancelJob(
        tenantA, job.id, { expectedVersion: job.version },
        metadata('app-build-capability-cancel-0002'),
      );
    } finally {
      await worker.unregisterHeartbeat('android-only-worker');
      if (previousEnabled === undefined) delete process.env.APP_BUILD_WORKER_ENABLED;
      else process.env.APP_BUILD_WORKER_ENABLED = previousEnabled;
      if (previousProvider === undefined) delete process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID;
      else process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID = previousProvider;
    }
  });

  it('keeps app profiles and build facts invisible to a tenant database role', async () => {
    await database.exec(`
      create role app_build_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to app_build_tenant_probe;
      grant execute on function app.has_platform_access(name) to app_build_tenant_probe;
      grant select on tenant_app_build_profiles, tenant_app_build_jobs to app_build_tenant_probe;
      begin;
      set role app_build_tenant_probe;
      set local app.tenant_id = '${tenantA}';
    `);
    const profiles = await database.query('select id from tenant_app_build_profiles');
    const jobs = await database.query('select id from tenant_app_build_jobs');
    expect(profiles.rows).toHaveLength(0);
    expect(jobs.rows).toHaveLength(0);
    await database.exec('rollback; reset role');
  });

  it('claims outside work, accepts only a validated platform artifact, and records success', async () => {
    const profile = (await service.getProfile(tenantA)).profile!;
    const job = await service.createJob(tenantA, {
      expectedProfileVersion: profile.version,
      target: 'android_debug',
    }, metadata('app-build-worker-success-0001'));
    let executions = 0;
    const executor: AppBuildExecutor = {
      execute: async (input) => {
        executions += 1;
        expect(input.jobId).toBe(job.id);
        expect(input.snapshot).toMatchObject({ tenantId: tenantA });
        return {
          checksum: `sha256:${'d'.repeat(64)}`,
          contentType: 'application/vnd.android.package-archive',
          filename: 'build-a-debug.apk',
          objectKey: `app-builds/${tenantA}/${job.id}/build-a-debug.apk`,
          sizeBytes: 12_345n,
          storageProviderId: platformArtifactProvider,
        };
      },
    };
    const previousEnabled = process.env.APP_BUILD_WORKER_ENABLED;
    const previousProvider = process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID;
    process.env.APP_BUILD_WORKER_ENABLED = 'true';
    process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID = platformArtifactProvider;
    const worker = new AppBuildWorkerService(databaseService, executor);
    try {
      await worker.registerHeartbeat(['android_debug'], 'test-builder-1');
      await expect(worker.processAvailable(1, 'test-builder-1')).resolves.toEqual({ claimed: 1 });
    } finally {
      await worker.unregisterHeartbeat('test-builder-1');
      if (previousEnabled === undefined) delete process.env.APP_BUILD_WORKER_ENABLED;
      else process.env.APP_BUILD_WORKER_ENABLED = previousEnabled;
      if (previousProvider === undefined) delete process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID;
      else process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID = previousProvider;
    }
    expect(executions).toBe(1);
    const result = await service.getJob(tenantA, job.id);
    expect(result).toMatchObject({
      artifact: {
        contentType: 'application/vnd.android.package-archive',
        filename: 'build-a-debug.apk',
        sizeBytes: '12345',
      },
      status: 'succeeded',
    });
    expect(result.failureCode).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('artifact_object_key');
    expect(JSON.stringify(result)).not.toContain('app-build-artifacts-bucket');
  });

  it('maps unavailable and malformed executor results to fixed safe failure codes', async () => {
    const profile = (await service.getProfile(tenantA)).profile!;
    const unavailable = await service.createJob(tenantA, {
      expectedProfileVersion: profile.version,
      target: 'ios_simulator',
    }, metadata('app-build-worker-disabled-0002'));
    const malformed = await service.createJob(tenantA, {
      expectedProfileVersion: profile.version,
      target: 'android_debug',
    }, metadata('app-build-worker-malformed-0003'));
    const previousEnabled = process.env.APP_BUILD_WORKER_ENABLED;
    const previousProvider = process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID;
    process.env.APP_BUILD_WORKER_ENABLED = 'true';
    process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID = platformArtifactProvider;
    const unavailableWorker = new AppBuildWorkerService(
      databaseService, new DisabledAppBuildExecutor(),
    );
    const malformedExecutor: AppBuildExecutor = {
      execute: async () => ({
        checksum: `sha256:${'e'.repeat(64)}`,
        contentType: 'application/vnd.android.package-archive',
        filename: 'escape.apk',
        objectKey: `app-builds/${tenantB}/${malformed.id}/escape.apk`,
        sizeBytes: 1n,
        storageProviderId: platformArtifactProvider,
      }),
    };
    const malformedWorker = new AppBuildWorkerService(databaseService, malformedExecutor);
    try {
      await unavailableWorker.registerHeartbeat(['ios_simulator'], 'test-builder-2');
      await unavailableWorker.processAvailable(1, 'test-builder-2');
      await malformedWorker.registerHeartbeat(['android_debug'], 'test-builder-3');
      await malformedWorker.processAvailable(1, 'test-builder-3');
    } finally {
      await unavailableWorker.unregisterHeartbeat('test-builder-2');
      await malformedWorker.unregisterHeartbeat('test-builder-3');
      if (previousEnabled === undefined) delete process.env.APP_BUILD_WORKER_ENABLED;
      else process.env.APP_BUILD_WORKER_ENABLED = previousEnabled;
      if (previousProvider === undefined) delete process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID;
      else process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID = previousProvider;
    }
    await expect(service.getJob(tenantA, unavailable.id)).resolves.toMatchObject({
      failureCode: 'builder_unavailable', status: 'failed',
    });
    await expect(service.getJob(tenantA, malformed.id)).resolves.toMatchObject({
      failureCode: 'artifact_upload_failed', status: 'failed',
    });
  });

  it('recovers stale leases without rerunning exhausted jobs', async () => {
    const profile = (await service.getProfile(tenantA)).profile!;
    const retryable = await service.createJob(tenantA, {
      expectedProfileVersion: profile.version,
      target: 'android_debug',
    }, metadata('app-build-worker-recover-0004'));
    const exhausted = await service.createJob(tenantA, {
      expectedProfileVersion: profile.version,
      target: 'ios_simulator',
    }, metadata('app-build-worker-exhaust-0005'));
    await database.exec(`
      update tenant_app_build_jobs set status = 'processing', attempts = 1,
        locked_at = statement_timestamp() - interval '31 minutes',
        locked_by = 'dead-worker', started_at = statement_timestamp(), version = version + 1
      where id = '${retryable.id}';
      update tenant_app_build_jobs set status = 'processing', attempts = max_attempts,
        locked_at = statement_timestamp() - interval '31 minutes',
        locked_by = 'dead-worker', started_at = statement_timestamp(), version = version + 1
      where id = '${exhausted.id}';
    `);
    const previousEnabled = process.env.APP_BUILD_WORKER_ENABLED;
    process.env.APP_BUILD_WORKER_ENABLED = 'true';
    try {
      const worker = new AppBuildWorkerService(databaseService, {
        execute: async () => { throw new AppBuildExecutionError('build_failed'); },
      });
      await expect(worker.recoverStaleLocks()).resolves.toEqual({ failed: 1, requeued: 1 });
    } finally {
      if (previousEnabled === undefined) delete process.env.APP_BUILD_WORKER_ENABLED;
      else process.env.APP_BUILD_WORKER_ENABLED = previousEnabled;
    }
    await expect(service.getJob(tenantA, retryable.id)).resolves.toMatchObject({
      status: 'queued',
    });
    expect((await service.getJob(tenantA, retryable.id)).failureCode).toBeUndefined();
    await expect(service.getJob(tenantA, exhausted.id)).resolves.toMatchObject({
      failureCode: 'job_timed_out', status: 'failed',
    });
  });
});
