import {
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import type { S3StorageCredentials } from './storage-credentials';
import { validateStorageEndpoint } from './storage-endpoint-policy';

const MAX_PRESIGN_SECONDS = 900;
const MIN_PRESIGN_SECONDS = 60;
const MAX_GET_PRESIGN_SECONDS = 300;
const MIN_GET_PRESIGN_SECONDS = 120;

export const S3_COMPATIBLE_STORAGE_ADAPTER = Symbol('S3_COMPATIBLE_STORAGE_ADAPTER');

export interface S3StorageTarget {
  bucket: string;
  endpoint: string | null;
}

export interface PresignConditionalPutInput {
  checksumSha256Base64: string;
  contentLength: number;
  contentType: string;
  credentials: S3StorageCredentials;
  expiresInSeconds: number;
  objectKey: string;
  target: S3StorageTarget;
  uploadId: string;
}

export interface PresignedConditionalPut {
  contentLengthRequiresHeadVerification: true;
  expiresAt: Date;
  requiredHeaders: Record<string, string>;
  signedHeaders: string[];
  url: string;
}

export interface HeadStorageObjectInput {
  versionId?: string;
  credentials: S3StorageCredentials;
  objectKey: string;
  target: S3StorageTarget;
}

export interface PresignGetObjectInput {
  versionId?: string;
  credentials: S3StorageCredentials;
  expiresInSeconds: number;
  objectKey: string;
  target: S3StorageTarget;
}

export interface PresignedGetObject {
  cacheControl: 'private, no-store, max-age=0';
  contentDisposition: 'inline';
  expiresAt: Date;
  url: string;
}

export interface StorageObjectHead {
  checksumSha256Base64?: string;
  contentLength: number;
  contentType?: string;
  etag: string;
  exists: true;
  objectKey: string;
  uploadId?: string;
  versionId?: string;
}

export interface MissingStorageObjectHead {
  exists: false;
  objectKey: string;
}

export interface S3CompatibleStorageAdapter {
  readObject?(input: HeadStorageObjectInput & { maxBytes: number; range?: string }): Promise<{
    body: Buffer; contentType?: string; contentRange?: string;
  }>;
  headObject(input: HeadStorageObjectInput): Promise<MissingStorageObjectHead | StorageObjectHead>;
  presignConditionalPut(input: PresignConditionalPutInput): Promise<PresignedConditionalPut>;
  presignGetObject(input: PresignGetObjectInput): Promise<PresignedGetObject>;
}

export class S3StorageAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'S3StorageAdapterError';
  }
}

type ClientFactory = (configuration: S3ClientConfig) => S3Client;
type UrlPresigner = typeof getSignedUrl;

