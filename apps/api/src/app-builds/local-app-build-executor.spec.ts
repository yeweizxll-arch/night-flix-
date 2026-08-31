import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DatabaseService, DatabaseTransaction } from '../database/database.service';
import type { S3CompatibleStorageAdapter } from '../storage/s3-compatible.adapter';
import type { StorageCredentialCipher } from '../storage/storage-credentials';
import { LocalAppBuildExecutor } from './local-app-build-executor';
import type { NativeAppBuilder } from './native-app-builder';

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e7735d0101';
const jobId = '018f2f45-7f5e-7e70-b17f-f6e7735d0102';
const mediaId = '018f2f45-7f5e-7e70-b17f-f6e7735d0103';
const tenantProviderId = '018f2f45-7f5e-7e70-b17f-f6e7735d0104';
const artifactProviderId = '018f2f45-7f5e-7e70-b17f-f6e7735d0105';

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID;
});

describe('LocalAppBuildExecutor', () => {
  it('rechecks immutable source bytes, builds, uploads conditionally and verifies HEAD', async () => {
    const icon = await sharp({
      create: { background: '#1d4ed8', channels: 3, height: 1024, width: 1024 },
    }).png().toBuffer();
    const iconHex = createHash('sha256').update(icon).digest('hex');
    const artifact = Buffer.from('verified-native-artifact');
    const artifactHex = createHash('sha256').update(artifact).digest('hex');
    const artifactBase64 = Buffer.from(artifactHex, 'hex').toString('base64');
    const temporary = await mkdtemp(join(tmpdir(), 'app-build-executor-test-'));
    const artifactPath = join(temporary, 'artifact.apk');
    await writeFile(artifactPath, artifact);
    const cleanup = vi.fn(() => rm(temporary, { force: true, recursive: true }));
    const builder = { build: vi.fn(async () => ({
      cleanup,
      contentType: 'application/vnd.android.package-archive' as const,
      filename: `${jobId}-android-debug.apk`,
      path: artifactPath,
    })) };
    const cipher = { decrypt: vi.fn(() => ({
      accessKeyId: 'access-key', region: 'us-east-1', secretAccessKey: 'secret-key-value',
    })) };
    const adapter = {
      headObject: vi.fn(async () => ({
        checksumSha256Base64: artifactBase64,
        contentLength: artifact.length,
        contentType: 'application/vnd.android.package-archive',
        etag: 'etag', exists: true as const,
        objectKey: `app-builds/${tenantId}/${jobId}/${jobId}-android-debug.apk`,
      })),
      presignConditionalPut: vi.fn(async (input) => ({
        contentLengthRequiresHeadVerification: true as const,
        expiresAt: new Date(Date.now() + 900_000),
        requiredHeaders: {
          'content-length': String(input.contentLength),
          'content-type': input.contentType,
          'if-none-match': '*',
          'x-amz-checksum-sha256': input.checksumSha256Base64,
          'x-amz-meta-upload-id': input.uploadId,
        },
        signedHeaders: ['content-length', 'content-type', 'if-none-match',
          'x-amz-checksum-sha256', 'x-amz-meta-upload-id'],
        url: 'https://objects.example.test/artifact-put',
      })),
      presignGetObject: vi.fn(async () => ({
        cacheControl: 'private, no-store, max-age=0' as const,
        contentDisposition: 'inline' as const,
        expiresAt: new Date(Date.now() + 180_000),
        url: 'https://objects.example.test/icon-get',
      })),
    };
    const database = databaseFixture((sql) => {
      if (sql.includes('from media_assets as media')) return [{
        bucket: 'tenant-assets',
        checksum: `sha256:${iconHex}`,
        credential_ciphertext: 'tenant-cipher',
        endpoint: null,
        key_version: 1,
        mime_type: 'image/png',
        object_key: 'assets/icon.png',
        owner_tenant_id: tenantId,
        owner_type: 'tenant',
        provider_id: tenantProviderId,
        size_bytes: icon.length,
      }];
      if (sql.includes('from storage_providers where id')) return [{
        bucket: 'platform-artifacts', credential_ciphertext: 'platform-cipher',
        endpoint: null, key_version: 2, provider_id: artifactProviderId,
      }];
      return [];
    });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/icon-get')) return new Response(icon, { status: 200 });
      expect(String(url)).toContain('/artifact-put');
      expect(init?.method).toBe('PUT');
      return new Response(null, { status: 200 });
    }));
    process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID = artifactProviderId;
    const executor = new LocalAppBuildExecutor(
      database,
      cipher as unknown as StorageCredentialCipher,
      adapter as unknown as S3CompatibleStorageAdapter,
      builder as unknown as NativeAppBuilder,
    );
    const result = await executor.execute(executionInput(iconHex));
    expect(result).toEqual({
      checksum: `sha256:${artifactHex}`,
      contentType: 'application/vnd.android.package-archive',
      filename: `${jobId}-android-debug.apk`,
      objectKey: `app-builds/${tenantId}/${jobId}/${jobId}-android-debug.apk`,
      sizeBytes: BigInt(artifact.length),
      storageProviderId: artifactProviderId,
    });
    expect(builder.build).toHaveBeenCalledWith(expect.objectContaining({
      androidApplicationId: 'com.example.merchant',
      h5Origin: 'https://video.example.test',
      jobId,
    }));
    expect(adapter.presignConditionalPut).toHaveBeenCalledWith(expect.objectContaining({
      checksumSha256Base64: artifactBase64,
      contentLength: artifact.length,
      uploadId: jobId,
    }));
    expect(adapter.headObject).toHaveBeenCalledOnce();
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('rejects a tenant or target mismatch before storage access', async () => {
    const database = databaseFixture(() => { throw new Error('must not query'); });
    const executor = new LocalAppBuildExecutor(
      database,
      { decrypt: vi.fn() } as unknown as StorageCredentialCipher,
      {} as S3CompatibleStorageAdapter,
      {} as NativeAppBuilder,
    );
    const input = executionInput('a'.repeat(64));
    input.snapshot = { ...input.snapshot, tenantId: '018f2f45-7f5e-7e70-b17f-f6e7735d0199' };
    await expect(executor.execute(input)).rejects.toMatchObject({
      code: 'build_failed',
    });
  });
});

function executionInput(iconHex: string) {
  return {
    jobId,
    snapshot: {
      androidApplicationId: 'com.example.merchant',
      appName: 'Merchant Video',
      h5Origin: 'https://video.example.test',
      icon: { checksum: `sha256:${iconHex}`, mediaAssetId: mediaId },
      iosBundleId: 'com.example.merchant',
      releaseChannel: 'internal_test',
      splash: null,
      target: 'android_debug',
      tenantId,
    },
    target: 'android_debug' as const,
    tenantId,
  };
}

function databaseFixture(query: (sql: string, values: unknown[]) => unknown[]) {
  const transaction = (async (strings: TemplateStringsArray, ...values: unknown[]) => (
    query(strings.join('$'), values)
  )) as unknown as DatabaseTransaction;
  Object.assign(transaction, { json: (value: unknown) => JSON.stringify(value) });
  return {
    inPlatformContext: <T>(callback: (tag: DatabaseTransaction) => Promise<T>) =>
      callback(transaction),
  } as unknown as DatabaseService;
}
