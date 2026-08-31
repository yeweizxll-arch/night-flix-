import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import {
  CUSTOMER_CONTENT_LOCALES,
  type CustomerContentLocale,
} from '../customer-content/customer-content-catalog.types';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  CustomerEntitlementFilter,
  CustomerEntitlementQuery,
  CustomerPageQuery,
  CustomerStoreCurrency,
  CustomerStoreQuery,
} from './customer-store.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'KRW'] as const;
const MAX_CURSOR_LENGTH = 1_024;

interface StoreTenantContext {
  defaultLocale: CustomerContentLocale;
}

interface CatalogPriceRow {
  amount_minor: string | number | bigint;
  code: string;
  currency: CustomerStoreCurrency;
  description: string;
  duration_days?: number;
  id: string;
  locale: CustomerContentLocale;
  name: string;
}

interface TopupPriceRow extends CatalogPriceRow {
  bonus_points: string | number | bigint;
  points_amount: string | number | bigint;
}

export interface NavigationRow {
  code: string;
  id: string;
  locale: CustomerContentLocale;
  name: string;
}

interface PageCursor {
  accountId: string;
  createdAt: string;
  filter?: string;
  id: string;
  locale?: string;
  scope: 'entitlements' | 'point_ledger';
  tenantId: string;
  version: 1;
}

export function customerSiteUnavailable(): ForbiddenException {
  return new ForbiddenException({
    code: 'CUSTOMER_SITE_UNAVAILABLE',
    error: 'Forbidden',
    message: 'Customer site is unavailable',
    statusCode: 403,
  });
}

