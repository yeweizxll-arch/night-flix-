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
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import type {
  AppBuildJobRecord,
  AppBuildMutationMetadata,
  AppBuildProfileRecord,
  AppBuildStatus,
  AppBuildTarget,
  CreateAppBuildJobInput,
  UpsertAppBuildProfileInput,
} from './app-build.types';

interface ProfileRow {
  android_application_id: string;
  app_name: string;
  created_at: Date;
  h5_domain_id: string;
  h5_host: string;
  icon_media_asset_id: string;
  id: string;
  ios_bundle_id: string;
  splash_media_asset_id: string | null;
  tenant_id: string;
  updated_at: Date;
  version: number;
}

interface BuildSnapshotRow extends ProfileRow {
  default_locale: string;
  icon_checksum: string;
  site_name: string;
  splash_checksum: string | null;
  tenant_status: string;
  theme_json: unknown;
}

interface JobRow {
  artifact_content_type:
    | 'application/vnd.android.package-archive'
    | 'application/zip'
    | null;
  artifact_filename: string | null;
  artifact_size_bytes: string | number | bigint | null;
  completed_at: Date | null;
  created_at: Date;
  failure_code: string | null;
  id: string;
  profile_id: string;
  profile_version: number;
  release_channel: 'internal_test';
  started_at: Date | null;
  status: AppBuildStatus;
  target: AppBuildTarget;
  tenant_id: string;
  total_count?: number;
  version: number;
}

