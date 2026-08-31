import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  CustomerPlaybackAccess,
  CustomerPlaybackAccessRecord,
} from './playback.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface PlaybackTargetRow {
  drama_id: string;
  duration_seconds: number;
  episode_id: string;
  media_asset_id: string;
  owner_type: 'platform' | 'tenant';
  publication_status: 'approved' | 'published' | 'unpublished' | null;
  preview_media_asset_id: string | null;
  preview_seconds: number;
}

/** Single database-authoritative policy for playback metadata and progress writes. */
@Injectable()
export class CustomerPlaybackAccessService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async getAccess(
    principal: CustomerPrincipal,
    episodeId: string,
  ): Promise<CustomerPlaybackAccessRecord> {
    assertUuid(episodeId, 'episodeId');
    return this.database.inTenantContext(principal.tenantId, (transaction) =>
      this.resolveInTransaction(transaction, principal, episodeId));
  }

  async resolveInTransaction(
    transaction: DatabaseTransaction,
    principal: CustomerPrincipal,
    episodeId: string,
  ): Promise<CustomerPlaybackAccessRecord> {
    assertUuid(episodeId, 'episodeId');
    await this.lockAvailableCustomer(transaction, principal);

    const targets = await transaction<PlaybackTargetRow[]>`
      select
        drama.id as drama_id,
        drama.owner_type,
        episode.id as episode_id,
        episode.duration_seconds,
        episode.preview_seconds,
        episode.media_asset_id,
        episode.preview_media_asset_id
        ,(
          select publication.status
          from tenant_public_drama_publications as publication
          where publication.tenant_id = ${principal.tenantId}
            and publication.drama_id = drama.id
          limit 1
        ) as publication_status
      from episodes as episode
      inner join dramas as drama on drama.id = episode.drama_id
      inner join media_assets as media on media.id = episode.media_asset_id
      where episode.id = ${episodeId}
        and episode.status = 'published'
        and episode.deleted_at is null
        and drama.status = 'published'
        and drama.deleted_at is null
        and media.kind = 'video'
        and media.status = 'ready'
        and media.deleted_at is null
        and (
          (
            drama.owner_type = 'tenant'
            and drama.owner_tenant_id = ${principal.tenantId}
          )
          or (
            drama.owner_type = 'platform'
            and app.tenant_has_drama_license(drama.id)
          )
        )
      for share of episode, drama, media
    `;
    const target = targets[0];
    if (!target) throw new NotFoundException('Published episode is unavailable');

    const prices = await transaction<{ id: string }[]>`
      select price.id
      from content_prices as price
      where price.tenant_id = ${principal.tenantId}
        and price.status = 'active'
        and (
          (price.target_type = 'drama' and price.target_id = ${target.drama_id})
          or
          (price.target_type = 'episode' and price.target_id = ${target.episode_id})
        )
      order by price.id
      for share of price
    `;
    const pointPrices = await transaction<{ id: string }[]>`
      select price.id
      from content_point_prices as price
      where price.tenant_id = ${principal.tenantId}
        and price.status = 'active'
        and (
          (price.target_type = 'drama' and price.target_id = ${target.drama_id})
          or
          (price.target_type = 'episode' and price.target_id = ${target.episode_id})
        )
      order by price.id
      for share of price
    `;

    if (target.owner_type === 'platform') {
      await this.lockEffectiveLicense(
        transaction,
        principal.tenantId,
        target.drama_id,
      );
    }

    let entitled = false;
    const requiresPermanentPurchase = target.owner_type === 'platform'
      && target.publication_status === 'unpublished';
    if (prices.length > 0 || pointPrices.length > 0 || requiresPermanentPurchase) {
      const entitlements = await transaction<{ id: string }[]>`
        select entitlement.id
        from entitlements as entitlement
        where entitlement.tenant_id = ${principal.tenantId}
          and entitlement.account_id = ${principal.accountId}
          and entitlement.revoked_at is null
          and entitlement.starts_at <= statement_timestamp()
          and (
            entitlement.expires_at is null
            or entitlement.expires_at > statement_timestamp()
          )
          and (
            (
              ${requiresPermanentPurchase} = false
              and entitlement.entitlement_type = 'membership'
            )
            or (
              entitlement.entitlement_type = 'drama'
              and entitlement.product_id = ${target.drama_id}
              and (${requiresPermanentPurchase} = false or entitlement.expires_at is null)
            )
            or (
              entitlement.entitlement_type = 'episode'
              and entitlement.product_id = ${target.episode_id}
              and (${requiresPermanentPurchase} = false or entitlement.expires_at is null)
            )
          )
        order by entitlement.id
        limit 1
        for share of entitlement
      `;
      entitled = Boolean(entitlements[0]);
    }

    const access: CustomerPlaybackAccess = (!requiresPermanentPurchase
      && prices.length === 0 && pointPrices.length === 0) || entitled
      ? 'full'
      : target.preview_seconds > 0
        ? 'preview'
        : 'locked';
    return {
      access,
      dramaId: target.drama_id,
      durationSeconds: target.duration_seconds,
      episodeId: target.episode_id,
      mediaAssetId: target.media_asset_id,
      previewMediaAssetId: target.preview_media_asset_id ?? undefined,
      previewSeconds: target.preview_seconds,
    };
  }

  private async lockAvailableCustomer(
    transaction: DatabaseTransaction,
    principal: CustomerPrincipal,
  ): Promise<void> {
    const tenants = await transaction<{ id: string }[]>`
      select tenant.id
      from tenants as tenant
      where tenant.id = ${principal.tenantId}
        and tenant.status = 'active'
        and tenant.expires_at > statement_timestamp()
        and tenant.user_site_enabled
        and tenant.platform_site_enabled
      for share of tenant
    `;
    if (!tenants[0]) throw new ForbiddenException('Customer site is unavailable');
    const customers = await transaction<{ id: string }[]>`
      select customer.id
      from customer_accounts as customer
      where customer.tenant_id = ${principal.tenantId}
        and customer.id = ${principal.accountId}
        and customer.status = 'active'
      for share of customer
    `;
    if (!customers[0]) throw new ForbiddenException('Customer account is unavailable');
  }

  private async lockEffectiveLicense(
    transaction: DatabaseTransaction,
    tenantId: string,
    dramaId: string,
  ): Promise<void> {
    const licenses = await transaction<{ id: string; source: string }[]>`
      select publication.id, 'public_pool'::text as source
      from tenant_public_drama_publications as publication
      where publication.tenant_id = ${tenantId}
        and publication.drama_id = ${dramaId}
        and publication.status in ('published', 'unpublished')
      union all
      select license.id, 'legacy_license'::text as source
      from content_licenses as license
      where license.tenant_id = ${tenantId}
        and license.status in ('scheduled', 'active')
        and license.starts_at <= statement_timestamp()
        and license.expires_at > statement_timestamp()
        and exists (
          select 1 from content_license_items as item
          where item.tenant_id = license.tenant_id
            and item.license_id = license.id and item.drama_id = ${dramaId}
        )
      order by source, id
      limit 1
    `;
    const license = licenses[0];
    if (!license) throw new NotFoundException('Published episode is unavailable');
    if (license.source === 'legacy_license') {
      const items = await transaction<{ id: string }[]>`
        select item.id from content_license_items as item
        where item.tenant_id = ${tenantId}
          and item.license_id = ${license.id} and item.drama_id = ${dramaId}
        for share of item
      `;
      if (!items[0]) throw new NotFoundException('Published episode is unavailable');
    }
  }
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}