@Injectable()
export class CustomerStoreService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async bootstrap(tenantId: string, rawQuery: Record<string, unknown>) {
    assertUuid(tenantId, 'tenantId');
    assertAllowedKeys(rawQuery, []);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<Array<{
        default_locale: CustomerContentLocale;
        icon_media_asset_id: string | null;
        logo_media_asset_id: string | null;
        site_name: string;
        theme_json: unknown;
      }>>`
        select
          coalesce(site_name, name) as site_name,
          default_locale,
          theme_json,
          logo_media_asset_id,
          icon_media_asset_id
        from tenants
        where id = ${tenantId}
          and status = 'active'
          and expires_at > statement_timestamp()
          and platform_site_enabled
          and user_site_enabled
        for share
      `;
      const tenant = rows[0];
      if (!tenant) throw customerSiteUnavailable();
      return {
        capabilities: {
          commerceCatalog: true,
          customerAuthentication: true,
          entitlements: true,
          pointsWallet: true,
        },
        defaultLocale: tenant.default_locale,
        iconMediaAssetId: tenant.icon_media_asset_id ?? undefined,
        logoMediaAssetId: tenant.logo_media_asset_id ?? undefined,
        onlineOnly: true,
        siteName: tenant.site_name,
        supportedLocales: [...CUSTOMER_CONTENT_LOCALES],
        theme: safeTheme(tenant.theme_json),
      };
    });
  }

  async commerceCatalog(tenantId: string, rawQuery: CustomerStoreQuery) {
    assertUuid(tenantId, 'tenantId');
    const query = storeQuery(rawQuery);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const tenant = await this.lockAvailableTenant(transaction, tenantId);
      const locale = query.locale ?? tenant.defaultLocale;
      const plans = await transaction<CatalogPriceRow[]>`
        with selected_plans as (
          select selected.*
          from membership_plans as selected
          where selected.tenant_id = ${tenantId}
            and selected.status = 'active'
            and exists (
              select 1 from membership_plan_prices as selected_price
              where selected_price.tenant_id = selected.tenant_id
                and selected_price.plan_id = selected.id
                and selected_price.status = 'active'
                and (${query.currency ?? null}::text is null
                  or selected_price.currency = ${query.currency ?? null})
            )
            and exists (
              select 1 from membership_plan_translations as selected_translation
              where selected_translation.tenant_id = selected.tenant_id
                and selected_translation.plan_id = selected.id
            )
          order by selected.created_at desc, selected.id desc
          limit 101
        )
        select
          plan.id,
          plan.code::text,
          plan.duration_days,
          translation.locale,
          translation.name,
          translation.description,
          price.currency,
          price.amount_minor::text as amount_minor
        from selected_plans as plan
        inner join membership_plan_prices as price
          on price.tenant_id = plan.tenant_id
          and price.plan_id = plan.id
          and price.status = 'active'
          and (${query.currency ?? null}::text is null
            or price.currency = ${query.currency ?? null})
        inner join lateral (
          select selected.locale, selected.name, selected.description
          from membership_plan_translations as selected
          where selected.tenant_id = plan.tenant_id
            and selected.plan_id = plan.id
          order by
            case
              when selected.locale = ${locale} then 0
              when selected.locale = ${tenant.defaultLocale} then 1
              when selected.locale = 'en-US' then 2
              else 3
            end,
            selected.locale
          limit 1
        ) as translation on true
        order by plan.created_at desc, plan.id, price.currency
      `;
      const topups = await transaction<TopupPriceRow[]>`
        with selected_packages as (
          select selected.*
          from points_topup_packages as selected
          where selected.tenant_id = ${tenantId}
            and selected.status = 'active'
            and exists (
              select 1 from points_topup_package_prices as selected_price
              where selected_price.tenant_id = selected.tenant_id
                and selected_price.package_id = selected.id
                and selected_price.status = 'active'
                and (${query.currency ?? null}::text is null
                  or selected_price.currency = ${query.currency ?? null})
            )
            and exists (
              select 1 from points_topup_package_translations as selected_translation
              where selected_translation.tenant_id = selected.tenant_id
                and selected_translation.package_id = selected.id
            )
          order by selected.created_at desc, selected.id desc
          limit 101
        )
        select
          package.id,
          package.code::text,
          package.points_amount::text as points_amount,
          package.bonus_points::text as bonus_points,
          translation.locale,
          translation.name,
          translation.description,
          price.currency,
          price.amount_minor::text as amount_minor
        from selected_packages as package
        inner join points_topup_package_prices as price
          on price.tenant_id = package.tenant_id
          and price.package_id = package.id
          and price.status = 'active'
          and (${query.currency ?? null}::text is null
            or price.currency = ${query.currency ?? null})
        inner join lateral (
          select selected.locale, selected.name, selected.description
          from points_topup_package_translations as selected
          where selected.tenant_id = package.tenant_id
            and selected.package_id = package.id
          order by
            case
              when selected.locale = ${locale} then 0
              when selected.locale = ${tenant.defaultLocale} then 1
              when selected.locale = 'en-US' then 2
              else 3
            end,
            selected.locale
          limit 1
        ) as translation on true
        order by package.created_at desc, package.id, price.currency
      `;
      const membershipPlans = groupPlans(plans);
      const pointsTopupPackages = groupTopups(topups);
      return {
        currency: query.currency,
        locale,
        membershipPlans: membershipPlans.slice(0, 100),
        membershipPlansHasMore: membershipPlans.length > 100,
        pointsTopupPackages: pointsTopupPackages.slice(0, 100),
        pointsTopupPackagesHasMore: pointsTopupPackages.length > 100,
      };
    });
  }

  async categories(tenantId: string, rawQuery: Record<string, unknown>) {
    return this.navigation(tenantId, rawQuery, 'category');
  }

  async tags(tenantId: string, rawQuery: Record<string, unknown>) {
    return this.navigation(tenantId, rawQuery, 'tag');
  }

  async accountMe(principal: CustomerPrincipal, rawQuery: Record<string, unknown>) {
    assertAllowedKeys(rawQuery, []);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.lockAvailableTenant(transaction, principal.tenantId);
      const rows = await transaction<Array<{
        email: string | null;
        email_verified_at: Date | string | null;
        phone: string | null;
        phone_verified_at: Date | string | null;
        username: string;
      }>>`
        select username::text, email::text, phone::text,
          email_verified_at, phone_verified_at
        from customer_accounts
        where tenant_id = ${principal.tenantId}
          and id = ${principal.accountId}
          and status = 'active'
        for share
      `;
      const account = rows[0];
      if (!account) throw new NotFoundException('Customer account is unavailable');
      return {
        accountId: principal.accountId,
        email: account.email
          ? { masked: maskEmail(account.email), verified: Boolean(account.email_verified_at) }
          : undefined,
        phone: account.phone
          ? { masked: maskPhone(account.phone), verified: Boolean(account.phone_verified_at) }
          : undefined,
        username: account.username,
      };
    });
  }

  async pointWallet(principal: CustomerPrincipal, rawQuery: Record<string, unknown>) {
    assertAllowedKeys(rawQuery, []);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.lockAvailableTenant(transaction, principal.tenantId);
      await this.lockCustomer(transaction, principal);
      const rows = await transaction<Array<{
        balance: string | number | bigint;
        updated_at: Date | string;
      }>>`
        select balance::text as balance, updated_at
        from point_accounts
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
      `;
      return {
        balancePoints: decimalString(rows[0]?.balance ?? 0),
        updatedAt: rows[0] ? isoTimestamp(rows[0].updated_at) : undefined,
      };
    });
  }

  async pointLedger(principal: CustomerPrincipal, rawQuery: CustomerPageQuery) {
    const query = pageQuery(rawQuery, 'point_ledger', principal);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.lockAvailableTenant(transaction, principal.tenantId);
      await this.lockCustomer(transaction, principal);
      const rows = await transaction<Array<{
        balance_after: string | number | bigint;
        created_at: Date | string;
        delta: string | number | bigint;
        entry_type: string;
        id: string;
        reference_id: string;
        reference_type: string;
      }>>`
        select id, entry_type, delta::text as delta,
          balance_after::text as balance_after,
          reference_type, reference_id, created_at
        from point_ledger
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and (
            ${query.cursor?.createdAt ?? null}::timestamptz is null
            or (created_at, id) < (
              ${query.cursor?.createdAt ?? null}::timestamptz,
              ${query.cursor?.id ?? null}::uuid
            )
          )
        order by created_at desc, id desc
        limit ${query.pageSize + 1}
      `;
      const hasMore = rows.length > query.pageSize;
      const selected = rows.slice(0, query.pageSize);
      const last = selected.at(-1);
      return {
        items: selected.map((row) => ({
          balanceAfterPoints: decimalString(row.balance_after),
          createdAt: isoTimestamp(row.created_at),
          deltaPoints: decimalString(row.delta),
          entryType: row.entry_type,
          id: row.id,
          referenceId: row.reference_id,
          referenceType: row.reference_type,
        })),
        nextCursor: hasMore && last
          ? encodeCursor({
              accountId: principal.accountId,
              createdAt: isoTimestamp(last.created_at),
              id: last.id,
              scope: 'point_ledger',
              tenantId: principal.tenantId,
              version: 1,
            })
          : undefined,
        pageSize: query.pageSize,
      };
    });
  }

  async entitlements(principal: CustomerPrincipal, rawQuery: CustomerEntitlementQuery) {
    const query = entitlementQuery(rawQuery, principal);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      const tenant = await this.lockAvailableTenant(transaction, principal.tenantId);
      await this.lockCustomer(transaction, principal);
      const locale = query.locale ?? tenant.defaultLocale;
      if (query.cursor && query.cursor.locale !== locale) {
        throw new BadRequestException('cursor does not match this entitlement query');
      }
      const rows = await transaction<Array<{
        code: string | null;
        created_at: Date | string;
        entitlement_type: 'drama' | 'episode' | 'membership';
        expires_at: Date | string | null;
        id: string;
        locale: CustomerContentLocale | null;
        product_id: string;
        starts_at: Date | string;
        title: string | null;
      }>>`
        select
          entitlement.id,
          entitlement.entitlement_type,
          entitlement.product_id,
          entitlement.starts_at,
          entitlement.expires_at,
          entitlement.created_at,
          case
            when entitlement.entitlement_type = 'membership' then membership.code::text
            when entitlement.entitlement_type = 'drama' then drama.code::text
            when entitlement.entitlement_type = 'episode' then episode_drama.code::text
          end as code,
          case
            when entitlement.entitlement_type = 'membership' then membership_translation.name
            when entitlement.entitlement_type = 'drama' then drama_translation.title
            when entitlement.entitlement_type = 'episode' then episode_translation.title
          end as title,
          case
            when entitlement.entitlement_type = 'membership' then membership_translation.locale
            when entitlement.entitlement_type = 'drama' then drama_translation.locale
            when entitlement.entitlement_type = 'episode' then episode_translation.locale
          end as locale
        from entitlements as entitlement
        left join membership_plans as membership
          on entitlement.entitlement_type = 'membership'
          and membership.tenant_id = entitlement.tenant_id
          and membership.id = entitlement.product_id
        left join lateral (
          select selected.locale, selected.name
          from membership_plan_translations as selected
          where selected.tenant_id = membership.tenant_id
            and selected.plan_id = membership.id
          order by
            case
              when selected.locale = ${locale} then 0
              when selected.locale = ${tenant.defaultLocale} then 1
              when selected.locale = 'en-US' then 2
              else 3
            end,
            selected.locale
          limit 1
        ) as membership_translation on true
        left join dramas as drama
          on entitlement.entitlement_type = 'drama'
          and drama.id = entitlement.product_id
        left join lateral (
          select selected.locale, selected.title
          from drama_translations as selected
          where selected.drama_id = drama.id
          order by
            case
              when selected.locale = ${locale} then 0
              when selected.locale = ${tenant.defaultLocale} then 1
              when selected.locale = 'en-US' then 2
              else 3
            end,
            selected.locale
          limit 1
        ) as drama_translation on true
        left join episodes as episode
          on entitlement.entitlement_type = 'episode'
          and episode.id = entitlement.product_id
        left join dramas as episode_drama on episode_drama.id = episode.drama_id
        left join lateral (
          select selected.locale, selected.title
          from episode_translations as selected
          where selected.episode_id = episode.id
          order by
            case
              when selected.locale = ${locale} then 0
              when selected.locale = ${tenant.defaultLocale} then 1
              when selected.locale = 'en-US' then 2
              else 3
            end,
            selected.locale
          limit 1
        ) as episode_translation on true
        where entitlement.tenant_id = ${principal.tenantId}
          and entitlement.account_id = ${principal.accountId}
          and (
            (
              ${query.status} = 'active'
              and entitlement.revoked_at is null
              and entitlement.starts_at <= statement_timestamp()
              and (entitlement.expires_at is null
                or entitlement.expires_at > statement_timestamp())
            )
            or (
              ${query.status} = 'expired'
              and (
                entitlement.revoked_at is not null
                or entitlement.expires_at <= statement_timestamp()
              )
            )
          )
          and (
            ${query.cursor?.createdAt ?? null}::timestamptz is null
            or (entitlement.created_at, entitlement.id) < (
              ${query.cursor?.createdAt ?? null}::timestamptz,
              ${query.cursor?.id ?? null}::uuid
            )
          )
        order by entitlement.created_at desc, entitlement.id desc
        limit ${query.pageSize + 1}
      `;
      const hasMore = rows.length > query.pageSize;
      const selected = rows.slice(0, query.pageSize);
      const last = selected.at(-1);
      return {
        items: selected.map((row) => ({
          code: row.code ?? undefined,
          expiresAt: row.expires_at ? isoTimestamp(row.expires_at) : undefined,
          id: row.id,
          locale: row.locale ?? undefined,
          productId: row.product_id,
          startsAt: isoTimestamp(row.starts_at),
          status: query.status,
          title: row.title ?? undefined,
          type: row.entitlement_type,
        })),
        nextCursor: hasMore && last
          ? encodeCursor({
              accountId: principal.accountId,
              createdAt: isoTimestamp(last.created_at),
              filter: query.status,
              id: last.id,
              locale,
              scope: 'entitlements',
              tenantId: principal.tenantId,
              version: 1,
            })
          : undefined,
        pageSize: query.pageSize,
        status: query.status,
      };
    });
  }

  private async navigation(
    tenantId: string,
    rawQuery: Record<string, unknown>,
    kind: 'category' | 'tag',
  ) {
    assertUuid(tenantId, 'tenantId');
    assertAllowedKeys(rawQuery, ['locale']);
    const requestedLocale = optionalLocale(rawQuery.locale);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const tenant = await this.lockAvailableTenant(transaction, tenantId);
      const locale = requestedLocale ?? tenant.defaultLocale;
      const rows = kind === 'category'
        ? await transaction<NavigationRow[]>`
            select category.id, category.code::text, translation.locale, translation.name
            from categories as category
            inner join lateral (
              select selected.locale, selected.name
              from category_translations as selected
              where selected.category_id = category.id
              order by
                case
                  when selected.locale = ${locale} then 0
                  when selected.locale = ${tenant.defaultLocale} then 1
                  when selected.locale = 'en-US' then 2
                  else 3
                end,
                selected.locale
              limit 1
            ) as translation on true
            where category.status = 'active'
              and category.deleted_at is null
              and (
                (category.owner_type = 'tenant' and category.owner_tenant_id = ${tenantId})
                or category.owner_type = 'platform'
              )
              and exists (
                select 1 from dramas as drama
                where drama.category_id = category.id
                  and drama.status = 'published'
                  and drama.deleted_at is null
                  and (drama.release_at is null
                    or drama.release_at <= statement_timestamp())
                  and (drama.unpublish_at is null
                    or drama.unpublish_at > statement_timestamp())
                  and (
                    (drama.owner_type = 'tenant'
                      and drama.owner_tenant_id = ${tenantId})
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
              )
            order by category.sort_order, translation.name, category.id
            limit 201
          `
        : await transaction<NavigationRow[]>`
            select tag.id, tag.code::text, translation.locale, translation.name
            from tags as tag
            inner join lateral (
              select selected.locale, selected.name
              from tag_translations as selected
              where selected.tag_id = tag.id
              order by
                case
                  when selected.locale = ${locale} then 0
                  when selected.locale = ${tenant.defaultLocale} then 1
                  when selected.locale = 'en-US' then 2
                  else 3
                end,
                selected.locale
              limit 1
            ) as translation on true
            where tag.status = 'active'
              and tag.deleted_at is null
              and (
                (tag.owner_type = 'tenant' and tag.owner_tenant_id = ${tenantId})
                or tag.owner_type = 'platform'
              )
              and exists (
                select 1
                from drama_tags as drama_tag
                inner join dramas as drama on drama.id = drama_tag.drama_id
                where drama_tag.tag_id = tag.id
                  and drama.status = 'published'
                  and drama.deleted_at is null
                  and (drama.release_at is null
                    or drama.release_at <= statement_timestamp())
                  and (drama.unpublish_at is null
                    or drama.unpublish_at > statement_timestamp())
                  and (
                    (drama.owner_type = 'tenant'
                      and drama.owner_tenant_id = ${tenantId})
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
              )
            order by translation.name, tag.id
            limit 201
          `;
      return { hasMore: rows.length > 200, items: rows.slice(0, 200), locale };
    });
  }

  private async lockAvailableTenant(
    transaction: DatabaseTransaction,
    tenantId: string,
  ): Promise<StoreTenantContext> {
    const rows = await transaction<{ default_locale: CustomerContentLocale }[]>`
      select default_locale
      from tenants
      where id = ${tenantId}
        and status = 'active'
        and expires_at > statement_timestamp()
        and platform_site_enabled
        and user_site_enabled
      for share
    `;
    if (!rows[0]) throw customerSiteUnavailable();
    return { defaultLocale: rows[0].default_locale };
  }

  private async lockCustomer(
    transaction: DatabaseTransaction,
    principal: CustomerPrincipal,
  ): Promise<void> {
    const rows = await transaction<{ id: string }[]>`
      select id from customer_accounts
      where tenant_id = ${principal.tenantId}
        and id = ${principal.accountId}
        and status = 'active'
      for share
    `;
    if (!rows[0]) throw new NotFoundException('Customer account is unavailable');
  }
}