interface CommandRow {
  id: string;
  request_hash: string;
  response_json: unknown;
  status: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ANDROID_ID = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const IOS_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;
const STATUSES = new Set<AppBuildStatus>([
  'cancelled', 'failed', 'processing', 'queued', 'succeeded',
]);
const TARGETS = new Set<AppBuildTarget>(['android_debug', 'ios_simulator']);

@Injectable()
export class AppBuildService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async getPrerequisites(tenantId: string) {
    uuid(tenantId, 'tenantId');
    return this.database.inPlatformContext(async (transaction) => {
      const tenants = await transaction<Array<{
        effective_site_enabled: boolean;
        name: string;
        settings_version: number;
      }>>`
        select coalesce(site_name, name) as name, version as settings_version,
          (status = 'active' and expires_at > statement_timestamp()
            and platform_site_enabled and user_site_enabled) as effective_site_enabled
        from tenants where id = ${tenantId}
      `;
      const tenant = tenants[0];
      if (!tenant) throw new NotFoundException('Merchant was not found');
      const domains = await transaction<Array<{
        disabled_at: Date | null;
        host: string;
        id: string;
        is_primary: boolean;
        tls_status: string;
        type: string;
        verified_at: Date | null;
        version: number;
      }>>`
        select id, host::text, type, tls_status, verified_at, disabled_at,
          is_primary, version
        from tenant_domains where tenant_id = ${tenantId}
        order by is_primary desc, created_at asc, id asc
      `;
      const images = await transaction<Array<{
        checksum: string;
        created_at: Date;
        height: string | null;
        id: string;
        mime_type: string;
        purpose: string;
        size_bytes: string | number | bigint;
        width: string | null;
      }>>`
        select media.id, media.mime_type, media.size_bytes, media.checksum, media.created_at,
          media.metadata_json #>> '{appBuildAsset,purpose}' as purpose,
          media.metadata_json #>> '{appBuildAsset,width}' as width,
          media.metadata_json #>> '{appBuildAsset,height}' as height
        from media_assets as media
        inner join storage_providers as provider on provider.id = media.storage_provider_id
        where media.owner_type = 'tenant' and media.owner_tenant_id = ${tenantId}
          and media.kind = 'image' and media.status = 'ready'
          and media.transcode_status in ('ready', 'not_required')
          and media.object_key is not null and media.source_url is null
          and media.checksum is not null and media.deleted_at is null
          and provider.status = 'active'
          and media.metadata_json #>> '{appBuildAsset,purpose}' in ('app_icon', 'launch_image')
        order by media.created_at desc, media.id desc limit 101
      `;
      const assetProviders = await transaction<Array<{
        account_label: string;
        id: string;
        owner_type: 'platform' | 'tenant';
      }>>`
        select id, owner_type, account_label from storage_providers
        where provider = 's3' and status = 'active'
          and (
            (owner_type = 'tenant' and owner_tenant_id = ${tenantId})
            or (owner_type = 'platform' and owner_tenant_id is null)
          )
        order by owner_type desc, account_label asc, id asc
      `;
      const workers = await transaction<Array<{
        android_available: boolean;
        ios_available: boolean;
      }>>`
        select
          coalesce(bool_or('android_debug' = any(capabilities)), false) as android_available,
          coalesce(bool_or('ios_simulator' = any(capabilities)), false) as ios_available
        from app_build_worker_heartbeats as heartbeat
        inner join storage_providers as artifact_provider
          on artifact_provider.id = heartbeat.artifact_storage_provider_id
        where heartbeat.last_seen_at >= statement_timestamp() - interval '30 seconds'
          and artifact_provider.owner_type = 'platform'
          and artifact_provider.owner_tenant_id is null
          and artifact_provider.provider = 's3'
          and artifact_provider.status = 'active'
      `;
      const worker = workers[0] ?? { android_available: false, ios_available: false };
      const mappedDomains = domains.map((domain) => {
        const reasons: string[] = [];
        if (!domain.verified_at) reasons.push('not_verified');
        if (domain.disabled_at) reasons.push('disabled');
        if (domain.tls_status !== 'active') reasons.push('tls_not_active');
        return {
          eligible: reasons.length === 0,
          host: domain.host,
          id: domain.id,
          isPrimary: domain.is_primary,
          reasons,
          tlsStatus: domain.tls_status,
          type: domain.type,
          version: domain.version,
        };
      });
      const safeImages = images.slice(0, 100).map((image) => ({
        buildReady: true,
        checksum: image.checksum,
        createdAt: image.created_at.toISOString(),
        height: image.height,
        iconCandidate: image.purpose === 'app_icon',
        id: image.id,
        mimeType: image.mime_type,
        purpose: image.purpose,
        sizeBytes: String(image.size_bytes),
        width: image.width,
      }));
      const internalReady = tenant.effective_site_enabled
        && mappedDomains.some((domain) => domain.eligible)
        && safeImages.some((image) => image.iconCandidate);
      return {
        assetProviders: assetProviders.map((provider) => ({
          id: provider.id,
          label: provider.account_label,
          ownerType: provider.owner_type,
        })),
        assets: { hasMore: images.length > 100, items: safeImages },
        domains: mappedDomains,
        effectiveSiteEnabled: tenant.effective_site_enabled,
        siteName: tenant.name,
        siteSettingsVersion: tenant.settings_version,
        targets: {
          androidDebug: {
            available: internalReady && worker.android_available,
            ...(!worker.android_available ? { reason: 'builder_unavailable' } : {}),
          },
          androidStore: { available: false, reason: 'signing_not_configured' },
          iosSimulator: {
            available: internalReady && worker.ios_available,
            ...(!worker.ios_available ? { reason: 'builder_unavailable' } : {}),
          },
          iosStore: { available: false, reason: 'signing_not_configured' },
        },
        tenantId,
      };
    });
  }

