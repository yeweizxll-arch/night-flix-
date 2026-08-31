import { PGlite, type Transaction } from '@electric-sql/pglite';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import { ContentLicensingService } from '../src/content-licensing/content-licensing.service';
import type { LicensingMutationMetadata } from '../src/content-licensing/content-licensing.types';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';

let database: PGlite;
let licensing: ContentLicensingService;
let packageId: string;
let packageLicenseId: string;

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773572101';
const platformStaffId = '018f2f45-7f5e-7e70-b17f-f6e773572102';
const firstDramaId = '018f2f45-7f5e-7e70-b17f-f6e773572103';
const secondDramaId = '018f2f45-7f5e-7e70-b17f-f6e773572104';
const tenantDramaId = '018f2f45-7f5e-7e70-b17f-f6e773572105';
const unpublishedDramaId = '018f2f45-7f5e-7e70-b17f-f6e773572108';
const deletedDramaId = '018f2f45-7f5e-7e70-b17f-f6e773572109';

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

function metadata(
  idempotencyKey?: string,
): LicensingMutationMetadata {
  return {
    actorId: platformStaffId,
    idempotencyKey,
    ip: '127.0.0.1',
    requestId: uuidV7(),
  };
}

describe('public content licensing PostgreSQL workflow', () => {
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

    await database.exec(`
      insert into tenants (id, code, name, expires_at)
      values (
        '${tenantId}', 'licensing-test', 'Licensing Test',
        statement_timestamp() + interval '1 year'
      );
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaffId}', 'license-operator', '${'p'.repeat(64)}');
      insert into dramas (
        id, owner_type, owner_tenant_id, code, status, total_episodes
      ) values (
        '${firstDramaId}', 'platform', null, 'public-drama-one', 'published', 12
      ), (
        '${secondDramaId}', 'platform', null, 'public-drama-two', 'published', 8
      ), (
        '${tenantDramaId}', 'tenant', '${tenantId}', 'private-drama', 'published', 3
      ), (
        '${unpublishedDramaId}', 'platform', null, 'public-unpublished', 'unpublished', 4
      ), (
        '${deletedDramaId}', 'platform', null, 'public-deleted', 'published', 5
      );
      update dramas
      set
        deleted_at = statement_timestamp(),
        deleted_by = '${platformStaffId}',
        delete_reason = 'catalog boundary fixture',
        restore_until = statement_timestamp() + interval '30 days'
      where id = '${deletedDramaId}';
      insert into drama_translations (id, drama_id, locale, title, summary)
      values (
        '018f2f45-7f5e-7e70-b17f-f6e773572106', '${firstDramaId}',
        'en-US', 'Public Drama One', 'First public drama'
      ), (
        '018f2f45-7f5e-7e70-b17f-f6e773572107', '${secondDramaId}',
        'en-US', 'Public Drama Two', 'Second public drama'
      ), (
        '018f2f45-7f5e-7e70-b17f-f6e773572110', '${unpublishedDramaId}',
        'en-US', 'Hidden Public Drama', 'Not yet published'
      ), (
        '018f2f45-7f5e-7e70-b17f-f6e773572111', '${deletedDramaId}',
        'en-US', 'Deleted Public Drama', 'Soft deleted'
      );
    `);

    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        _tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
    } as unknown as DatabaseService;
    licensing = new ContentLicensingService(databaseService);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('lists only platform library dramas and safely searches code or title', async () => {
    const firstPage = await licensing.listPlatformLibraryDramas(1, 1, undefined, undefined);
    expect(firstPage).toMatchObject({ page: 1, pageSize: 1, total: 2 });
    expect(firstPage.items).toHaveLength(1);
    expect([firstDramaId, secondDramaId]).toContain(firstPage.items[0]?.id);

    const titleMatch = await licensing.listPlatformLibraryDramas(
      1,
      20,
      'published',
      'Drama Two',
    );
    expect(titleMatch.items).toEqual([
      {
        code: 'public-drama-two',
        id: secondDramaId,
        status: 'published',
        title: 'Public Drama Two',
        totalEpisodes: 8,
        version: 0,
      },
    ]);

    const codeMatch = await licensing.listPlatformLibraryDramas(
      1,
      20,
      'published',
      'public-drama-one',
    );
    expect(codeMatch.items.map((drama) => drama.id)).toEqual([firstDramaId]);

    const tenantBoundary = await licensing.listPlatformLibraryDramas(
      1,
      20,
      'published',
      'private-drama',
    );
    expect(tenantBoundary.items).toHaveLength(0);

    const unpublished = await licensing.listPlatformLibraryDramas(
      1,
      20,
      'unpublished',
      'Hidden Public',
    );
    expect(unpublished.items.map((drama) => drama.id)).toEqual([unpublishedDramaId]);

    const escapedWildcard = await licensing.listPlatformLibraryDramas(
      1,
      20,
      'published',
      '%',
    );
    expect(escapedWildcard.items).toHaveLength(0);
    const escapedSingleCharacterWildcard = await licensing.listPlatformLibraryDramas(
      1,
      20,
      'published',
      '_',
    );
    expect(escapedSingleCharacterWildcard.items).toHaveLength(0);
    await expect(licensing.listPlatformLibraryDramas(
      1,
      20,
      'not-a-status',
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(licensing.listPlatformLibraryDramas(
      1,
      20,
      'published',
      'q'.repeat(201),
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it('snapshots package dramas and keeps the grant unchanged after package edits', async () => {
    const created = await licensing.createPackage(
      { code: 'starter-pack', name: 'Starter Pack' },
      metadata('create-starter-package'),
    );
    packageId = created.id;
    const repeated = await licensing.createPackage(
      { code: 'starter-pack', name: 'Starter Pack' },
      metadata('create-starter-package'),
    );
    expect(repeated).toEqual(created);

    await expect(licensing.replacePackageItems(
      packageId,
      { dramaIds: [tenantDramaId], version: 0 },
      metadata(),
    )).rejects.toBeInstanceOf(BadRequestException);

    const withFirstDrama = await licensing.replacePackageItems(
      packageId,
      { dramaIds: [firstDramaId], version: 0 },
      metadata('starter-package-first-snapshot'),
    );
    expect(withFirstDrama).toMatchObject({
      dramaIds: [firstDramaId],
      version: 1,
    });

    const granted = await licensing.grantLicense(
      {
        expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
        licenseType: 'package',
        packageId,
        startsAt: new Date(Date.now() - 3_600_000).toISOString(),
        tenantId,
      },
      metadata('grant-starter-package'),
    );
    packageLicenseId = granted.id;
    expect(granted).toMatchObject({
      dramaIds: [firstDramaId],
      licenseType: 'package',
      status: 'active',
      tenantId,
    });

    const withSecondDrama = await licensing.replacePackageItems(
      packageId,
      { dramaIds: [secondDramaId], version: 1 },
      metadata('starter-package-second-snapshot'),
    );
    expect(withSecondDrama.dramaIds).toEqual([secondDramaId]);

    const licenses = await licensing.listLicenses(1, 20);
    expect(licenses.items.find((license) => license.id === packageLicenseId)?.dramaIds)
      .toEqual([firstDramaId]);
    const visible = await licensing.listTenantLicensedDramas(tenantId, 1, 20);
    expect(visible.items).toEqual([
      expect.objectContaining({
        code: 'public-drama-one',
        id: firstDramaId,
        status: 'published',
      }),
    ]);

    const facts = await database.query<{
      audits: string;
      commands: string;
      events: string;
      snapshot_items: string;
    }>(`
      select
        (select count(*)::text from audit_logs
          where resource_id = '${packageLicenseId}'
            and action = 'content.license.grant') as audits,
        (select count(*)::text from command_idempotency
          where idempotency_key = 'create-starter-package') as commands,
        (select count(*)::text from outbox_events
          where aggregate_id = '${packageLicenseId}'
            and event_type = 'ContentLicenseGranted') as events,
        (select count(*)::text from content_license_items
          where license_id = '${packageLicenseId}'
            and drama_id = '${firstDramaId}') as snapshot_items
    `);
    expect(facts.rows[0]).toEqual({
      audits: '1',
      commands: '1',
      events: '1',
      snapshot_items: '1',
    });
  });

  it('removes an expired grant from tenant reads using database time', async () => {
    await database.exec(`
      update content_licenses
      set expires_at = statement_timestamp() - interval '1 second'
      where id = '${packageLicenseId}'
    `);
    const platformList = await licensing.listLicenses(1, 20);
    expect(platformList.items.find((license) => license.id === packageLicenseId)?.status)
      .toBe('expired');
    const tenantList = await licensing.listTenantLicensedDramas(tenantId, 1, 20);
    expect(tenantList.items).toHaveLength(0);
  });

  it('requires an active tenant, active package, published drama, and valid period', async () => {
    const startsAt = new Date(Date.now() + 86_400_000).toISOString();
    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    await database.exec(`
      update content_license_packages set status = 'disabled' where id = '${packageId}'
    `);
    await expect(licensing.grantLicense(
      { expiresAt, licenseType: 'package', packageId, startsAt, tenantId },
      metadata(),
    )).rejects.toBeInstanceOf(BadRequestException);
    await database.exec(`
      update content_license_packages set status = 'active' where id = '${packageId}';
      update tenants set status = 'suspended' where id = '${tenantId}'
    `);
    await expect(licensing.grantLicense(
      { dramaId: secondDramaId, expiresAt, licenseType: 'drama', startsAt, tenantId },
      metadata(),
    )).rejects.toBeInstanceOf(ConflictException);
    await database.exec(`
      update tenants set status = 'active' where id = '${tenantId}';
      update dramas set status = 'unpublished' where id = '${secondDramaId}'
    `);
    await expect(licensing.grantLicense(
      { dramaId: secondDramaId, expiresAt, licenseType: 'drama', startsAt, tenantId },
      metadata(),
    )).rejects.toBeInstanceOf(BadRequestException);
    await database.exec(`
      update dramas set status = 'published' where id = '${secondDramaId}'
    `);
    await expect(licensing.grantLicense(
      {
        dramaId: secondDramaId,
        expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString(),
        licenseType: 'drama',
        startsAt,
        tenantId,
      },
      metadata(),
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(licensing.grantLicense(
      {
        dramaId: secondDramaId,
        expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
        licenseType: 'drama',
        startsAt,
        tenantId,
      },
      metadata(),
    )).rejects.toBeInstanceOf(BadRequestException);

    const scheduled = await licensing.grantLicense(
      { dramaId: firstDramaId, expiresAt, licenseType: 'drama', startsAt, tenantId },
      metadata('scheduled-public-drama-one'),
    );
    expect(scheduled.status).toBe('scheduled');
    const visible = await licensing.listTenantLicensedDramas(tenantId, 1, 20);
    expect(visible.items).toHaveLength(0);
  });

  it('grants a single drama idempotently and hides it immediately after revoke', async () => {
    const input = {
      dramaId: secondDramaId,
      expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
      licenseType: 'drama' as const,
      startsAt: new Date(Date.now() - 3_600_000).toISOString(),
      tenantId,
    };
    const granted = await licensing.grantLicense(
      input,
      metadata('grant-public-drama-two'),
    );
    const repeated = await licensing.grantLicense(
      input,
      metadata('grant-public-drama-two'),
    );
    expect(repeated).toEqual(granted);
    await expect(licensing.grantLicense(
      { ...input, dramaId: firstDramaId },
      metadata('grant-public-drama-two'),
    )).rejects.toBeInstanceOf(ConflictException);

    const beforeRevoke = await licensing.listTenantLicensedDramas(tenantId, 1, 20);
    expect(beforeRevoke.items.map((drama) => drama.id)).toEqual([secondDramaId]);
    await expect(licensing.revokeLicense(
      granted.id,
      { reason: 'Stale operator view', version: 1 },
      metadata(),
    )).rejects.toBeInstanceOf(ConflictException);
    const revoked = await licensing.revokeLicense(
      granted.id,
      { reason: 'Merchant contract ended', version: 0 },
      metadata('revoke-public-drama-two'),
    );
    expect(revoked).toMatchObject({
      id: granted.id,
      revokeReason: 'Merchant contract ended',
      status: 'revoked',
      version: 1,
    });
    const afterRevoke = await licensing.listTenantLicensedDramas(tenantId, 1, 20);
    expect(afterRevoke.items).toHaveLength(0);
    await expect(licensing.revokeLicense(
      granted.id,
      { reason: 'Duplicate revoke', version: 0 },
      metadata(),
    )).rejects.toBeInstanceOf(ConflictException);

    const facts = await database.query<{ events: string; licenses: string }>(`
      select
        (select count(*)::text from outbox_events
          where aggregate_id = '${granted.id}') as events,
        (select count(*)::text from content_licenses
          where id = '${granted.id}') as licenses
    `);
    expect(facts.rows[0]).toEqual({ events: '2', licenses: '1' });
  });
});