function storeQuery(raw: CustomerStoreQuery) {
  assertAllowedKeys(raw, ['currency', 'locale']);
  return {
    currency: optionalCurrency(raw.currency),
    locale: optionalLocale(raw.locale),
  };
}

function pageQuery(
  raw: CustomerPageQuery,
  scope: PageCursor['scope'],
  principal: CustomerPrincipal,
) {
  assertAllowedKeys(raw, ['cursor', 'pageSize']);
  const cursor = optionalCursor(raw.cursor, scope, principal);
  return { cursor, pageSize: pageSize(raw.pageSize) };
}

function entitlementQuery(raw: CustomerEntitlementQuery, principal: CustomerPrincipal) {
  assertAllowedKeys(raw, ['cursor', 'locale', 'pageSize', 'status']);
  const status = entitlementStatus(raw.status);
  const locale = optionalLocale(raw.locale);
  const cursor = optionalCursor(raw.cursor, 'entitlements', principal);
  if (cursor && cursor.filter !== status) {
    throw new BadRequestException('cursor does not match this entitlement query');
  }
  return { cursor, locale, pageSize: pageSize(raw.pageSize), status };
}

function entitlementStatus(value: unknown): CustomerEntitlementFilter {
  if (value === undefined) return 'active';
  if (value !== 'active' && value !== 'expired') {
    throw new BadRequestException('status is invalid');
  }
  return value;
}

