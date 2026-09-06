import { ConflictException, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService, DatabaseTransaction } from '../database/database.service';
import type {
  PresignConditionalPutInput,
  S3CompatibleStorageAdapter,
} from './s3-compatible.adapter';
import type { StorageCredentialCipher } from './storage-credentials';
import { StorageUploadService } from './storage-upload.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '22222222-2222-4222-8222-222222222222';
const actorId = '33333333-3333-4333-8333-333333333333';
const providerId = '44444444-4444-4444-8444-444444444444';
const mediaId = '55555555-5555-4555-8555-555555555555';
const commandId = '66666666-6666-4666-8666-666666666666';
const checksumHex = '00'.repeat(32);
const checksumBase64 = Buffer.from(checksumHex, 'hex').toString('base64');
const objectKey = 'tenant-media/abcdefghijklmno/image/abcdefghijklmnopqrstuvwxyz0123456789abcd.png';
const credentials = {
  accessKeyId: 'test-access-key',
  region: 'us-east-1',
  secretAccessKey: 'test-secret-access-key-value',
};
const createInput = {
  checksumSha256: checksumHex,
  contentType: 'image/png',
  extension: 'png',
  kind: 'image' as const,
  providerId,
  sizeBytes: 12,
};
const mutationMetadata = {
  actorId,
  idempotencyKey: 'upload-command-0001',
  ip: '203.0.113.10',
  requestId: '77777777-7777-4777-8777-777777777777',
};

