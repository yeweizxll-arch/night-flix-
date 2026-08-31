import { createHash } from 'node:crypto';

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import sharp from 'sharp';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { generateStorageObjectKey } from '../storage/object-key';
import {
  S3_COMPATIBLE_STORAGE_ADAPTER,
  type S3CompatibleStorageAdapter,
  type StorageObjectHead,
} from '../storage/s3-compatible.adapter';
import {
  StorageCredentialCipher,
  type S3StorageCredentials,
} from '../storage/storage-credentials';
import type { AppBuildMutationMetadata } from './app-build.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_BYTES = 25 * 1024 * 1024;
const INTENT_TTL_SECONDS = 600;

type BuildAssetPurpose = 'app_icon' | 'launch_image';

export interface CreateAppBuildAssetInput {
  checksumSha256: string;
  contentType: 'image/jpeg' | 'image/png' | 'image/webp';
  providerId: string;
  purpose: BuildAssetPurpose;
  sizeBytes: number;
}

export interface AppBuildAssetUploadIntentResponse {
  completionVerificationRequired: true;
  createdAt: string;
  expiresAt: string;
  id: string;
  method: 'PUT';
  purpose: BuildAssetPurpose;
  requiredHeaders: Record<string, string>;
  sizeVerifiedOnComplete: true;
  status: 'uploading';
  uploadUrl: string;
  version: number;
}

export interface AppBuildAssetCompletionResponse {
  checksumSha256: string;
  hasAlpha: boolean;
  height: number;
  id: string;
  purpose: BuildAssetPurpose;
  sizeBytes: number;
  status: 'ready';
  version: number;
  width: number;
}

interface ProviderRow {
  bucket: string;
  credential_ciphertext: string;
  endpoint: string | null;
  id: string;
  key_version: number;
  owner_tenant_id: string | null;
  owner_type: 'platform' | 'tenant';
  version: number;
}

interface CandidateRow extends ProviderRow {
  checksum: string;
  media_version: number;
  metadata_json: unknown;
  mime_type: string;
  object_key: string;
  size_bytes: string | number | bigint;
  status: string;
}

interface UploadIntent {
  expiresAt: string;
  providerKeyVersion: number;
  providerVersion: number;
  purpose: BuildAssetPurpose;
  state: 'issued' | 'verified';
  uploadId: string;
  version: 1;
}