  async getProfile(tenantId: string): Promise<{ profile: AppBuildProfileRecord | null }> {
    uuid(tenantId, 'tenantId');
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await this.profileRows(transaction, tenantId);
      return { profile: rows[0] ? profileRecord(rows[0]) : null };
    });
  }

  async upsertProfile(
    tenantId: string,
    rawInput: UpsertAppBuildProfileInput,
    metadata: AppBuildMutationMetadata,
  ): Promise<AppBuildProfileRecord> {
    uuid(tenantId, 'tenantId');
    const input = profileInput(rawInput);
    mutationMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await beginCommand<AppBuildProfileRecord>(
        transaction,
        metadata,
        'platform.app_build.profile.upsert',
        { input, tenantId },
      );
      if (command.cached) return command.cached;

      await this.assertProfileInputs(transaction, tenantId, input);

      const existing = await transaction<Array<{ id: string; version: number }>>`
        select id, version from tenant_app_build_profiles
        where tenant_id = ${tenantId} for update
      `;
      const current = existing[0];
      let profileId: string;
      if (!current) {
        if (input.expectedVersion !== null) {
          throw new ConflictException('App build profile does not exist');
        }
        profileId = uuidV7();
        await transaction`
          insert into tenant_app_build_profiles (
            id, tenant_id, app_name, android_application_id, ios_bundle_id,
            icon_media_asset_id, splash_media_asset_id, h5_domain_id,
            created_by, updated_by
          ) values (
            ${profileId}, ${tenantId}, ${input.appName}, ${input.androidApplicationId},
            ${input.iosBundleId}, ${input.iconMediaAssetId},
            ${input.splashMediaAssetId ?? null}, ${input.h5DomainId},
            ${metadata.actorId}, ${metadata.actorId}
          )
        `;
      } else {
        if (input.expectedVersion !== current.version) {
          throw new ConflictException('App build profile version changed');
        }
        profileId = current.id;
        const updated = await transaction<{ id: string }[]>`
          update tenant_app_build_profiles set
            app_name = ${input.appName},
            android_application_id = ${input.androidApplicationId},
            ios_bundle_id = ${input.iosBundleId},
            icon_media_asset_id = ${input.iconMediaAssetId},
            splash_media_asset_id = ${input.splashMediaAssetId ?? null},
            h5_domain_id = ${input.h5DomainId},
            updated_by = ${metadata.actorId}, version = version + 1
          where id = ${profileId} and tenant_id = ${tenantId}
            and version = ${input.expectedVersion}
          returning id
        `;
        if (!updated[0]) throw new ConflictException('App build profile version changed');
      }

      const rows = await this.profileRows(transaction, tenantId);
      const result = rows[0];
      if (!result) throw new Error('App build profile could not be loaded');
      const response = profileRecord(result);
      await recordMutation(transaction, metadata, {
        action: current ? 'platform.app_build.profile.update' : 'platform.app_build.profile.create',
        after: response,
        eventType: current ? 'AppBuildProfileUpdated' : 'AppBuildProfileCreated',
        resourceId: profileId,
        resourceType: 'app_build_profile',
        tenantId,
      });
      await completeCommand(transaction, command.id, response, 'app_build_profile', profileId);
      return response;
    });
  }

  async createJob(
    tenantId: string,
    rawInput: CreateAppBuildJobInput,
    metadata: AppBuildMutationMetadata,
  ): Promise<AppBuildJobRecord> {
    uuid(tenantId, 'tenantId');
    const input = createJobInput(rawInput);
    mutationMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await beginCommand<AppBuildJobRecord>(
        transaction,
        metadata,
        'platform.app_build.job.create',
        { input, tenantId },
      );
      if (command.cached) return command.cached;

      const rows = await transaction<BuildSnapshotRow[]>`
        select profile.id, profile.tenant_id, profile.app_name,
          profile.android_application_id, profile.ios_bundle_id,
          profile.icon_media_asset_id, profile.splash_media_asset_id,
          profile.h5_domain_id, profile.version, profile.created_at, profile.updated_at,
          domain.host::text as h5_host, tenant.status as tenant_status,
          coalesce(tenant.site_name, tenant.name) as site_name,
          tenant.default_locale, tenant.theme_json,
          icon.checksum as icon_checksum, null::text as splash_checksum
        from tenant_app_build_profiles as profile
        inner join tenants as tenant on tenant.id = profile.tenant_id
        inner join tenant_domains as domain on domain.id = profile.h5_domain_id
          and domain.tenant_id = profile.tenant_id
        inner join media_assets as icon on icon.id = profile.icon_media_asset_id
        inner join storage_providers as icon_provider on icon_provider.id = icon.storage_provider_id
        where profile.tenant_id = ${tenantId}
          and icon.owner_type = 'tenant' and icon.owner_tenant_id = profile.tenant_id
          and icon.kind = 'image' and icon.mime_type = 'image/png'
          and icon.status = 'ready' and icon.object_key is not null
          and icon.source_url is null and icon.checksum is not null
          and icon.deleted_at is null and icon_provider.status = 'active'
          and icon.metadata_json @> ${transaction.json({
            appBuildAsset: {
              hasAlpha: false, height: 1024, purpose: 'app_icon', width: 1024,
            },
          })}
        for share of profile, tenant, domain, icon, icon_provider
      `;
      const profile = rows[0];
      if (!profile) {
        const exists = await transaction<{ id: string }[]>`
          select id from tenant_app_build_profiles where tenant_id = ${tenantId}
        `;
        if (exists[0]) throw new ConflictException('App build assets are no longer ready');
        throw new NotFoundException('App build profile was not found');
      }
      if (profile.splash_media_asset_id) {
        const splash = await transaction<{ checksum: string }[]>`
          select media.checksum from media_assets as media
          inner join storage_providers as provider on provider.id = media.storage_provider_id
          where media.id = ${profile.splash_media_asset_id}
            and media.owner_type = 'tenant' and media.owner_tenant_id = ${tenantId}
            and media.kind = 'image' and media.status = 'ready'
            and media.object_key is not null and media.source_url is null
            and media.checksum is not null and media.deleted_at is null
            and provider.status = 'active'
            and media.metadata_json @> ${transaction.json({
              appBuildAsset: { purpose: 'launch_image' },
            })}
          for share of media, provider
        `;
        if (!splash[0]) throw new ConflictException('App splash image is no longer ready');
        profile.splash_checksum = splash[0].checksum;
      }
      if (profile.version !== input.expectedProfileVersion) {
        throw new ConflictException('App build profile version changed');
      }
      const active = await transaction<{ active: boolean }[]>`
        select (
          tenant.status = 'active'
          and tenant.expires_at > statement_timestamp()
          and tenant.platform_site_enabled
          and tenant.user_site_enabled
          and domain.verified_at is not null
          and domain.disabled_at is null
          and domain.tls_status = 'active'
        ) as active
        from tenants as tenant
        inner join tenant_domains as domain on domain.id = ${profile.h5_domain_id}
        where tenant.id = ${profile.tenant_id}
      `;
      if (!active[0]?.active) {
        throw new ConflictException('Tenant and H5 domain must be active before building');
      }
      const availableWorkers = await transaction<{ available: boolean }[]>`
        select exists (
          select 1 from app_build_worker_heartbeats
          inner join storage_providers as artifact_provider
            on artifact_provider.id = app_build_worker_heartbeats.artifact_storage_provider_id
          where app_build_worker_heartbeats.last_seen_at
              >= statement_timestamp() - interval '30 seconds'
            and ${input.target} = any(app_build_worker_heartbeats.capabilities)
            and artifact_provider.owner_type = 'platform'
            and artifact_provider.owner_tenant_id is null
            and artifact_provider.provider = 's3'
            and artifact_provider.status = 'active'
        ) as available
      `;
      if (!availableWorkers[0]?.available) {
        throw new ConflictException('No compatible app build worker is currently online');
      }

      const snapshot = {
        androidApplicationId: profile.android_application_id,
        appName: profile.app_name,
        defaultLocale: profile.default_locale,
        h5Origin: `https://${profile.h5_host}`,
        icon: { checksum: profile.icon_checksum, mediaAssetId: profile.icon_media_asset_id },
        iosBundleId: profile.ios_bundle_id,
        profileVersion: profile.version,
        releaseChannel: 'internal_test',
        siteName: profile.site_name,
        splash: profile.splash_media_asset_id
          ? { checksum: profile.splash_checksum, mediaAssetId: profile.splash_media_asset_id }
          : null,
        target: input.target,
        tenantId: profile.tenant_id,
        theme: profile.theme_json,
      };
      const jobId = uuidV7();
      const inserted = await transaction<JobRow[]>`
        insert into tenant_app_build_jobs (
          id, tenant_id, profile_id, profile_version, target,
          snapshot_json, created_by
        ) values (
          ${jobId}, ${profile.tenant_id}, ${profile.id}, ${profile.version},
          ${input.target}, ${transaction.json(toJson(snapshot))}, ${metadata.actorId}
        )
        returning id, tenant_id, profile_id, profile_version, target,
          release_channel, status, attempts, started_at, completed_at,
          artifact_filename, artifact_content_type, artifact_size_bytes,
          failure_code, version, created_at
      `;
      const job = inserted[0];
      if (!job) throw new Error('App build job could not be created');
      const response = jobRecord(job);
      await recordMutation(transaction, metadata, {
        action: 'platform.app_build.job.create',
        after: response,
        eventType: 'AppBuildRequested',
        resourceId: jobId,
        resourceType: 'app_build_job',
        tenantId: profile.tenant_id,
      });
      await completeCommand(transaction, command.id, response, 'app_build_job', jobId);
      return response;
    });
  }

  async listJobs(tenantId: string, rawQuery: Record<string, unknown>): Promise<{
    items: AppBuildJobRecord[]; page: number; pageSize: number; total: number;
  }> {
    uuid(tenantId, 'tenantId');
    const query = jobsQuery(rawQuery);
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<JobRow[]>`
        select id, tenant_id, profile_id, profile_version, target,
          release_channel, status, started_at, completed_at,
          artifact_filename, artifact_content_type, artifact_size_bytes,
          failure_code, version, created_at, count(*) over()::integer as total_count
        from tenant_app_build_jobs
        where tenant_id = ${tenantId}
          and (${query.status ?? null}::text is null or status = ${query.status ?? null})
          and (${query.target ?? null}::text is null or target = ${query.target ?? null})
        order by created_at desc, id desc
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
      `;
      return {
        items: rows.map(jobRecord),
        page: query.page,
        pageSize: query.pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  async getJob(tenantId: string, jobId: string): Promise<AppBuildJobRecord> {
    uuid(tenantId, 'tenantId');
    uuid(jobId, 'jobId');
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<JobRow[]>`
        select id, tenant_id, profile_id, profile_version, target,
          release_channel, status, started_at, completed_at,
          artifact_filename, artifact_content_type, artifact_size_bytes,
          failure_code, version, created_at
        from tenant_app_build_jobs where id = ${jobId} and tenant_id = ${tenantId}
      `;
      if (!rows[0]) throw new NotFoundException('App build job was not found');
      return jobRecord(rows[0]);
    });
  }

  async cancelJob(
    tenantId: string,
    jobId: string,
    rawInput: { expectedVersion: number },
    metadata: AppBuildMutationMetadata,
  ): Promise<AppBuildJobRecord> {
    uuid(tenantId, 'tenantId');
    uuid(jobId, 'jobId');
    const input = expectedVersionInput(rawInput);
    mutationMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await beginCommand<AppBuildJobRecord>(
        transaction, metadata, 'platform.app_build.job.cancel', { input, jobId, tenantId },
      );
      if (command.cached) return command.cached;
      const rows = await transaction<JobRow[]>`
        update tenant_app_build_jobs set status = 'cancelled',
          completed_at = statement_timestamp(), version = version + 1
        where id = ${jobId} and tenant_id = ${tenantId}
          and status = 'queued' and version = ${input.expectedVersion}
        returning id, tenant_id, profile_id, profile_version, target,
          release_channel, status, started_at, completed_at,
          artifact_filename, artifact_content_type, artifact_size_bytes,
          failure_code, version, created_at
      `;
      const job = rows[0];
      if (!job) {
        const exists = await transaction<{ status: string; version: number }[]>`
          select status, version from tenant_app_build_jobs
          where id = ${jobId} and tenant_id = ${tenantId}
        `;
        if (!exists[0]) throw new NotFoundException('App build job was not found');
        throw new ConflictException('Only the current queued build can be cancelled');
      }
      const response = jobRecord(job);
      await recordMutation(transaction, metadata, {
        action: 'platform.app_build.job.cancel', after: response,
        eventType: 'AppBuildCancelled', resourceId: jobId,
        resourceType: 'app_build_job', tenantId: job.tenant_id,
      });
      await completeCommand(transaction, command.id, response, 'app_build_job', jobId);
      return response;
    });
  }

  private profileRows(transaction: DatabaseTransaction, tenantId: string) {
    return transaction<ProfileRow[]>`
      select profile.id, profile.tenant_id, profile.app_name,
        profile.android_application_id, profile.ios_bundle_id,
        profile.icon_media_asset_id, profile.splash_media_asset_id,
        profile.h5_domain_id, domain.host::text as h5_host,
        profile.version, profile.created_at, profile.updated_at
      from tenant_app_build_profiles as profile
      inner join tenant_domains as domain on domain.id = profile.h5_domain_id
        and domain.tenant_id = profile.tenant_id
      where profile.tenant_id = ${tenantId}
    `;
  }

  private async assertProfileInputs(
    transaction: DatabaseTransaction,
    tenantId: string,
    input: ReturnType<typeof profileInput>,
  ): Promise<void> {
    const tenants = await transaction<{ id: string }[]>`
      select id from tenants where id = ${tenantId}
    `;
    if (!tenants[0]) throw new NotFoundException('Merchant was not found');
    const domains = await transaction<{ id: string }[]>`
      select id from tenant_domains where id = ${input.h5DomainId}
        and tenant_id = ${tenantId} and verified_at is not null
        and disabled_at is null and tls_status = 'active'
    `;
    if (!domains[0]) {
      throw new BadRequestException('h5DomainId must be a verified active TLS domain');
    }
    for (const [field, mediaId, icon] of [
      ['iconMediaAssetId', input.iconMediaAssetId, true],
      ['splashMediaAssetId', input.splashMediaAssetId, false],
    ] as const) {
      if (!mediaId) continue;
      const media = await transaction<{ id: string }[]>`
        select media.id from media_assets as media
        inner join storage_providers as provider on provider.id = media.storage_provider_id
        where media.id = ${mediaId}
          and media.owner_type = 'tenant' and media.owner_tenant_id = ${tenantId}
          and media.kind = 'image' and media.status = 'ready'
          and media.transcode_status in ('ready', 'not_required')
          and media.object_key is not null and media.source_url is null
          and media.checksum is not null and media.deleted_at is null
          and provider.status = 'active'
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
      `;
      if (!media[0]) throw new BadRequestException(`${field} is not build-ready`);
    }
    const conflicts = await transaction<{ id: string }[]>`
      select id from tenant_app_build_profiles
      where tenant_id <> ${tenantId} and (
        lower(android_application_id) = lower(${input.androidApplicationId})
        or lower(ios_bundle_id) = lower(${input.iosBundleId})
      ) limit 1
    `;
    if (conflicts[0]) {
      throw new ConflictException('App identifiers are already assigned to another merchant');
    }
  }
}

