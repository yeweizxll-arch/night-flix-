import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { generateStorageObjectKey } from './object-key';
import {
  S3_COMPATIBLE_STORAGE_ADAPTER,
  type PresignedConditionalPut,
  type S3CompatibleStorageAdapter,
  type StorageObjectHead,
} from './s3-compatible.adapter';
import {
  StorageCredentialCipher,
  type S3StorageCredentials,
} from './storage-credentials';

const PRESIGN_TTL_SECONDS = 600;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const UPLOAD_POLICIES = {
  file: {
    maximumBytes: 100 * 1_024 ** 2,
    mimeTypes: new Set([
      'application/json',
      'application/zip',
      'text/csv',
      'text/plain',
    ]),
  },
  image: {
    maximumBytes: 25 * 1_024 ** 2,
    mimeTypes: new Set([
      'image/avif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]),
  },
  video: {
    maximumBytes: 2 * 1_024 ** 3,
    mimeTypes: new Set([
      'video/mp4',
      'video/quicktime',
      'video/webm',
    ]),
  },
} as const;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CreateStorageUploadIntentInput {
  checksumSha256: string;
  contentType: string;
  extension?: string;
  kind: 'file' | 'image' | 'video';
  providerId: string;
  sizeBytes: number;
}

export interface StorageMutationMetadata {
  actorId: string;
  idempotencyKey?: string;
  ip?: string;
  requestId: string;
}

export interface StorageUploadIntentResult {
  completionVerificationRequired: true;
  createdAt: string;
  expiresAt: string;
  id: string;
  method: 'PUT';
  objectKey: string;
  requiredHeaders: Record<string, string>;
  sizeVerifiedOnComplete: true;
  status: string;
  uploadUrl: string;
  version: number;
}

interface StorageProviderRow {
  bucket: string;
  credential_ciphertext: string;
  endpoint: string | null;
  id: string;
  key_version: number;
  owner_tenant_id: string | null;
  owner_type: 'platform' | 'tenant';
  provider: string;
  version: number;
}

interface CompletionRow extends StorageProviderRow {
  checksum: string;
  kind: 'file' | 'image' | 'video';
  media_status: string;
  media_version: number;
  metadata_json: unknown;
  mime_type: string;
  object_key: string;
  size_bytes_text: string;
  storage_provider_id: string;
  transcode_status: string;
}

interface UploadIntentMetadata {
  expiresAt: string;
  providerKeyVersion: number;
  providerVersion: number;
  state: 'issued' | 'verified';
  uploadId: string;
  version: 1;
}

interface ParsedCompletion {
  expectedChecksumHex: string;
  expectedChecksumStorage: string;
  expectedContentType: string;
  expectedSizeBytes: number;
  intent: UploadIntentMetadata;
}

@Injectable()
export class StorageUploadService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(StorageCredentialCipher)
    private readonly credentialCipher: StorageCredentialCipher,
    @Inject(S3_COMPATIBLE_STORAGE_ADAPTER)
    private readonly adapter: S3CompatibleStorageAdapter,
  ) {}

  async createPlatformUploadIntent(
    rawInput: CreateStorageUploadIntentInput,
    metadata: StorageMutationMetadata,
  ): Promise<StorageUploadIntentResult> {
    assertMutationMetadata(metadata);
    const input = validateCreateInput(rawInput);
    const checksumSha256Base64 = Buffer.from(input.checksumSha256, 'hex').toString('base64');

    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginPlatformCommand<StorageUploadIntentResult>(
        transaction,
        'platform.content.media.upload_create',
        input,
        metadata,
      );
      if (command.cached !== undefined) {
        if (Date.parse(command.cached.expiresAt) <= Date.now()) {
          throw new ConflictException(
            'The cached upload URL expired; retry with a new Idempotency-Key',
          );
        }
        return command.cached;
      }

      const mediaId = uuidV7();
      const objectKey = generateStorageObjectKey(input.kind, input.extension);
      const providers = await transaction<StorageProviderRow[]>`
        select
          id, owner_type, owner_tenant_id, provider, endpoint, bucket,
          credential_ciphertext, key_version, version
        from storage_providers
        where id = ${input.providerId} and owner_type = 'platform'
          and owner_tenant_id is null and provider = 's3' and status = 'active'
        for share
      `;
      const provider = providers[0];
      if (!provider) throw new NotFoundException('Platform S3 provider is unavailable');
      const credentials = this.decryptProviderCredentials(provider);
      const presigned = await this.adapter.presignConditionalPut({
        checksumSha256Base64,
        contentLength: input.sizeBytes,
        contentType: input.contentType,
        credentials,
        expiresInSeconds: PRESIGN_TTL_SECONDS,
        objectKey,
        target: { bucket: provider.bucket, endpoint: provider.endpoint },
        uploadId: mediaId,
      });
      assertPresignedIntent(presigned, {
        checksumSha256Base64,
        contentLength: input.sizeBytes,
        contentType: input.contentType,
        uploadId: mediaId,
      });
      const uploadIntent: UploadIntentMetadata = {
        expiresAt: presigned.expiresAt.toISOString(),
        providerKeyVersion: provider.key_version,
        providerVersion: provider.version,
        state: 'issued',
        uploadId: mediaId,
        version: 1,
      };
      const rows = await transaction<
        Array<{ created_at: Date; id: string; status: string; version: number }>
      >`
        insert into media_assets (
          id, owner_type, owner_tenant_id, kind, storage_provider_id,
          object_key, mime_type, size_bytes, checksum, status,
          transcode_status, metadata_json, created_by
        ) values (
          ${mediaId}, 'platform', null, ${input.kind}, ${provider.id},
          ${objectKey}, ${input.contentType}, ${input.sizeBytes},
          ${`sha256:${input.checksumSha256}`}, 'uploading', 'not_required',
          ${transaction.json(toJsonValue({ uploadIntent, uploadVerification: null }))},
          ${metadata.actorId}
        ) returning id, status, version, created_at
      `;
      const row = rows[0];
      if (!row) throw new Error('Platform upload intent could not be persisted');
      await insertPlatformAudit(transaction, metadata, {
        action: 'platform.content.media.upload.intent_create',
        after: {
          checksumAlgorithm: 'sha256',
          contentType: input.contentType,
          providerId: provider.id,
          sizeBytes: input.sizeBytes,
        },
        resourceId: mediaId,
      });
      const eventId = uuidV7();
      await transaction`
        insert into outbox_events (
          id, scope_type, tenant_id, event_key, idempotency_key,
          aggregate_type, aggregate_id, event_type, payload_json
        ) values (
          ${eventId}, 'platform', null, ${`event:${eventId}`},
          ${`platform-upload-create:${mediaId}`}, 'media_asset', ${mediaId},
          'PlatformMediaUploadCreated',
          ${transaction.json(toJsonValue({ kind: input.kind, mediaId }))}
        )
      `;
      const response: StorageUploadIntentResult = {
        completionVerificationRequired: true,
        createdAt: row.created_at.toISOString(),
        expiresAt: presigned.expiresAt.toISOString(),
        id: row.id,
        method: 'PUT',
        objectKey,
        requiredHeaders: presigned.requiredHeaders,
        sizeVerifiedOnComplete: true,
        status: row.status,
        uploadUrl: presigned.url,
        version: row.version,
      };
      await this.completePlatformCommand(transaction, command.id, response, 201, mediaId);
      return response;
    });
  }

  async completePlatformUpload(
    mediaId: string,
    metadata: StorageMutationMetadata,
  ) {
    assertUuid(mediaId, 'mediaId');
    assertMutationMetadata(metadata);
    requireIdempotencyKey(metadata);

    const candidate = await this.database.inPlatformContext(async (transaction) => {
      const rows = await this.selectPlatformCompletionRows(transaction, mediaId, false);
      return rows[0];
    });
    if (!candidate) throw new NotFoundException('Platform upload intent not found');
    const parsed = parseCompletion(candidate, mediaId);
    const completed = completedResponse(candidate, parsed);
    if (completed) {
      return this.database.inPlatformContext(async (transaction) => {
        const command = await this.beginPlatformCommand<typeof completed>(
          transaction,
          'platform.content.media.upload_complete',
          { mediaId },
          metadata,
        );
        if (command.cached !== undefined) return command.cached;
        const lockedRows = await this.selectPlatformCompletionRows(transaction, mediaId, true);
        const locked = lockedRows[0];
        if (!locked) throw new NotFoundException('Platform upload intent not found');
        const result = completedResponse(locked, parseCompletion(locked, mediaId));
        if (!result) throw new ConflictException('Platform upload completion changed');
        await this.completePlatformCommand(transaction, command.id, result, 200, mediaId);
        return result;
      });
    }
    if (candidate.media_status !== 'uploading') {
      throw new ConflictException('Platform upload intent is not completable');
    }
    const credentials = this.decryptProviderCredentials(candidate);
    const head = await this.adapter.headObject({
      credentials,
      objectKey: candidate.object_key,
      target: { bucket: candidate.bucket, endpoint: candidate.endpoint },
    });
    if (!head.exists) throw new ConflictException('Uploaded object was not found');
    verifyHead(head, candidate, parsed);

    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginPlatformCommand<ReturnType<typeof completedResponse>>(
        transaction,
        'platform.content.media.upload_complete',
        { mediaId },
        metadata,
      );
      if (command.cached !== undefined) return command.cached;
      const rows = await this.selectPlatformCompletionRows(transaction, mediaId, true);
      const locked = rows[0];
      if (!locked) throw new NotFoundException('Platform upload intent not found');
      const lockedParsed = parseCompletion(locked, mediaId);
      const alreadyCompleted = completedResponse(locked, lockedParsed);
      if (alreadyCompleted) {
        await this.completePlatformCommand(
          transaction,
          command.id,
          alreadyCompleted,
          200,
          mediaId,
        );
        return alreadyCompleted;
      }
      assertUnchangedCandidate(candidate, locked);
      if (locked.media_status !== 'uploading') {
        throw new ConflictException('Platform upload intent is not completable');
      }
      const verification = {
        checksumSha256: lockedParsed.expectedChecksumHex,
        contentType: lockedParsed.expectedContentType,
        etag: head.etag,
        objectKey: locked.object_key,
        sizeBytes: lockedParsed.expectedSizeBytes,
        uploadId: lockedParsed.intent.uploadId,
        verifiedAt: new Date().toISOString(),
        versionId: head.versionId,
      };
      const updated = await transaction<Array<{ status: string; version: number }>>`
        update media_assets set status = 'ready', transcode_status = 'not_required',
          metadata_json = ${transaction.json(toJsonValue({
            uploadIntent: { ...lockedParsed.intent, state: 'verified' },
            uploadVerification: verification,
          }))}, updated_by = ${metadata.actorId}, version = version + 1
        where id = ${mediaId} and owner_type = 'platform'
          and owner_tenant_id is null and status = 'uploading'
          and version = ${locked.media_version}
        returning status, version
      `;
      const result = updated[0];
      if (!result) throw new ConflictException('Platform upload changed during completion');
      await insertPlatformAudit(transaction, metadata, {
        action: 'platform.content.media.upload.complete',
        after: {
          checksumSha256: lockedParsed.expectedChecksumHex,
          etag: head.etag,
          sizeBytes: lockedParsed.expectedSizeBytes,
          status: result.status,
        },
        resourceId: mediaId,
      });
      const eventId = uuidV7();
      await transaction`
        insert into outbox_events (
          id, scope_type, tenant_id, event_key, idempotency_key,
          aggregate_type, aggregate_id, event_type, payload_json
        ) values (
          ${eventId}, 'platform', null, ${`event:${eventId}`},
          ${`platform-upload-complete:${mediaId}`}, 'media_asset', ${mediaId},
          'PlatformMediaUploadCompleted',
          ${transaction.json(toJsonValue({ mediaId }))}
        )
      `;
      const response = {
        checksumSha256: lockedParsed.expectedChecksumHex,
        etag: head.etag,
        id: mediaId,
        sizeBytes: lockedParsed.expectedSizeBytes,
        status: result.status,
        version: result.version,
      };
      await this.completePlatformCommand(transaction, command.id, response, 200, mediaId);
      return response;
    });
  }

  async createTenantUploadIntent(
    tenantId: string,
    rawInput: CreateStorageUploadIntentInput,
    metadata: StorageMutationMetadata,
  ): Promise<StorageUploadIntentResult> {
    assertUuid(tenantId, 'tenantId');
    assertMutationMetadata(metadata);
    const input = validateCreateInput(rawInput);
    const checksumSha256Base64 = Buffer.from(input.checksumSha256, 'hex').toString('base64');

    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCreateCommand(
        transaction,
        tenantId,
        input,
        metadata,
      );
      if (command.cached !== undefined) {
        if (Date.parse(command.cached.expiresAt) <= Date.now()) {
          throw new ConflictException(
            'The cached upload URL expired; retry with a new Idempotency-Key',
          );
        }
        return command.cached;
      }

      const mediaId = uuidV7();
      const objectKey = generateStorageObjectKey(input.kind, input.extension);
      const providers = await transaction<StorageProviderRow[]>`
        select
          id, owner_type, owner_tenant_id, provider, endpoint, bucket,
          credential_ciphertext, key_version, version
        from storage_providers
        where id = ${input.providerId}
          and status = 'active'
          and (
            (owner_type = 'tenant' and owner_tenant_id = ${tenantId})
            or (owner_type = 'platform' and owner_tenant_id is null)
          )
        for share
      `;
      const provider = providers[0];
      if (!provider) throw new NotFoundException('Storage provider is unavailable');
      const credentials = this.decryptProviderCredentials(provider);
      const presigned = await this.adapter.presignConditionalPut({
        checksumSha256Base64,
        contentLength: input.sizeBytes,
        contentType: input.contentType,
        credentials,
        expiresInSeconds: PRESIGN_TTL_SECONDS,
        objectKey,
        target: { bucket: provider.bucket, endpoint: provider.endpoint },
        uploadId: mediaId,
      });
      assertPresignedIntent(presigned, {
        checksumSha256Base64,
        contentLength: input.sizeBytes,
        contentType: input.contentType,
        uploadId: mediaId,
      });
      const uploadIntent: UploadIntentMetadata = {
        expiresAt: presigned.expiresAt.toISOString(),
        providerKeyVersion: provider.key_version,
        providerVersion: provider.version,
        state: 'issued',
        uploadId: mediaId,
        version: 1,
      };
      const rows = await transaction<
        Array<{ created_at: Date; id: string; status: string; version: number }>
      >`
        insert into media_assets (
          id, owner_type, owner_tenant_id, kind, storage_provider_id,
          object_key, mime_type, size_bytes, checksum, status,
          transcode_status, metadata_json, created_by
        ) values (
          ${mediaId}, 'tenant', ${tenantId}, ${input.kind}, ${provider.id},
          ${objectKey}, ${input.contentType}, ${input.sizeBytes},
          ${`sha256:${input.checksumSha256}`}, 'uploading',
          'not_required',
          ${transaction.json(toJsonValue({
            uploadIntent,
            uploadVerification: null,
          }))},
          ${metadata.actorId}
        )
        returning id, status, version, created_at
      `;
      const row = rows[0];
      if (!row) throw new Error('Upload intent could not be persisted');
      await insertAudit(transaction, tenantId, metadata, {
        action: 'storage.upload.intent_create',
        after: {
          checksumAlgorithm: 'sha256',
          contentType: input.contentType,
          providerId: provider.id,
          sizeBytes: input.sizeBytes,
        },
        resourceId: mediaId,
      });
      const response: StorageUploadIntentResult = {
        completionVerificationRequired: true,
        createdAt: row.created_at.toISOString(),
        expiresAt: presigned.expiresAt.toISOString(),
        id: row.id,
        method: 'PUT' as const,
        objectKey,
        requiredHeaders: presigned.requiredHeaders,
        sizeVerifiedOnComplete: true,
        status: row.status,
        uploadUrl: presigned.url,
        version: row.version,
      };
      await this.completeCreateCommand(transaction, command.id, response, mediaId);
      return response;
    });
  }

  async completeTenantUpload(
    tenantId: string,
    mediaId: string,
    metadata: StorageMutationMetadata,
  ) {
    assertUuid(tenantId, 'tenantId');
    assertUuid(mediaId, 'mediaId');
    assertMutationMetadata(metadata);

    const candidate = await this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await this.selectCompletionRows(transaction, tenantId, mediaId, false);
      return rows[0];
    });
    if (!candidate) throw new NotFoundException('Upload intent not found');
    const parsed = parseCompletion(candidate, mediaId);
    const completed = completedResponse(candidate, parsed);
    if (completed) return completed;
    if (candidate.media_status !== 'uploading') {
      throw new ConflictException('Upload intent is not completable');
    }

    const credentials = this.decryptProviderCredentials(candidate);
    const head = await this.adapter.headObject({
      credentials,
      objectKey: candidate.object_key,
      target: { bucket: candidate.bucket, endpoint: candidate.endpoint },
    });
    if (!head.exists) throw new ConflictException('Uploaded object was not found');
    verifyHead(head, candidate, parsed);

    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await this.selectCompletionRows(transaction, tenantId, mediaId, true);
      const locked = rows[0];
      if (!locked) throw new NotFoundException('Upload intent not found');
      const lockedParsed = parseCompletion(locked, mediaId);
      const alreadyCompleted = completedResponse(locked, lockedParsed);
      if (alreadyCompleted) return alreadyCompleted;
      assertUnchangedCandidate(candidate, locked);
      if (locked.media_status !== 'uploading') {
        throw new ConflictException('Upload intent is not completable');
      }

      const targetStatus = 'ready';
      const verification = {
        checksumSha256: lockedParsed.expectedChecksumHex,
        contentType: lockedParsed.expectedContentType,
        etag: head.etag,
        objectKey: locked.object_key,
        sizeBytes: lockedParsed.expectedSizeBytes,
        uploadId: lockedParsed.intent.uploadId,
        verifiedAt: new Date().toISOString(),
        versionId: head.versionId,
      };
      const updated = await transaction<Array<{ status: string; version: number }>>`
        update media_assets
        set
          status = ${targetStatus},
          transcode_status = 'not_required',
          metadata_json = ${transaction.json(toJsonValue({
            uploadIntent: { ...lockedParsed.intent, state: 'verified' },
            uploadVerification: verification,
          }))},
          updated_by = ${metadata.actorId},
          version = version + 1
        where id = ${mediaId}
          and owner_type = 'tenant'
          and owner_tenant_id = ${tenantId}
          and status = 'uploading'
          and version = ${locked.media_version}
        returning status, version
      `;
      const result = updated[0];
      if (!result) throw new ConflictException('Upload intent changed during completion');
      await insertAudit(transaction, tenantId, metadata, {
        action: 'storage.upload.complete',
        after: {
          checksumSha256: lockedParsed.expectedChecksumHex,
          etag: head.etag,
          sizeBytes: lockedParsed.expectedSizeBytes,
          status: result.status,
        },
        resourceId: mediaId,
      });
      const eventId = uuidV7();
      await transaction`
        insert into outbox_events (
          id, scope_type, tenant_id, event_key, idempotency_key,
          aggregate_type, aggregate_id, event_type, payload_json
        ) values (
          ${eventId}, 'tenant', ${tenantId}, ${`event:${eventId}`},
          ${`storage-upload-complete:${mediaId}`}, 'media_asset', ${mediaId},
          'MediaUploadCompleted',
          ${transaction.json(toJsonValue({ mediaId, tenantId }))}
        )
      `;
      return {
        checksumSha256: lockedParsed.expectedChecksumHex,
        etag: head.etag,
        id: mediaId,
        sizeBytes: lockedParsed.expectedSizeBytes,
        status: result.status,
        version: result.version,
      };
    });
  }

  private decryptProviderCredentials(provider: StorageProviderRow): S3StorageCredentials {
    return this.credentialCipher.decrypt(provider.credential_ciphertext, {
      keyVersion: provider.key_version,
      ownerTenantId: provider.owner_tenant_id,
      ownerType: provider.owner_type,
      providerId: provider.id,
    });
  }

  private async beginPlatformCommand<T>(
    transaction: DatabaseTransaction,
    routeKey: string,
    request: unknown,
    metadata: StorageMutationMetadata,
  ): Promise<{ cached?: T; id: string }> {
    const key = requireIdempotencyKey(metadata);
    const requestHash = createHash('sha256')
      .update(JSON.stringify(toJsonValue(request)))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, 'platform', null, 'platform_staff', ${metadata.actorId},
        ${routeKey}, ${key}, ${requestHash}, statement_timestamp() + interval '24 hours'
      ) on conflict do nothing returning id
    `;
    if (inserted[0]) return { id };
    const rows = await transaction<Array<{
      id: string; request_hash: string; response_json: unknown; status: string;
    }>>`
      select id, request_hash, status, response_json from command_idempotency
      where scope_type = 'platform' and tenant_id is null
        and actor_type = 'platform_staff' and actor_id = ${metadata.actorId}
        and route_key = ${routeKey} and idempotency_key = ${key}
      for update
    `;
    const existing = rows[0];
    if (!existing) throw new ConflictException('Idempotency record is unavailable');
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used for another request');
    }
    if (existing.status === 'completed' && existing.response_json !== null) {
      return { cached: existing.response_json as T, id: existing.id };
    }
    throw new ConflictException('The same command is already processing');
  }

  private async completePlatformCommand(
    transaction: DatabaseTransaction,
    commandId: string,
    response: unknown,
    responseStatus: number,
    mediaId: string,
  ): Promise<void> {
    const updated = await transaction<{ id: string }[]>`
      update command_idempotency set status = 'completed',
        response_status = ${responseStatus},
        response_json = ${transaction.json(toJsonValue(response))},
        resource_type = 'media_asset', resource_id = ${mediaId}, locked_at = null
      where id = ${commandId} and status = 'processing' returning id
    `;
    if (!updated[0]) throw new ConflictException('Idempotency command changed unexpectedly');
  }

  private selectPlatformCompletionRows(
    transaction: DatabaseTransaction,
    mediaId: string,
    forUpdate: boolean,
  ): Promise<CompletionRow[]> {
    if (forUpdate) {
      return transaction<CompletionRow[]>`
        select media.kind, media.storage_provider_id, media.object_key,
          media.mime_type, media.size_bytes::text as size_bytes_text,
          media.checksum, media.status as media_status, media.transcode_status,
          media.metadata_json, media.version as media_version,
          provider.id, provider.owner_type, provider.owner_tenant_id,
          provider.provider, provider.endpoint, provider.bucket,
          provider.credential_ciphertext, provider.key_version, provider.version
        from media_assets as media
        inner join storage_providers as provider on provider.id = media.storage_provider_id
        where media.id = ${mediaId} and media.owner_type = 'platform'
          and media.owner_tenant_id is null and media.deleted_at is null
          and provider.owner_type = 'platform' and provider.owner_tenant_id is null
          and provider.provider = 's3' and provider.status = 'active'
        for update of media, provider
      `;
    }
    return transaction<CompletionRow[]>`
      select media.kind, media.storage_provider_id, media.object_key,
        media.mime_type, media.size_bytes::text as size_bytes_text,
        media.checksum, media.status as media_status, media.transcode_status,
        media.metadata_json, media.version as media_version,
        provider.id, provider.owner_type, provider.owner_tenant_id,
        provider.provider, provider.endpoint, provider.bucket,
        provider.credential_ciphertext, provider.key_version, provider.version
      from media_assets as media
      inner join storage_providers as provider on provider.id = media.storage_provider_id
      where media.id = ${mediaId} and media.owner_type = 'platform'
        and media.owner_tenant_id is null and media.deleted_at is null
        and provider.owner_type = 'platform' and provider.owner_tenant_id is null
        and provider.provider = 's3' and provider.status = 'active'
    `;
  }

  private async beginCreateCommand(
    transaction: DatabaseTransaction,
    tenantId: string,
    request: CreateStorageUploadIntentInput,
    metadata: StorageMutationMetadata,
  ): Promise<{ cached?: StorageUploadIntentResult; id?: string }> {
    const key = metadata.idempotencyKey?.trim();
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw new BadRequestException('A valid Idempotency-Key is required');
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify(toJsonValue(request)))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, 'tenant', ${tenantId}, 'tenant_staff', ${metadata.actorId},
        'tenant.content.media.upload_create', ${key}, ${requestHash},
        statement_timestamp() + interval '24 hours'
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) return { id };
    const rows = await transaction<
      Array<{ request_hash: string; response_json: unknown; status: string }>
    >`
      select request_hash, status, response_json
      from command_idempotency
      where scope_type = 'tenant'
        and tenant_id = ${tenantId}
        and actor_type = 'tenant_staff'
        and actor_id = ${metadata.actorId}
        and route_key = 'tenant.content.media.upload_create'
        and idempotency_key = ${key}
      for update
    `;
    const existing = rows[0];
    if (!existing) throw new ConflictException('Idempotency record is unavailable');
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used for another request');
    }
    if (existing.status === 'completed' && existing.response_json !== null) {
      return { cached: parseCachedUploadIntent(existing.response_json) };
    }
    throw new ConflictException('The same command is already processing');
  }

  private async completeCreateCommand(
    transaction: DatabaseTransaction,
    commandId: string | undefined,
    response: StorageUploadIntentResult,
    mediaId: string,
  ): Promise<void> {
    if (!commandId) throw new Error('Upload idempotency command is missing');
    const updated = await transaction<{ id: string }[]>`
      update command_idempotency
      set
        status = 'completed',
        response_status = 201,
        response_json = ${transaction.json(toJsonValue(response))},
        resource_type = 'media_asset',
        resource_id = ${mediaId},
        locked_at = null
      where id = ${commandId} and status = 'processing'
      returning id
    `;
    if (!updated[0]) throw new ConflictException('Idempotency command changed unexpectedly');
  }

  private selectCompletionRows(
    transaction: DatabaseTransaction,
    tenantId: string,
    mediaId: string,
    forUpdate: boolean,
  ): Promise<CompletionRow[]> {
    if (forUpdate) {
      return transaction<CompletionRow[]>`
        select
          media.kind, media.storage_provider_id, media.object_key,
          media.mime_type, media.size_bytes::text as size_bytes_text,
          media.checksum, media.status as media_status,
          media.transcode_status, media.metadata_json, media.version as media_version,
          provider.id, provider.owner_type, provider.owner_tenant_id,
          provider.provider, provider.endpoint, provider.bucket,
          provider.credential_ciphertext, provider.key_version, provider.version
        from media_assets as media
        inner join storage_providers as provider on provider.id = media.storage_provider_id
        where media.id = ${mediaId}
          and media.owner_type = 'tenant'
          and media.owner_tenant_id = ${tenantId}
          and media.deleted_at is null
          and provider.status = 'active'
          and (
            (provider.owner_type = 'tenant' and provider.owner_tenant_id = ${tenantId})
            or (provider.owner_type = 'platform' and provider.owner_tenant_id is null)
          )
        for update of media, provider
      `;
    }
    return transaction<CompletionRow[]>`
      select
        media.kind, media.storage_provider_id, media.object_key,
        media.mime_type, media.size_bytes::text as size_bytes_text,
        media.checksum, media.status as media_status,
        media.transcode_status, media.metadata_json, media.version as media_version,
        provider.id, provider.owner_type, provider.owner_tenant_id,
        provider.provider, provider.endpoint, provider.bucket,
        provider.credential_ciphertext, provider.key_version, provider.version
      from media_assets as media
      inner join storage_providers as provider on provider.id = media.storage_provider_id
      where media.id = ${mediaId}
        and media.owner_type = 'tenant'
        and media.owner_tenant_id = ${tenantId}
        and media.deleted_at is null
        and provider.status = 'active'
        and (
          (provider.owner_type = 'tenant' and provider.owner_tenant_id = ${tenantId})
          or (provider.owner_type = 'platform' and provider.owner_tenant_id is null)
        )
    `;
  }
}

function validateCreateInput(
  value: CreateStorageUploadIntentInput,
): CreateStorageUploadIntentInput {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  assertUuid(value.providerId, 'providerId');
  if (value.kind !== 'file' && value.kind !== 'image' && value.kind !== 'video') {
    throw new BadRequestException('kind is invalid');
  }
  const policy = UPLOAD_POLICIES[value.kind];
  if (
    !Number.isSafeInteger(value.sizeBytes)
    || value.sizeBytes < 1
    || value.sizeBytes > policy.maximumBytes
  ) throw new BadRequestException('sizeBytes exceeds the limit for this media kind');
  if (
    typeof value.contentType !== 'string'
    || value.contentType.length > 200
    || !/^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(value.contentType)
  ) {
    throw new BadRequestException('contentType is invalid');
  }
  if (!(policy.mimeTypes as ReadonlySet<string>).has(value.contentType)) {
    throw new BadRequestException('contentType is not allowed for this media kind');
  }
  if (typeof value.checksumSha256 !== 'string' || !SHA256_HEX_PATTERN.test(value.checksumSha256)) {
    throw new BadRequestException('checksumSha256 must be lowercase hexadecimal SHA-256');
  }
  if (
    value.extension !== undefined
    && (typeof value.extension !== 'string' || value.extension.length > 17)
  ) {
    throw new BadRequestException('extension is invalid');
  }
  return {
    checksumSha256: value.checksumSha256,
    contentType: value.contentType,
    extension: value.extension,
    kind: value.kind,
    providerId: value.providerId,
    sizeBytes: value.sizeBytes,
  };
}

function parseCachedUploadIntent(value: unknown): StorageUploadIntentResult {
  const record = asRecord(value);
  if (
    record.completionVerificationRequired !== true
    || typeof record.createdAt !== 'string'
    || !Number.isFinite(Date.parse(record.createdAt))
    || typeof record.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(record.expiresAt))
    || typeof record.id !== 'string'
    || !UUID_PATTERN.test(record.id)
    || record.method !== 'PUT'
    || typeof record.objectKey !== 'string'
    || typeof record.requiredHeaders !== 'object'
    || record.requiredHeaders === null
    || Array.isArray(record.requiredHeaders)
    || record.sizeVerifiedOnComplete !== true
    || typeof record.status !== 'string'
    || typeof record.uploadUrl !== 'string'
    || !Number.isInteger(record.version)
  ) {
    throw new ConflictException('Cached upload response is invalid');
  }
  return record as unknown as StorageUploadIntentResult;
}

function assertPresignedIntent(
  presigned: PresignedConditionalPut,
  expected: {
    checksumSha256Base64: string;
    contentLength: number;
    contentType: string;
    uploadId: string;
  },
): void {
  if (!(presigned.expiresAt instanceof Date) || !Number.isFinite(presigned.expiresAt.getTime())) {
    throw new Error('Storage adapter returned an invalid expiry');
  }
  let url: URL;
  try {
    url = new URL(presigned.url);
  } catch {
    throw new Error('Storage adapter returned an invalid URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new Error('Storage adapter returned an unsafe URL');
  }
  const headers = Object.fromEntries(
    Object.entries(presigned.requiredHeaders).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const signed = new Set(presigned.signedHeaders.map((header) => header.toLowerCase()));
  const required = {
    'content-type': expected.contentType,
    'if-none-match': '*',
    'x-amz-checksum-sha256': expected.checksumSha256Base64,
    'x-amz-meta-upload-id': expected.uploadId,
  };
  for (const [name, value] of Object.entries(required)) {
    if (headers[name] !== value || !signed.has(name)) {
      throw new Error(`Storage adapter did not bind required upload header ${name}`);
    }
  }
  if (headers['content-length'] !== String(expected.contentLength)) {
    throw new Error('Storage adapter returned the wrong content length');
  }
  if (presigned.contentLengthRequiresHeadVerification !== true) {
    throw new Error('Storage adapter must require completion size verification');
  }
}

function parseCompletion(row: CompletionRow, mediaId: string): ParsedCompletion {
  if (
    row.storage_provider_id !== row.id
    || !row.object_key
    || !row.mime_type
    || !row.checksum?.startsWith('sha256:')
  ) {
    throw new ConflictException('Upload intent binding is invalid');
  }
  const expectedChecksumHex = row.checksum.slice('sha256:'.length);
  const expectedSizeBytes = Number(row.size_bytes_text);
  if (!SHA256_HEX_PATTERN.test(expectedChecksumHex) || !Number.isSafeInteger(expectedSizeBytes)) {
    throw new ConflictException('Upload intent constraints are invalid');
  }
  const container = asRecord(row.metadata_json);
  const value = asRecord(container.uploadIntent);
  if (
    value.version !== 1
    || value.uploadId !== mediaId
    || (value.state !== 'issued' && value.state !== 'verified')
    || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.expiresAt))
    || value.providerVersion !== row.version
    || value.providerKeyVersion !== row.key_version
  ) {
    throw new ConflictException('Upload intent metadata is invalid');
  }
  return {
    expectedChecksumHex,
    expectedChecksumStorage: row.checksum,
    expectedContentType: row.mime_type,
    expectedSizeBytes,
    intent: value as unknown as UploadIntentMetadata,
  };
}

function completedResponse(row: CompletionRow, parsed: ParsedCompletion) {
  if (!['processing', 'ready'].includes(row.media_status) || parsed.intent.state !== 'verified') {
    return undefined;
  }
  const verification = asRecord(asRecord(row.metadata_json).uploadVerification);
  const etag = typeof verification.etag === 'string' ? verification.etag : undefined;
  if (!etag) throw new ConflictException('Upload verification evidence is missing');
  return {
    checksumSha256: parsed.expectedChecksumHex,
    etag,
    id: parsed.intent.uploadId,
    sizeBytes: parsed.expectedSizeBytes,
    status: row.media_status,
    version: row.media_version,
  };
}

function verifyHead(head: StorageObjectHead, row: CompletionRow, parsed: ParsedCompletion): void {
  const checksumBase64 = Buffer.from(parsed.expectedChecksumHex, 'hex').toString('base64');
  if (
    head.objectKey !== row.object_key
    || head.uploadId !== parsed.intent.uploadId
    || head.contentLength !== parsed.expectedSizeBytes
    || head.contentType?.toLowerCase() !== parsed.expectedContentType
    || head.checksumSha256Base64 !== checksumBase64
    || !head.etag
  ) {
    throw new ConflictException('Uploaded object does not match the signed upload intent');
  }
}

function assertUnchangedCandidate(before: CompletionRow, after: CompletionRow): void {
  if (
    before.media_version !== after.media_version
    || before.storage_provider_id !== after.storage_provider_id
    || before.object_key !== after.object_key
    || before.mime_type !== after.mime_type
    || before.size_bytes_text !== after.size_bytes_text
    || before.checksum !== after.checksum
    || before.version !== after.version
    || before.key_version !== after.key_version
  ) {
    throw new ConflictException('Upload intent changed during completion');
  }
}

async function insertAudit(
  transaction: DatabaseTransaction,
  tenantId: string,
  metadata: StorageMutationMetadata,
  input: { action: string; after: object; resourceId: string },
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, ip, request_id
    ) values (
      ${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff', ${metadata.actorId},
      ${input.action}, 'media_asset', ${input.resourceId},
      ${transaction.json(toJsonValue(input.after))}, ${metadata.ip ?? null},
      ${metadata.requestId}
    )
  `;
}

async function insertPlatformAudit(
  transaction: DatabaseTransaction,
  metadata: StorageMutationMetadata,
  input: { action: string; after: object; resourceId: string },
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, ip, request_id
    ) values (
      ${uuidV7()}, 'platform', null, 'platform_staff', ${metadata.actorId},
      ${input.action}, 'media_asset', ${input.resourceId},
      ${transaction.json(toJsonValue(input.after))}, ${metadata.ip ?? null},
      ${metadata.requestId}
    )
  `;
}

function requireIdempotencyKey(metadata: StorageMutationMetadata): string {
  const key = metadata.idempotencyKey?.trim();
  if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
    throw new BadRequestException('A valid Idempotency-Key is required');
  }
  return key;
}

function assertMutationMetadata(value: StorageMutationMetadata): void {
  if (!value || typeof value !== 'object') throw new TypeError('Mutation metadata is required');
  assertUuid(value.actorId, 'actorId');
  if (typeof value.requestId !== 'string' || value.requestId.length < 8 || value.requestId.length > 128) {
    throw new TypeError('requestId is invalid');
  }
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConflictException('Upload metadata is invalid');
  }
  return value as Record<string, unknown>;
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
