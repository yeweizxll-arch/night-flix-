import { lockPublicDistribution } from '../public-drama-pool/public-distribution';
import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { amountNumber } from '../commerce/commerce-validation';
import {
  CUSTOMER_CONTENT_LOCALES,
  type CustomerContentLocale,
  type CustomerDramaCatalogDetail,
  type CustomerDramaCatalogItem,
  type CustomerDramaCatalogQuery,
} from './customer-content-catalog.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,63}$/;

interface TenantCatalogContext {
  defaultLocale: CustomerContentLocale;
}

interface DramaCatalogRow {
  code: string;
  cover_media_id: string | null;
  id: string;
  locale: CustomerContentLocale;
  owner_type?: 'platform' | 'tenant';
  points_amount: string | number | bigint | null;
  summary: string;
  title: string;
  total_count?: number;
  total_episodes: number;
  heat?: number;
  published_at?: Date | string;
}

@Injectable()
export class CustomerContentCatalogService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async listDramas(
    tenantId: string,
    rawQuery: CustomerDramaCatalogQuery,
    accountId?: string,
  ): Promise<{
    items: CustomerDramaCatalogItem[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    assertUuid(tenantId, 'tenantId');
    if (accountId !== undefined) assertUuid(accountId, 'accountId');
    const query = catalogQuery(rawQuery);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const context = await this.requireAvailableTenant(transaction, tenantId);
      const requestedLocale = query.locale ?? context.defaultLocale;
      const rows = await transaction<DramaCatalogRow[]>`
        with activity as (
          -- One contribution per account/drama/type. Episode count and repeated
          -- progress pings cannot multiply a show's popularity.
          select drama_id, 100 as weight, max(updated_at) as happened_at
          from watch_progress
          where tenant_id = ${tenantId} and (position_seconds >= 10 or completed)
          group by drama_id, account_id
          union all
          select drama_id, 200, created_at from customer_drama_likes
          where tenant_id = ${tenantId}
          union all
          select drama_id, 300, created_at from customer_favorites
          where tenant_id = ${tenantId}
          union all
          select drama_id, 100, max(created_at) from interaction_comments
          where tenant_id = ${tenantId} and status = 'visible'
          group by drama_id, account_id
        ), heat as (
          select drama_id, floor(sum(weight * power(0.5,
            greatest(0, extract(epoch from (statement_timestamp() - happened_at)))
            / 604800.0)))::integer as score
          from activity
          where happened_at > statement_timestamp() - interval '90 days'
          group by drama_id
        ), preferences as (
          select watched.category_id, count(distinct progress.drama_id)::integer as affinity
          from watch_progress as progress
          join dramas as watched on watched.id = progress.drama_id
          where progress.tenant_id = ${tenantId}
            and progress.account_id = ${accountId ?? null}::uuid
            and (progress.position_seconds >= 10 or progress.completed)
            and progress.updated_at > statement_timestamp() - interval '30 days'
          group by watched.category_id
        )
        select
          drama.id,
          drama.code::text,
          drama.total_episodes,
          coalesce(heat.score, 0) as heat,
          coalesce(publication.published_at, drama.first_published_at, drama.release_at, drama.created_at) as published_at,
          (
            select point_price.points_amount
            from content_point_prices as point_price
            where point_price.tenant_id = ${tenantId}
              and point_price.target_type = 'drama'
              and point_price.target_id = drama.id
              and point_price.status = 'active'
          ) as points_amount,
          translation.locale,
          translation.title,
          translation.summary,
          case when cover.id is not null then drama.cover_file_id else null end
            as cover_media_id,
          count(*) over()::integer as total_count
        from dramas as drama
        left join heat on heat.drama_id = drama.id
        left join tenant_drama_discovery as discovery
          on discovery.tenant_id = ${tenantId} and discovery.drama_id = drama.id
        left join tenant_public_drama_publications as publication
          on publication.tenant_id = ${tenantId} and publication.drama_id = drama.id
        left join preferences on preferences.category_id = drama.category_id
        inner join lateral (
          select selected.locale, selected.title, selected.summary
          from drama_translations as selected
          where selected.drama_id = drama.id
          order by
            case
              when selected.locale = ${requestedLocale} then 0
              when selected.locale = ${context.defaultLocale} then 1
              when selected.locale = 'en-US' then 2
              else 3
            end,
            selected.locale
          limit 1
        ) as translation on true
        left join media_assets as cover
          on cover.id = drama.cover_file_id
          and cover.kind = 'image'
          and cover.status = 'ready'
          and cover.deleted_at is null
        where drama.status = 'published'
          and drama.deleted_at is null
          and drama.emergency_takedown_at is null
          and app.customer_region_allowed(${tenantId}, drama.id)
          and (drama.release_at is null or drama.release_at <= statement_timestamp())
          and (drama.unpublish_at is null or drama.unpublish_at > statement_timestamp())
          and (
            (
              drama.owner_type = 'tenant'
              and drama.owner_tenant_id = ${tenantId}
            )
            or (
              drama.owner_type = 'platform'
              and app.tenant_drama_published(drama.id)
            )
          )
          and (
            ${query.qPattern ?? null}::text is null
            or drama.code::text ilike ${query.qPattern ?? null} escape '!'
            or exists (
              select 1
              from drama_translations as searched
              where searched.drama_id = drama.id
                and (
                  searched.title ilike ${query.qPattern ?? null} escape '!'
                  or searched.summary ilike ${query.qPattern ?? null} escape '!'
                  or exists (
                    select 1 from unnest(searched.search_keywords) as keyword
                    where keyword ilike ${query.qPattern ?? null} escape '!'
                  )
                )
            )
          )
          and (
            ${query.categoryId ?? null}::uuid is null
            or drama.category_id = ${query.categoryId ?? null}
          )
          and (
            ${query.categoryCode ?? null}::text is null
            or exists (
              select 1 from categories as category
              where category.id = drama.category_id
                and category.code = ${query.categoryCode ?? null}
                and category.status = 'active'
                and category.deleted_at is null
            )
          )
          and (
            (${query.tagId ?? null}::uuid is null and ${query.tagCode ?? null}::text is null)
            or exists (
              select 1
              from drama_tags as drama_tag
              inner join tags as tag on tag.id = drama_tag.tag_id
              where drama_tag.drama_id = drama.id
                and tag.status = 'active'
                and tag.deleted_at is null
                and (
                  (${query.tagId ?? null}::uuid is not null and tag.id = ${query.tagId ?? null})
                  or (
                    ${query.tagCode ?? null}::text is not null
                    and tag.code = ${query.tagCode ?? null}
                  )
                )
            )
          )
        order by
          case when ${query.sort} <> 'latest'
            then coalesce(nullif(discovery.pinned_rank, 0), 2147483647) else 0 end,
          case when ${query.sort} = 'recommended'
            then coalesce(heat.score, 0) + coalesce(discovery.weight, 0)
              + least(coalesce(preferences.affinity, 0), 5) * 200
            when ${query.sort} = 'popular' then coalesce(heat.score, 0) + coalesce(discovery.weight, 0)
            else 0 end desc,
          coalesce(publication.published_at, drama.first_published_at, drama.release_at, drama.created_at) desc, drama.id desc
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
      `;
      return {
        items: rows.map(mapDrama),
        page: query.page,
        pageSize: query.pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  async getDrama(
    tenantId: string,
    dramaId: string,
    localeValue: unknown,
    accountId?: string,
  ): Promise<CustomerDramaCatalogDetail> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    if (accountId) assertUuid(accountId, 'accountId');
    const locale = optionalLocale(localeValue);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const context = await this.requireAvailableTenant(transaction, tenantId);
      const requestedLocale = locale ?? context.defaultLocale;
      const rows = await transaction<DramaCatalogRow[]>`
        select
          drama.id,
          drama.code::text,
          drama.owner_type,
          drama.total_episodes,
          (
            select point_price.points_amount
            from content_point_prices as point_price
            where point_price.tenant_id = ${tenantId}
              and point_price.target_type = 'drama'
              and point_price.target_id = drama.id
              and point_price.status = 'active'
          ) as points_amount,
          translation.locale,
          translation.title,
          translation.summary,
          case when cover.id is not null then drama.cover_file_id else null end
            as cover_media_id
        from dramas as drama
        inner join lateral (
          select selected.locale, selected.title, selected.summary
          from drama_translations as selected
          where selected.drama_id = drama.id
          order by
            case
              when selected.locale = ${requestedLocale} then 0
              when selected.locale = ${context.defaultLocale} then 1
              when selected.locale = 'en-US' then 2
              else 3
            end,
            selected.locale
          limit 1
        ) as translation on true
        left join media_assets as cover
          on cover.id = drama.cover_file_id
          and cover.kind = 'image'
          and cover.status = 'ready'
          and cover.deleted_at is null
        where drama.id = ${dramaId}
          and drama.status = 'published'
          and drama.deleted_at is null
          and drama.emergency_takedown_at is null
          and app.customer_region_allowed(${tenantId}, drama.id)
          and (drama.release_at is null or drama.release_at <= statement_timestamp())
          and (drama.unpublish_at is null or drama.unpublish_at > statement_timestamp())
          and (
            (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
            or (
              drama.owner_type = 'platform'
              and (app.tenant_drama_published(drama.id) or (
                ${accountId ?? null}::uuid is not null
                and exists (
                  select 1 from tenant_public_drama_publications p
                  where p.tenant_id = ${tenantId} and p.drama_id = drama.id and p.status = 'unpublished'
                )
                and exists (
                  select 1 from entitlements e
                  where e.tenant_id = ${tenantId} and e.account_id = ${accountId ?? null}
                    and e.revoked_at is null and e.expires_at is null and e.starts_at <= statement_timestamp()
                    and ((e.entitlement_type = 'drama' and e.product_id = drama.id)
                      or (e.entitlement_type = 'episode' and exists (
                        select 1 from episodes ep where ep.id = e.product_id and ep.drama_id = drama.id
                      )))
                    and app.lock_customer_row('entitlements', e.id, to_jsonb(e.*))
                )
              ))
            )
          )
        and app.lock_customer_row('dramas', drama.id, to_jsonb(drama.*))
      `;
      const drama = rows[0];
      if (!drama) throw new NotFoundException('Published drama is unavailable');
      if (drama.owner_type === 'platform') {
        await lockPublicDistribution(transaction, tenantId, drama.id,
          accountId ? ['published', 'unpublished'] : ['published']);
      }
      const episodes = await transaction<Array<{
        duration_seconds: number;
        episode_no: number;
        id: string;
        locale: CustomerContentLocale;
        media_asset_id: string;
        preview_seconds: number;
        points_amount: string | number | bigint | null;
        title: string;
        tracks: Array<{
          id: string;
          isDefault: boolean;
          label: string;
          locale: string;
          mediaAssetId: string;
          type: 'dubbing' | 'subtitle';
        }>;
      }>>`
        select
          episode.id,
          episode.episode_no,
          episode.duration_seconds,
          episode.preview_seconds,
          (
            select point_price.points_amount
            from content_point_prices as point_price
            where point_price.tenant_id = ${tenantId}
              and point_price.target_type = 'episode'
              and point_price.target_id = episode.id
              and point_price.status = 'active'
          ) as points_amount,
          episode.media_asset_id,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'id', track.id,
              'isDefault', track.is_default,
              'label', track.label,
              'locale', track.locale,
              'mediaAssetId', track.media_asset_id,
              'type', track.track_type
            ) order by track.track_type, track.is_default desc, track.locale)
            from episode_media_tracks as track
            where track.episode_id = episode.id and track.status = 'active'
          ), '[]'::jsonb) as tracks,
          translation.locale,
          translation.title
        from episodes as episode
        inner join media_assets as media
          on media.id = episode.media_asset_id
          and media.kind = 'video'
          and media.status = 'ready'
          and media.deleted_at is null
        inner join lateral (
          select selected.locale, selected.title
          from episode_translations as selected
          where selected.episode_id = episode.id
          order by
            case
              when selected.locale = ${requestedLocale} then 0
              when selected.locale = ${context.defaultLocale} then 1
              when selected.locale = 'en-US' then 2
              else 3
            end,
            selected.locale
          limit 1
        ) as translation on true
        where episode.drama_id = ${drama.id}
          and episode.status = 'published'
          and episode.deleted_at is null
          and (episode.release_at is null or episode.release_at <= statement_timestamp())
          and (episode.unpublish_at is null or episode.unpublish_at > statement_timestamp())
          and app.lock_customer_row('episodes', episode.id, to_jsonb(episode.*))
          and app.lock_customer_row('media_assets', media.id, to_jsonb(media.*))
        order by episode.episode_no, episode.id
      `;
      return {
        ...mapDrama(drama),
        episodes: episodes.map((episode) => ({
          durationSeconds: episode.duration_seconds,
          episodeNo: episode.episode_no,
          id: episode.id,
          locale: episode.locale,
          mediaAssetId: episode.media_asset_id,
          ...(episode.points_amount === null
            ? {}
            : { pointsAmount: amountNumber(episode.points_amount) }),
          previewSeconds: episode.preview_seconds,
          title: episode.title,
          tracks: episode.tracks,
        })),
      };
    });
  }

  private async requireAvailableTenant(
    transaction: DatabaseTransaction,
    tenantId: string,
  ): Promise<TenantCatalogContext> {
    const rows = await transaction<{ default_locale: CustomerContentLocale }[]>`
      select default_locale
      from tenants
      where id = ${tenantId}
        and status = 'active'
        and expires_at > statement_timestamp()
        and user_site_enabled
        and platform_site_enabled
      for share
    `;
    const tenant = rows[0];
    if (!tenant) throw new ForbiddenException('Customer site is unavailable');
    return { defaultLocale: tenant.default_locale };
  }

}

