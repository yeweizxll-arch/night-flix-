import type { HeadObjectCommandOutput, S3Client, S3ClientConfig } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import {
  AwsSdkS3CompatibleStorageAdapter,
  S3StorageAdapterError,
} from './s3-compatible.adapter';

const credentials = {
  accessKeyId: 'test-access-key',
  forcePathStyle: true,
  region: 'us-east-1',
  secretAccessKey: 'test-secret-access-key-value',
};
const uploadId = '11111111-1111-4111-8111-111111111111';
const objectKey = 'tenant-media/abcdefghijklmno/image/abcdefghijklmnopqrstuvwxyz0123456789abcd.png';

describe('AwsSdkS3CompatibleStorageAdapter', () => {
  it('creates a short-lived inline GET using the official SDK without network access', async () => {
    const adapter = new AwsSdkS3CompatibleStorageAdapter();
    const result = await adapter.presignGetObject({
      credentials,
      expiresInSeconds: 180,
      objectKey,
      target: { bucket: 'media-bucket', endpoint: null },
    });
    const url = new URL(result.url);
    expect(url.protocol).toBe('https:');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('180');
    expect(url.searchParams.get('response-content-disposition')).toBe('inline');
    expect(url.searchParams.get('response-cache-control')).toBe('private, no-store, max-age=0');
    expect(result).toMatchObject({
      cacheControl: 'private, no-store, max-age=0',
      contentDisposition: 'inline',
    });
    expect(JSON.stringify(result)).not.toContain(credentials.secretAccessKey);
  });

  it('bounds playback URL expiry to two through five minutes', async () => {
    const adapter = new AwsSdkS3CompatibleStorageAdapter();
    for (const expiresInSeconds of [119, 301, 180.5]) {
      await expect(adapter.presignGetObject({
        credentials, expiresInSeconds, objectKey,
        target: { bucket: 'media-bucket', endpoint: null },
      })).rejects.toThrow(/between 120 and 300/);
    }
  });

  it('forces inline and no-store response overrides into the signed GET', async () => {
    const destroy = vi.fn();
    const presigner = vi.fn(async (_client, command, options) => {
      expect(command.input).toMatchObject({
        Bucket: 'media-bucket',
        Key: objectKey,
        ResponseCacheControl: 'private, no-store, max-age=0',
        ResponseContentDisposition: 'inline',
      });
      expect(options).toEqual({ expiresIn: 180 });
      return 'https://media.example/object?X-Amz-Expires=180';
    });
    const adapter = new AwsSdkS3CompatibleStorageAdapter(
      () => ({ destroy }) as unknown as S3Client,
      presigner as never,
      () => new Date('2026-08-22T00:00:00.000Z'),
    );
    const result = await adapter.presignGetObject({
      credentials, expiresInSeconds: 180, objectKey,
      target: { bucket: 'media-bucket', endpoint: null },
    });
    expect(result.expiresAt.toISOString()).toBe('2026-08-22T00:03:00.000Z');
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('is compatible with the official AWS SDK v3 presigner without network access', async () => {
    const adapter = new AwsSdkS3CompatibleStorageAdapter();
    const result = await adapter.presignConditionalPut({
      checksumSha256Base64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      contentLength: 12,
      contentType: 'image/png',
      credentials,
      expiresInSeconds: 600,
      objectKey,
      target: { bucket: 'media-bucket', endpoint: null },
      uploadId,
    });

    expect(new URL(result.url).hostname).toMatch(/(?:^|\.)s3\.us-east-1\.amazonaws\.com$/);
    expect(result.signedHeaders).toEqual(expect.arrayContaining([
      'content-length',
      'content-type',
      'if-none-match',
      'x-amz-checksum-sha256',
      'x-amz-meta-upload-id',
    ]));
  });

  it('uses a conditional PUT and binds all integrity headers into the signature', async () => {
    const destroy = vi.fn();
    const configurations: S3ClientConfig[] = [];
    const clientFactory = vi.fn((configuration: S3ClientConfig) => {
      configurations.push(configuration);
      return { destroy } as unknown as S3Client;
    });
    const presigner = vi.fn(async (_client, command, options) => {
      expect(command.input).toMatchObject({
        Bucket: 'media-bucket',
        ChecksumSHA256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
        ContentLength: 12,
        ContentType: 'image/png',
        IfNoneMatch: '*',
        Key: objectKey,
        Metadata: { 'upload-id': uploadId },
      });
      expect(options?.signableHeaders).toEqual(new Set(['content-length', 'content-type']));
      expect(options?.unhoistableHeaders).toEqual(new Set([
        'if-none-match',
        'x-amz-checksum-sha256',
        'x-amz-meta-upload-id',
      ]));
      return 'https://media-bucket.s3.example/object?X-Amz-SignedHeaders=content-length%3Bcontent-type%3Bhost%3Bif-none-match%3Bx-amz-checksum-sha256%3Bx-amz-meta-upload-id';
    });
    const adapter = new AwsSdkS3CompatibleStorageAdapter(
      clientFactory,
      presigner as never,
      () => new Date('2026-08-21T00:00:00.000Z'),
    );

    const result = await adapter.presignConditionalPut({
      checksumSha256Base64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      contentLength: 12,
      contentType: 'image/png',
      credentials,
      expiresInSeconds: 600,
      objectKey,
      target: { bucket: 'media-bucket', endpoint: null },
      uploadId,
    });

    expect(result.requiredHeaders).toMatchObject({
      'content-length': '12',
      'content-type': 'image/png',
      'if-none-match': '*',
      'x-amz-meta-upload-id': uploadId,
    });
    expect(result.contentLengthRequiresHeadVerification).toBe(true);
    expect(result.expiresAt.toISOString()).toBe('2026-08-21T00:10:00.000Z');
    expect(configurations[0]).toMatchObject({ maxAttempts: 2, region: 'us-east-1' });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('rejects a presigner result that fails to sign an integrity header', async () => {
    const adapter = new AwsSdkS3CompatibleStorageAdapter(
      () => ({ destroy: vi.fn() }) as unknown as S3Client,
      (async () => 'https://media.example/object?X-Amz-SignedHeaders=content-type%3Bhost') as never,
    );
    await expect(adapter.presignConditionalPut({
      checksumSha256Base64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      contentLength: 12,
      contentType: 'image/png',
      credentials,
      expiresInSeconds: 600,
      objectKey,
      target: { bucket: 'media-bucket', endpoint: null },
      uploadId,
    })).rejects.toThrow(/did not sign required header/);
  });

  it('normalizes a complete HEAD response and never exposes credentials', async () => {
    const send = vi.fn(async () => ({
      ChecksumSHA256: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ContentLength: 12,
      ContentType: 'IMAGE/PNG',
      ETag: '"etag-value"',
      Metadata: { 'upload-id': uploadId },
      VersionId: 'version-1',
    } satisfies Partial<HeadObjectCommandOutput>));
    const adapter = new AwsSdkS3CompatibleStorageAdapter(
      () => ({ destroy: vi.fn(), send }) as unknown as S3Client,
    );

    const result = await adapter.headObject({
      credentials,
      objectKey,
      target: { bucket: 'media-bucket', endpoint: null },
    });

    expect(result).toEqual({
      checksumSha256Base64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      contentLength: 12,
      contentType: 'image/png',
      etag: 'etag-value',
      exists: true,
      objectKey,
      uploadId,
      versionId: 'version-1',
    });
    expect(JSON.stringify(result)).not.toContain(credentials.secretAccessKey);
  });

  it('maps not-found while replacing provider errors with a secret-free error', async () => {
    const notFound = new AwsSdkS3CompatibleStorageAdapter(
      () => ({
        destroy: vi.fn(),
        send: vi.fn(async () => {
          throw Object.assign(new Error('missing'), { $metadata: { httpStatusCode: 404 } });
        }),
      }) as unknown as S3Client,
    );
    await expect(notFound.headObject({
      credentials,
      objectKey,
      target: { bucket: 'media-bucket', endpoint: null },
    })).resolves.toEqual({ exists: false, objectKey });

    const providerError = new AwsSdkS3CompatibleStorageAdapter(
      () => ({
        destroy: vi.fn(),
        send: vi.fn(async () => {
          throw new Error(`provider leaked ${credentials.secretAccessKey}`);
        }),
      }) as unknown as S3Client,
    );
    const error = await providerError.headObject({
      credentials,
      objectKey,
      target: { bucket: 'media-bucket', endpoint: null },
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(S3StorageAdapterError);
    expect(String(error)).not.toContain(credentials.secretAccessKey);
  });
});
