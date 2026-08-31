import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import {
  S3_COMPATIBLE_STORAGE_ADAPTER,
  type S3CompatibleStorageAdapter,
} from '../storage/s3-compatible.adapter';
import {
  StorageCredentialCipher,
  type S3StorageCredentials,
} from '../storage/storage-credentials';
import {
  AppBuildExecutionError,
  type AppBuildExecutionArtifact,
  type AppBuildExecutionInput,
  type AppBuildExecutor,
} from './app-build-executor';
import { NativeAppBuilder } from './native-app-builder';

const MAX_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 4_294_967_296;
const SOURCE_DOWNLOAD_TIMEOUT_MS = 60_000;
const ARTIFACT_UPLOAD_TIMEOUT_MS = 15 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SnapshotAsset {
  checksum: string;
  mediaAssetId: string;
}

interface ParsedSnapshot {
  androidApplicationId: string;
  appName: string;
  h5Origin: string;
  icon: SnapshotAsset;
  iosBundleId: string;
  splash?: SnapshotAsset;
  tenantId: string;
}

interface StorageAssetRow {
  bucket: string;
  checksum: string;
  credential_ciphertext: string;
  endpoint: string | null;
  key_version: number;
  mime_type: string;
  object_key: string;
  owner_tenant_id: string | null;
  owner_type: 'platform' | 'tenant';
  provider_id: string;
  size_bytes: string | number | bigint;
}

interface ArtifactProviderRow {
  bucket: string;
  credential_ciphertext: string;
  endpoint: string | null;
  key_version: number;
  provider_id: string;
}

interface SignedSourceAsset {
  checksum: string;
  mimeType: string;
  sizeBytes: number;
  url: string;
}

