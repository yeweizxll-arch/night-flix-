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
import type {
  ContentLicenseRecord,
  CreateLicensePackageInput,
  GrantContentLicenseInput,
  LicensedPublicDramaRecord,
  LicensePackageRecord,
  LicensingMutationMetadata,
  ReplaceLicensePackageItemsInput,
  RevokeContentLicenseInput,
} from './content-licensing.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PACKAGE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,127}$/;
const MAX_PACKAGE_DRAMAS = 1_000;
const LIBRARY_STATUSES = new Set([
  'approved',
  'draft',
  'pending_review',
  'published',
  'rejected',
  'unpublished',
]);

interface PackageRow {
  code: string;
  created_at: Date;
  drama_ids: unknown;
  id: string;
  name: string;
  status: 'active' | 'disabled';
  total_count?: number;
  updated_at: Date;
  version: number;
}

interface LicenseRow {
  created_at: Date;
  drama_id: string | null;
  drama_ids: unknown;
  expires_at: Date;
  id: string;
  license_type: 'drama' | 'package';
  package_id: string | null;
  revoke_reason: string | null;
  revoked_at: Date | null;
  starts_at: Date;
  status: ContentLicenseRecord['status'];
  tenant_id: string;
  tenant_name: string;
  total_count?: number;
  version: number;
}

interface CommandIdempotencyRow {
  id: string;
  request_hash: string;
  response_json: unknown;
  status: 'completed' | 'failed' | 'processing';
}