function profileInput(raw: unknown): Required<Omit<UpsertAppBuildProfileInput, 'splashMediaAssetId'>>
  & { splashMediaAssetId?: string | null } {
  const value = record(raw);
  rejectUnknown(value, [
    'androidApplicationId', 'appName', 'expectedVersion', 'h5DomainId',
    'iconMediaAssetId', 'iosBundleId', 'splashMediaAssetId',
  ]);
  const appName = text(value.appName, 'appName', 2, 50);
  const androidApplicationId = text(value.androidApplicationId, 'androidApplicationId', 3, 150);
  const iosBundleId = text(value.iosBundleId, 'iosBundleId', 3, 200);
  if (!ANDROID_ID.test(androidApplicationId)) {
    throw new BadRequestException('androidApplicationId is invalid');
  }
  if (!IOS_ID.test(iosBundleId)) throw new BadRequestException('iosBundleId is invalid');
  const expectedVersion = value.expectedVersion === null
    ? null : integer(value.expectedVersion, 'expectedVersion', 0, 2_147_483_647);
  return {
    androidApplicationId,
    appName,
    expectedVersion,
    h5DomainId: uuid(value.h5DomainId, 'h5DomainId'),
    iconMediaAssetId: uuid(value.iconMediaAssetId, 'iconMediaAssetId'),
    iosBundleId,
    splashMediaAssetId: value.splashMediaAssetId === undefined || value.splashMediaAssetId === null
      ? null : uuid(value.splashMediaAssetId, 'splashMediaAssetId'),
  };
}

