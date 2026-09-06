import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';

import type { PlaybackViewer } from './playback.types';
import { DatabaseService } from '../database/database.service';
import {
  S3_COMPATIBLE_STORAGE_ADAPTER,
  type S3CompatibleStorageAdapter,
} from '../storage/s3-compatible.adapter';
import { StorageCredentialCipher } from '../storage/storage-credentials';
import type { S3StorageCredentials } from '../storage/storage-credentials';
import { CustomerPlaybackAccessService } from './customer-playback-access.service';
import { PlaybackUrlRateLimiterService } from './playback-url-rate-limiter.service';
import { HlsPlaybackService } from './hls-playback.service';

const DEFAULT_EXPIRY_SECONDS = 180;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SecureAssetRow {
  object_version?: string;
  mime_type?: string;
  bucket: string;
  credential_ciphertext: string;
  endpoint: string | null;
  key_version: number;
  object_key: string;
  owner_tenant_id: string | null;
  owner_type: 'platform' | 'tenant';
  provider_id: string;
}

interface SecureTrackAssetRow extends SecureAssetRow {
  label: string;
  locale: string;
  track_type: 'dubbing' | 'subtitle';
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
    @Optional() @Inject(HlsPlaybackService) private readonly hls?: HlsPlaybackService,
  ) {}

  async issue(
    principal: PlaybackViewer,
    episodeIdValue: unknown,
    expiryValue: unknown,
    ipValue: unknown,
    publicOrigin?: string,
  ) {
    assertPrincipal(principal);
    const episodeId = uuid(episodeIdValue, 'episodeId');
    const expiresInSeconds = expirySeconds(expiryValue);
    const ip = requestIp(ipValue);
    await this.rateLimiter.consume({
      accountId: principal.accountId ?? `guest:${ip}`,
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
            media.object_key, media.mime_type,
            coalesce(media.metadata_json #>> '{uploadVerification,versionId}',
              media.metadata_json #>> '{sourceReference,versionId}') as object_version
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
            and app.lock_customer_row('media_assets', media.id, to_jsonb(media))
            and app.lock_customer_row('storage_providers', provider.id, to_jsonb(provider.*))
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
        try {
          const isHls = asset.mime_type?.includes('mpegurl');
          if (isHls && (!this.hls || !publicOrigin)) throw new Error('HLS gateway is unavailable');
          const signed = isHls
            ? this.hls!.issue(principal, episodeId, mediaAssetId, asset.object_key, expiresInSeconds, publicOrigin!)
            : await this.signAsset(asset, expiresInSeconds);
          return {
            access: access.access,
            expiresAt: signed.expiresAt.toISOString(),
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

  async issueTrack(
    principal: PlaybackViewer,
    episodeIdValue: unknown,
    trackIdValue: unknown,
    expiryValue: unknown,
    ipValue: unknown,
  ) {
    assertPrincipal(principal);
    const episodeId = uuid(episodeIdValue, 'episodeId');
    const trackId = uuid(trackIdValue, 'trackId');
    const expiresInSeconds = expirySeconds(expiryValue);
    const ip = requestIp(ipValue);
    await this.rateLimiter.consume({
      accountId: principal.accountId ?? `guest:${ip}`,
      ip,
      tenantId: principal.tenantId,
    });
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      const access = await this.playbackAccess.resolveInTransaction(
        transaction, principal, episodeId,
      );
      if (access.access !== 'full') {
        throw new ForbiddenException({
          code: 'TRACK_ENTITLEMENT_REQUIRED',
          message: 'Full playback access is required for subtitle and dubbing tracks',
        });
      }
      const rows = await transaction<SecureTrackAssetRow[]>`
        select
          provider.id as provider_id,
          provider.owner_type,
          provider.owner_tenant_id,
          provider.endpoint,
          provider.bucket,
          provider.credential_ciphertext,
          provider.key_version,
          media.object_key,
          coalesce(media.metadata_json #>> '{uploadVerification,versionId}',
            media.metadata_json #>> '{sourceReference,versionId}') as object_version,
          track.track_type,
          track.locale,
          track.label
        from episode_media_tracks as track
        inner join media_assets as media on media.id = track.media_asset_id
        inner join storage_providers as provider on provider.id = media.storage_provider_id
        where track.id = ${trackId}
          and track.episode_id = ${episodeId}
          and track.status = 'active'
          and media.kind = 'file'
          and media.status = 'ready'
          and media.deleted_at is null
          and media.object_key is not null
          and media.source_url is null
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
          and app.lock_customer_row('episode_media_tracks', track.id, to_jsonb(track))
          and app.lock_customer_row('media_assets', media.id, to_jsonb(media))
          and app.lock_customer_row('storage_providers', provider.id, to_jsonb(provider.*))
      `;
      const track = rows[0];
      if (!track) throw new NotFoundException('Playback track is unavailable');
      try {
        const signed = await this.signAsset(track, expiresInSeconds);
        return {
          expiresAt: signed.expiresAt.toISOString(),
          id: trackId,
          label: track.label,
          locale: track.locale,
          offlineSupported: false as const,
          type: track.track_type,
          url: signed.url,
        };
      } catch {
        throw new ServiceUnavailableException({
          code: 'PLAYBACK_SIGNING_UNAVAILABLE',
          message: 'Secure playback is temporarily unavailable',
        });
      }
    });
  }

  private async signAsset(asset: SecureAssetRow, expiresInSeconds: number) {
    // Keep presigning inside the transaction while the provider is share-locked,
    // so provider disable or credential rotation cannot race URL issuance.
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
      ...(asset.object_version ? { versionId: asset.object_version } : {}),
      target: { bucket: asset.bucket, endpoint: asset.endpoint },
    });
    return { expiresAt: validSignedResponse(signed, expiresInSeconds), url: signed.url };
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

function assertPrincipal(principal: PlaybackViewer): void {
  if (!principal || typeof principal !== 'object') {
    throw new ForbiddenException('Customer principal is required');
  }
  uuid(principal.tenantId, 'tenantId');
  if (principal.accountId !== undefined) uuid(principal.accountId, 'accountId');
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}