@Injectable()
export class AppBuildAssetService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(StorageCredentialCipher) private readonly cipher: StorageCredentialCipher,
    @Inject(S3_COMPATIBLE_STORAGE_ADAPTER)
    private readonly storage: S3CompatibleStorageAdapter,
  ) {}

  async create(
    tenantId: string,
    rawInput: CreateAppBuildAssetInput,
    metadata: AppBuildMutationMetadata,
  ): Promise<AppBuildAssetUploadIntentResponse> {
    assertUuid(tenantId, 'tenantId');
    const input = createInput(rawInput);
    mutationMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await beginCommand<AppBuildAssetUploadIntentResponse>(
        transaction, metadata, 'platform.app_build.asset.create', { input, tenantId },
      );
      if (command.cached) {
        const expiresAt = command.cached.expiresAt;
        if (typeof expiresAt !== 'string' || Date.parse(expiresAt) <= Date.now()) {
          throw new ConflictException('The cached upload URL expired; use a new Idempotency-Key');
        }
        return command.cached;
      }
      const tenants = await transaction<{ id: string }[]>`
        select id from tenants where id = ${tenantId} for share
      `;
      if (!tenants[0]) throw new NotFoundException('Merchant was not found');
      const providers = await transaction<ProviderRow[]>`
        select id, owner_type, owner_tenant_id, endpoint, bucket,
          credential_ciphertext, key_version, version
        from storage_providers where id = ${input.providerId}
          and provider = 's3' and status = 'active'
          and (
            (owner_type = 'tenant' and owner_tenant_id = ${tenantId})
            or (owner_type = 'platform' and owner_tenant_id is null)
          )
        for share
      `;
      const provider = providers[0];
      if (!provider) throw new NotFoundException('Build asset storage provider is unavailable');
      const credentials = decrypt(this.cipher, provider);
      const mediaId = uuidV7();
      const extension = input.contentType === 'image/png'
        ? 'png' : input.contentType === 'image/jpeg' ? 'jpg' : 'webp';
      const objectKey = generateStorageObjectKey('image', extension);
      const signed = await this.storage.presignConditionalPut({
        checksumSha256Base64: Buffer.from(input.checksumSha256, 'hex').toString('base64'),
        contentLength: input.sizeBytes,
        contentType: input.contentType,
        credentials,
        expiresInSeconds: INTENT_TTL_SECONDS,
        objectKey,
        target: { bucket: provider.bucket, endpoint: provider.endpoint },
        uploadId: mediaId,
      });
      validateSignedPut(signed, input);
      const intent: UploadIntent = {
        expiresAt: signed.expiresAt.toISOString(),
        providerKeyVersion: provider.key_version,
        providerVersion: provider.version,
        purpose: input.purpose,
        state: 'issued',
        uploadId: mediaId,
        version: 1,
      };
      const inserted = await transaction<Array<{ created_at: Date; version: number }>>`
        insert into media_assets (
          id, owner_type, owner_tenant_id, kind, storage_provider_id,
          object_key, mime_type, size_bytes, checksum, status,
          transcode_status, metadata_json, created_by
        ) values (
          ${mediaId}, 'tenant', ${tenantId}, 'image', ${provider.id},
          ${objectKey}, ${input.contentType}, ${input.sizeBytes},
          ${`sha256:${input.checksumSha256}`}, 'uploading', 'not_required',
          ${transaction.json(toJsonValue({ appBuildAsset: null, appBuildUpload: intent }))},
          ${metadata.actorId}
        ) returning created_at, version
      `;
      const row = inserted[0];
      if (!row) throw new Error('Build asset upload could not be created');
      const response: AppBuildAssetUploadIntentResponse = {
        completionVerificationRequired: true as const,
        createdAt: row.created_at.toISOString(),
        expiresAt: signed.expiresAt.toISOString(),
        id: mediaId,
        method: 'PUT' as const,
        purpose: input.purpose,
        requiredHeaders: signed.requiredHeaders,
        sizeVerifiedOnComplete: true as const,
        status: 'uploading',
        uploadUrl: signed.url,
        version: row.version,
      };
      await recordMutation(transaction, metadata, {
        action: 'platform.app_build.asset.upload_create',
        after: {
          contentType: input.contentType,
          providerId: provider.id,
          purpose: input.purpose,
          sizeBytes: input.sizeBytes,
          tenantId,
        },
        eventType: 'AppBuildAssetUploadCreated',
        mediaId,
        tenantId,
      });
      await completeCommand(transaction, command.id, response, mediaId, 201);
      return response;
    });
  }

  async complete(
    tenantId: string,
    mediaId: string,
    metadata: AppBuildMutationMetadata,
  ): Promise<AppBuildAssetCompletionResponse> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(mediaId, 'mediaId');
    mutationMetadata(metadata);
    const prepared = await this.database.inPlatformContext(async (transaction) => {
      const rows = await selectCandidate(transaction, tenantId, mediaId, true);
      const candidate = rows[0];
      if (!candidate) throw new NotFoundException('Build asset upload was not found');
      const intent = parseIntent(candidate.metadata_json, mediaId);
      const existing = completedResponse(candidate, intent);
      if (existing) return { candidate, existing, intent };
      if (candidate.status !== 'uploading') {
        throw new ConflictException('Build asset upload is not completable');
      }
      const credentials = decrypt(this.cipher, candidate);
      const signed = await this.storage.presignGetObject({
        credentials,
        expiresInSeconds: 180,
        objectKey: candidate.object_key,
        target: { bucket: candidate.bucket, endpoint: candidate.endpoint },
      });
      safeHttps(signed.url);
      return { candidate, credentials, intent, signedUrl: signed.url };
    });
    if (prepared.existing) return prepared.existing;
    const expectedSize = safeInteger(prepared.candidate.size_bytes, 'sizeBytes', 1, MAX_BYTES);
    const head = await this.storage.headObject({
      credentials: prepared.credentials!,
      objectKey: prepared.candidate.object_key,
      target: { bucket: prepared.candidate.bucket, endpoint: prepared.candidate.endpoint },
    });
    verifyHead(head, prepared.candidate, expectedSize);
    const bytes = await downloadExact(
      prepared.signedUrl!, expectedSize, prepared.candidate.checksum,
    );
    let probe: Awaited<ReturnType<typeof probeBuildImage>>;
    try {
      probe = await probeBuildImage(bytes, prepared.intent.purpose);
    } finally {
      bytes.fill(0);
    }

    return this.database.inPlatformContext(async (transaction) => {
      const command = await beginCommand<AppBuildAssetCompletionResponse>(
        transaction, metadata, 'platform.app_build.asset.complete', { mediaId, tenantId },
      );
      if (command.cached) return command.cached;
      const rows = await selectCandidate(transaction, tenantId, mediaId, true);
      const locked = rows[0];
      if (!locked) throw new NotFoundException('Build asset upload was not found');
      const lockedIntent = parseIntent(locked.metadata_json, mediaId);
      const existing = completedResponse(locked, lockedIntent);
      if (existing) {
        await completeCommand(transaction, command.id, existing, mediaId, 200);
        return existing;
      }
      if (locked.status !== 'uploading'
        || locked.media_version !== prepared.candidate.media_version
        || locked.version !== prepared.candidate.version
        || locked.key_version !== prepared.candidate.key_version
        || locked.checksum !== prepared.candidate.checksum
        || locked.object_key !== prepared.candidate.object_key) {
        throw new ConflictException('Build asset upload changed during verification');
      }
      const validatedAt = new Date().toISOString();
      const updated = await transaction<{ version: number }[]>`
        update media_assets set status = 'ready', transcode_status = 'not_required',
          metadata_json = ${transaction.json(toJsonValue({
            appBuildAsset: { ...probe, purpose: lockedIntent.purpose, validatedAt, version: 1 },
            appBuildUpload: { ...lockedIntent, state: 'verified' },
          }))},
          updated_by = ${metadata.actorId}, version = version + 1
        where id = ${mediaId} and owner_type = 'tenant' and owner_tenant_id = ${tenantId}
          and status = 'uploading' and version = ${locked.media_version}
        returning version
      `;
      if (!updated[0]) throw new ConflictException('Build asset upload changed');
      const response: AppBuildAssetCompletionResponse = {
        checksumSha256: locked.checksum.slice('sha256:'.length),
        hasAlpha: probe.hasAlpha,
        height: probe.height,
        id: mediaId,
        purpose: lockedIntent.purpose,
        sizeBytes: expectedSize,
        status: 'ready',
        version: updated[0].version,
        width: probe.width,
      };
      await recordMutation(transaction, metadata, {
        action: 'platform.app_build.asset.upload_complete',
        after: { ...response, tenantId },
        eventType: 'AppBuildAssetReady',
        mediaId,
        tenantId,
      });
      await completeCommand(transaction, command.id, response, mediaId, 200);
      return response;
    });
  }
}