function catalogQuery(raw: CustomerDramaCatalogQuery) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException('Query is invalid');
  }
  const q = optionalText(raw.q, 'q', 1, 100);
  const category = optionalSelector(raw.category, 'category');
  const tag = optionalSelector(raw.tag, 'tag');
  const sort = raw.sort ?? 'latest';
  if (!['latest', 'popular', 'recommended'].includes(sort as string)) {
    throw new BadRequestException('sort must be latest, popular or recommended');
  }
  return {
    sort: sort as string,
    categoryCode: category?.code,
    categoryId: category?.id,
    locale: optionalLocale(raw.locale),
    page: integer(raw.page, 'page', 1, 1, 10_000),
    pageSize: integer(raw.pageSize, 'pageSize', 20, 1, 50),
    qPattern: q ? `%${escapeLike(q)}%` : undefined,
    tagCode: tag?.code,
    tagId: tag?.id,
  };
}

function optionalSelector(
  value: unknown,
  field: string,
): { code?: string; id?: string } | undefined {
  const selected = optionalText(value, field, 2, 64);
  if (!selected) return undefined;
  if (UUID_PATTERN.test(selected)) return { id: selected };
  const code = selected.toLowerCase();
  if (!CODE_PATTERN.test(code)) {
    throw new BadRequestException(`${field} must be a UUID or code`);
  }
  return { code };
}

function optionalLocale(value: unknown): CustomerContentLocale | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'string'
    || !CUSTOMER_CONTENT_LOCALES.includes(value as CustomerContentLocale)
  ) {
    throw new BadRequestException('locale is invalid');
  }
  return value as CustomerContentLocale;
}

function optionalText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} is invalid`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return normalized;
}

function integer(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequestException(`${field} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return parsed;
}

function escapeLike(value: string): string {
  return value.replace(/[!%_]/g, '!$&');
}

function mapDrama(row: DramaCatalogRow): CustomerDramaCatalogItem {
  return {
    code: row.code,
    coverMediaId: row.cover_media_id ?? undefined,
    id: row.id,
    locale: row.locale,
    ...(row.points_amount === null
      ? {}
      : { pointsAmount: amountNumber(row.points_amount) }),
    summary: row.summary,
    title: row.title,
    totalEpisodes: row.total_episodes,
    ...(row.heat === undefined ? {} : { heat: row.heat }),
    ...(row.published_at === undefined ? {} : { publishedAt: new Date(row.published_at).toISOString() }),
  };
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}
