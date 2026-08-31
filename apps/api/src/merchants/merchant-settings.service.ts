import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { TenantDirectoryService } from '../tenancy/tenant-directory.service';
import { DomainTxtVerificationService } from './domain-txt-verification.service';
import type {
  MerchantSettingsMutationMetadata,
  SiteTheme,
  TenantDomainRecord,
  TenantSiteSettingsRecord,
} from './merchant-settings.types';

interface SettingsRow {
  default_locale: string;
  icon_media_asset_id: string | null;
  id: string;
  logo_media_asset_id: string | null;
  name: string;
  platform_site_enabled: boolean;
  site_name: string | null;
  theme_json: unknown;
  user_site_enabled: boolean;
  version: number;
}

interface DomainRow {
  created_at: Date;
  disabled_at: Date | null;
  host: string;
  id: string;
  is_primary: boolean;
  tenant_id: string;
  tls_status: TenantDomainRecord['tlsStatus'];
  type: 'custom' | 'subdomain';
  updated_at: Date;
  verification_token: string;
  verified_at: Date | null;
  version: number;
}

interface OwnerContext {
  actorType: 'platform_staff' | 'tenant_staff';
  scope: 'platform' | 'tenant';
  tenantId: string | null;
}

interface CommandRow {
  request_hash: string;
  response_json: unknown;
  status: 'completed' | 'failed' | 'processing';
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const SUBDOMAIN_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;
const SUPPORTED_LOCALES = new Set([
  'zh-CN',
  'zh-TW',
  'en-US',
  'fr-FR',
  'ja-JP',
  'ko-KR',
]);
const DEFAULT_THEME: SiteTheme = {
  accentColor: '#7c3aed',
  colorMode: 'light',
  primaryColor: '#2563eb',
};

@Injectable()
export class MerchantSettingsService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(DomainTxtVerificationService)
    private readonly dnsVerification: DomainTxtVerificationService,
    @Inject(TenantDirectoryService)
    private readonly tenantDirectory: TenantDirectoryService,
  ) {}

  getPlatformSettings(tenantId: string): Promise<TenantSiteSettingsRecord> {
    assertUuid(tenantId, 'tenantId');
    return this.database.inPlatformContext((transaction) =>
      this.loadSettings(transaction, tenantId),
    );
  }

  getTenantSettings(tenantId: string): Promise<TenantSiteSettingsRecord> {
    assertUuid(tenantId, 'tenantId');
    return this.database.inTenantContext(tenantId, (transaction) =>
      this.loadSettings(transaction, tenantId),
    );
  }

  updatePlatformBranding(
    tenantId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
  ): Promise<TenantSiteSettingsRecord> {
    return this.updateSettings(
      platformOwner(),
      tenantId,
      rawInput,
      metadata,
      'none',
      'platform.merchant.site.update',
    );
  }

  updatePlatformSiteStatus(
    tenantId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
  ): Promise<TenantSiteSettingsRecord> {
    const input = requiredRecord(rawInput);
    rejectUnknownKeys(input, ['platformSiteEnabled', 'version']);
    if (typeof input.platformSiteEnabled !== 'boolean') {
      throw new BadRequestException('platformSiteEnabled must be a boolean');
    }
    return this.updateSettings(
      platformOwner(),
      tenantId,
      rawInput,
      metadata,
      'platform',
      'platform.merchant.site.status',
      true,
    );
  }

  updateTenantSettings(
    tenantId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
  ): Promise<TenantSiteSettingsRecord> {
    return this.updateSettings(
      tenantOwner(tenantId),
      tenantId,
      rawInput,
      metadata,
      'user',
      'tenant.site.update',
    );
  }

  listPlatformDomains(tenantId: string): Promise<TenantDomainRecord[]> {
    assertUuid(tenantId, 'tenantId');
    return this.database.inPlatformContext((transaction) =>
      this.listDomains(transaction, tenantId, false),
    );
  }

  listTenantDomains(tenantId: string): Promise<TenantDomainRecord[]> {
    assertUuid(tenantId, 'tenantId');
    return this.database.inTenantContext(tenantId, (transaction) =>
      this.listDomains(transaction, tenantId, true),
    );
  }

  createPlatformSubdomain(
    tenantId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
  ): Promise<TenantDomainRecord> {
    assertUuid(tenantId, 'tenantId');
    const input = parseSubdomainInput(rawInput);
    const owner = platformOwner();
    const host = `${input.label}.${tenantBaseDomain()}`;
    assertNotPlatformAdminHost(host);
    assertMetadata(metadata);
    return this.database.inPlatformContext((transaction) =>
      this.runCommand(
        transaction,
        owner,
        'platform.merchant.domain.create_subdomain',
        { host, tenantId },
        metadata,
        'tenant_domain',
        async () => {
          await this.assertTenantExists(transaction, tenantId);
          const domainId = uuidV7();
          let rows: DomainRow[];
          try {
            rows = await transaction<DomainRow[]>`
              insert into tenant_domains (
                id, tenant_id, host, type, verification_token, verified_at,
                tls_status, is_primary, created_by, updated_by
              ) values (
                ${domainId}, ${tenantId}, ${host}, 'subdomain',
                ${randomBytes(24).toString('base64url')}, statement_timestamp(),
                'pending', false, ${metadata.actorId}, ${metadata.actorId}
              )
              returning id, tenant_id, host::text, type, verification_token,
                verified_at, tls_status, is_primary, disabled_at, version,
                created_at, updated_at
            `;
          } catch (error) {
            if (isDatabaseError(error, '23505')) {
              throw new ConflictException('Domain is already assigned');
            }
            throw error;
          }
          const row = rows[0];
          if (!row) throw new Error('Created domain could not be loaded');
          const response = mapDomain(row, false);
          await this.insertAudit(transaction, owner, metadata, {
            action: 'platform.merchant.domain.create_subdomain',
            after: response,
            resourceId: domainId,
          });
          return { resourceId: domainId, value: response };
        },
      ),
    );
  }

  createTenantCustomDomain(
    tenantId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
  ): Promise<TenantDomainRecord> {
    assertUuid(tenantId, 'tenantId');
    const input = parseCustomDomainInput(rawInput);
    const owner = tenantOwner(tenantId);
    assertMetadata(metadata);
    return this.database.inTenantContext(tenantId, (transaction) =>
      this.runCommand(
        transaction,
        owner,
        'tenant.domain.create',
        input,
        metadata,
        'tenant_domain',
        async () => {
          const domainId = uuidV7();
          let rows: DomainRow[];
          try {
            rows = await transaction<DomainRow[]>`
              insert into tenant_domains (
                id, tenant_id, host, type, verification_token, tls_status,
                is_primary, created_by, updated_by
              ) values (
                ${domainId}, ${tenantId}, ${input.host}, 'custom',
                ${randomBytes(24).toString('base64url')}, 'pending', false,
                ${metadata.actorId}, ${metadata.actorId}
              )
              returning id, tenant_id, host::text, type, verification_token,
                verified_at, tls_status, is_primary, disabled_at, version,
                created_at, updated_at
            `;
          } catch (error) {
            if (isDatabaseError(error, '23505')) {
              throw new ConflictException('Domain is already assigned');
            }
            throw error;
          }
          const row = rows[0];
          if (!row) throw new Error('Created domain could not be loaded');
          const response = mapDomain(row, false);
          await this.insertAudit(transaction, owner, metadata, {
            action: 'tenant.domain.create',
            after: response,
            resourceId: domainId,
          });
          return { resourceId: domainId, value: response };
        },
      ),
    );
  }

  async verifyTenantCustomDomain(
    tenantId: string,
    domainId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
  ): Promise<TenantDomainRecord> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(domainId, 'domainId');
    const input = parseVersionInput(rawInput);
    assertMetadata(metadata);
    const owner = tenantOwner(tenantId);

    const pending = await this.database.inTenantContext(tenantId, (transaction) =>
      this.lockDomain(transaction, tenantId, domainId, true),
    );
    const possibleIdempotentReplay = Boolean(
      pending.verified_at && pending.version === input.version + 1,
    );
    if (pending.version !== input.version && !possibleIdempotentReplay) {
      throw new ConflictException('Domain was changed by another operator');
    }
    if (!pending.verified_at) {
      const verified = await this.dnsVerification.hasExactRecord(
        verificationRecordName(pending.host),
        verificationRecordValue(pending.verification_token),
      );
      if (!verified) {
        throw new BadRequestException('Required DNS TXT verification record was not found');
      }
    }

    return this.database.inTenantContext(tenantId, (transaction) =>
      this.runCommand(
        transaction,
        owner,
        'tenant.domain.verify',
        { domainId, version: input.version },
        metadata,
        'tenant_domain',
        async () => {
          const current = await this.lockDomain(transaction, tenantId, domainId, true);
          if (current.version !== input.version) {
            throw new ConflictException('Domain was changed by another operator');
          }
          if (current.verified_at) {
            return { resourceId: domainId, value: mapDomain(current, false) };
          }
          const rows = await transaction<DomainRow[]>`
            update tenant_domains
            set verified_at = statement_timestamp(), tls_status = 'provisioning',
              version = version + 1, updated_by = ${metadata.actorId}
            where id = ${domainId} and tenant_id = ${tenantId}
              and type = 'custom' and version = ${input.version}
            returning id, tenant_id, host::text, type, verification_token,
              verified_at, tls_status, is_primary, disabled_at, version,
              created_at, updated_at
          `;
          const row = rows[0];
          if (!row) throw new ConflictException('Domain was changed by another operator');
          const response = mapDomain(row, false);
          await this.insertAudit(transaction, owner, metadata, {
            action: 'tenant.domain.verify',
            after: response,
            before: mapDomain(current, false),
            resourceId: domainId,
          });
          this.tenantDirectory.invalidate(row.host);
          return { resourceId: domainId, value: response };
        },
      ),
    );
  }

  updatePlatformDomain(
    tenantId: string,
    domainId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
  ): Promise<TenantDomainRecord> {
    return this.updateDomain(platformOwner(), tenantId, domainId, rawInput, metadata, false);
  }

  setPlatformDomainTlsStatus(
    tenantId: string,
    domainId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
  ): Promise<TenantDomainRecord> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(domainId, 'domainId');
    const input = parseTlsStatusInput(rawInput);
    assertMetadata(metadata);
    const owner = platformOwner();
    return this.database.inPlatformContext((transaction) =>
      this.runCommand(
        transaction,
        owner,
        'platform.domain.tls_status',
        { domainId, tenantId, ...input },
        metadata,
        'tenant_domain',
        async () => {
          const current = await this.lockDomain(transaction, tenantId, domainId, false);
          if (current.version !== input.version) {
            throw new ConflictException('Domain was changed by another operator');
          }
          if (!current.verified_at || current.disabled_at) {
            throw new BadRequestException('TLS status can only change for a verified, enabled domain');
          }
          if (current.is_primary && input.tlsStatus !== 'active') {
            throw new BadRequestException('Choose another primary domain before marking TLS failed');
          }
          const rows = await transaction<DomainRow[]>`
            update tenant_domains
            set tls_status = ${input.tlsStatus}, version = version + 1,
              updated_by = ${metadata.actorId}
            where id = ${domainId} and tenant_id = ${tenantId}
              and verified_at is not null and disabled_at is null
              and version = ${input.version}
            returning id, tenant_id, host::text, type, verification_token,
              verified_at, tls_status, is_primary, disabled_at, version,
              created_at, updated_at
          `;
          const row = rows[0];
          if (!row) throw new ConflictException('Domain was changed by another operator');
          const response = mapDomain(row, false);
          await this.insertAudit(transaction, owner, metadata, {
            action: 'platform.domain.tls_status',
            after: { ...response, certificateReference: input.certificateReference },
            before: mapDomain(current, false),
            resourceId: domainId,
          });
          this.tenantDirectory.invalidate(row.host);
          return { resourceId: domainId, value: response };
        },
      ),
    );
  }

  updateTenantDomain(
    tenantId: string,
    domainId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
  ): Promise<TenantDomainRecord> {
    return this.updateDomain(tenantOwner(tenantId), tenantId, domainId, rawInput, metadata, true);
  }

  private updateSettings(
    owner: OwnerContext,
    tenantId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
    statusField: 'none' | 'platform' | 'user',
    routeKey: string,
    statusOnly = false,
  ): Promise<TenantSiteSettingsRecord> {
    assertUuid(tenantId, 'tenantId');
    const input = parseSettingsInput(rawInput, statusField, statusOnly);
    assertMetadata(metadata);
    return this.inOwnerContext(owner, (transaction) =>
      this.runCommand(
        transaction,
        owner,
        routeKey,
        { ...input, tenantId },
        metadata,
        'tenant',
        async () => {
          const current = await this.lockSettings(transaction, tenantId);
          if (current.version !== input.version) {
            throw new ConflictException('Site settings were changed by another operator');
          }
          const nextLogo: string | null = input.hasLogoMediaAssetId
            ? (input.logoMediaAssetId ?? null)
            : current.logo_media_asset_id;
          const nextIcon: string | null = input.hasIconMediaAssetId
            ? (input.iconMediaAssetId ?? null)
            : current.icon_media_asset_id;
          const nextSiteName: string | null = input.hasSiteName
            ? input.siteName!
            : current.site_name;
          await this.assertBrandingMedia(transaction, tenantId, nextLogo, owner.scope);
          await this.assertBrandingMedia(transaction, tenantId, nextIcon, owner.scope);
          const nextTheme = input.theme ?? parseStoredTheme(current.theme_json);
          const rows = await transaction<SettingsRow[]>`
            update tenants
            set
              site_name = ${nextSiteName},
              logo_media_asset_id = ${nextLogo},
              icon_media_asset_id = ${nextIcon},
              theme_json = ${transaction.json(toJsonValue(nextTheme))},
              default_locale = ${input.defaultLocale ?? current.default_locale},
              user_site_enabled = ${input.userSiteEnabled ?? current.user_site_enabled},
              platform_site_enabled = ${input.platformSiteEnabled ?? current.platform_site_enabled},
              version = version + 1,
              updated_by = ${metadata.actorId}
            where id = ${tenantId} and version = ${input.version}
            returning id, name, site_name, logo_media_asset_id, icon_media_asset_id,
              theme_json, default_locale, user_site_enabled, platform_site_enabled, version
          `;
          const row = rows[0];
          if (!row) throw new ConflictException('Site settings were changed by another operator');
          const before = mapSettings(current);
          const response = mapSettings(row);
          await this.insertAudit(transaction, owner, metadata, {
            action: routeKey,
            after: response,
            before,
            resourceId: tenantId,
          });
          return { resourceId: tenantId, value: response };
        },
      ),
    );
  }

  private updateDomain(
    owner: OwnerContext,
    tenantId: string,
    domainId: string,
    rawInput: unknown,
    metadata: MerchantSettingsMutationMetadata,
    customOnly: boolean,
  ): Promise<TenantDomainRecord> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(domainId, 'domainId');
    const input = parseDomainUpdateInput(rawInput);
    assertMetadata(metadata);
    const routeKey = `${owner.scope}.domain.update`;
    return this.inOwnerContext(owner, (transaction) =>
      this.runCommand(
        transaction,
        owner,
        routeKey,
        { domainId, tenantId, ...input },
        metadata,
        'tenant_domain',
        async () => {
          const current = await this.lockDomain(
            transaction,
            tenantId,
            domainId,
            customOnly,
          );
          if (current.version !== input.version) {
            throw new ConflictException('Domain was changed by another operator');
          }
          if (
            input.isPrimary &&
            (!current.verified_at || current.disabled_at || current.tls_status !== 'active')
          ) {
            throw new BadRequestException('Only a verified, enabled domain with active TLS can be primary');
          }
          if (input.enabled === false && current.is_primary) {
            throw new BadRequestException('Choose another primary domain before disabling this one');
          }
          if (input.isPrimary) {
            await transaction`
              update tenant_domains
              set is_primary = false, version = version + 1, updated_by = ${metadata.actorId}
              where tenant_id = ${tenantId} and is_primary and id <> ${domainId}
            `;
          }
          const hasEnabledChange = input.enabled !== undefined;
          const enableValue = input.enabled ?? false;
          const nextTlsStatus = input.enabled === undefined
            ? current.tls_status
            : input.enabled
              ? current.verified_at
                ? 'provisioning'
                : 'pending'
              : 'disabled';
          const rows = await transaction<DomainRow[]>`
            update tenant_domains
            set
              disabled_at = case
                when not ${hasEnabledChange} then disabled_at
                when ${enableValue} then null
                else statement_timestamp()
              end,
              tls_status = ${nextTlsStatus},
              is_primary = ${input.isPrimary ?? current.is_primary},
              version = version + 1,
              updated_by = ${metadata.actorId}
            where id = ${domainId} and tenant_id = ${tenantId}
              and version = ${input.version}
              and (${customOnly} = false or type = 'custom')
            returning id, tenant_id, host::text, type, verification_token,
              verified_at, tls_status, is_primary, disabled_at, version,
              created_at, updated_at
          `;
          const row = rows[0];
          if (!row) throw new ConflictException('Domain was changed by another operator');
          const before = mapDomain(current, false);
          const response = mapDomain(row, false);
          await this.insertAudit(transaction, owner, metadata, {
            action: routeKey,
            after: response,
            before,
            resourceId: domainId,
          });
          this.tenantDirectory.invalidate(row.host);
          return { resourceId: domainId, value: response };
        },
      ),
    );
  }

  private inOwnerContext<T>(
    owner: OwnerContext,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return owner.scope === 'platform'
      ? this.database.inPlatformContext(callback)
      : this.database.inTenantContext(owner.tenantId!, callback);
  }

  private async loadSettings(
    transaction: DatabaseTransaction,
    tenantId: string,
  ): Promise<TenantSiteSettingsRecord> {
    const rows = await transaction<SettingsRow[]>`
      select id, name, site_name, logo_media_asset_id, icon_media_asset_id,
        theme_json, default_locale, user_site_enabled, platform_site_enabled, version
      from tenants where id = ${tenantId}
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('Merchant was not found');
    return mapSettings(row);
  }

  private async lockSettings(
    transaction: DatabaseTransaction,
    tenantId: string,
  ): Promise<SettingsRow> {
    const rows = await transaction<SettingsRow[]>`
      select id, name, site_name, logo_media_asset_id, icon_media_asset_id,
        theme_json, default_locale, user_site_enabled, platform_site_enabled, version
      from tenants where id = ${tenantId} for update
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('Merchant was not found');
    return row;
  }

  private async listDomains(
    transaction: DatabaseTransaction,
    tenantId: string,
    tenantView: boolean,
  ): Promise<TenantDomainRecord[]> {
    await this.assertTenantExists(transaction, tenantId);
    const rows = await transaction<DomainRow[]>`
      select id, tenant_id, host::text, type, verification_token, verified_at,
        tls_status, is_primary, disabled_at, version, created_at, updated_at
      from tenant_domains where tenant_id = ${tenantId}
      order by is_primary desc, created_at asc, id asc
    `;
    return rows.map((row) => mapDomain(row, tenantView && row.type === 'subdomain'));
  }

  private async lockDomain(
    transaction: DatabaseTransaction,
    tenantId: string,
    domainId: string,
    customOnly: boolean,
  ): Promise<DomainRow> {
    const rows = await transaction<DomainRow[]>`
      select id, tenant_id, host::text, type, verification_token, verified_at,
        tls_status, is_primary, disabled_at, version, created_at, updated_at
      from tenant_domains
      where id = ${domainId} and tenant_id = ${tenantId}
        and (${customOnly} = false or type = 'custom')
      for update
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('Domain was not found');
    return row;
  }

  private async assertTenantExists(
    transaction: DatabaseTransaction,
    tenantId: string,
  ): Promise<void> {
    const rows = await transaction<{ id: string }[]>`
      select id from tenants where id = ${tenantId}
    `;
    if (!rows[0]) throw new NotFoundException('Merchant was not found');
  }

  private async assertBrandingMedia(
    transaction: DatabaseTransaction,
    tenantId: string,
    mediaId: string | null,
    _scope: OwnerContext['scope'],
  ): Promise<void> {
    if (!mediaId) return;
    const rows = await transaction<{ id: string }[]>`
      select id from media_assets
      where id = ${mediaId} and kind = 'image' and status = 'ready'
        and deleted_at is null
        and owner_type = 'tenant' and owner_tenant_id = ${tenantId}
    `;
    if (!rows[0]) {
      throw new BadRequestException('Branding media must be a ready image owned by this merchant');
    }
  }

  private async insertAudit(
    transaction: DatabaseTransaction,
    owner: OwnerContext,
    metadata: MerchantSettingsMutationMetadata,
    input: {
      action: string;
      after: object;
      before?: object;
      resourceId: string;
    },
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, before_json, after_json, ip, request_id
      ) values (
        ${uuidV7()}, ${owner.scope}, ${owner.tenantId}, ${owner.actorType},
        ${metadata.actorId}, ${input.action},
        ${input.action.includes('domain') ? 'tenant_domain' : 'tenant'},
        ${input.resourceId},
        ${input.before ? transaction.json(toJsonValue(input.before)) : null},
        ${transaction.json(toJsonValue(input.after))}, ${metadata.ip ?? null},
        ${metadata.requestId}
      )
    `;
  }

  private async runCommand<T>(
    transaction: DatabaseTransaction,
    owner: OwnerContext,
    routeKey: string,
    request: unknown,
    metadata: MerchantSettingsMutationMetadata,
    resourceType: string,
    operation: () => Promise<{ resourceId: string; value: T }>,
  ): Promise<T> {
    const key = metadata.idempotencyKey?.trim();
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw new BadRequestException('A valid Idempotency-Key is required');
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify(toJsonValue(request)))
      .digest('hex');
    const commandId = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${commandId}, ${owner.scope}, ${owner.tenantId}, ${owner.actorType},
        ${metadata.actorId}, ${routeKey}, ${key}, ${requestHash},
        statement_timestamp() + interval '24 hours'
      ) on conflict do nothing returning id
    `;
    if (!inserted[0]) {
      const rows = await transaction<CommandRow[]>`
        select request_hash, status, response_json from command_idempotency
        where scope_type = ${owner.scope}
          and tenant_id is not distinct from ${owner.tenantId}
          and actor_type = ${owner.actorType} and actor_id = ${metadata.actorId}
          and route_key = ${routeKey} and idempotency_key = ${key}
        for update
      `;
      const existing = rows[0];
      if (!existing) throw new ConflictException('Idempotency record is unavailable');
      if (existing.request_hash !== requestHash) {
        throw new ConflictException('Idempotency-Key was already used for another request');
      }
      if (existing.status === 'completed' && existing.response_json !== null) {
        return existing.response_json as T;
      }
      throw new ConflictException('The same command is already processing');
    }
    const result = await operation();
    await transaction`
      update command_idempotency
      set status = 'completed', response_status = 200,
        response_json = ${transaction.json(toJsonValue(result.value))},
        resource_type = ${resourceType}, resource_id = ${result.resourceId},
        locked_at = null
      where id = ${commandId} and status = 'processing'
    `;
    return result.value;
  }
}

function parseSettingsInput(
  raw: unknown,
  statusField: 'none' | 'platform' | 'user',
  statusOnly: boolean,
) {
  const value = requiredRecord(raw);
  const allowed = statusOnly
    ? [statusField === 'platform' ? 'platformSiteEnabled' : 'userSiteEnabled', 'version']
    : [
        'defaultLocale',
        'iconMediaAssetId',
        'logoMediaAssetId',
        'siteName',
        'theme',
        'version',
        ...(statusField === 'user' ? ['userSiteEnabled'] : []),
        ...(statusField === 'platform' ? ['platformSiteEnabled'] : []),
      ];
  rejectUnknownKeys(value, allowed);
  const version = nonNegativeInteger(value.version, 'version');
  const hasSiteName = Object.hasOwn(value, 'siteName');
  const siteName = hasSiteName ? requiredText(value.siteName, 'siteName', 1, 200) : undefined;
  const hasLogoMediaAssetId = Object.hasOwn(value, 'logoMediaAssetId');
  const hasIconMediaAssetId = Object.hasOwn(value, 'iconMediaAssetId');
  const logoMediaAssetId = optionalNullableUuid(value.logoMediaAssetId, 'logoMediaAssetId');
  const iconMediaAssetId = optionalNullableUuid(value.iconMediaAssetId, 'iconMediaAssetId');
  const defaultLocale = value.defaultLocale === undefined
    ? undefined
    : requiredText(value.defaultLocale, 'defaultLocale', 1, 20);
  if (defaultLocale && !SUPPORTED_LOCALES.has(defaultLocale)) {
    throw new BadRequestException('Default locale is not supported');
  }
  const userSiteEnabled = value.userSiteEnabled === undefined
    ? undefined
    : booleanValue(value.userSiteEnabled, 'userSiteEnabled');
  const platformSiteEnabled = value.platformSiteEnabled === undefined
    ? undefined
    : booleanValue(value.platformSiteEnabled, 'platformSiteEnabled');
  const theme = value.theme === undefined ? undefined : parseTheme(value.theme);
  if (
    !hasSiteName && !hasLogoMediaAssetId && !hasIconMediaAssetId &&
    defaultLocale === undefined && userSiteEnabled === undefined &&
    platformSiteEnabled === undefined && theme === undefined
  ) {
    throw new BadRequestException('At least one site setting must change');
  }
  return {
    defaultLocale,
    hasIconMediaAssetId,
    hasLogoMediaAssetId,
    hasSiteName,
    iconMediaAssetId,
    logoMediaAssetId,
    platformSiteEnabled,
    siteName,
    theme,
    userSiteEnabled,
    version,
  };
}

function parseTlsStatusInput(raw: unknown) {
  const value = requiredRecord(raw);
  rejectUnknownKeys(value, ['certificateReference', 'tlsStatus', 'version']);
  const tlsStatus = requiredText(value.tlsStatus, 'tlsStatus', 6, 6);
  if (tlsStatus !== 'active' && tlsStatus !== 'failed') {
    throw new BadRequestException('tlsStatus must be active or failed');
  }
  const certificateReference = requiredText(
    value.certificateReference,
    'certificateReference',
    3,
    200,
  );
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,199}$/.test(certificateReference)) {
    throw new BadRequestException('certificateReference format is invalid');
  }
  return {
    certificateReference,
    tlsStatus: tlsStatus as 'active' | 'failed',
    version: nonNegativeInteger(value.version, 'version'),
  };
}

function parseTheme(raw: unknown): SiteTheme {
  const value = requiredRecord(raw);
  rejectUnknownKeys(value, ['accentColor', 'colorMode', 'primaryColor']);
  const primaryColor = requiredText(value.primaryColor, 'theme.primaryColor', 7, 7);
  const accentColor = requiredText(value.accentColor, 'theme.accentColor', 7, 7);
  const colorMode = requiredText(value.colorMode, 'theme.colorMode', 4, 6);
  if (!COLOR_PATTERN.test(primaryColor) || !COLOR_PATTERN.test(accentColor)) {
    throw new BadRequestException('Theme colors must use #RRGGBB format');
  }
  if (!['dark', 'light', 'system'].includes(colorMode)) {
    throw new BadRequestException('Theme colorMode is invalid');
  }
  return { accentColor: accentColor.toLowerCase(), colorMode: colorMode as SiteTheme['colorMode'], primaryColor: primaryColor.toLowerCase() };
}

function parseStoredTheme(raw: unknown): SiteTheme {
  try {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      return {
        accentColor: typeof record.accentColor === 'string' && COLOR_PATTERN.test(record.accentColor)
          ? record.accentColor.toLowerCase()
          : DEFAULT_THEME.accentColor,
        colorMode: record.colorMode === 'dark' || record.colorMode === 'system'
          ? record.colorMode
          : 'light',
        primaryColor: typeof record.primaryColor === 'string' && COLOR_PATTERN.test(record.primaryColor)
          ? record.primaryColor.toLowerCase()
          : DEFAULT_THEME.primaryColor,
      };
    }
  } catch {
    // Fall back to the fixed non-sensitive theme defaults for legacy rows.
  }
  return { ...DEFAULT_THEME };
}

function parseSubdomainInput(raw: unknown) {
  const value = requiredRecord(raw);
  rejectUnknownKeys(value, ['label']);
  const label = requiredText(value.label, 'label', 1, 63).toLowerCase();
  if (!SUBDOMAIN_LABEL_PATTERN.test(label)) {
    throw new BadRequestException('Subdomain label format is invalid');
  }
  return { label };
}

function parseCustomDomainInput(raw: unknown) {
  const value = requiredRecord(raw);
  rejectUnknownKeys(value, ['host']);
  return { host: normalizeCustomHost(value.host) };
}

function parseVersionInput(raw: unknown) {
  const value = requiredRecord(raw);
  rejectUnknownKeys(value, ['version']);
  return { version: nonNegativeInteger(value.version, 'version') };
}

function parseDomainUpdateInput(raw: unknown) {
  const value = requiredRecord(raw);
  rejectUnknownKeys(value, ['enabled', 'isPrimary', 'version']);
  const enabled = value.enabled === undefined ? undefined : booleanValue(value.enabled, 'enabled');
  const isPrimary = value.isPrimary === undefined
    ? undefined
    : booleanValue(value.isPrimary, 'isPrimary');
  if (enabled === undefined && isPrimary === undefined) {
    throw new BadRequestException('At least one domain setting must change');
  }
  return { enabled, isPrimary, version: nonNegativeInteger(value.version, 'version') };
}

export function normalizeCustomHost(raw: unknown): string {
  if (typeof raw !== 'string') throw new BadRequestException('host must be a string');
  const candidate = raw.trim().toLowerCase().replace(/\.$/, '');
  if (!candidate || candidate.includes('/') || candidate.includes(':') || candidate.includes('@')) {
    throw new BadRequestException('Custom domain must be a hostname without scheme, path, or port');
  }
  const host = domainToASCII(candidate).toLowerCase();
  if (!host || host.length > 253 || isIP(host) !== 0 || !HOST_PATTERN.test(host)) {
    throw new BadRequestException('Custom domain format is invalid');
  }
  const baseDomain = tenantBaseDomain();
  if (host === baseDomain || host.endsWith(`.${baseDomain}`)) {
    throw new BadRequestException('Platform subdomains must be assigned by the platform');
  }
  assertNotPlatformAdminHost(host);
  return host;
}

function tenantBaseDomain(): string {
  const value = process.env.PLATFORM_TENANT_BASE_DOMAIN?.trim().toLowerCase();
  if (!value) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PLATFORM_TENANT_BASE_DOMAIN is required in production');
    }
    return 'tenant.localhost';
  }
  const host = domainToASCII(value.replace(/\.$/, '')).toLowerCase();
  if (!host || host.length > 220 || !HOST_PATTERN.test(host)) {
    throw new Error('PLATFORM_TENANT_BASE_DOMAIN is invalid');
  }
  return host;
}

function assertNotPlatformAdminHost(host: string): void {
  const reserved = (process.env.PLATFORM_ADMIN_HOSTS ?? '')
    .split(',')
    .map((value) => domainToASCII(value.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '')))
    .filter(Boolean);
  if (reserved.includes(host)) {
    throw new BadRequestException('Domain is reserved for platform administration');
  }
}

function mapSettings(row: SettingsRow): TenantSiteSettingsRecord {
  return {
    defaultLocale: row.default_locale,
    iconMediaAssetId: row.icon_media_asset_id ?? undefined,
    logoMediaAssetId: row.logo_media_asset_id ?? undefined,
    merchantName: row.name,
    platformSiteEnabled: row.platform_site_enabled,
    siteName: row.site_name ?? row.name,
    tenantId: row.id,
    theme: parseStoredTheme(row.theme_json),
    userSiteEnabled: row.user_site_enabled,
    effectiveSiteEnabled: row.platform_site_enabled && row.user_site_enabled,
    version: row.version,
  };
}

function mapDomain(row: DomainRow, readOnly: boolean): TenantDomainRecord {
  return {
    createdAt: row.created_at.toISOString(),
    enabled: row.disabled_at === null,
    host: row.host,
    id: row.id,
    isPrimary: row.is_primary,
    readOnly,
    tlsStatus: row.tls_status,
    type: row.type,
    updatedAt: row.updated_at.toISOString(),
    verification: row.verified_at
      ? { status: 'verified', verifiedAt: row.verified_at.toISOString() }
      : {
          recordName: verificationRecordName(row.host),
          recordType: 'TXT',
          recordValue: verificationRecordValue(row.verification_token),
          status: 'pending',
        },
    version: row.version,
  };
}

function verificationRecordName(host: string): string {
  return `_drama-verification.${host}`;
}

function verificationRecordValue(token: string): string {
  return `drama-verification=${token}`;
}

function platformOwner(): OwnerContext {
  return { actorType: 'platform_staff', scope: 'platform', tenantId: null };
}

function tenantOwner(tenantId: string): OwnerContext {
  return { actorType: 'tenant_staff', scope: 'tenant', tenantId };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Request body must be an object');
  }
  if (Object.hasOwn(value, 'tenantId')) {
    throw new BadRequestException('tenantId must not be supplied in the request body');
  }
  return value as Record<string, unknown>;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[]): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown) throw new BadRequestException(`Unknown field: ${unknown}`);
}

function requiredText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be a string`);
  const text = value.trim();
  if (text.length < minimum || text.length > maximum) {
    throw new BadRequestException(`${field} length is invalid`);
  }
  return text;
}

function optionalNullableUuid(value: unknown, field: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID or null`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new BadRequestException(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function booleanValue(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new BadRequestException(`${field} must be a boolean`);
  return value;
}

function assertUuid(value: string, field: string): void {
  if (!UUID_PATTERN.test(value)) throw new NotFoundException(`${field} was not found`);
}

function assertMetadata(metadata: MerchantSettingsMutationMetadata): void {
  if (!UUID_PATTERN.test(metadata.actorId)) throw new BadRequestException('actorId is invalid');
  if (!metadata.requestId || metadata.requestId.length < 8 || metadata.requestId.length > 128) {
    throw new BadRequestException('requestId is invalid');
  }
}

function isDatabaseError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