function createInput(raw: unknown): CreateAppBuildAssetInput {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Build asset input is required');
  }
  const value = raw as Record<string, unknown>;
  const allowed = new Set(['checksumSha256', 'contentType', 'providerId', 'purpose', 'sizeBytes']);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new BadRequestException('Build asset input contains unsupported fields');
  }
  if (value.purpose !== 'app_icon' && value.purpose !== 'launch_image') {
    throw new BadRequestException('purpose is invalid');
  }
  if (typeof value.contentType !== 'string'
    || !['image/jpeg', 'image/png', 'image/webp'].includes(value.contentType)
    || (value.purpose === 'app_icon' && value.contentType !== 'image/png')) {
    throw new BadRequestException('contentType is invalid for purpose');
  }
  if (typeof value.checksumSha256 !== 'string' || !SHA256.test(value.checksumSha256)) {
    throw new BadRequestException('checksumSha256 is invalid');
  }
  return {
    checksumSha256: value.checksumSha256,
    contentType: value.contentType as CreateAppBuildAssetInput['contentType'],
    providerId: assertUuid(value.providerId, 'providerId'),
    purpose: value.purpose,
    sizeBytes: safeInteger(value.sizeBytes, 'sizeBytes', 1, MAX_BYTES),
  };
}

function parseIntent(raw: unknown, mediaId: string): UploadIntent {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConflictException('Build asset upload metadata is invalid');
  }
  const value = (raw as Record<string, unknown>).appBuildUpload;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictException('Build asset upload metadata is invalid');
  }
  const intent = value as Record<string, unknown>;
  if (intent.uploadId !== mediaId || intent.version !== 1
    || (intent.purpose !== 'app_icon' && intent.purpose !== 'launch_image')
    || (intent.state !== 'issued' && intent.state !== 'verified')
    || typeof intent.expiresAt !== 'string' || !Number.isFinite(Date.parse(intent.expiresAt))
    || !Number.isInteger(intent.providerKeyVersion) || !Number.isInteger(intent.providerVersion)) {
    throw new ConflictException('Build asset upload metadata is invalid');
  }
  return intent as unknown as UploadIntent;
}