@Injectable()
export class LocalAppBuildExecutor implements AppBuildExecutor {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(StorageCredentialCipher) private readonly cipher: StorageCredentialCipher,
    @Inject(S3_COMPATIBLE_STORAGE_ADAPTER)
    private readonly storage: S3CompatibleStorageAdapter,
    @Inject(NativeAppBuilder) private readonly builder: NativeAppBuilder,
  ) {}

  async execute(input: AppBuildExecutionInput): Promise<AppBuildExecutionArtifact> {
    const snapshot = parseSnapshot(input);
    const signedAssets = await this.signSourceAssets(snapshot);
    const icon = await downloadAsset(signedAssets.icon);
    const splash = signedAssets.splash
      ? await downloadAsset(signedAssets.splash)
      : undefined;
    let build: Awaited<ReturnType<NativeAppBuilder['build']>>;
    try {
      build = await this.builder.build({
        androidApplicationId: snapshot.androidApplicationId,
        appName: snapshot.appName,
        h5Origin: snapshot.h5Origin,
        icon,
        iosBundleId: snapshot.iosBundleId,
        jobId: input.jobId,
        splash,
        target: input.target,
      });
    } finally {
      icon.fill(0);
      splash?.fill(0);
    }
    try {
      const artifact = await hashArtifact(build.path);
      const objectKey = `app-builds/${input.tenantId}/${input.jobId}/${build.filename}`;
      const uploaded = await this.uploadArtifact({
        checksumBase64: artifact.checksumBase64,
        checksumHex: artifact.checksumHex,
        contentType: build.contentType,
        jobId: input.jobId,
        objectKey,
        path: build.path,
        sizeBytes: artifact.sizeBytes,
      });
      return {
        checksum: `sha256:${artifact.checksumHex}`,
        contentType: build.contentType,
        filename: build.filename,
        objectKey,
        sizeBytes: BigInt(artifact.sizeBytes),
        storageProviderId: uploaded.providerId,
      };
    } finally {
      await build.cleanup();
    }
  }

  private signSourceAssets(snapshot: ParsedSnapshot): Promise<{
    icon: SignedSourceAsset; splash?: SignedSourceAsset;
  }> {
    return this.database.inPlatformContext(async (transaction) => {
      const sign = async (asset: SnapshotAsset, icon: boolean) => {
        const rows = await transaction<StorageAssetRow[]>`
          select media.checksum, media.mime_type, media.size_bytes, media.object_key,
            provider.id as provider_id, provider.owner_type, provider.owner_tenant_id,
            provider.endpoint, provider.bucket, provider.credential_ciphertext,
            provider.key_version
          from media_assets as media
          inner join storage_providers as provider on provider.id = media.storage_provider_id
          where media.id = ${asset.mediaAssetId}
            and media.owner_type = 'tenant' and media.owner_tenant_id = ${snapshot.tenantId}
            and media.kind = 'image' and media.status = 'ready'
            and media.transcode_status in ('ready', 'not_required')
            and media.object_key is not null and media.source_url is null
            and media.checksum = ${asset.checksum} and media.deleted_at is null
            and provider.provider = 's3' and provider.status = 'active'
            and (
              (provider.owner_type = 'tenant' and provider.owner_tenant_id = ${snapshot.tenantId})
              or (provider.owner_type = 'platform' and provider.owner_tenant_id is null)
            )
            and (
              (${icon} = true and media.mime_type = 'image/png'
                and media.metadata_json @> ${transaction.json({
                  appBuildAsset: {
                    hasAlpha: false, height: 1024, purpose: 'app_icon', width: 1024,
                  },
                })})
              or (${icon} = false
                and media.metadata_json @> ${transaction.json({
                  appBuildAsset: { purpose: 'launch_image' },
                })})
            )
          for share of media, provider
        `;
        const row = rows[0];
        if (!row) throw new AppBuildExecutionError('asset_unavailable');
        const sizeBytes = safeSize(row.size_bytes, MAX_SOURCE_IMAGE_BYTES);
        try {
          const credentials = this.cipher.decrypt(row.credential_ciphertext, {
            keyVersion: row.key_version,
            ownerTenantId: row.owner_tenant_id,
            ownerType: row.owner_type,
            providerId: row.provider_id,
          });
          const signed = await this.storage.presignGetObject({
            credentials,
            expiresInSeconds: 180,
            objectKey: row.object_key,
            target: { bucket: row.bucket, endpoint: row.endpoint },
          });
          validateHttpsUrl(signed.url);
          return {
            checksum: row.checksum,
            mimeType: row.mime_type,
            sizeBytes,
            url: signed.url,
          };
        } catch (error) {
          if (error instanceof AppBuildExecutionError) throw error;
          throw new AppBuildExecutionError('asset_unavailable');
        }
      };
      return {
        icon: await sign(snapshot.icon, true),
        ...(snapshot.splash ? { splash: await sign(snapshot.splash, false) } : {}),
      };
    });
  }

  private async uploadArtifact(input: {
    checksumBase64: string;
    checksumHex: string;
    contentType: string;
    jobId: string;
    objectKey: string;
    path: string;
    sizeBytes: number;
  }) {
    const providerId = process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID;
    if (!providerId || !UUID.test(providerId)) {
      throw new AppBuildExecutionError('builder_unavailable');
    }
    const provider = await this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<ArtifactProviderRow[]>`
        select id as provider_id, endpoint, bucket, credential_ciphertext, key_version
        from storage_providers where id = ${providerId}
          and owner_type = 'platform' and owner_tenant_id is null
          and provider = 's3' and status = 'active'
        for share
      `;
      const row = rows[0];
      if (!row) throw new AppBuildExecutionError('artifact_upload_failed');
      try {
        const credentials = this.cipher.decrypt(row.credential_ciphertext, {
          keyVersion: row.key_version,
          ownerTenantId: null,
          ownerType: 'platform',
          providerId: row.provider_id,
        });
        const signed = await this.storage.presignConditionalPut({
          checksumSha256Base64: input.checksumBase64,
          contentLength: input.sizeBytes,
          contentType: input.contentType,
          credentials,
          expiresInSeconds: 900,
          objectKey: input.objectKey,
          target: { bucket: row.bucket, endpoint: row.endpoint },
          uploadId: input.jobId,
        });
        validateHttpsUrl(signed.url);
        return { credentials, providerId: row.provider_id, row, signed };
      } catch (error) {
        if (error instanceof AppBuildExecutionError) throw error;
        throw new AppBuildExecutionError('artifact_upload_failed');
      }
    });
    await putArtifact(input.path, provider.signed.url, provider.signed.requiredHeaders);
    try {
      const head = await this.storage.headObject({
        credentials: provider.credentials as S3StorageCredentials,
        objectKey: input.objectKey,
        target: { bucket: provider.row.bucket, endpoint: provider.row.endpoint },
      });
      if (!head.exists || head.contentLength !== input.sizeBytes
        || head.contentType !== input.contentType
        || head.checksumSha256Base64 !== input.checksumBase64) {
        throw new AppBuildExecutionError('artifact_upload_failed');
      }
    } catch (error) {
      if (error instanceof AppBuildExecutionError) throw error;
      throw new AppBuildExecutionError('artifact_upload_failed');
    }
    return { providerId: provider.providerId };
  }
}