@Injectable()
export class ContentLicensingService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async listPlatformLibraryDramas(
    pageValue: number,
    pageSizeValue: number,
    statusValue: unknown = 'published',
    queryValue?: unknown,
  ): Promise<{
    items: Array<{
      code: string;
      id: string;
      status: string;
      title: string;
      totalEpisodes: number;
      version: number;
    }>;
    page: number;
    pageSize: number;
    total: number;
  }> {
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    const status = libraryStatus(statusValue);
    const query = optionalLibraryQuery(queryValue);
    const searchPattern = query ? `%${escapeLikePattern(query)}%` : null;

    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{
        code: string;
        id: string;
        status: string;
        title: string;
        total_count: number;
        total_episodes: number;
        version: number;
      }>>`
        select
          drama.id,
          drama.code::text as code,
          drama.status,
          drama.total_episodes,
          drama.version,
          coalesce((
            select translation.title
            from drama_translations as translation
            where translation.drama_id = drama.id
            order by
              case translation.locale
                when 'zh-CN' then 0
                when 'en-US' then 1
                else 2
              end,
              translation.locale,
              translation.id
            limit 1
          ), drama.code::text) as title,
          count(*) over()::integer as total_count
        from dramas as drama
        where drama.owner_type = 'platform'
          and drama.deleted_at is null
          and drama.status = ${status}
          and (
            ${searchPattern}::text is null
            or drama.code::text ilike ${searchPattern} escape '\\'
            or exists (
              select 1
              from drama_translations as matching_translation
              where matching_translation.drama_id = drama.id
                and matching_translation.title ilike ${searchPattern} escape '\\'
            )
          )
        order by drama.updated_at desc, drama.id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map((row) => ({
          code: row.code,
          id: row.id,
          status: row.status,
          title: row.title,
          totalEpisodes: row.total_episodes,
          version: row.version,
        })),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  async listPackages(
    pageValue: number,
    pageSizeValue: number,
  ): Promise<{
    items: LicensePackageRecord[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<PackageRow[]>`
        select
          package.id,
          package.code::text,
          package.name,
          package.status,
          package.version,
          package.created_at,
          package.updated_at,
          count(*) over()::integer as total_count,
          coalesce((
            select jsonb_agg(item.drama_id order by item.drama_id)
            from content_license_package_items as item
            where item.package_id = package.id
          ), '[]'::jsonb) as drama_ids
        from content_license_packages as package
        order by package.created_at desc, package.id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map(mapPackage),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  async createPackage(
    rawInput: CreateLicensePackageInput,
    metadata: LicensingMutationMetadata,
  ): Promise<LicensePackageRecord> {
    const input = validateCreatePackage(rawInput);
    const packageId = uuidV7();
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<LicensePackageRecord>(transaction, {
        actorId: metadata.actorId,
        idempotencyKey: metadata.idempotencyKey,
        request: input,
        routeKey: 'platform.content_license.package.create',
      });
      if (command.cached !== undefined) return command.cached;

      try {
        await transaction`
          insert into content_license_packages (
            id, code, name, created_by, updated_by
          ) values (
            ${packageId}, ${input.code}, ${input.name},
            ${metadata.actorId}, ${metadata.actorId}
          )
        `;
      } catch (error) {
        if (isDatabaseError(error, '23505')) {
          throw new ConflictException('License package code already exists');
        }
        throw error;
      }

      const created = await this.findPackage(transaction, packageId);
      if (!created) throw new Error('Created license package could not be loaded');
      const response = mapPackage(created);
      await this.insertPlatformAudit(transaction, metadata, {
        action: 'content.license_package.create',
        after: response,
        resourceId: packageId,
        resourceType: 'content_license_package',
      });
      await this.completeCommand(transaction, command.id, response, 201, {
        resourceId: packageId,
        resourceType: 'content_license_package',
      });
      return response;
    });
  }

  async replacePackageItems(
    packageId: string,
    rawInput: ReplaceLicensePackageItemsInput,
    metadata: LicensingMutationMetadata,
  ): Promise<LicensePackageRecord> {
    assertUuid(packageId, 'packageId');
    const input = validateReplacePackageItems(rawInput);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<LicensePackageRecord>(transaction, {
        actorId: metadata.actorId,
        idempotencyKey: metadata.idempotencyKey,
        request: { packageId, ...input },
        routeKey: 'platform.content_license.package.replace_items',
      });
      if (command.cached !== undefined) return command.cached;

      const packages = await transaction<
        Array<{ id: string; status: 'active' | 'disabled'; version: number }>
      >`
        select id, status, version
        from content_license_packages
        where id = ${packageId}
        for update
      `;
      const current = packages[0];
      if (!current) throw new NotFoundException('License package not found');
      if (current.version !== input.version) {
        throw new ConflictException('License package was changed by another operator');
      }

      for (const dramaId of input.dramaIds) {
        const dramas = await transaction<{ id: string }[]>`
          select id from dramas
          where id = ${dramaId}
            and owner_type = 'platform'
            and deleted_at is null
        `;
        if (!dramas[0]) {
          throw new BadRequestException(`Platform drama is unavailable: ${dramaId}`);
        }
      }

      const previousRows = await transaction<{ drama_id: string }[]>`
        select drama_id
        from content_license_package_items
        where package_id = ${packageId}
        order by drama_id
      `;
      await transaction`
        delete from content_license_package_items
        where package_id = ${packageId}
      `;
      for (const dramaId of input.dramaIds) {
        await transaction`
          insert into content_license_package_items (
            package_id, drama_id, created_by
          ) values (${packageId}, ${dramaId}, ${metadata.actorId})
        `;
      }
      const updated = await transaction<{ id: string }[]>`
        update content_license_packages
        set version = version + 1, updated_by = ${metadata.actorId}
        where id = ${packageId} and version = ${input.version}
        returning id
      `;
      if (!updated[0]) {
        throw new ConflictException('License package was changed by another operator');
      }

      const record = await this.findPackage(transaction, packageId);
      if (!record) throw new Error('Updated license package could not be loaded');
      const response = mapPackage(record);
      await this.insertPlatformAudit(transaction, metadata, {
        action: 'content.license_package.replace_items',
        after: { dramaIds: input.dramaIds, version: response.version },
        before: { dramaIds: previousRows.map((row) => row.drama_id) },
        resourceId: packageId,
        resourceType: 'content_license_package',
      });
      await this.completeCommand(transaction, command.id, response, 200, {
        resourceId: packageId,
        resourceType: 'content_license_package',
      });
      return response;
    });
  }

  async listLicenses(
    pageValue: number,
    pageSizeValue: number,
    tenantId?: string,
  ): Promise<{
    items: ContentLicenseRecord[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    if (tenantId !== undefined) assertUuid(tenantId, 'tenantId');
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<LicenseRow[]>`
        select
          license.id,
          license.tenant_id,
          tenant.name as tenant_name,
          license.license_type,
          license.drama_id,
          license.package_id,
          license.starts_at,
          license.expires_at,
          case
            when license.status = 'revoked' then 'revoked'
            when license.status = 'expired'
              or license.expires_at <= statement_timestamp() then 'expired'
            when license.starts_at > statement_timestamp() then 'scheduled'
            else 'active'
          end as status,
          license.revoked_at,
          license.revoke_reason,
          license.version,
          license.created_at,
          count(*) over()::integer as total_count,
          coalesce((
            select jsonb_agg(item.drama_id order by item.drama_id)
            from content_license_items as item
            where item.license_id = license.id
              and item.tenant_id = license.tenant_id
          ), '[]'::jsonb) as drama_ids
        from content_licenses as license
        inner join tenants as tenant on tenant.id = license.tenant_id
        where (${tenantId ?? null}::uuid is null or license.tenant_id = ${tenantId ?? null})
        order by license.created_at desc, license.id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map(mapLicense),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  async grantLicense(
    rawInput: GrantContentLicenseInput,
    metadata: LicensingMutationMetadata,
  ): Promise<ContentLicenseRecord> {
    const input = validateGrantLicense(rawInput);
    const licenseId = uuidV7();
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<ContentLicenseRecord>(transaction, {
        actorId: metadata.actorId,
        idempotencyKey: metadata.idempotencyKey,
        request: input,
        routeKey: 'platform.content_license.grant',
      });
      if (command.cached !== undefined) return command.cached;

      const tenants = await transaction<
        Array<{ expires_at: Date; id: string; status: string }>
      >`
        select id, status, expires_at
        from tenants
        where id = ${input.tenantId}
        for update
      `;
      const tenant = tenants[0];
      if (!tenant) throw new NotFoundException('Tenant not found');
      if (tenant.status !== 'active') {
        throw new ConflictException('Tenant is not active');
      }
      const clocks = await transaction<{ current_time: Date }[]>`
        select statement_timestamp() as current_time
      `;
      const currentTime = clocks[0]?.current_time;
      if (!currentTime) throw new Error('Database clock could not be read');
      if (tenant.expires_at <= currentTime) {
        throw new ConflictException('Tenant is expired');
      }
      if (input.expiresAt <= currentTime) {
        throw new BadRequestException('expiresAt must be in the future');
      }
      if (input.expiresAt > tenant.expires_at) {
        throw new BadRequestException('License cannot exceed tenant expiry');
      }

      let packageVersion: number | undefined;
      let dramaIds: string[];
      if (input.licenseType === 'drama') {
        const dramas = await transaction<{ id: string }[]>`
          select id from dramas
          where id = ${input.dramaId}
            and owner_type = 'platform'
            and status = 'published'
            and deleted_at is null
        `;
        if (!dramas[0]) {
          throw new BadRequestException('Platform drama is not published or available');
        }
        dramaIds = [input.dramaId];
      } else {
        const packages = await transaction<Array<{ id: string; version: number }>>`
          select id, version
          from content_license_packages
          where id = ${input.packageId} and status = 'active'
          for update
        `;
        const licensePackage = packages[0];
        if (!licensePackage) {
          throw new BadRequestException('Active license package not found');
        }
        packageVersion = licensePackage.version;
        const packageItems = await transaction<{ drama_id: string }[]>`
          select item.drama_id
          from content_license_package_items as item
          inner join dramas as drama
            on drama.id = item.drama_id
            and drama.owner_type = 'platform'
            and drama.status = 'published'
            and drama.deleted_at is null
          where item.package_id = ${input.packageId}
          order by item.drama_id
        `;
        const totalItems = await transaction<{ total: string }[]>`
          select count(*)::text as total
          from content_license_package_items
          where package_id = ${input.packageId}
        `;
        if (
          packageItems.length === 0
          || packageItems.length !== Number(totalItems[0]?.total ?? 0)
        ) {
          throw new BadRequestException('License package contains unavailable dramas');
        }
        dramaIds = packageItems.map((item) => item.drama_id);
      }

      const scopeSnapshot = {
        dramaIds,
        licenseType: input.licenseType,
        packageId: input.packageId,
        packageVersion,
      };
      const inserted = await transaction<{ id: string }[]>`
        insert into content_licenses (
          id, tenant_id, license_type, drama_id, package_id,
          starts_at, expires_at, status, scope_snapshot_json, granted_by
        ) values (
          ${licenseId}, ${input.tenantId}, ${input.licenseType},
          ${input.dramaId ?? null}, ${input.packageId ?? null},
          ${input.startsAt}, ${input.expiresAt},
          case
            when ${input.startsAt}::timestamptz > statement_timestamp()
              then 'scheduled'
            else 'active'
          end,
          ${transaction.json(toJsonValue(scopeSnapshot))}, ${metadata.actorId}
        )
        returning id
      `;
      if (!inserted[0]) throw new Error('License could not be created');
      for (const dramaId of dramaIds) {
        await transaction`
          insert into content_license_items (
            id, tenant_id, license_id, drama_id, created_by
          ) values (
            ${uuidV7()}, ${input.tenantId}, ${licenseId},
            ${dramaId}, ${metadata.actorId}
          )
        `;
      }

      const created = await this.findLicense(transaction, licenseId);
      if (!created) throw new Error('Created license could not be loaded');
      const response = mapLicense(created);
      await this.insertPlatformAudit(transaction, metadata, {
        action: 'content.license.grant',
        after: response,
        resourceId: licenseId,
        resourceType: 'content_license',
      });
      await this.insertTenantOutbox(transaction, input.tenantId, metadata.requestId, {
        aggregateId: licenseId,
        eventType: 'ContentLicenseGranted',
        payload: {
          dramaIds,
          expiresAt: response.expiresAt,
          licenseId,
          startsAt: response.startsAt,
          tenantId: input.tenantId,
        },
      });
      await this.completeCommand(transaction, command.id, response, 201, {
        resourceId: licenseId,
        resourceType: 'content_license',
      });
      return response;
    });
  }

  async revokeLicense(
    licenseId: string,
    rawInput: RevokeContentLicenseInput,
    metadata: LicensingMutationMetadata,
  ): Promise<ContentLicenseRecord> {
    assertUuid(licenseId, 'licenseId');
    const input = validateRevokeLicense(rawInput);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<ContentLicenseRecord>(transaction, {
        actorId: metadata.actorId,
        idempotencyKey: metadata.idempotencyKey,
        request: { licenseId, ...input },
        routeKey: 'platform.content_license.revoke',
      });
      if (command.cached !== undefined) return command.cached;

      const rows = await transaction<LicenseRow[]>`
        select
          license.id, license.tenant_id, tenant.name as tenant_name,
          license.license_type, license.drama_id, license.package_id,
          license.starts_at, license.expires_at, license.status,
          license.revoked_at, license.revoke_reason, license.version,
          license.created_at,
          coalesce((
            select jsonb_agg(item.drama_id order by item.drama_id)
            from content_license_items as item
            where item.license_id = license.id
              and item.tenant_id = license.tenant_id
          ), '[]'::jsonb) as drama_ids
        from content_licenses as license
        inner join tenants as tenant on tenant.id = license.tenant_id
        where license.id = ${licenseId}
        for update of license
      `;
      const current = rows[0];
      if (!current) throw new NotFoundException('License not found');
      if (current.status === 'revoked' || current.version !== input.version) {
        throw new ConflictException('License was already changed');
      }
      const updated = await transaction<{ id: string }[]>`
        update content_licenses
        set
          status = 'revoked',
          revoked_at = statement_timestamp(),
          revoked_by = ${metadata.actorId},
          revoke_reason = ${input.reason},
          version = version + 1
        where id = ${licenseId}
          and version = ${input.version}
          and status <> 'revoked'
        returning id
      `;
      if (!updated[0]) throw new ConflictException('License was already changed');

      const changed = await this.findLicense(transaction, licenseId);
      if (!changed) throw new Error('Revoked license could not be loaded');
      const response = mapLicense(changed);
      await this.insertPlatformAudit(transaction, metadata, {
        action: 'content.license.revoke',
        after: response,
        before: mapLicense(current),
        resourceId: licenseId,
        resourceType: 'content_license',
      });
      await this.insertTenantOutbox(transaction, current.tenant_id, metadata.requestId, {
        aggregateId: licenseId,
        eventType: 'ContentLicenseRevoked',
        payload: {
          dramaIds: toStringArray(current.drama_ids),
          licenseId,
          reason: input.reason,
          tenantId: current.tenant_id,
        },
      });
      await this.completeCommand(transaction, command.id, response, 200, {
        resourceId: licenseId,
        resourceType: 'content_license',
      });
      return response;
    });
  }

  async listTenantLicensedDramas(
    tenantId: string,
    pageValue: number,
    pageSizeValue: number,
  ): Promise<{
    items: LicensedPublicDramaRecord[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    assertUuid(tenantId, 'tenantId');
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<
        Array<{
          code: string;
          cover_file_id: string | null;
          id: string;
          licensed_until: Date;
          total_count: number;
          total_episodes: number;
          translations: unknown;
        }>
      >`
        with licensed_dramas as (
          select item.drama_id, max(license.expires_at) as licensed_until
          from content_license_items as item
          inner join content_licenses as license
            on license.id = item.license_id
            and license.tenant_id = item.tenant_id
          where item.tenant_id = ${tenantId}
            and license.status in ('scheduled', 'active')
            and license.starts_at <= statement_timestamp()
            and license.expires_at > statement_timestamp()
          group by item.drama_id
        )
        select
          drama.id,
          drama.code::text,
          drama.cover_file_id,
          drama.total_episodes,
          licensed.licensed_until,
          count(*) over()::integer as total_count,
          coalesce((
            select jsonb_agg(
              jsonb_build_object(
                'locale', translation.locale,
                'title', translation.title,
                'summary', translation.summary,
                'searchKeywords', translation.search_keywords
              ) order by translation.locale
            )
            from drama_translations as translation
            where translation.drama_id = drama.id
          ), '[]'::jsonb) as translations
        from licensed_dramas as licensed
        inner join dramas as drama
          on drama.id = licensed.drama_id
          and drama.owner_type = 'platform'
          and drama.status = 'published'
          and drama.deleted_at is null
        order by drama.created_at desc, drama.id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map((row) => ({
          code: row.code,
          coverFileId: row.cover_file_id ?? undefined,
          id: row.id,
          licensedUntil: row.licensed_until.toISOString(),
          status: 'published',
          totalEpisodes: row.total_episodes,
          translations: toTranslations(row.translations),
        })),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  private async findPackage(
    transaction: DatabaseTransaction,
    packageId: string,
  ): Promise<PackageRow | undefined> {
    const rows = await transaction<PackageRow[]>`
      select
        package.id, package.code::text, package.name, package.status,
        package.version, package.created_at, package.updated_at,
        coalesce((
          select jsonb_agg(item.drama_id order by item.drama_id)
          from content_license_package_items as item
          where item.package_id = package.id
        ), '[]'::jsonb) as drama_ids
      from content_license_packages as package
      where package.id = ${packageId}
    `;
    return rows[0];
  }

  private async findLicense(
    transaction: DatabaseTransaction,
    licenseId: string,
  ): Promise<LicenseRow | undefined> {
    const rows = await transaction<LicenseRow[]>`
      select
        license.id,
        license.tenant_id,
        tenant.name as tenant_name,
        license.license_type,
        license.drama_id,
        license.package_id,
        license.starts_at,
        license.expires_at,
        case
          when license.status = 'revoked' then 'revoked'
          when license.status = 'expired'
            or license.expires_at <= statement_timestamp() then 'expired'
          when license.starts_at > statement_timestamp() then 'scheduled'
          else 'active'
        end as status,
        license.revoked_at,
        license.revoke_reason,
        license.version,
        license.created_at,
        coalesce((
          select jsonb_agg(item.drama_id order by item.drama_id)
          from content_license_items as item
          where item.license_id = license.id
            and item.tenant_id = license.tenant_id
        ), '[]'::jsonb) as drama_ids
      from content_licenses as license
      inner join tenants as tenant on tenant.id = license.tenant_id
      where license.id = ${licenseId}
    `;
    return rows[0];
  }

  private async insertPlatformAudit(
    transaction: DatabaseTransaction,
    metadata: LicensingMutationMetadata,
    input: {
      action: string;
      after: object;
      before?: object;
      resourceId: string;
      resourceType: string;
    },
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id, scope_type, actor_type, actor_id, action,
        resource_type, resource_id, before_json, after_json, ip, request_id
      ) values (
        ${uuidV7()}, 'platform', 'platform_staff', ${metadata.actorId},
        ${input.action}, ${input.resourceType}, ${input.resourceId},
        ${input.before
          ? transaction.json(toJsonValue(input.before))
          : null},
        ${transaction.json(toJsonValue(input.after))},
        ${metadata.ip ?? null}, ${metadata.requestId}
      )
    `;
  }

  private async insertTenantOutbox(
    transaction: DatabaseTransaction,
    tenantId: string,
    requestId: string,
    input: { aggregateId: string; eventType: string; payload: object },
  ): Promise<void> {
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, 'tenant', ${tenantId}, ${`event:${eventId}`},
        ${`${requestId}:${input.eventType}`}, 'content_license',
        ${input.aggregateId}, ${input.eventType},
        ${transaction.json(toJsonValue(input.payload))}
      )
    `;
  }

  private async beginCommand<T>(
    transaction: DatabaseTransaction,
    input: {
      actorId: string;
      idempotencyKey?: string;
      request: unknown;
      routeKey: string;
    },
  ): Promise<{ cached?: T; id?: string }> {
    if (!input.idempotencyKey) return {};
    const key = input.idempotencyKey.trim();
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key is invalid');
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify(toJsonValue(input.request)))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, 'platform', 'platform_staff', ${input.actorId},
        ${input.routeKey}, ${key}, ${requestHash},
        statement_timestamp() + interval '24 hours'
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) return { id };

    const rows = await transaction<CommandIdempotencyRow[]>`
      select id, request_hash, status, response_json
      from command_idempotency
      where scope_type = 'platform'
        and tenant_id is null
        and actor_type = 'platform_staff'
        and actor_id = ${input.actorId}
        and route_key = ${input.routeKey}
        and idempotency_key = ${key}
      for update
    `;
    const existing = rows[0];
    if (!existing) throw new ConflictException('Idempotency record is unavailable');
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used for another request');
    }
    if (existing.status === 'completed' && existing.response_json !== null) {
      return { cached: existing.response_json as T };
    }
    throw new ConflictException('The same command is already processing');
  }

  private async completeCommand(
    transaction: DatabaseTransaction,
    commandId: string | undefined,
    response: unknown,
    responseStatus: number,
    resource: { resourceId: string; resourceType: string },
  ): Promise<void> {
    if (!commandId) return;
    await transaction`
      update command_idempotency
      set
        status = 'completed',
        response_status = ${responseStatus},
        response_json = ${transaction.json(toJsonValue(response))},
        resource_type = ${resource.resourceType},
        resource_id = ${resource.resourceId},
        locked_at = null
      where id = ${commandId} and status = 'processing'
    `;
  }
}