function completedResponse(
  row: CandidateRow,
  intent: UploadIntent,
): AppBuildAssetCompletionResponse | undefined {
  if (row.status !== 'ready' || intent.state !== 'verified') return undefined;
  const raw = row.metadata_json as Record<string, unknown>;
  const asset = raw.appBuildAsset as Record<string, unknown> | undefined;
  if (!asset || asset.purpose !== intent.purpose
    || !Number.isInteger(asset.width) || !Number.isInteger(asset.height)
    || typeof asset.hasAlpha !== 'boolean') {
    throw new ConflictException('Build asset verification metadata is invalid');
  }
  return {
    checksumSha256: row.checksum.slice('sha256:'.length),
    hasAlpha: asset.hasAlpha as boolean,
    height: asset.height as number,
    id: intent.uploadId,
    purpose: intent.purpose,
    sizeBytes: safeInteger(row.size_bytes, 'sizeBytes', 1, MAX_BYTES),
    status: 'ready',
    version: row.media_version,
    width: asset.width as number,
  };
}

function selectCandidate(
  transaction: DatabaseTransaction,
  tenantId: string,
  mediaId: string,
  lock: boolean,
) {
  if (lock) {
    return transaction<CandidateRow[]>`
      select media.checksum, media.mime_type, media.size_bytes, media.object_key,
        media.status, media.version as media_version, media.metadata_json,
        provider.id, provider.owner_type, provider.owner_tenant_id,
        provider.endpoint, provider.bucket, provider.credential_ciphertext,
        provider.key_version, provider.version
      from media_assets as media
      inner join storage_providers as provider on provider.id = media.storage_provider_id
      where media.id = ${mediaId} and media.owner_type = 'tenant'
        and media.owner_tenant_id = ${tenantId} and media.kind = 'image'
        and media.object_key is not null and media.source_url is null
        and media.checksum is not null and media.deleted_at is null
        and provider.provider = 's3' and provider.status = 'active'
        and (
          (provider.owner_type = 'tenant' and provider.owner_tenant_id = ${tenantId})
          or (provider.owner_type = 'platform' and provider.owner_tenant_id is null)
        )
      for share of media, provider
    `;
  }
  return transaction<CandidateRow[]>`
    select media.checksum, media.mime_type, media.size_bytes, media.object_key,
      media.status, media.version as media_version, media.metadata_json,
      provider.id, provider.owner_type, provider.owner_tenant_id,
      provider.endpoint, provider.bucket, provider.credential_ciphertext,
      provider.key_version, provider.version
    from media_assets as media
    inner join storage_providers as provider on provider.id = media.storage_provider_id
    where media.id = ${mediaId} and media.owner_type = 'tenant'
      and media.owner_tenant_id = ${tenantId} and media.kind = 'image'
      and media.object_key is not null and media.source_url is null
      and media.checksum is not null and media.deleted_at is null
      and provider.provider = 's3' and provider.status = 'active'
      and (
        (provider.owner_type = 'tenant' and provider.owner_tenant_id = ${tenantId})
        or (provider.owner_type = 'platform' and provider.owner_tenant_id is null)
      )
  `;
}