describe('StorageUploadService', () => {
  it('registers original versioned HLS storage without uploading and pins every referenced resource', async () => {
    const root = 'shanchuang/work-1/episode-1/master.m3u8';
    let stored: Record<string, unknown> | undefined;
    const tx = fakeTransaction((query, values) => {
      if (query.includes('insert into command_idempotency') || query.includes('update command_idempotency')) return [{ id: commandId }];
      if (query.includes('from storage_providers')) return [{ ...providerRow(), owner_type: 'platform', owner_tenant_id: null }];
      if (query.includes('insert into media_assets')) {
        stored = values.find((v) => typeof v === 'object' && v !== null && 'sourceReference' in v) as Record<string, unknown>;
      }
      return [];
    });
    const adapter = adapterMock({
      headObject: vi.fn(async (input) => ({ exists: true, objectKey: input.objectKey, contentLength: 64,
        contentType: input.objectKey.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'application/octet-stream',
        etag: 'server-etag', versionId: input.objectKey === root ? 'root-v1' : 'child-v1' })),
      readObject: vi.fn(async (input) => {
        expect(input.versionId).toBe('root-v1');
        return { body: Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment1.ts\n#EXT-X-ENDLIST') };
      }),
    });
    await expect(makeService(tx, adapter).registerPlatformSourceObject({
      providerId, objectKey: root, versionId: 'root-v1', kind: 'video',
      shanchuangWorkId: 'work-1', shanchuangCreatorId: 'creator-1',
    }, mutationMetadata)).resolves.toMatchObject({ status: 'ready' });
    expect(stored).toMatchObject({ sourceReference: {
      resourceVersions: { [root]: 'root-v1',
        'shanchuang/work-1/episode-1/key.bin': 'child-v1',
        'shanchuang/work-1/episode-1/segment1.ts': 'child-v1' },
    } });
    expect(adapter.presignConditionalPut).not.toHaveBeenCalled();
  });
  it('rejects unversioned or cross-owner original source storage', async () => {
    const service = makeService(fakeTransaction((query) =>
      query.includes('insert into command_idempotency') ? [{ id: commandId }] : []));
    const input = { providerId, objectKey, versionId: 'v1', kind: 'image' as const,
      shanchuangWorkId: 'work-1', shanchuangCreatorId: 'creator-1' };
    await expect(service.registerPlatformSourceObject(input, mutationMetadata)).rejects.toThrow('Platform S3 provider');
    await expect(service.registerPlatformSourceObject({ ...input, versionId: 'null' }, mutationMetadata)).rejects.toThrow('versioning');
    await expect(service.registerPlatformSourceObject({ ...input, objectKey: '../../etc/passwd' }, mutationMetadata)).rejects.toThrow('Invalid source');
  });
  it('creates only a platform-owned S3 upload and writes platform audit and outbox facts', async () => {
    let generatedMediaId: string | undefined;
    const queries: string[] = [];
    const transaction = fakeTransaction((sql) => {
      queries.push(sql);
      if (sql.includes('insert into command_idempotency')) return [{ id: commandId }];
      if (sql.includes('from storage_providers')) {
        expect(sql).toContain("owner_type = 'platform'");
        expect(sql).toContain("provider = 's3'");
        return [{ ...providerRow(), owner_tenant_id: null, owner_type: 'platform' }];
      }
      if (sql.includes('insert into media_assets')) {
        expect(sql).toContain("'platform', null");
        return [{
          created_at: new Date('2026-08-21T00:00:00.000Z'),
          id: generatedMediaId,
          status: 'uploading',
          version: 0,
        }];
      }
      if (sql.includes('insert into audit_logs')) {
        expect(sql).toContain("'platform', null, 'platform_staff'");
        return [];
      }
      if (sql.includes('insert into outbox_events')) {
        expect(sql).toContain("'platform', null");
        return [];
      }
      if (sql.includes('update command_idempotency')) return [{ id: commandId }];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const adapter = adapterMock({
      presignConditionalPut: vi.fn(async (input) => {
        generatedMediaId = input.uploadId;
        return signedIntent(input.uploadId);
      }),
    });
    const service = makeService(transaction, adapter);

    const result = await service.createPlatformUploadIntent(
      createInput,
      mutationMetadata,
    );
    expect(result).toMatchObject({ id: generatedMediaId, status: 'uploading' });
    expect(JSON.stringify(queries)).not.toContain(credentials.secretAccessKey);
  });

  it('does not make a storage request for a tenant-owned media id on platform completion', async () => {
    const transaction = fakeTransaction((sql) => {
      if (sql.includes('from media_assets')) return [];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const adapter = adapterMock();
    await expect(makeService(transaction, adapter).completePlatformUpload(
      mediaId,
      mutationMetadata,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(adapter.headObject).not.toHaveBeenCalled();
  });

  it('verifies and completes a platform upload with a command fact', async () => {
    const queries: string[] = [];
    const platformCompletion = completionRow({
      owner_tenant_id: null,
      owner_type: 'platform',
    });
    const transaction = fakeTransaction((sql) => {
      queries.push(sql);
      if (sql.includes('from media_assets')) {
        expect(sql).toContain("media.owner_type = 'platform'");
        expect(sql).toContain("provider.status = 'active'");
        return [platformCompletion];
      }
      if (sql.includes('insert into command_idempotency')) return [{ id: commandId }];
      if (sql.includes('update media_assets')) return [{ status: 'ready', version: 2 }];
      if (sql.includes('insert into audit_logs')) return [];
      if (sql.includes('insert into outbox_events')) return [];
      if (sql.includes('update command_idempotency')) return [{ id: commandId }];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const adapter = adapterMock({
      headObject: vi.fn(async () => ({
        checksumSha256Base64: checksumBase64,
        contentLength: 12,
        contentType: 'image/png',
        etag: 'platform-etag',
        exists: true as const,
        objectKey,
        uploadId: mediaId,
      })),
    });
    await expect(makeService(transaction, adapter).completePlatformUpload(
      mediaId,
      mutationMetadata,
    )).resolves.toMatchObject({ id: mediaId, status: 'ready', version: 2 });
    expect(queries.at(-1)).toContain('update command_idempotency');
  });

  it('creates and command-caches an integrity-bound upload intent in one transaction', async () => {
    let generatedMediaId: string | undefined;
    const queries: string[] = [];
    const transaction = fakeTransaction((sql, values) => {
      queries.push(sql);
      if (sql.includes('insert into command_idempotency')) return [{ id: commandId }];
      if (sql.includes('from storage_providers')) return [providerRow()];
      if (sql.includes('insert into media_assets')) {
        return [{
          created_at: new Date('2026-08-21T00:00:00.000Z'),
          id: generatedMediaId,
          status: 'uploading',
          version: 1,
        }];
      }
      if (sql.includes('insert into audit_logs')) return [];
      if (sql.includes('update command_idempotency')) return [{ id: commandId }];
      throw new Error(`Unexpected query: ${sql} / ${String(values.length)}`);
    });
    const adapter = adapterMock({
      presignConditionalPut: vi.fn(async (input: PresignConditionalPutInput) => {
        generatedMediaId = input.uploadId;
        return signedIntent(input.uploadId);
      }),
    });
    const service = makeService(transaction, adapter);

    const result = await service.createTenantUploadIntent(
      tenantId,
      createInput,
      mutationMetadata,
    );

    expect(result.id).toBe(generatedMediaId);
    expect(result.requiredHeaders).toMatchObject({
      'if-none-match': '*',
      'x-amz-checksum-sha256': checksumBase64,
      'x-amz-meta-upload-id': generatedMediaId,
    });
    expect(JSON.stringify(result)).not.toContain(credentials.secretAccessKey);
    expect(queries.findIndex((sql) => sql.includes('insert into command_idempotency')))
      .toBeLessThan(queries.findIndex((sql) => sql.includes('from storage_providers')));
    expect(queries.at(-1)).toContain('update command_idempotency');
  });

  it('returns a cached result for the same key and request without signing a second URL', async () => {
    const cached = cachedIntent('2099-08-21T00:10:00.000Z');
    const requestHash = createHash('sha256')
      .update(JSON.stringify(createInput))
      .digest('hex');
    const transaction = fakeTransaction((sql) => {
      if (sql.includes('insert into command_idempotency')) return [];
      if (sql.includes('from command_idempotency')) {
        return [{ request_hash: requestHash, response_json: cached, status: 'completed' }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    const adapter = adapterMock();
    const service = makeService(transaction, adapter);

    await expect(service.createTenantUploadIntent(
      tenantId,
      createInput,
      mutationMetadata,
    )).resolves.toEqual(cached);
    expect(adapter.presignConditionalPut).not.toHaveBeenCalled();
  });

  it('rejects a reused key with a different request and an expired cached URL', async () => {
    const wrongHashTransaction = fakeTransaction((sql) => {
      if (sql.includes('insert into command_idempotency')) return [];
      if (sql.includes('from command_idempotency')) {
        return [{ request_hash: 'ff'.repeat(32), response_json: null, status: 'processing' }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    await expect(makeService(wrongHashTransaction).createTenantUploadIntent(
      tenantId,
      createInput,
      mutationMetadata,
    )).rejects.toThrow(/another request/);

    const requestHash = createHash('sha256')
      .update(JSON.stringify(createInput))
      .digest('hex');
    const expiredTransaction = fakeTransaction((sql) => {
      if (sql.includes('insert into command_idempotency')) return [];
      if (sql.includes('from command_idempotency')) {
        return [{
          request_hash: requestHash,
          response_json: cachedIntent('2020-01-01T00:00:00.000Z'),
          status: 'completed',
        }];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });
    await expect(makeService(expiredTransaction).createTenantUploadIntent(
      tenantId,
      createInput,
      mutationMetadata,
    )).rejects.toThrow(/cached upload URL expired/);
  });

  it('requires an idempotency key and rejects an adapter that omits signed constraints', async () => {
    const emptyTransaction = fakeTransaction(() => []);
    await expect(makeService(emptyTransaction).createTenantUploadIntent(
      tenantId,
      createInput,
      { ...mutationMetadata, idempotencyKey: undefined },
    )).rejects.toThrow(/Idempotency-Key is required/);

    const transaction = fakeTransaction((sql) => {
      if (sql.includes('insert into command_idempotency')) return [{ id: commandId }];
      if (sql.includes('from storage_providers')) return [providerRow()];
      throw new Error(`Intent persisted after unsafe presign: ${sql}`);
    });
    const adapter = adapterMock({
      presignConditionalPut: vi.fn(async () => ({
        ...signedIntent(mediaId),
        signedHeaders: ['content-type'],
      })),
    });
    await expect(makeService(transaction, adapter).createTenantUploadIntent(
      tenantId,
      createInput,
      mutationMetadata,
    )).rejects.toThrow(/did not bind required upload header/);
  });

  it('does not make a storage request for a cross-tenant media id', async () => {
    const transaction = fakeTransaction((sql) => {
      if (sql.includes('from media_assets')) return [];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const adapter = adapterMock();
    await expect(makeService(transaction, adapter).completeTenantUpload(
      otherTenantId,
      mediaId,
      mutationMetadata,
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(adapter.headObject).not.toHaveBeenCalled();
  });

  it.each([
    ['size', { contentLength: 13 }],
    ['content type', { contentType: 'image/jpeg' }],
    ['checksum', { checksumSha256Base64: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' }],
    ['upload binding', { uploadId: otherTenantId }],
    ['object key', { objectKey: `${objectKey}-tampered` }],
  ])('rejects a completed object with a tampered %s', async (_name, override) => {
    const transaction = fakeTransaction((sql) => {
      if (sql.includes('from media_assets')) return [completionRow()];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const adapter = adapterMock({
      headObject: vi.fn(async () => ({
        checksumSha256Base64: checksumBase64,
        contentLength: 12,
        contentType: 'image/png',
        etag: 'etag-value',
        exists: true as const,
        objectKey,
        uploadId: mediaId,
        ...override,
      })),
    });
    await expect(makeService(transaction, adapter).completeTenantUpload(
      tenantId,
      mediaId,
      mutationMetadata,
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('marks a verified direct upload ready without requesting transcoding', async () => {
    const queries: string[] = [];
    const transaction = fakeTransaction((sql) => {
      queries.push(sql);
      if (sql.includes('from media_assets')) return [completionRow()];
      if (sql.includes('update media_assets')) return [{ status: 'ready', version: 2 }];
      if (sql.includes('insert into audit_logs')) return [];
      if (sql.includes('insert into outbox_events')) return [];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const adapter = adapterMock({
      headObject: vi.fn(async () => ({
        checksumSha256Base64: checksumBase64,
        contentLength: 12,
        contentType: 'image/png',
        etag: 'etag-value',
        exists: true as const,
        objectKey,
        uploadId: mediaId,
      })),
    });

    await expect(makeService(transaction, adapter).completeTenantUpload(
      tenantId,
      mediaId,
      mutationMetadata,
    )).resolves.toMatchObject({ id: mediaId, status: 'ready', version: 2 });
    expect(queries.find((sql) => sql.includes('update media_assets'))).toContain(
      "transcode_status = 'not_required'",
    );
    const outbox = queries.find((sql) => sql.includes('insert into outbox_events'));
    expect(outbox).toBeDefined();
    expect(outbox).not.toContain('MediaTranscodeRequested');
  });

  it('returns an already verified upload without another HEAD request', async () => {
    const completed = completionRow({
      media_status: 'ready',
      media_version: 2,
      metadata_json: {
        uploadIntent: {
          ...completionRow().metadata_json.uploadIntent,
          state: 'verified',
        },
        uploadVerification: { etag: 'etag-value' },
      },
    });
    const transaction = fakeTransaction((sql) => {
      if (sql.includes('from media_assets')) return [completed];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const adapter = adapterMock();
    await expect(makeService(transaction, adapter).completeTenantUpload(
      tenantId,
      mediaId,
      mutationMetadata,
    )).resolves.toMatchObject({ id: mediaId, status: 'ready', version: 2 });
    expect(adapter.headObject).not.toHaveBeenCalled();
  });
});

function makeService(
  transaction: DatabaseTransaction,
  adapter = adapterMock(),
): StorageUploadService {
  const database = {
    inPlatformContext: vi.fn(async (callback) => callback(transaction)),
    inTenantContext: vi.fn(async (_tenantId, callback) => callback(transaction)),
  } as unknown as DatabaseService;
  const cipher = {
    decrypt: vi.fn(() => credentials),
  } as unknown as StorageCredentialCipher;
  return new StorageUploadService(database, cipher, adapter);
}

function fakeTransaction(
  handler: (sql: string, values: unknown[]) => unknown[] | Promise<unknown[]>,
): DatabaseTransaction {
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join(' ').replace(/\s+/g, ' ').trim();
    return handler(sql, values);
  };
  Object.assign(tag, { json: (value: unknown) => value });
  return tag as unknown as DatabaseTransaction;
}

function adapterMock(
  overrides: Partial<S3CompatibleStorageAdapter> = {},
): S3CompatibleStorageAdapter {
  return {
    headObject: vi.fn(async () => ({ exists: false as const, objectKey })),
    presignConditionalPut: vi.fn(async (input) => signedIntent(input.uploadId)),
    presignGetObject: vi.fn(async () => ({
      cacheControl: 'private, no-store, max-age=0' as const,
      contentDisposition: 'inline' as const,
      expiresAt: new Date('2099-08-21T00:03:00.000Z'),
      url: 'https://storage.example.test/signed-object',
    })),
    ...overrides,
  };
}

function signedIntent(uploadId: string) {
  return {
    contentLengthRequiresHeadVerification: true as const,
    expiresAt: new Date('2099-08-21T00:10:00.000Z'),
    requiredHeaders: {
      'content-length': '12',
      'content-type': 'image/png',
      'if-none-match': '*',
      'x-amz-checksum-sha256': checksumBase64,
      'x-amz-meta-upload-id': uploadId,
    },
    signedHeaders: [
      'content-type',
      'if-none-match',
      'x-amz-checksum-sha256',
      'x-amz-meta-upload-id',
    ],
    url: 'https://media.example/upload?signature=redacted',
  };
}

function providerRow() {
  return {
    bucket: 'media-bucket',
    credential_ciphertext: 'encrypted-credentials',
    endpoint: null,
    id: providerId,
    key_version: 1,
    owner_tenant_id: tenantId,
    owner_type: 'tenant' as const,
    provider: 's3',
    version: 3,
  };
}

function completionRow(overrides: Record<string, unknown> = {}) {
  return {
    ...providerRow(),
    checksum: `sha256:${checksumHex}`,
    kind: 'image' as const,
    media_status: 'uploading',
    media_version: 1,
    metadata_json: {
      uploadIntent: {
        expiresAt: '2099-08-21T00:10:00.000Z',
        providerKeyVersion: 1,
        providerVersion: 3,
        state: 'issued',
        uploadId: mediaId,
        version: 1,
      },
      uploadVerification: null,
    },
    mime_type: 'image/png',
    object_key: objectKey,
    size_bytes_text: '12',
    storage_provider_id: providerId,
    transcode_status: 'not_required',
    ...overrides,
  };
}

function cachedIntent(expiresAt: string) {
  return {
    completionVerificationRequired: true as const,
    createdAt: '2026-08-21T00:00:00.000Z',
    expiresAt,
    id: mediaId,
    method: 'PUT' as const,
    objectKey,
    requiredHeaders: signedIntent(mediaId).requiredHeaders,
    sizeVerifiedOnComplete: true as const,
    status: 'uploading',
    uploadUrl: 'https://media.example/upload?signature=redacted',
    version: 1,
  };
}
