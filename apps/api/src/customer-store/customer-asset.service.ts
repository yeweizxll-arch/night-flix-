import {
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import {
  S3_COMPATIBLE_STORAGE_ADAPTER,
  type S3CompatibleStorageAdapter,
} from '../storage/s3-compatible.adapter';
import {
  StorageCredentialCipher,
  type S3StorageCredentials,
} from '../storage/storage-credentials';
import { CustomerAssetRateLimiterService } from './customer-asset-rate-limiter.service';
import { customerSiteUnavailable } from './customer-store.service';

const EXPIRY_SECONDS = 180;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface BrandingRow {
  icon_media_asset_id: string | null;
  logo_media_asset_id: string | null;
}

interface CoverDramaRow {
  id: string;
  owner_type: 'platform' | 'tenant';
}

interface SecureImageRow {
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
export class CustomerAssetService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(StorageCredentialCipher)
    private readonly credentialCipher: StorageCredentialCipher,
    @Inject(S3_COMPATIBLE_STORAGE_ADAPTER)
    private readonly storage: S3CompatibleStorageAdapter,
    @Inject(CustomerAssetRateLimiterService)
    private readonly rateLimiter: CustomerAssetRateLimiterService,
  ) {}

  async issue(
    tenantIdValue: unknown,
    mediaIdValue: unknown,
    rawQuery: Record<string, unknown>,
    ipValue: unknown,
  ) {
    const tenantId = uuid(tenantIdValue, 'tenantId');
    const mediaId = uuid(mediaIdValue, 'mediaId');
    assertNoQuery(rawQuery);
    const ip = requestIp(ipValue);
    await this.rateLimiter.consume({ ip, tenantId });
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const branding = await this.lockAvailableTenant(transaction, tenantId);
      const brandingAsset = branding.logo_media_asset_id === mediaId
        || branding.icon_media_asset_id === mediaId;
      if (!brandingAsset) {
        const drama = await this.lockVisibleCoverDrama(transaction, tenantId, mediaId);
        if (!drama) throw new NotFoundException('Customer image is unavailable');
        if (drama.owner_type === 'platform') {
          await this.lockEffectiveLicense(transaction, tenantId, drama.id);
        }
      }
      const rows = await transaction<SecureImageRow[]>`
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
        where media.id = ${mediaId}
          and media.kind = 'image'
          and media.mime_type in (
            'image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/webp'
          )
          and media.status = 'ready'
          and media.deleted_at is null
          and media.storage_provider_id is not null
          and media.object_key is not null
          and media.source_url is null
          and (
            media.owner_type = 'platform'
            or (media.owner_type = 'tenant' and media.owner_tenant_id = ${tenantId})
          )
          and provider.provider = 's3'
          and provider.status = 'active'
          and (
            (provider.owner_type = 'platform' and provider.owner_tenant_id is null)
            or (
              provider.owner_type = 'tenant'
              and provider.owner_tenant_id = ${tenantId}
              and media.owner_type = 'tenant'
              and media.owner_tenant_id = ${tenantId}
            )
          )
        for share of media, provider
      `;
      const asset = rows[0];
      if (!asset) throw new NotFoundException('Customer image is unavailable');
      // Presigning is local cryptographic work. The provider/media/authorization rows
      // remain share-locked until this finishes, blocking disable, rotation and unpublish.
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
          expiresInSeconds: EXPIRY_SECONDS,
          objectKey: asset.object_key,
          target: { bucket: asset.bucket, endpoint: asset.endpoint },
        });
        const expiresAt = validSignedResponse(signed);
        return {
          expiresAt: expiresAt.toISOString(),
          mediaAssetId: mediaId,
          url: signed.url,
        };
      } catch {
        throw new ServiceUnavailableException({
          code: 'CUSTOMER_ASSET_SIGNING_UNAVAILABLE',
          message: 'Customer image access is temporarily unavailable',
        });
      }
    });
  }

  private async lockAvailableTenant(
    transaction: DatabaseTransaction,
    tenantId: string,
  ): Promise<BrandingRow> {
    const rows = await transaction<BrandingRow[]>`
      select logo_media_asset_id, icon_media_asset_id
      from tenants
      where id = ${tenantId}
        and status = 'active'
        and expires_at > statement_timestamp()
        and platform_site_enabled
        and user_site_enabled
      for share
    `;
    if (!rows[0]) throw customerSiteUnavailable();
    return rows[0];
  }

  private async lockVisibleCoverDrama(
    transaction: DatabaseTransaction,
    tenantId: string,
    mediaId: string,
  ): Promise<CoverDramaRow | undefined> {
    const rows = await transaction<CoverDramaRow[]>`
      select drama.id, drama.owner_type
      from dramas as drama
      where drama.cover_file_id = ${mediaId}
        and drama.status = 'published'
        and drama.deleted_at is null
        and (drama.release_at is null or drama.release_at <= statement_timestamp())
        and (drama.unpublish_at is null or drama.unpublish_at > statement_timestamp())
        and (
          (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
          or (
            drama.owner_type = 'platform'
            and exists (
              select 1
              from content_license_items as license_item
              inner join content_licenses as license
                on license.id = license_item.license_id
                and license.tenant_id = license_item.tenant_id
              where license_item.tenant_id = ${tenantId}
                and license_item.drama_id = drama.id
                and license.status in ('scheduled', 'active')
                and license.starts_at <= statement_timestamp()
                and license.expires_at > statement_timestamp()
            )
          )
        )
      order by drama.id
      limit 1
      for share of drama
    `;
    return rows[0];
  }

  private async lockEffectiveLicense(
    transaction: DatabaseTransaction,
    tenantId: string,
    dramaId: string,
  ): Promise<void> {
    const licenses = await transaction<{ id: string }[]>`
      select license.id
      from content_licenses as license
      where license.tenant_id = ${tenantId}
        and license.status in ('scheduled', 'active')
        and license.starts_at <= statement_timestamp()
        and license.expires_at > statement_timestamp()
        and exists (
          select 1 from content_license_items as item
          where item.tenant_id = license.tenant_id
            and item.license_id = license.id
            and item.drama_id = ${dramaId}
        )
      order by license.id
      limit 1
      for share of license
    `;
    const license = licenses[0];
    if (!license) throw new NotFoundException('Customer image is unavailable');
    const items = await transaction<{ id: string }[]>`
      select item.id
      from content_license_items as item
      where item.tenant_id = ${tenantId}
        and item.license_id = ${license.id}
        and item.drama_id = ${dramaId}
      for share of item
    `;
    if (!items[0]) throw new NotFoundException('Customer image is unavailable');
  }
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function assertNoQuery(value: unknown): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Query is invalid');
  }
  const key = Object.keys(value)[0];
  if (key) throw new BadRequestException(`Unknown query parameter: ${key}`);
}

function requestIp(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128
    || /[\u0000-\u0020\u007f]/.test(value)) {
    throw new BadRequestException('Request IP is invalid');
  }
  return value;
}

function validSignedResponse(value: {
  cacheControl: string;
  contentDisposition: string;
  expiresAt: Date;
  url: string;
}): Date {
  if (!value || typeof value.url !== 'string' || value.url.length > 16_384) {
    throw new Error('Storage adapter returned an invalid image URL');
  }
  if (
    value.cacheControl !== 'private, no-store, max-age=0'
    || value.contentDisposition !== 'inline'
  ) {
    throw new Error('Storage adapter returned unsafe image response controls');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch {
    throw new Error('Storage adapter returned an invalid image URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error('Storage adapter returned an invalid image URL');
  }
  if (!(value.expiresAt instanceof Date) || !Number.isFinite(value.expiresAt.getTime())) {
    throw new Error('Storage adapter returned an invalid image expiry');
  }
  const remaining = value.expiresAt.getTime() - Date.now();
  if (remaining <= 0 || remaining > (EXPIRY_SECONDS + 5) * 1_000) {
    throw new Error('Storage adapter returned an invalid image expiry');
  }
  return value.expiresAt;
}