async function probeBuildImage(bytes: Buffer, purpose: BuildAssetPurpose) {
  const image = await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata()
    .catch(() => undefined);
  if (!image?.width || !image.height || !image.format) {
    throw new BadRequestException('Uploaded build asset is not a decodable image');
  }
  if (purpose === 'app_icon'
    && (image.format !== 'png' || image.width !== 1024 || image.height !== 1024 || image.hasAlpha)) {
    throw new BadRequestException('App icon must be a 1024x1024 PNG without alpha');
  }
  if (purpose === 'launch_image'
    && (!['jpeg', 'png', 'webp'].includes(image.format)
      || Math.min(image.width, image.height) < 640
      || image.width > 10_000 || image.height > 10_000)) {
    throw new BadRequestException('Launch image dimensions or format are invalid');
  }
  return { hasAlpha: Boolean(image.hasAlpha), height: image.height, width: image.width };
}

async function downloadExact(url: string, size: number, checksum: string) {
  safeHttps(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(url, {
      cache: 'no-store', method: 'GET', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new ConflictException('Build asset could not be read');
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > size || total > MAX_BYTES) {
        await reader.cancel();
        throw new BadRequestException('Build asset size does not match the upload intent');
      }
      chunks.push(Buffer.from(chunk.value));
    }
    if (total !== size) throw new BadRequestException('Build asset size does not match the upload intent');
    const body = Buffer.concat(chunks, total);
    if (`sha256:${createHash('sha256').update(body).digest('hex')}` !== checksum) {
      body.fill(0);
      throw new BadRequestException('Build asset checksum does not match the upload intent');
    }
    return body;
  } catch (error) {
    if (error instanceof BadRequestException || error instanceof ConflictException) throw error;
    throw new ConflictException('Build asset could not be read');
  } finally {
    clearTimeout(timeout);
  }
}

function verifyHead(head: StorageObjectHead | { exists: false }, row: CandidateRow, size: number) {
  const expectedBase64 = Buffer.from(row.checksum.slice('sha256:'.length), 'hex').toString('base64');
  if (!head.exists || head.contentLength !== size || head.contentType !== row.mime_type
    || head.checksumSha256Base64 !== expectedBase64) {
    throw new BadRequestException('Uploaded build asset failed storage verification');
  }
}

function decrypt(cipher: StorageCredentialCipher, provider: ProviderRow): S3StorageCredentials {
  try {
    return cipher.decrypt(provider.credential_ciphertext, {
      keyVersion: provider.key_version,
      ownerTenantId: provider.owner_tenant_id,
      ownerType: provider.owner_type,
      providerId: provider.id,
    });
  } catch {
    throw new ConflictException('Build asset storage is temporarily unavailable');
  }
}

