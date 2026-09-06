import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  EmergencyTakedownInput,
  PublicDramaPoolMutationMetadata,
  PublishPublicDramaInput,
  ReviewPublicDramaInput,
  TenantAppRuntimeConfigInput,
  UnpublishPublicDramaInput,
} from './public-drama-pool.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;
const LOCALE_PATTERN = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|-[0-9]{3})?$/;
const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

interface PublicationRow {
  allowed_countries: string[];
  blocked_countries: string[];
  drama_id: string;
  id: string;
  published_at: Date | null;
  review_note: string | null;
  status: string;
  version: number;
}

@Injectable()
export class PublicDramaPoolService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async listPool(tenantId: string, pageValue: unknown, pageSizeValue: unknown) {
    assertUuid(tenantId, 'tenantId');
    const page = positiveInteger(pageValue, 1, 10_000, 'page');
    const pageSize = positiveInteger(pageSizeValue, 20, 100, 'pageSize');
    return this.database.inPlatformContext(async (transaction) => {
      await this.requireTenant(transaction, tenantId);
      const rows = await transaction<Array<{
        code: string;
        cover_media_asset_id: string | null;
        drama_id: string;
        emergency_takedown_at: Date | null;
        locale: string;
        publication_status: string | null;
        publication_version: number | null;
        summary: string;
        title: string;
        total_count: number;
        total_episodes: number;
      }>>`
        select
          drama.id as drama_id,
          drama.code::text,
          drama.total_episodes,
          drama.cover_file_id as cover_media_asset_id,
          drama.emergency_takedown_at,
          translation.locale,
          translation.title,
          translation.summary,
          publication.status as publication_status,
          publication.version as publication_version,
          count(*) over()::integer as total_count
        from dramas as drama
        inner join lateral (
          select selected.locale, selected.title, selected.summary
          from drama_translations as selected
          where selected.drama_id = drama.id
          order by case when selected.locale = 'en-US' then 0 else 1 end, selected.locale
          limit 1
        ) as translation on true
        left join tenant_public_drama_publications as publication
          on publication.drama_id = drama.id
          and publication.tenant_id = ${tenantId}
        where drama.owner_type = 'platform'
          and drama.owner_tenant_id is null
          and drama.status = 'published'
          and drama.deleted_at is null
          and drama.emergency_takedown_at is null
        order by coalesce(drama.release_at, drama.created_at) desc, drama.id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map((row) => ({
          code: row.code,
          coverMediaAssetId: row.cover_media_asset_id ?? undefined,
          dramaId: row.drama_id,
          locale: row.locale,
          publicationStatus: row.publication_status ?? 'pending_review',
          publicationVersion: row.publication_version ?? 0,
          summary: row.summary,
          title: row.title,
          totalEpisodes: row.total_episodes,
        })),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  async review(
    tenantId: string,
    dramaId: string,
    rawInput: ReviewPublicDramaInput,
    metadata: PublicDramaPoolMutationMetadata,
  ) {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    const input = reviewInput(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.requireTenant(transaction, tenantId);
      const existing = await this.lockPublication(transaction, tenantId, dramaId);
      if (existing && existing.status === 'published') {
        throw new ConflictException('Published drama must be unpublished before another review');
      }
      if (existing && existing.version !== input.expectedVersion) {
        throw new ConflictException('Public drama publication has changed');
      }
      const id = existing?.id ?? uuidV7();
      const rows = await transaction<PublicationRow[]>`
        insert into tenant_public_drama_publications (
          id, tenant_id, drama_id, status, review_note, reviewed_at, reviewed_by,
          version, created_by, updated_by
        ) values (
          ${id}, ${tenantId}, ${dramaId}, ${input.decision}, ${input.note ?? null},
          statement_timestamp(), ${metadata.actorId}, 0, ${metadata.actorId}, ${metadata.actorId}
        )
        on conflict (tenant_id, drama_id) do update
        set status = excluded.status,
          review_note = excluded.review_note,
          reviewed_at = statement_timestamp(),
          reviewed_by = excluded.reviewed_by,
          unpublished_at = null,
          version = tenant_public_drama_publications.version + 1,
          updated_by = excluded.updated_by
        where tenant_public_drama_publications.version = ${input.expectedVersion}
        returning *
      `;
      const saved = rows[0];
      if (!saved) throw new ConflictException('Public drama publication has changed');
      await this.auditTenant(transaction, tenantId, metadata, {
        action: `public_drama.review.${input.decision}`,
        resourceId: saved.id,
        after: { dramaId, note: input.note, status: input.decision, version: saved.version },
      });
      return publicationRecord(saved);
    });
  }

  async publish(
    tenantId: string,
    dramaId: string,
    rawInput: PublishPublicDramaInput,
    metadata: PublicDramaPoolMutationMetadata,
  ) {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    const input = publishInput(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.requireTenant(transaction, tenantId);
      const publication = await this.lockPublication(transaction, tenantId, dramaId);
      if (!publication) throw new BadRequestException('Drama must be approved before publishing');
      if (!['approved', 'unpublished'].includes(publication.status)) {
        throw new ConflictException('Drama is not ready to publish');
      }
      if (publication.version !== input.expectedVersion) {
        throw new ConflictException('Public drama publication has changed');
      }
      const dramas = await transaction<{ id: string }[]>`
        select drama.id
        from dramas as drama
        where drama.id = ${dramaId}
          and drama.owner_type = 'platform'
          and drama.status = 'published'
          and drama.deleted_at is null
          and drama.emergency_takedown_at is null
          and app.freeze_public_release(drama.id)
      `;
      if (!dramas[0]) throw new NotFoundException('Public drama is unavailable');
      await this.upsertPointPrices(transaction, tenantId, dramaId, input, metadata.actorId);
      const rows = await transaction<PublicationRow[]>`
        update tenant_public_drama_publications
        set status = 'published',
          allowed_countries = ${input.allowedCountries},
          blocked_countries = ${input.blockedCountries},
          published_at = coalesce(published_at, statement_timestamp()),
          unpublished_at = null,
          version = version + 1,
          updated_by = ${metadata.actorId}
        where tenant_id = ${tenantId}
          and drama_id = ${dramaId}
          and version = ${input.expectedVersion}
        returning *
      `;
      const saved = rows[0];
      if (!saved) throw new ConflictException('Public drama publication has changed');
      await this.auditTenant(transaction, tenantId, metadata, {
        action: 'public_drama.publish',
        resourceId: saved.id,
        after: {
          allowedCountries: input.allowedCountries,
          blockedCountries: input.blockedCountries,
          dramaId,
          dramaPoints: input.dramaPoints,
          episodePointCount: input.episodePoints.length,
          status: 'published',
          version: saved.version,
        },
      });
      return publicationRecord(saved);
    });
  }

  async unpublish(
    tenantId: string,
    dramaId: string,
    rawInput: UnpublishPublicDramaInput,
    metadata: PublicDramaPoolMutationMetadata,
  ) {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    const expectedVersion = versionValue(rawInput?.expectedVersion);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<PublicationRow[]>`
        update tenant_public_drama_publications
        set status = 'unpublished', unpublished_at = statement_timestamp(),
          version = version + 1, updated_by = ${metadata.actorId}
        where tenant_id = ${tenantId} and drama_id = ${dramaId}
          and status = 'published' and version = ${expectedVersion}
        returning *
      `;
      const saved = rows[0];
      if (!saved) throw new ConflictException('Published drama state has changed');
      await this.auditTenant(transaction, tenantId, metadata, {
        action: 'public_drama.unpublish', resourceId: saved.id,
        after: { dramaId, status: 'unpublished', version: saved.version },
      });
      return publicationRecord(saved);
    });
  }

  async emergencyTakedown(
    dramaId: string,
    rawInput: EmergencyTakedownInput,
    metadata: PublicDramaPoolMutationMetadata,
  ) {
    assertUuid(dramaId, 'dramaId');
    const expectedVersion = versionValue(rawInput?.expectedVersion);
    const reason = textValue(rawInput?.reason, 'reason', 1, 2_000);
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<{ id: string; version: number }[]>`
        update dramas
        set status = 'unpublished',
          emergency_takedown_at = statement_timestamp(),
          emergency_takedown_reason = ${reason},
          version = version + 1,
          updated_by = ${metadata.actorId}
        where id = ${dramaId}
          and owner_type = 'platform'
          and deleted_at is null
          and emergency_takedown_at is null
          and version = ${expectedVersion}
        returning id, version
      `;
      const drama = rows[0];
      if (!drama) throw new ConflictException('Public drama state has changed');
      await transaction`
        update episodes set status = 'unpublished', version = version + 1,
          updated_by = ${metadata.actorId}
        where drama_id = ${dramaId} and deleted_at is null and status <> 'unpublished'
      `;
      await this.auditPlatform(transaction, metadata, {
        action: 'platform.public_drama.emergency_takedown',
        resourceId: dramaId,
        after: { reason, version: drama.version },
      });
      return { dramaId, emergencyTakedown: true, reason, version: drama.version };
    });
  }

  async getRuntimeConfig(tenantId: string) {
    assertUuid(tenantId, 'tenantId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.requireTenant(transaction, tenantId);
      const rows = await transaction<Array<{
        admob_json: unknown; allowed_countries: string[]; deep_link_host: string | null;
        feature_flags_json: unknown; store_products_json: unknown;
        supported_locales: string[]; version: number;
      }>>`
        select supported_locales, allowed_countries, deep_link_host,
          feature_flags_json, admob_json, store_products_json, version
        from tenant_app_runtime_configs where tenant_id = ${tenantId}
      `;
      return runtimeConfigRecord(rows[0]);
    });
  }

  async updateRuntimeConfig(
    tenantId: string,
    rawInput: TenantAppRuntimeConfigInput,
    metadata: PublicDramaPoolMutationMetadata,
  ) {
    assertUuid(tenantId, 'tenantId');
    const input = runtimeConfigInput(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await this.requireTenant(transaction, tenantId);
      const idRows = await transaction<{ tenant_id: string }[]>`
        insert into tenant_app_runtime_configs (
          tenant_id, supported_locales, allowed_countries, deep_link_host,
          feature_flags_json, admob_json, store_products_json,
          version, created_by, updated_by
        ) values (
          ${tenantId}, ${input.supportedLocales}, ${input.allowedCountries},
          ${input.deepLinkHost}, ${transaction.json(input.featureFlags)},
          ${transaction.json(input.admob)}, ${transaction.json(input.storeProducts)},
          0, ${metadata.actorId}, ${metadata.actorId}
        )
        on conflict (tenant_id) do update set
          supported_locales = excluded.supported_locales,
          allowed_countries = excluded.allowed_countries,
          deep_link_host = excluded.deep_link_host,
          feature_flags_json = excluded.feature_flags_json,
          admob_json = excluded.admob_json,
          store_products_json = excluded.store_products_json,
          version = tenant_app_runtime_configs.version + 1,
          updated_by = excluded.updated_by
        where tenant_app_runtime_configs.version = ${input.expectedVersion}
        returning tenant_id
      `;
      if (!idRows[0]) throw new ConflictException('App runtime config has changed');
      await this.auditTenant(transaction, tenantId, metadata, {
        action: 'tenant.app_runtime_config.update', resourceId: tenantId,
        after: { ...input, expectedVersion: undefined },
      });
      const rows = await transaction<any[]>`
        select supported_locales, allowed_countries, deep_link_host,
          feature_flags_json, admob_json, store_products_json, version
        from tenant_app_runtime_configs where tenant_id = ${tenantId}
      `;
      return runtimeConfigRecord(rows[0]);
    });
  }

  private async lockPublication(
    transaction: DatabaseTransaction,
    tenantId: string,
    dramaId: string,
  ): Promise<PublicationRow | undefined> {
    const rows = await transaction<PublicationRow[]>`
      select * from tenant_public_drama_publications
      where tenant_id = ${tenantId} and drama_id = ${dramaId}
      for update
    `;
    return rows[0];
  }

  private async requireTenant(transaction: DatabaseTransaction, tenantId: string) {
    const rows = await transaction<{ id: string }[]>`
      select id from tenants where id = ${tenantId} and status = 'active'
        and expires_at > statement_timestamp() for share
    `;
    if (!rows[0]) throw new NotFoundException('Tenant is unavailable');
  }

  private async upsertPointPrices(
    transaction: DatabaseTransaction,
    tenantId: string,
    dramaId: string,
    input: ReturnType<typeof publishInput>,
    actorId: string,
  ) {
    const targets = [
      ...(input.dramaPoints === undefined ? [] : [{ type: 'drama', id: dramaId, points: input.dramaPoints }]),
      ...input.episodePoints.map((item) => ({ type: 'episode', id: item.episodeId, points: item.points })),
    ];
    for (const target of targets) {
      if (target.type === 'episode') {
        const rows = await transaction<{ id: string }[]>`
          select id from episodes where id = ${target.id} and drama_id = ${dramaId}
            and status = 'published' and deleted_at is null
        `;
        if (!rows[0]) throw new BadRequestException('Episode point price target is unavailable');
      }
      await transaction`
        insert into content_point_prices (
          id, tenant_id, target_type, target_id, points_amount, status,
          created_by, updated_by
        ) values (
          ${uuidV7()}, ${tenantId}, ${target.type}, ${target.id}, ${target.points},
          'active', ${actorId}, ${actorId}
        ) on conflict (tenant_id, target_type, target_id) do update
        set points_amount = excluded.points_amount, status = 'active',
          version = content_point_prices.version + 1, updated_by = excluded.updated_by
      `;
    }
  }

  private async auditTenant(
    transaction: DatabaseTransaction,
    tenantId: string,
    metadata: PublicDramaPoolMutationMetadata,
    input: { action: string; after: object; resourceId: string },
  ) {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, ip, request_id
      ) values (
        ${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff', ${metadata.actorId},
        ${input.action}, 'public_drama_publication', ${input.resourceId},
        ${transaction.json(toJson(input.after))}, ${metadata.ip ?? null}, ${metadata.requestId}
      )
    `;
  }

  private async auditPlatform(
    transaction: DatabaseTransaction,
    metadata: PublicDramaPoolMutationMetadata,
    input: { action: string; after: object; resourceId: string },
  ) {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, ip, request_id
      ) values (
        ${uuidV7()}, 'platform', null, 'platform_staff', ${metadata.actorId},
        ${input.action}, 'drama', ${input.resourceId},
        ${transaction.json(toJson(input.after))}, ${metadata.ip ?? null}, ${metadata.requestId}
      )
    `;
  }
}

function reviewInput(input: ReviewPublicDramaInput) {
  if (!input || !['approved', 'rejected'].includes(input.decision)) {
    throw new BadRequestException('decision must be approved or rejected');
  }
  const note = input.note === undefined ? undefined : textValue(input.note, 'note', 1, 2_000);
  if (input.decision === 'rejected' && !note) {
    throw new BadRequestException('note is required when rejecting a drama');
  }
  return { decision: input.decision, expectedVersion: versionValue(input.expectedVersion ?? 0), note };
}

function publishInput(input: PublishPublicDramaInput) {
  if (!input) throw new BadRequestException('Request body is required');
  const allowedCountries = countryCodes(input.allowedCountries ?? []);
  const blockedCountries = countryCodes(input.blockedCountries ?? []);
  if (allowedCountries.some((country) => blockedCountries.includes(country))) {
    throw new BadRequestException('A country cannot be both allowed and blocked');
  }
  const episodePoints = (input.episodePoints ?? []).map((item) => ({
    episodeId: uuidValue(item?.episodeId, 'episodeId'),
    points: pointsValue(item?.points, 'episode points'),
  }));
  if (new Set(episodePoints.map((item) => item.episodeId)).size !== episodePoints.length) {
    throw new BadRequestException('episodePoints contains duplicate episodes');
  }
  return {
    allowedCountries,
    blockedCountries,
    dramaPoints: input.dramaPoints === undefined ? undefined : pointsValue(input.dramaPoints, 'dramaPoints'),
    episodePoints,
    expectedVersion: versionValue(input.expectedVersion),
  };
}

function runtimeConfigInput(input: TenantAppRuntimeConfigInput) {
  if (!input) throw new BadRequestException('Request body is required');
  const supportedLocales = input.supportedLocales ?? ['en-US'];
  if (supportedLocales.length < 1 || supportedLocales.length > 50
      || supportedLocales.some((locale) => !LOCALE_PATTERN.test(locale))) {
    throw new BadRequestException('supportedLocales is invalid');
  }
  const deepLinkHost = input.deepLinkHost ?? null;
  if (deepLinkHost !== null && !HOST_PATTERN.test(deepLinkHost)) {
    throw new BadRequestException('deepLinkHost is invalid');
  }
  return {
    admob: jsonObject(input.admob),
    allowedCountries: countryCodes(input.allowedCountries ?? []),
    deepLinkHost,
    expectedVersion: versionValue(input.expectedVersion),
    featureFlags: jsonObject(input.featureFlags),
    storeProducts: jsonObject(input.storeProducts),
    supportedLocales: [...new Set(supportedLocales)],
  };
}

function publicationRecord(row: PublicationRow) {
  return {
    allowedCountries: row.allowed_countries,
    blockedCountries: row.blocked_countries,
    dramaId: row.drama_id,
    id: row.id,
    publishedAt: row.published_at?.toISOString(),
    reviewNote: row.review_note ?? undefined,
    status: row.status,
    version: row.version,
  };
}

function runtimeConfigRecord(row: any) {
  return {
    admob: row?.admob_json ?? {},
    allowedCountries: row?.allowed_countries ?? [],
    deepLinkHost: row?.deep_link_host ?? undefined,
    featureFlags: row?.feature_flags_json ?? {},
    storeProducts: row?.store_products_json ?? {},
    supportedLocales: row?.supported_locales ?? ['en-US'],
    version: row?.version ?? 0,
  };
}

function countryCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 250 || value.some((code) => typeof code !== 'string' || !COUNTRY_PATTERN.test(code))) {
    throw new BadRequestException('country codes must be uppercase ISO 3166-1 alpha-2 values');
  }
  return [...new Set(value)];
}

function jsonObject(value: unknown): Record<string, postgres.JSONValue> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Runtime config JSON values must be objects');
  }
  return JSON.parse(JSON.stringify(value)) as Record<string, postgres.JSONValue>;
}

function positiveInteger(value: unknown, fallback: number, max: number, field: string) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return parsed;
}

function pointsValue(value: unknown, field: string) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 9_000_000_000_000_000) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return parsed;
}

function versionValue(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 1_000_000_000) {
    throw new BadRequestException('expectedVersion is invalid');
  }
  return parsed;
}

function textValue(value: unknown, field: string, min: number, max: number) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value.trim();
}

function uuidValue(value: unknown, field: string) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  uuidValue(value, field);
}

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