function parseSnapshot(input: AppBuildExecutionInput): ParsedSnapshot {
  if (!input || typeof input !== 'object' || !UUID.test(input.jobId)
    || !UUID.test(input.tenantId) || !input.snapshot || typeof input.snapshot !== 'object') {
    throw new AppBuildExecutionError('build_failed');
  }
  const value = input.snapshot;
  const appName = string(value.appName, 2, 50);
  const androidApplicationId = string(value.androidApplicationId, 3, 150);
  const iosBundleId = string(value.iosBundleId, 3, 200);
  const h5Origin = string(value.h5Origin, 10, 2048);
  if (value.tenantId !== input.tenantId || value.target !== input.target
    || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(androidApplicationId)
    || !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(iosBundleId)) {
    throw new AppBuildExecutionError('build_failed');
  }
  validateHttpsUrl(h5Origin, true);
  return {
    androidApplicationId,
    appName,
    h5Origin,
    icon: snapshotAsset(value.icon),
    iosBundleId,
    ...(value.splash === null || value.splash === undefined
      ? {} : { splash: snapshotAsset(value.splash) }),
    tenantId: input.tenantId,
  };
}

function snapshotAsset(raw: unknown): SnapshotAsset {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AppBuildExecutionError('asset_unavailable');
  }
  const value = raw as Record<string, unknown>;
  if (typeof value.mediaAssetId !== 'string' || !UUID.test(value.mediaAssetId)
    || typeof value.checksum !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(value.checksum)) {
    throw new AppBuildExecutionError('asset_unavailable');
  }
  return { checksum: value.checksum, mediaAssetId: value.mediaAssetId };
}

async function downloadAsset(asset: SignedSourceAsset): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SOURCE_DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(asset.url, {
      cache: 'no-store',
      method: 'GET',
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new AppBuildExecutionError('asset_unavailable');
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) !== asset.sizeBytes) {
      throw new AppBuildExecutionError('asset_unavailable');
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > asset.sizeBytes || total > MAX_SOURCE_IMAGE_BYTES) {
        await reader.cancel();
        throw new AppBuildExecutionError('asset_unavailable');
      }
      chunks.push(Buffer.from(chunk.value));
    }
    if (total !== asset.sizeBytes) throw new AppBuildExecutionError('asset_unavailable');
    const body = Buffer.concat(chunks, total);
    const digest = createHash('sha256').update(body).digest('hex');
    if (`sha256:${digest}` !== asset.checksum) {
      body.fill(0);
      throw new AppBuildExecutionError('asset_unavailable');
    }
    return body;
  } catch (error) {
    if (error instanceof AppBuildExecutionError) throw error;
    throw new AppBuildExecutionError('asset_unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

async function hashArtifact(path: string) {
  const file = await stat(path).catch(() => undefined);
  if (!file?.isFile() || file.size < 1 || file.size > MAX_ARTIFACT_BYTES) {
    throw new AppBuildExecutionError('build_failed');
  }
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  const checksumHex = hash.digest('hex');
  return {
    checksumBase64: Buffer.from(checksumHex, 'hex').toString('base64'),
    checksumHex,
    sizeBytes: file.size,
  };
}

async function putArtifact(path: string, url: string, headers: Record<string, string>) {
  validateHttpsUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ARTIFACT_UPLOAD_TIMEOUT_MS);
  try {
    const request = {
      body: createReadStream(path) as never,
      cache: 'no-store',
      duplex: 'half' as const,
      headers,
      method: 'PUT',
      redirect: 'error',
      signal: controller.signal,
    } as RequestInit & { duplex: 'half' };
    const response = await fetch(url, request);
    if (!response.ok && response.status !== 412) {
      throw new AppBuildExecutionError('artifact_upload_failed');
    }
  } catch (error) {
    if (error instanceof AppBuildExecutionError) throw error;
    throw new AppBuildExecutionError('artifact_upload_failed');
  } finally {
    clearTimeout(timeout);
  }
}

function validateHttpsUrl(value: string, originOnly = false) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppBuildExecutionError('build_failed');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname
    || (originOnly && (parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash))) {
    throw new AppBuildExecutionError('build_failed');
  }
}

function safeSize(raw: string | number | bigint, maximum: number) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new AppBuildExecutionError('asset_unavailable');
  }
  return value;
}

function string(value: unknown, minimum: number, maximum: number) {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new AppBuildExecutionError('build_failed');
  }
  return value;
}