function validateSignedPut(
  signed: { expiresAt: Date; requiredHeaders: Record<string, string>; url: string },
  input: CreateAppBuildAssetInput,
) {
  safeHttps(signed.url);
  if (!(signed.expiresAt instanceof Date) || !Number.isFinite(signed.expiresAt.getTime())
    || signed.expiresAt.getTime() <= Date.now()
    || signed.expiresAt.getTime() > Date.now() + (INTENT_TTL_SECONDS + 5) * 1_000
    || signed.requiredHeaders['content-length'] !== String(input.sizeBytes)
    || signed.requiredHeaders['content-type'] !== input.contentType
    || signed.requiredHeaders['if-none-match'] !== '*') {
    throw new ConflictException('Storage returned an invalid upload intent');
  }
}

async function beginCommand<T>(
  transaction: DatabaseTransaction,
  metadata: AppBuildMutationMetadata,
  routeKey: string,
  request: unknown,
): Promise<{ cached?: T; id: string }> {
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const id = uuidV7();
  const inserted = await transaction<{ id: string }[]>`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, expires_at
    ) values (
      ${id}, 'platform', null, 'platform_staff', ${metadata.actorId}, ${routeKey},
      ${metadata.idempotencyKey}, ${requestHash}, statement_timestamp() + interval '24 hours'
    ) on conflict do nothing returning id
  `;
  if (inserted[0]) return { id };
  const rows = await transaction<Array<{
    id: string; request_hash: string; response_json: unknown; status: string;
  }>>`
    select id, request_hash, response_json, status from command_idempotency
    where scope_type = 'platform' and tenant_id is null
      and actor_type = 'platform_staff' and actor_id = ${metadata.actorId}
      and route_key = ${routeKey} and idempotency_key = ${metadata.idempotencyKey}
    for update
  `;
  const row = rows[0];
  if (!row || row.request_hash !== requestHash) {
    throw new ConflictException('Idempotency-Key was already used for another request');
  }
  if (row.status === 'completed' && row.response_json !== null) {
    return { cached: row.response_json as T, id: row.id };
  }
  throw new ConflictException('The same command is already processing');
}

async function completeCommand(
  transaction: DatabaseTransaction,
  commandId: string,
  response: unknown,
  mediaId: string,
  status: number,
) {
  const rows = await transaction<{ id: string }[]>`
    update command_idempotency set status = 'completed', response_status = ${status},
      response_json = ${transaction.json(toJsonValue(response))}, resource_type = 'media_asset',
      resource_id = ${mediaId}, locked_at = null
    where id = ${commandId} and status = 'processing' returning id
  `;
  if (!rows[0]) throw new ConflictException('Upload command changed unexpectedly');
}

async function recordMutation(
  transaction: DatabaseTransaction,
  metadata: AppBuildMutationMetadata,
  input: { action: string; after: object; eventType: string; mediaId: string; tenantId: string },
) {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, ip, request_id
    ) values (
      ${uuidV7()}, 'platform', null, 'platform_staff', ${metadata.actorId}, ${input.action},
      'media_asset', ${input.mediaId}, ${transaction.json(toJsonValue(input.after))},
      ${metadata.ip ?? null}, ${metadata.requestId}
    )
  `;
  const eventId = uuidV7();
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key,
      aggregate_type, aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, 'platform', null, ${`event:${eventId}`},
      ${`${metadata.requestId}:${input.eventType}`}, 'media_asset', ${input.mediaId},
      ${input.eventType}, ${transaction.json(toJsonValue({
        id: input.mediaId, tenantId: input.tenantId,
      }))}
    )
  `;
}

function mutationMetadata(value: AppBuildMutationMetadata) {
  assertUuid(value.actorId, 'actorId');
  assertUuid(value.requestId, 'requestId');
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value.idempotencyKey)) {
    throw new BadRequestException('A valid Idempotency-Key is required');
  }
}

function safeInteger(raw: unknown, field: string, minimum: number, maximum: number) {
  if (typeof raw !== 'number' && typeof raw !== 'string' && typeof raw !== 'bigint') {
    throw new BadRequestException(`${field} is invalid`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

function assertUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

function safeHttps(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConflictException('Storage URL is invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) {
    throw new ConflictException('Storage URL is invalid');
  }
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