export class AwsSdkS3CompatibleStorageAdapter implements S3CompatibleStorageAdapter {
  constructor(
    private readonly clientFactory: ClientFactory = (configuration) => new S3Client(configuration),
    private readonly presigner: UrlPresigner = getSignedUrl,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async readObject(input: HeadStorageObjectInput & { maxBytes: number; range?: string }) {
    validateHeadInput(input);
    if (!Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 8 * 1024 * 1024) {
      throw new TypeError('Invalid storage read limit');
    }
    if (input.range && !/^bytes=\d+-\d*$/.test(input.range)) throw new TypeError('Invalid byte range');
    const client = this.clientFactory(clientConfiguration(input.target, input.credentials));
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15_000);
    try {
      const response = await client.send(new GetObjectCommand({
        Bucket: input.target.bucket, Key: input.objectKey, Range: input.range, VersionId: input.versionId,
      }), { abortSignal: abort.signal });
      if (!response.Body || (response.ContentLength ?? 0) > input.maxBytes) {
        throw new S3StorageAdapterError('Storage object exceeds the playback read limit');
      }
      const parts: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > input.maxBytes) throw new S3StorageAdapterError('Storage object exceeds the playback read limit');
        parts.push(Buffer.from(chunk));
      }
      return { body: Buffer.concat(parts), contentType: response.ContentType, contentRange: response.ContentRange };
    } catch {
      throw new S3StorageAdapterError('Secure storage read is unavailable');
    } finally {
      clearTimeout(timeout);
      abort.abort();
      client.destroy();
    }
  }

  async presignGetObject(rawInput: PresignGetObjectInput): Promise<PresignedGetObject> {
    const input = validateGetPresignInput(rawInput);
    const now = this.clock();
    assertValidDate(now);
    const client = this.clientFactory(clientConfiguration(input.target, input.credentials));
    try {
      const command = new GetObjectCommand({
        Bucket: input.target.bucket,
        Key: input.objectKey,
        VersionId: input.versionId,
        ResponseCacheControl: 'private, no-store, max-age=0',
        ResponseContentDisposition: 'inline',
      });
      const url = await this.presigner(client, command, { expiresIn: input.expiresInSeconds });
      validatePresignedUrl(url);
      const parsed = new URL(url);
      const signedExpiry = parsed.searchParams.get('X-Amz-Expires')
        ?? parsed.searchParams.get('x-amz-expires');
      if (signedExpiry !== String(input.expiresInSeconds)) {
        throw new S3StorageAdapterError('S3 presigner returned an unexpected expiry');
      }
      return {
        cacheControl: 'private, no-store, max-age=0',
        contentDisposition: 'inline',
        expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1_000),
        url,
      };
    } catch (error) {
      if (error instanceof S3StorageAdapterError) throw error;
      throw new S3StorageAdapterError('Could not create the secure playback URL');
    } finally {
      client.destroy();
    }
  }

  async presignConditionalPut(
    rawInput: PresignConditionalPutInput,
  ): Promise<PresignedConditionalPut> {
    const input = validatePresignInput(rawInput);
    const now = this.clock();
    assertValidDate(now);
    const client = this.clientFactory(clientConfiguration(input.target, input.credentials));
    const requiredHeaders = {
      'content-length': String(input.contentLength),
      'content-type': input.contentType,
      'if-none-match': '*',
      'x-amz-checksum-sha256': input.checksumSha256Base64,
      'x-amz-meta-upload-id': input.uploadId,
    };
    try {
      const command = new PutObjectCommand({
        Bucket: input.target.bucket,
        ChecksumSHA256: input.checksumSha256Base64,
        ContentLength: input.contentLength,
        ContentType: input.contentType,
        IfNoneMatch: '*',
        Key: input.objectKey,
        Metadata: { 'upload-id': input.uploadId },
      });
      const url = await this.presigner(client, command, {
        expiresIn: input.expiresInSeconds,
        signableHeaders: new Set(['content-length', 'content-type']),
        unhoistableHeaders: new Set([
          'if-none-match',
          'x-amz-checksum-sha256',
          'x-amz-meta-upload-id',
        ]),
      });
      validatePresignedUrl(url);
      const signedHeaders = signedHeadersFromUrl(url);
      for (const required of [
        'content-type',
        'if-none-match',
        'x-amz-checksum-sha256',
        'x-amz-meta-upload-id',
      ]) {
        if (!signedHeaders.includes(required)) {
          throw new S3StorageAdapterError(`S3 presigner did not sign required header ${required}`);
        }
      }
      return {
        contentLengthRequiresHeadVerification: true,
        expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1_000),
        requiredHeaders,
        signedHeaders,
        url,
      };
    } catch (error) {
      if (error instanceof S3StorageAdapterError) throw error;
      throw new S3StorageAdapterError('Could not create the conditional upload URL');
    } finally {
      client.destroy();
    }
  }

  async headObject(
    rawInput: HeadStorageObjectInput,
  ): Promise<MissingStorageObjectHead | StorageObjectHead> {
    const input = validateHeadInput(rawInput);
    const client = this.clientFactory(clientConfiguration(input.target, input.credentials));
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 15_000);
    try {
      const result = await client.send(new HeadObjectCommand({
        Bucket: input.target.bucket,
        ChecksumMode: 'ENABLED',
        Key: input.objectKey,
        VersionId: input.versionId,
      }), { abortSignal: abort.signal });
      const contentLength = result.ContentLength;
      const etag = normalizeEtag(result.ETag);
      if (!Number.isSafeInteger(contentLength) || (contentLength as number) < 0 || !etag) {
        throw new S3StorageAdapterError('Object storage HEAD response is incomplete');
      }
      return {
        checksumSha256Base64: boundedOptional(result.ChecksumSHA256, 128),
        contentLength: contentLength as number,
        contentType: boundedOptional(result.ContentType, 200)?.toLowerCase(),
        etag,
        exists: true,
        objectKey: input.objectKey,
        uploadId: boundedOptional(result.Metadata?.['upload-id'], 128),
        versionId: boundedOptional(result.VersionId, 512),
      };
    } catch (error) {
      if (isNotFound(error)) return { exists: false, objectKey: input.objectKey };
      if (error instanceof S3StorageAdapterError) throw error;
      throw new S3StorageAdapterError('Object storage HEAD request failed');
    } finally {
      clearTimeout(timer);
      abort.abort();
      client.destroy();
    }
  }
}

function clientConfiguration(
  target: S3StorageTarget,
  credentials: S3StorageCredentials,
): S3ClientConfig {
  validateTarget(target);
  validateCredentialsForSigning(credentials);
  return {
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
    },
    endpoint: target.endpoint ?? undefined,
    forcePathStyle: credentials.forcePathStyle ?? Boolean(target.endpoint),
    maxAttempts: 2,
    region: credentials.region,
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  };
}

