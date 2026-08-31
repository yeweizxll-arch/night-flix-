import { PGlite, type Transaction } from '@electric-sql/pglite';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import type { S3CompatibleStorageAdapter } from '../src/storage/s3-compatible.adapter';
import type { StorageCredentialCipher } from '../src/storage/storage-credentials';
import type { CustomerAssetRateLimiterService } from '../src/customer-store/customer-asset-rate-limiter.service';
import { CustomerAssetService } from '../src/customer-store/customer-asset.service';

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e77358c101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e77358c102';
const staff = '018f2f45-7f5e-7e70-b17f-f6e77358c103';
const providerA = '018f2f45-7f5e-7e70-b17f-f6e77358c104';
const providerB = '018f2f45-7f5e-7e70-b17f-f6e77358c105';
const platformProvider = '018f2f45-7f5e-7e70-b17f-f6e77358c106';
const disabledProvider = '018f2f45-7f5e-7e70-b17f-f6e77358c107';
const logo = '018f2f45-7f5e-7e70-b17f-f6e77358c108';
const externalIcon = '018f2f45-7f5e-7e70-b17f-f6e77358c109';
const ownCover = '018f2f45-7f5e-7e70-b17f-f6e77358c10a';
const licensedCover = '018f2f45-7f5e-7e70-b17f-f6e77358c10b';
const unlicensedCover = '018f2f45-7f5e-7e70-b17f-f6e77358c10c';
const otherCover = '018f2f45-7f5e-7e70-b17f-f6e77358c10d';
const arbitraryImage = '018f2f45-7f5e-7e70-b17f-f6e77358c10e';
const video = '018f2f45-7f5e-7e70-b17f-f6e77358c10f';
const disabledCover = '018f2f45-7f5e-7e70-b17f-f6e77358c110';
const ownDrama = '018f2f45-7f5e-7e70-b17f-f6e77358c111';
const licensedDrama = '018f2f45-7f5e-7e70-b17f-f6e77358c112';
const unlicensedDrama = '018f2f45-7f5e-7e70-b17f-f6e77358c113';
const otherDrama = '018f2f45-7f5e-7e70-b17f-f6e77358c114';
const disabledDrama = '018f2f45-7f5e-7e70-b17f-f6e77358c115';

let database: PGlite;
let service: CustomerAssetService;
let cipher: { decrypt: ReturnType<typeof vi.fn> };
let storage: { presignGetObject: ReturnType<typeof vi.fn> };

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}

describe('public customer image signing authorization', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of filenames) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(
        source
          .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
          .replace(/\bcitext\b/g, 'text'),
      );
    }
    await seed();
    const databaseService = {
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        const tagged = transactionTag(transaction);
        await tagged`
          select
            set_config('app.access_scope', 'tenant', true),
            set_config('app.tenant_id', ${tenantId}, true)
        `;
        return callback(tagged);
      }),
    } as unknown as DatabaseService;
    cipher = { decrypt: vi.fn(() => ({
      accessKeyId: 'customer-assets',
      region: 'us-east-1',
      secretAccessKey: 'customer-assets-secret-key',
    })) };
    storage = { presignGetObject: vi.fn(async () => ({
      cacheControl: 'private, no-store, max-age=0',
      contentDisposition: 'inline',
      expiresAt: new Date(Date.now() + 180_000),
      url: 'https://signed.example.test/customer-image?X-Amz-Expires=180',
    })) };
    service = new CustomerAssetService(
      databaseService,
      cipher as unknown as StorageCredentialCipher,
      {
        headObject: vi.fn(),
        presignConditionalPut: vi.fn(),
        presignGetObject: storage.presignGetObject,
      } as unknown as S3CompatibleStorageAdapter,
      { consume: vi.fn(async () => undefined) } as unknown as CustomerAssetRateLimiterService,
    );
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('signs tenant branding, own published covers, and licensed platform covers', async () => {
    for (const id of [logo, ownCover, licensedCover]) {
      await expect(service.issue(tenantA, id, {}, '203.0.113.9')).resolves.toEqual({
        expiresAt: expect.any(String),
        mediaAssetId: id,
        url: expect.stringContaining('https://signed.example.test/'),
      });
    }
    expect(cipher.decrypt).toHaveBeenCalledTimes(3);
    expect(storage.presignGetObject).toHaveBeenCalledTimes(3);
    const bindings = cipher.decrypt.mock.calls.map((call) => call[1]);
    expect(bindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ownerTenantId: tenantA, ownerType: 'tenant' }),
      expect.objectContaining({ ownerTenantId: null, ownerType: 'platform' }),
    ]));
  });

  it('rejects cross-tenant, unlicensed, arbitrary, non-image, and external assets', async () => {
    for (const id of [
      otherCover,
      unlicensedCover,
      arbitraryImage,
      video,
      externalIcon,
    ]) {
      await expect(service.issue(tenantA, id, {}, '203.0.113.9'))
        .rejects.toBeInstanceOf(NotFoundException);
    }
    await expect(service.issue(tenantB, ownCover, {}, '203.0.113.10'))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('rechecks media and provider state instead of trusting a cover relationship', async () => {
    await expect(service.issue(tenantA, disabledCover, {}, '203.0.113.9'))
      .rejects.toBeInstanceOf(NotFoundException);
    await database.exec(`update media_assets set status = 'quarantined' where id = '${ownCover}'`);
    await expect(service.issue(tenantA, ownCover, {}, '203.0.113.9'))
      .rejects.toBeInstanceOf(NotFoundException);
    await database.exec(`update media_assets set status = 'ready' where id = '${ownCover}'`);
  });

  it('fails closed on both customer-site switches using the stable public code', async () => {
    await database.exec(`update tenants set user_site_enabled = false where id = '${tenantA}'`);
    const error = await service.issue(tenantA, logo, {}, '203.0.113.9')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toMatchObject({
      code: 'CUSTOMER_SITE_UNAVAILABLE',
    });
    await database.exec(`
      update tenants set user_site_enabled = true, platform_site_enabled = false
      where id = '${tenantA}'
    `);
    await expect(service.issue(tenantA, logo, {}, '203.0.113.9'))
      .rejects.toBeInstanceOf(ForbiddenException);
    await database.exec(`update tenants set platform_site_enabled = true where id = '${tenantA}'`);
  });
});