function validateCreatePackage(value: CreateLicensePackageInput) {
  if (!isRecord(value)) throw new BadRequestException('Body is required');
  const code = requiredString(value.code, 'code', 2, 128).toLowerCase();
  if (!PACKAGE_CODE_PATTERN.test(code)) {
    throw new BadRequestException('Invalid package code');
  }
  return {
    code,
    name: requiredString(value.name, 'name', 1, 200),
  };
}

function validateReplacePackageItems(value: ReplaceLicensePackageItemsInput) {
  if (!isRecord(value)) throw new BadRequestException('Body is required');
  const version = nonNegativeInteger(value.version, 'version');
  if (!Array.isArray(value.dramaIds) || value.dramaIds.length > MAX_PACKAGE_DRAMAS) {
    throw new BadRequestException('dramaIds is invalid');
  }
  const dramaIds = [...new Set(value.dramaIds)];
  if (dramaIds.length !== value.dramaIds.length) {
    throw new BadRequestException('dramaIds must not contain duplicates');
  }
  dramaIds.forEach((dramaId) => assertUuid(dramaId, 'dramaId'));
  return { dramaIds, version };
}

function validateGrantLicense(value: GrantContentLicenseInput) {
  if (!isRecord(value)) throw new BadRequestException('Body is required');
  assertUuid(value.tenantId, 'tenantId');
  if (value.licenseType !== 'drama' && value.licenseType !== 'package') {
    throw new BadRequestException('licenseType is invalid');
  }
  const startsAt = requiredDate(value.startsAt, 'startsAt');
  const expiresAt = requiredDate(value.expiresAt, 'expiresAt');
  if (expiresAt <= startsAt) {
    throw new BadRequestException('expiresAt must be after startsAt');
  }
  if (value.licenseType === 'drama') {
    assertUuid(value.dramaId, 'dramaId');
    if (value.packageId !== undefined) {
      throw new BadRequestException('packageId is not allowed for a drama license');
    }
    return {
      dramaId: value.dramaId,
      expiresAt,
      licenseType: value.licenseType,
      startsAt,
      tenantId: value.tenantId,
    };
  }
  assertUuid(value.packageId, 'packageId');
  if (value.dramaId !== undefined) {
    throw new BadRequestException('dramaId is not allowed for a package license');
  }
  return {
    expiresAt,
    licenseType: value.licenseType,
    packageId: value.packageId,
    startsAt,
    tenantId: value.tenantId,
  };
}

