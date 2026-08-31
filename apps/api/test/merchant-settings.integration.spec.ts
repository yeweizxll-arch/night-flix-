import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';
import type { DomainTxtVerificationService } from '../src/merchants/domain-txt-verification.service';
import {
  MerchantSettingsService,
  normalizeCustomHost,
} from '../src/merchants/merchant-settings.service';
import type { MerchantSettingsMutationMetadata } from '../src/merchants/merchant-settings.types';
import type { TenantDirectoryService } from '../src/tenancy/tenant-directory.service';

let database: PGlite;
let service: MerchantSettingsService;
const dnsVerification = { hasExactRecord: vi.fn(async () => true) };
const directory = { invalidate: vi.fn() };

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e77357e101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e77357e102';
const tenantActorA = '018f2f45-7f5e-7e70-b17f-f6e77357e103';
const tenantActorB = '018f2f45-7f5e-7e70-b17f-f6e77357e104';
const platformActor = '018f2f45-7f5e-7e70-b17f-f6e77357e105';
const mediaA = '018f2f45-7f5e-7e70-b17f-f6e77357e106';
const mediaB = '018f2f45-7f5e-7e70-b17f-f6e77357e107';

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (typeof value === 'function') {
        throw new Error('Nested SQL fragments are not supported by this PGlite test adapter');
      }
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, {
    json: (value: unknown) => JSON.stringify(value),
  });
  return tag as unknown as DatabaseTransaction;
}

function metadata(
  actorId: string,
  idempotencyKey: string,
): MerchantSettingsMutationMetadata {
  return {
    actorId,
    idempotencyKey,
    ip: '127.0.0.1',
    requestId: uuidV7(),
  };
}