function validatePresignInput(input: PresignConditionalPutInput): PresignConditionalPutInput {
  if (!input || typeof input !== 'object') throw new TypeError('Presign input is required');
  validateCredentialsForSigning(input.credentials);
  validateTarget(input.target);
  validateObjectKey(input.objectKey);
  if (!isUuid(input.uploadId)) throw new TypeError('uploadId must be a UUID');
  if (!Number.isSafeInteger(input.contentLength) || input.contentLength < 1) {
    throw new TypeError('contentLength must be a positive safe integer');
  }
  if (!isContentType(input.contentType)) throw new TypeError('contentType is invalid');
  decodeSha256Base64(input.checksumSha256Base64);
  if (
    !Number.isInteger(input.expiresInSeconds)
    || input.expiresInSeconds < MIN_PRESIGN_SECONDS
    || input.expiresInSeconds > MAX_PRESIGN_SECONDS
  ) {
    throw new TypeError('expiresInSeconds must be between 60 and 900');
  }
  return input;
}

function validateGetPresignInput(input: PresignGetObjectInput): PresignGetObjectInput {
  if (!input || typeof input !== 'object') throw new TypeError('GET presign input is required');
  validateCredentialsForSigning(input.credentials);
  validateTarget(input.target);
  validateObjectKey(input.objectKey);
  if (!Number.isInteger(input.expiresInSeconds)
    || input.expiresInSeconds < MIN_GET_PRESIGN_SECONDS
    || input.expiresInSeconds > MAX_GET_PRESIGN_SECONDS) {
    throw new TypeError('expiresInSeconds must be between 120 and 300');
  }
  return input;
}

function validateHeadInput(input: HeadStorageObjectInput): HeadStorageObjectInput {
  if (!input || typeof input !== 'object') throw new TypeError('HEAD input is required');
  validateCredentialsForSigning(input.credentials);
  validateTarget(input.target);
  validateObjectKey(input.objectKey);
  return input;
}

function validateCredentialsForSigning(credentials: S3StorageCredentials): void {
  if (
    !credentials
    || typeof credentials.accessKeyId !== 'string'
    || credentials.accessKeyId.length < 3
    || typeof credentials.secretAccessKey !== 'string'
    || credentials.secretAccessKey.length < 16
    || typeof credentials.region !== 'string'
    || !/^[A-Za-z0-9._-]{1,100}$/.test(credentials.region)
  ) {
    throw new TypeError('S3 signing credentials are invalid');
  }
}

function validateTarget(target: S3StorageTarget): void {
  if (
    !target
    || typeof target.bucket !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,253}[A-Za-z0-9]$/.test(target.bucket)
  ) {
    throw new TypeError('Storage bucket is invalid');
  }
  if (target.endpoint === null) return;
  validateStorageEndpoint(target.endpoint);
}

export function validateObjectKey(value: string): void {
  if (
    typeof value !== 'string'
    || value.length < 16
    || value.length > 1_024
    || value.startsWith('/')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
    || value.split('/').some((segment) => segment === '.' || segment === '..' || !segment)
  ) {
    throw new TypeError('Storage object key is invalid');
  }
}

function signedHeadersFromUrl(value: string): string[] {
  const url = new URL(value);
  const signedHeaders = url.searchParams.get('X-Amz-SignedHeaders')
    ?? url.searchParams.get('x-amz-signedheaders');
  if (!signedHeaders) throw new S3StorageAdapterError('S3 presigner omitted signed headers');
  return signedHeaders.split(';').map((header) => header.toLowerCase()).sort();
}

function validatePresignedUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new S3StorageAdapterError('S3 presigner returned an invalid URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new S3StorageAdapterError('S3 presigner returned an unsafe URL');
  }
}

function decodeSha256Base64(value: string): Buffer {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new TypeError('SHA-256 checksum is invalid');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32 || decoded.toString('base64') !== value) {
    throw new TypeError('SHA-256 checksum is invalid');
  }
  return decoded;
}

function isContentType(value: string): boolean {
  return typeof value === 'string'
    && value.length <= 200
    && /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function boundedOptional(value: string | undefined, maximum: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.length > maximum || /[\r\n\u0000]/.test(normalized)) {
    throw new S3StorageAdapterError('Object storage HEAD response contains an invalid field');
  }
  return normalized;
}

function normalizeEtag(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^"|"$/g, '');
  if (!normalized || normalized.length > 512 || /[\r\n\u0000]/.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function isNotFound(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const value = error as { $metadata?: { httpStatusCode?: number }; name?: string };
  return value.$metadata?.httpStatusCode === 404
    || value.name === 'NotFound'
    || value.name === 'NoSuchKey';
}

function assertValidDate(value: Date): void {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error('Storage adapter clock returned an invalid date');
  }
}