async function seed(): Promise<void> {
  await database.exec(`
    insert into tenants (id, code, name, expires_at) values
      ('${tenantA}', 'asset-a', 'Asset A', statement_timestamp() + interval '1 year'),
      ('${tenantB}', 'asset-b', 'Asset B', statement_timestamp() + interval '1 year');
    insert into platform_staff (id, username, password_hash)
    values ('${staff}', 'asset_operator', '${'p'.repeat(64)}');
    insert into storage_providers (
      id, owner_type, owner_tenant_id, provider, account_label, endpoint,
      bucket, credential_ciphertext, status
    ) values
      ('${providerA}', 'tenant', '${tenantA}', 's3', 'tenant-a-assets',
        'https://s3.example.test', 'tenant-a-bucket',
        'encrypted-tenant-a-credentials', 'active'),
      ('${providerB}', 'tenant', '${tenantB}', 's3', 'tenant-b-assets',
        'https://s3.example.test', 'tenant-b-bucket',
        'encrypted-tenant-b-credentials', 'active'),
      ('${platformProvider}', 'platform', null, 's3', 'platform-assets',
        'https://s3.example.test', 'platform-bucket',
        'encrypted-platform-credentials', 'active'),
      ('${disabledProvider}', 'tenant', '${tenantA}', 's3', 'disabled-assets',
        'https://s3.example.test', 'disabled-bucket',
        'encrypted-disabled-credentials', 'disabled');
    insert into media_assets (
      id, owner_type, owner_tenant_id, kind, storage_provider_id, object_key,
      mime_type, status, transcode_status
    ) values
      ('${logo}', 'tenant', '${tenantA}', 'image', '${providerA}',
        'tenant-a/branding/logo.png', 'image/png', 'ready', 'not_required'),
      ('${ownCover}', 'tenant', '${tenantA}', 'image', '${providerA}',
        'tenant-a/covers/own.png', 'image/png', 'ready', 'not_required'),
      ('${licensedCover}', 'platform', null, 'image', '${platformProvider}',
        'platform/covers/licensed.webp', 'image/webp', 'ready', 'not_required'),
      ('${unlicensedCover}', 'platform', null, 'image', '${platformProvider}',
        'platform/covers/unlicensed.webp', 'image/webp', 'ready', 'not_required'),
      ('${otherCover}', 'tenant', '${tenantB}', 'image', '${providerB}',
        'tenant-b/covers/other.png', 'image/png', 'ready', 'not_required'),
      ('${arbitraryImage}', 'tenant', '${tenantA}', 'image', '${providerA}',
        'tenant-a/private/arbitrary.png', 'image/png', 'ready', 'not_required'),
      ('${video}', 'tenant', '${tenantA}', 'video', '${providerA}',
        'tenant-a/videos/not-an-image.mp4', 'video/mp4', 'ready', 'ready'),
      ('${disabledCover}', 'tenant', '${tenantA}', 'image', '${disabledProvider}',
        'tenant-a/covers/disabled.png', 'image/png', 'ready', 'not_required');
    insert into media_assets (
      id, owner_type, owner_tenant_id, kind, source_url, mime_type,
      checksum, status, transcode_status, metadata_json
    ) values (
      '${externalIcon}', 'tenant', '${tenantA}', 'image',
      'https://external.example.test/icon.png', 'image/png', '${'e'.repeat(64)}',
      'ready', 'not_required', '{"immutable":true}'
    );
    update tenants set logo_media_asset_id = '${logo}', icon_media_asset_id = '${externalIcon}'
    where id = '${tenantA}';
    insert into dramas (
      id, owner_type, owner_tenant_id, code, cover_file_id, status, release_at
    ) values
      ('${ownDrama}', 'tenant', '${tenantA}', 'asset-own', '${ownCover}', 'published',
        statement_timestamp() - interval '1 day'),
      ('${licensedDrama}', 'platform', null, 'asset-licensed', '${licensedCover}',
        'published', statement_timestamp() - interval '1 day'),
      ('${unlicensedDrama}', 'platform', null, 'asset-unlicensed', '${unlicensedCover}',
        'published', statement_timestamp() - interval '1 day'),
      ('${otherDrama}', 'tenant', '${tenantB}', 'asset-other', '${otherCover}', 'published',
        statement_timestamp() - interval '1 day'),
      ('${disabledDrama}', 'tenant', '${tenantA}', 'asset-disabled', '${disabledCover}',
        'published', statement_timestamp() - interval '1 day');
  `);
  const license = uuidV7();
  await database.exec(`
    insert into content_licenses (
      id, tenant_id, license_type, drama_id, starts_at, expires_at, status, granted_by
    ) values (
      '${license}', '${tenantA}', 'drama', '${licensedDrama}',
      statement_timestamp() - interval '1 day', statement_timestamp() + interval '30 days',
      'active', '${staff}'
    );
    insert into content_license_items (id, tenant_id, license_id, drama_id)
    values ('${uuidV7()}', '${tenantA}', '${license}', '${licensedDrama}');
  `);
}