function optionalCurrency(value: unknown): CustomerStoreCurrency | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !CURRENCIES.includes(value as CustomerStoreCurrency)) {
    throw new BadRequestException('currency is invalid');
  }
  return value as CustomerStoreCurrency;
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

function pageSize(value: unknown): number {
  if (value === undefined) return 20;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequestException('pageSize is invalid');
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) {
    throw new BadRequestException('pageSize is invalid');
  }
  return parsed;
}

function optionalCursor(
  value: unknown,
  scope: PageCursor['scope'],
  principal: CustomerPrincipal,
): PageCursor | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > MAX_CURSOR_LENGTH) {
    throw new BadRequestException('cursor is invalid');
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    const cursor = parsed as Partial<PageCursor>;
    if (
      cursor.version !== 1
      || cursor.scope !== scope
      || cursor.tenantId !== principal.tenantId
      || cursor.accountId !== principal.accountId
      || typeof cursor.createdAt !== 'string'
      || !validIsoTimestamp(cursor.createdAt)
      || typeof cursor.id !== 'string'
      || !UUID_PATTERN.test(cursor.id)
      || (cursor.filter !== undefined && typeof cursor.filter !== 'string')
      || (cursor.locale !== undefined && typeof cursor.locale !== 'string')
    ) {
      throw new Error();
    }
    return cursor as PageCursor;
  } catch {
    throw new BadRequestException('cursor is invalid');
  }
}