describe('merchant white-label and domain PostgreSQL workflow', () => {
  beforeAll(async () => {
    process.env.PLATFORM_TENANT_BASE_DOMAIN = 'shops.example.test';
    process.env.PLATFORM_ADMIN_HOSTS = 'admin.example.test';
    database = new PGlite();
    const migrationDirectory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(migrationDirectory))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    for (const filename of filenames) {
      const source = await readFile(resolve(migrationDirectory, filename), 'utf8');
      await database.exec(
        source
          .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
          .replace(/\bcitext\b/g, 'text'),
      );
    }
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantA}', 'branding-one', 'Branding One', statement_timestamp() + interval '1 year'),
        ('${tenantB}', 'branding-two', 'Branding Two', statement_timestamp() + interval '1 year');
      insert into tenant_domains (
        id, tenant_id, host, type, verification_token, verified_at,
        tls_status, is_primary
      ) values
        ('018f2f45-7f5e-7e70-b17f-f6e77357e108', '${tenantA}',
          'branding-one.shops.example.test', 'subdomain', '${'a'.repeat(24)}',
          statement_timestamp(), 'active', true),
        ('018f2f45-7f5e-7e70-b17f-f6e77357e109', '${tenantB}',
          'branding-two.shops.example.test', 'subdomain', '${'b'.repeat(24)}',
          statement_timestamp(), 'active', true);
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, source_url, mime_type,
        checksum, status, metadata_json
      ) values
        ('${mediaA}', 'tenant', '${tenantA}', 'image', 'https://assets.example.test/a.png',
          'image/png', '${'a'.repeat(64)}', 'ready', '{"immutable":true}'),
        ('${mediaB}', 'tenant', '${tenantB}', 'image', 'https://assets.example.test/b.png',
          'image/png', '${'b'.repeat(64)}', 'ready', '{"immutable":true}');
    `);

    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        await transaction.query(
          "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
          [tenantId],
        );
        return callback(transactionTag(transaction));
      }),
    } as unknown as DatabaseService;
    service = new MerchantSettingsService(
      databaseService,
      dnsVerification as unknown as DomainTxtVerificationService,
      directory as unknown as TenantDirectoryService,
    );
  }, 30_000);

  afterAll(async () => {
    delete process.env.PLATFORM_TENANT_BASE_DOMAIN;
    delete process.env.PLATFORM_ADMIN_HOSTS;
    await database?.close();
  });

  it('normalizes IDN hosts and rejects platform-controlled or URL-shaped inputs', () => {
    expect(normalizeCustomHost('  例子.COM. ')).toBe('xn--fsqu00a.com');
    expect(() => normalizeCustomHost('https://video.example.com/path'))
      .toThrow(BadRequestException);
    expect(() => normalizeCustomHost('other.shops.example.test'))
      .toThrow(BadRequestException);
    expect(() => normalizeCustomHost('admin.example.test'))
      .toThrow(BadRequestException);
  });

  it('updates tenant branding idempotently and never accepts cross-tenant media or arbitrary JSON', async () => {
    const input = {
      defaultLocale: 'ja-JP',
      logoMediaAssetId: mediaA,
      siteName: 'One Video',
      theme: {
        accentColor: '#abcdef',
        colorMode: 'dark',
        primaryColor: '#123456',
      },
      userSiteEnabled: false,
      version: 0,
    };
    const created = await service.updateTenantSettings(
      tenantA,
      input,
      metadata(tenantActorA, 'tenant-branding-update-001'),
    );
    const replayed = await service.updateTenantSettings(
      tenantA,
      input,
      metadata(tenantActorA, 'tenant-branding-update-001'),
    );
    expect(replayed).toEqual(created);
    expect(created).toMatchObject({
      effectiveSiteEnabled: false,
      logoMediaAssetId: mediaA,
      platformSiteEnabled: true,
      siteName: 'One Video',
      userSiteEnabled: false,
    });
    expect(JSON.stringify(created)).not.toMatch(/secret|signing|privateKey/i);

    expect(() => service.updateTenantSettings(
      tenantA,
      { platformSiteEnabled: true, version: created.version },
      metadata(tenantActorA, 'tenant-platform-switch-001'),
    )).toThrow(BadRequestException);
    await expect(service.updateTenantSettings(
      tenantA,
      { logoMediaAssetId: mediaB, version: created.version },
      metadata(tenantActorA, 'tenant-cross-media-001'),
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(() => service.updateTenantSettings(
      tenantA,
      {
        theme: { primaryColor: '#000000', signingKey: 'do-not-store' },
        version: created.version,
      },
      metadata(tenantActorA, 'tenant-theme-secret-001'),
    )).toThrow(BadRequestException);

    await expect(database.exec(`
      update tenants set logo_media_asset_id = '${mediaB}' where id = '${tenantA}'
    `)).rejects.toThrow(/branding media/i);
    await expect(database.exec(`
      update tenants set theme_json = '{"nested":{"unsafe":true}}' where id = '${tenantA}'
    `)).rejects.toThrow();
  });

  it('keeps platform and merchant site switches independent', async () => {
    const tenantSettings = await service.getTenantSettings(tenantA);
    const platformDisabled = await service.updatePlatformSiteStatus(
      tenantA,
      { platformSiteEnabled: false, version: tenantSettings.version },
      metadata(platformActor, 'platform-site-disable-001'),
    );
    expect(platformDisabled).toMatchObject({
      effectiveSiteEnabled: false,
      platformSiteEnabled: false,
      userSiteEnabled: false,
    });
    const merchantEnabled = await service.updateTenantSettings(
      tenantA,
      { userSiteEnabled: true, version: platformDisabled.version },
      metadata(tenantActorA, 'tenant-site-enable-001'),
    );
    expect(merchantEnabled).toMatchObject({
      effectiveSiteEnabled: false,
      platformSiteEnabled: false,
      userSiteEnabled: true,
    });
  });

  it('creates pending custom domains idempotently and requires real DNS plus active TLS before primary', async () => {
    const input = { host: ' Video.Example.COM. ' };
    const custom = await service.createTenantCustomDomain(
      tenantA,
      input,
      metadata(tenantActorA, 'tenant-domain-create-001'),
    );
    const replayed = await service.createTenantCustomDomain(
      tenantA,
      input,
      metadata(tenantActorA, 'tenant-domain-create-001'),
    );
    expect(replayed).toEqual(custom);
    expect(custom).toMatchObject({
      host: 'video.example.com',
      isPrimary: false,
      tlsStatus: 'pending',
      verification: { status: 'pending' },
    });
    expect(JSON.stringify(custom)).not.toMatch(/privateKey|signingKey|certificatePem/i);

    await expect(service.createTenantCustomDomain(
      tenantB,
      { host: 'video.example.com' },
      metadata(tenantActorB, 'tenant-domain-create-002'),
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(service.updateTenantDomain(
      tenantB,
      custom.id,
      { enabled: false, version: custom.version },
      metadata(tenantActorB, 'tenant-domain-cross-001'),
    )).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.updateTenantDomain(
      tenantA,
      custom.id,
      { isPrimary: true, version: custom.version },
      metadata(tenantActorA, 'tenant-domain-primary-001'),
    )).rejects.toBeInstanceOf(BadRequestException);

    const verified = await service.verifyTenantCustomDomain(
      tenantA,
      custom.id,
      { version: custom.version },
      metadata(tenantActorA, 'tenant-domain-verify-001'),
    );
    expect(dnsVerification.hasExactRecord).toHaveBeenCalledWith(
      '_drama-verification.video.example.com',
      expect.stringMatching(/^drama-verification=/),
    );
    expect(verified).toMatchObject({ tlsStatus: 'provisioning' });
    const unresolvedWithoutTls = await database.query(`
      select * from app.resolve_tenant_by_host('video.example.com')
    `);
    expect(unresolvedWithoutTls.rows).toHaveLength(0);
    await expect(service.updateTenantDomain(
      tenantA,
      custom.id,
      { isPrimary: true, version: verified.version },
      metadata(tenantActorA, 'tenant-domain-primary-002'),
    )).rejects.toBeInstanceOf(BadRequestException);

    const active = await service.setPlatformDomainTlsStatus(
      tenantA,
      custom.id,
      {
        certificateReference: 'cert-job/2026-001',
        tlsStatus: 'active',
        version: verified.version,
      },
      metadata(platformActor, 'platform-domain-tls-001'),
    );
    expect(active.tlsStatus).toBe('active');
    expect(JSON.stringify(active)).not.toContain('cert-job');
    const resolvedWithTls = await database.query<{ id: string }>(`
      select id from app.resolve_tenant_by_host('video.example.com')
    `);
    expect(resolvedWithTls.rows).toEqual([{ id: tenantA }]);
    const primary = await service.updateTenantDomain(
      tenantA,
      custom.id,
      { isPrimary: true, version: active.version },
      metadata(tenantActorA, 'tenant-domain-primary-003'),
    );
    expect(primary.isPrimary).toBe(true);
  });

  it('retains tenant RLS policies for settings and domains under a non-owner role', async () => {
    await database.exec(`
      create role merchant_config_probe;
      grant usage on schema app to merchant_config_probe;
      grant execute on function app.current_tenant_id() to merchant_config_probe;
      grant select, update on tenants to merchant_config_probe;
      grant select, insert, update on tenant_domains to merchant_config_probe;
      begin;
      set role merchant_config_probe;
      set local app.access_scope = 'tenant';
      set local app.tenant_id = '${tenantA}';
    `);
    const visible = await database.query<{ id: string }>(`
      select id from tenants order by id
    `);
    const visibleDomains = await database.query<{ tenant_id: string }>(`
      select tenant_id from tenant_domains order by tenant_id
    `);
    expect(visible.rows).toEqual([{ id: tenantA }]);
    expect(visibleDomains.rows.every((row) => row.tenant_id === tenantA)).toBe(true);
    const crossTenantUpdate = await database.query<{ id: string }>(`
      update tenants set site_name = 'cross tenant' where id = '${tenantB}' returning id
    `);
    expect(crossTenantUpdate.rows).toHaveLength(0);
    await database.exec('rollback; reset role');

    const unchanged = await database.query<{ site_name: string | null }>(`
      select site_name from tenants where id = '${tenantB}'
    `);
    expect(unchanged.rows[0]?.site_name).toBeNull();
    const policies = await database.query<{ policyname: string }>(`
      select policyname from pg_policies
      where schemaname = 'public' and tablename in ('tenants', 'tenant_domains')
      order by policyname
    `);
    expect(policies.rows.map((row) => row.policyname)).toEqual(expect.arrayContaining([
      'tenant_domains_tenant_isolation',
      'tenants_tenant_isolation',
    ]));
  });
});