function createJobInput(raw: unknown): CreateAppBuildJobInput {
  const value = record(raw);
  rejectUnknown(value, ['expectedProfileVersion', 'target']);
  if (typeof value.target !== 'string' || !TARGETS.has(value.target as AppBuildTarget)) {
    throw new BadRequestException('target is invalid');
  }
  return {
    expectedProfileVersion: integer(
      value.expectedProfileVersion, 'expectedProfileVersion', 0, 2_147_483_647,
    ),
    target: value.target as AppBuildTarget,
  };
}

function jobsQuery(raw: Record<string, unknown>) {
  rejectUnknown(raw, ['page', 'pageSize', 'status', 'target']);
  let status: AppBuildStatus | undefined;
  if (raw.status !== undefined) {
    if (typeof raw.status !== 'string' || !STATUSES.has(raw.status as AppBuildStatus)) {
      throw new BadRequestException('status is invalid');
    }
    status = raw.status as AppBuildStatus;
  }
  let target: AppBuildTarget | undefined;
  if (raw.target !== undefined) {
    if (typeof raw.target !== 'string' || !TARGETS.has(raw.target as AppBuildTarget)) {
      throw new BadRequestException('target is invalid');
    }
    target = raw.target as AppBuildTarget;
  }
  return {
    page: raw.page === undefined ? 1 : integer(raw.page, 'page', 1, 10_000),
    pageSize: raw.pageSize === undefined ? 20 : integer(raw.pageSize, 'pageSize', 1, 100),
    status,
    target,
  };
}