function encodeCursor(value: PageCursor): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function assertAllowedKeys(value: unknown, allowed: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Query is invalid');
  }
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) throw new BadRequestException(`Unknown query parameter: ${key}`);
  }
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function safeTheme(value: unknown) {
  const fallback = {
    accentColor: '#22c55e',
    colorMode: 'system' as const,
    primaryColor: '#2563eb',
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fallback;
  const theme = value as Record<string, unknown>;
  return {
    accentColor: color(theme.accentColor) ?? fallback.accentColor,
    colorMode: theme.colorMode === 'light' || theme.colorMode === 'dark'
      || theme.colorMode === 'system' ? theme.colorMode : fallback.colorMode,
    primaryColor: color(theme.primaryColor) ?? fallback.primaryColor,
  };
}

function color(value: unknown): string | undefined {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)
    ? value.toLowerCase()
    : undefined;
}

function groupPlans(rows: CatalogPriceRow[]) {
  const grouped = new Map<string, {
    code: string;
    description: string;
    durationDays: number;
    id: string;
    locale: CustomerContentLocale;
    name: string;
    prices: Array<{ amountMinor: string; currency: CustomerStoreCurrency }>;
  }>();
  for (const row of rows) {
    const current = grouped.get(row.id) ?? {
      code: row.code,
      description: row.description,
      durationDays: row.duration_days ?? 0,
      id: row.id,
      locale: row.locale,
      name: row.name,
      prices: [],
    };
    current.prices.push({ amountMinor: decimalString(row.amount_minor), currency: row.currency });
    grouped.set(row.id, current);
  }
  return [...grouped.values()];
}

