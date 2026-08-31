import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import { DatabaseService } from '../database/database.service';
import {
  S3_COMPATIBLE_STORAGE_ADAPTER,
  type S3CompatibleStorageAdapter,
} from '../storage/s3-compatible.adapter';
import { StorageCredentialCipher } from '../storage/storage-credentials';
import type { S3StorageCredentials } from '../storage/storage-credentials';
import { CustomerPlaybackAccessService } from './customer-playback-access.service';
import { PlaybackUrlRateLimiterService } from './playback-url-rate-limiter.service';

const DEFAULT_EXPIRY_SECONDS = 180;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SecureAssetRow {
  bucket: string;
  credential_ciphertext: string;
  endpoint: string | null;
  key_version: number;
  object_key: string;
  owner_tenant_id: string | null;
  owner_type: 'platform' | 'tenant';
  provider_id: string;
}

@Injectable()
export class CustomerPlaybackUrlService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CustomerPlaybackAccessService)
    private readonly playbackAccess: CustomerPlaybackAccessService,
    @Inject(StorageCredentialCipher) private readonly credentialCipher: StorageCredentialCipher,
    @Inject(S3_COMPATIBLE_STORAGE_ADAPTER)
    private readonly storage: S3CompatibleStorageAdapter,
    @Inject(PlaybackUrlRateLimiterService)
    private readonly rateLimiter: PlaybackUrlRateLimiterService,
  ) {}

  async issue(
    principal: CustomerPrincipal,
    episodeIdValue: unknown,
    expiryValue: unknown,
    ipValue: unknown,
  ) {
    assertPrincipal(principal);
    const episodeId = uuid(episodeIdValue, 'episodeId');
    const expiresInSeconds = expirySeconds(expiryValue);
    const ip = requestIp(ipValue);
    await this.rateLimiter.consume({
      accountId: principal.accountId,
      ip,
      tenantId: principal.tenantId,
    });

    return this.database.inTenantContext(
      principal.tenantId,
      async (transaction) => {
        const access = await this.playbackAccess.resolveInTransaction(
          transaction,
          principal,
          episodeId,
        );
        if (access.access === 'preview' && !access.previewMediaAssetId) {
          throw new ForbiddenException({
            access: 'preview',
            code: 'PREVIEW_PLAYBACK_ASSET_UNAVAILABLE',
            message: 'A separate preview media asset is not available',
            previewSeconds: access.previewSeconds,
          });
        }
        if (access.access === 'locked') {
          throw new ForbiddenException({
            access: 'locked',
            code: 'PLAYBACK_ENTITLEMENT_REQUIRED',
            message: 'Full playback access is required',
          });
        }
        // Preview continues into the same locked signer using only its dedicated
        // media UUID; the full episode UUID is never used as a fallback.
        const mediaAssetId = access.access === 'preview'
          ? access.previewMediaAssetId!
          : access.mediaAssetId;
        const rows = await transaction<SecureAssetRow[]>`
          select
            provider.id as provider_id,
            provider.owner_type,
            provider.owner_tenant_id,
            provider.endpoint,
            provider.bucket,
            provider.credential_ciphertext,
            provider.key_version,
            media.object_key
          from media_assets as media
          inner join storage_providers as provider
            on provider.id = media.storage_provider_id
          where media.id = ${mediaAssetId}
            and media.kind = 'video'
            and media.status = 'ready'
            and media.deleted_at is null
            and media.storage_provider_id is not null
            and media.object_key is not null
            and media.source_url is null
            and media.mime_type in (
              'video/mp4', 'video/quicktime', 'video/webm',
              'application/vnd.apple.mpegurl', 'application/x-mpegurl'
            )
            and provider.provider = 's3'
            and provider.status = 'active'
            and (
              (provider.owner_type = 'platform' and provider.owner_tenant_id is null)
              or (
                provider.owner_type = 'tenant'
                and provider.owner_tenant_id = ${principal.tenantId}
                and media.owner_type = 'tenant'
                and media.owner_tenant_id = ${principal.tenantId}
              )
            )
          for share of media, provider
        `;
        const asset = rows[0];
        if (!asset) {
          if (access.access === 'preview') {
            throw new ForbiddenException({
              access: 'preview',
              code: 'PREVIEW_PLAYBACK_ASSET_UNAVAILABLE',
              message: 'A separate preview media asset is not available',
              previewSeconds: access.previewSeconds,
            });
          }
          throw new NotFoundException('Secure playback asset is unavailable');
        }
        // Presigning is local cryptographic work. Keep it inside the transaction while
        // the provider row is share-locked, so disable/rotation cannot race issuance.
        try {
          const credentials: S3StorageCredentials = this.credentialCipher.decrypt(
            asset.credential_ciphertext,
            {
              keyVersion: asset.key_version,
              ownerTenantId: asset.owner_tenant_id,
              ownerType: asset.owner_type,
              providerId: asset.provider_id,
            },
          );
          const signed = await this.storage.presignGetObject({
            credentials,
            expiresInSeconds,
            objectKey: asset.object_key,
            target: {
              bucket: asset.bucket,
              endpoint: asset.endpoint,
            },
          });
          const expiresAt = validSignedResponse(signed, expiresInSeconds);
          return {
            access: access.access,
            expiresAt: expiresAt.toISOString(),
            mediaAssetId,
            offlineSupported: false as const,
            ...(access.access === 'preview'
              ? { previewSeconds: access.previewSeconds }
              : {}),
            url: signed.url,
          };
        } catch {
          throw new ServiceUnavailableException({
            code: 'PLAYBACK_SIGNING_UNAVAILABLE',
            message: 'Secure playback is temporarily unavailable',
          });
        }
      },
    );
  }
}

function expirySeconds(value: unknown): number {
  if (value === undefined) return DEFAULT_EXPIRY_SECONDS;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequestException('expiresInSeconds is invalid');
  }
  if (String(value).length > 3 || !/^\d+$/.test(String(value))) {
    throw new BadRequestException('expiresInSeconds is invalid');
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 120 || parsed > 300) {
    throw new BadRequestException('expiresInSeconds must be between 120 and 300');
  }
  return parsed;
}

function requestIp(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new BadRequestException('Request IP is invalid');
  }
  return value;
}

function validSignedResponse(
  value: { expiresAt: Date; url: string },
  requestedSeconds: number,
): Date {
  if (!value || typeof value.url !== 'string' || value.url.length > 16_384) {
    throw new Error('Storage adapter returned an invalid playback URL');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch {
    throw new Error('Storage adapter returned an invalid playback URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error('Storage adapter returned an invalid playback URL');
  }
  if (!(value.expiresAt instanceof Date) || !Number.isFinite(value.expiresAt.getTime())) {
    throw new Error('Storage adapter returned an invalid expiry');
  }
  const remaining = value.expiresAt.getTime() - Date.now();
  if (remaining <= 0 || remaining > (requestedSeconds + 5) * 1_000) {
    throw new Error('Storage adapter returned an invalid expiry');
  }
  return value.expiresAt;
}

function assertPrincipal(principal: CustomerPrincipal): void {
  if (!principal || typeof principal !== 'object') {
    throw new ForbiddenException('Customer principal is required');
  }
  uuid(principal.tenantId, 'tenantId');
  uuid(principal.accountId, 'accountId');
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}