function expectedVersionInput(raw: unknown): { expectedVersion: number } {
  const value = record(raw);
  rejectUnknown(value, ['expectedVersion']);
  return { expectedVersion: integer(value.expectedVersion, 'expectedVersion', 0, 2_147_483_647) };
}

function profileRecord(row: ProfileRow): AppBuildProfileRecord {
  return {
    androidApplicationId: row.android_application_id,
    appName: row.app_name,
    createdAt: row.created_at.toISOString(),
    h5DomainId: row.h5_domain_id,
    h5Host: row.h5_host,
    iconMediaAssetId: row.icon_media_asset_id,
    id: row.id,
    iosBundleId: row.ios_bundle_id,
    splashMediaAssetId: row.splash_media_asset_id ?? undefined,
    tenantId: row.tenant_id,
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

function jobRecord(row: JobRow): AppBuildJobRecord {
  const contentType = row.artifact_content_type;
  const artifact = row.status === 'succeeded' && row.artifact_filename
    && row.artifact_size_bytes !== null
    && (contentType === 'application/vnd.android.package-archive' || contentType === 'application/zip')
    ? { contentType, filename: row.artifact_filename, sizeBytes: String(row.artifact_size_bytes) }
    : undefined;
  return {
    artifact,
    completedAt: row.completed_at?.toISOString(),
    createdAt: row.created_at.toISOString(),
    failureCode: row.failure_code ?? undefined,
    id: row.id,
    profileId: row.profile_id,
    profileVersion: row.profile_version,
    releaseChannel: row.release_channel,
    startedAt: row.started_at?.toISOString(),
    status: row.status,
    target: row.target,
    tenantId: row.tenant_id,
    version: row.version,
  };
}

async function beginCommand<T>(
  transaction: DatabaseTransaction,
  metadata: AppBuildMutationMetadata,
  routeKey: string,
  request: unknown,
): Promise<{ cached?: T; id: string }> {
  const requestHash = createHash('sha256').update(JSON.stringify(toJson(request))).digest('hex');
  const id = uuidV7();
  const inserted = await transaction<{ id: string }[]>`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, expires_at
    ) values (
      ${id}, 'platform', null, 'platform_staff', ${metadata.actorId},
      ${routeKey}, ${metadata.idempotencyKey}, ${requestHash},
      statement_timestamp() + interval '24 hours'
    ) on conflict do nothing returning id
  `;
  if (inserted[0]) return { id };
  const rows = await transaction<CommandRow[]>`
    select id, request_hash, response_json, status from command_idempotency
    where scope_type = 'platform' and tenant_id is null
      and actor_type = 'platform_staff' and actor_id = ${metadata.actorId}
      and route_key = ${routeKey} and idempotency_key = ${metadata.idempotencyKey}
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

async function completeCommand(
  transaction: DatabaseTransaction,
  commandId: string,
  response: unknown,
  resourceType: string,
  resourceId: string,
) {
  const rows = await transaction<{ id: string }[]>`
    update command_idempotency set status = 'completed', response_status = 200,
      response_json = ${transaction.json(toJson(response))},
      resource_type = ${resourceType}, resource_id = ${resourceId}, locked_at = null
    where id = ${commandId} and status = 'processing' returning id
  `;
  if (!rows[0]) throw new ConflictException('Idempotency command changed unexpectedly');
}

async function recordMutation(
  transaction: DatabaseTransaction,
  metadata: AppBuildMutationMetadata,
  input: {
    action: string;
    after: object;
    eventType: string;
    resourceId: string;
    resourceType: string;
    tenantId: string;
  },
) {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, ip, request_id
    ) values (
      ${uuidV7()}, 'platform', null, 'platform_staff', ${metadata.actorId},
      ${input.action}, ${input.resourceType}, ${input.resourceId},
      ${transaction.json(toJson(input.after))}, ${metadata.ip ?? null}, ${metadata.requestId}
    )
  `;
  const eventId = uuidV7();
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key,
      aggregate_type, aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, 'platform', null, ${`event:${eventId}`},
      ${`${metadata.requestId}:${input.eventType}`}, ${input.resourceType},
      ${input.resourceId}, ${input.eventType},
      ${transaction.json(toJson({ id: input.resourceId, tenantId: input.tenantId }))}
    )
  `;
}

function mutationMetadata(value: AppBuildMutationMetadata): void {
  uuid(value.actorId, 'actorId');
  uuid(value.requestId, 'requestId');
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(value.idempotencyKey)) {
    throw new BadRequestException('A valid Idempotency-Key is required');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('A JSON object is required');
  }
  return value as Record<string, unknown>;
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]) {
  const key = Object.keys(value).find((candidate) => !allowed.includes(candidate));
  if (key) throw new BadRequestException(`Unknown field: ${key}`);
}

function text(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return result;
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  const result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isInteger(result) || Number(result) < minimum || Number(result) > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return Number(result);
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value.toLowerCase();
}

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