function groupTopups(rows: TopupPriceRow[]) {
  const grouped = new Map<string, {
    bonusPoints: string;
    code: string;
    description: string;
    id: string;
    locale: CustomerContentLocale;
    name: string;
    pointsAmount: string;
    prices: Array<{ amountMinor: string; currency: CustomerStoreCurrency }>;
  }>();
  for (const row of rows) {
    const current = grouped.get(row.id) ?? {
      bonusPoints: decimalString(row.bonus_points),
      code: row.code,
      description: row.description,
      id: row.id,
      locale: row.locale,
      name: row.name,
      pointsAmount: decimalString(row.points_amount),
      prices: [],
    };
    current.prices.push({ amountMinor: decimalString(row.amount_minor), currency: row.currency });
    grouped.set(row.id, current);
  }
  return [...grouped.values()];
}

function decimalString(value: string | number | bigint): string {
  const normalized = String(value);
  if (!/^-?[0-9]{1,16}$/.test(normalized)) {
    throw new Error('Database returned an invalid decimal amount');
  }
  return normalized;
}

function maskEmail(value: string): string {
  const separator = value.lastIndexOf('@');
  if (separator <= 0 || separator === value.length - 1) return '***';
  return `${value.slice(0, 1)}***@${value.slice(separator + 1)}`;
}

function maskPhone(value: string): string {
  const visible = value.slice(-4);
  return `${value.startsWith('+') ? '+' : ''}***${visible}`;
}

function isoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Database returned an invalid timestamp');
  return date.toISOString();
}

function validIsoTimestamp(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}