function validateRevokeLicense(value: RevokeContentLicenseInput) {
  if (!isRecord(value)) throw new BadRequestException('Body is required');
  return {
    reason: requiredString(value.reason, 'reason', 1, 2_000),
    version: nonNegativeInteger(value.version, 'version'),
  };
}

function mapPackage(row: PackageRow): LicensePackageRecord {
  return {
    code: row.code,
    createdAt: row.created_at.toISOString(),
    dramaIds: toStringArray(row.drama_ids),
    id: row.id,
    name: row.name,
    status: row.status,
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

function mapLicense(row: LicenseRow): ContentLicenseRecord {
  return {
    createdAt: row.created_at.toISOString(),
    dramaId: row.drama_id ?? undefined,
    dramaIds: toStringArray(row.drama_ids),
    expiresAt: row.expires_at.toISOString(),
    id: row.id,
    licenseType: row.license_type,
    packageId: row.package_id ?? undefined,
    revokeReason: row.revoke_reason ?? undefined,
    revokedAt: row.revoked_at?.toISOString(),
    startsAt: row.starts_at.toISOString(),
    status: row.status,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name,
    version: row.version,
  };
}

function toTranslations(value: unknown): LicensedPublicDramaRecord['translations'] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((translation) => ({
    locale: String(translation.locale ?? ''),
    searchKeywords: Array.isArray(translation.searchKeywords)
      ? translation.searchKeywords.map(String)
      : [],
    summary: String(translation.summary ?? ''),
    title: String(translation.title ?? ''),
  }));
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function libraryStatus(value: unknown): string {
  const status = value === undefined || value === null || value === ''
    ? 'published'
    : value;
  if (typeof status !== 'string' || !LIBRARY_STATUSES.has(status)) {
    throw new BadRequestException('Invalid content library status');
  }
  return status;
}

function optionalLibraryQuery(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new BadRequestException('Invalid content library query');
  }
  const query = value.trim();
  if (!query) return undefined;
  if (query.length > 200) {
    throw new BadRequestException('Content library query is too long');
  }
  return query;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new BadRequestException(`${field} must be a non-negative integer`);
  }
  return value;
}

function requiredDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new BadRequestException(`${field} is required`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return date;
}

function requiredString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) {
    throw new BadRequestException(`${field} length is invalid`);
  }
  return result;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function isDatabaseError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
