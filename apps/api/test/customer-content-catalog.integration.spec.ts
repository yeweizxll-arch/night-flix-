import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import { CustomerContentCatalogService } from '../src/customer-content/customer-content-catalog.service';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773576101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773576102';
const platformStaff = '018f2f45-7f5e-7e70-b17f-f6e773576103';
const categoryA = '018f2f45-7f5e-7e70-b17f-f6e773576104';
const tagA = '018f2f45-7f5e-7e70-b17f-f6e773576105';
const coverA = '018f2f45-7f5e-7e70-b17f-f6e773576106';
const tenantVideo = '018f2f45-7f5e-7e70-b17f-f6e773576107';
const platformVideo = '018f2f45-7f5e-7e70-b17f-f6e773576108';
const percentDrama = '018f2f45-7f5e-7e70-b17f-f6e773576109';
const defaultDrama = '018f2f45-7f5e-7e70-b17f-f6e77357610a';
const licensedDrama = '018f2f45-7f5e-7e70-b17f-f6e77357610b';
const expiredDrama = '018f2f45-7f5e-7e70-b17f-f6e77357610c';
const unlicensedDrama = '018f2f45-7f5e-7e70-b17f-f6e77357610d';
const tenantBDrama = '018f2f45-7f5e-7e70-b17f-f6e77357610e';
const publishedEpisode = '018f2f45-7f5e-7e70-b17f-f6e77357610f';
const draftEpisode = '018f2f45-7f5e-7e70-b17f-f6e773576110';
const futureEpisode = '018f2f45-7f5e-7e70-b17f-f6e773576111';
const licensedEpisode = '018f2f45-7f5e-7e70-b17f-f6e773576112';

let database: PGlite;
let catalog: CustomerContentCatalogService;

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

describe('anonymous customer content catalog', () => {
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
      insert into tenants (
        id, code, name, default_locale, expires_at
      ) values
        ('${tenantA}', 'catalog-a', 'Catalog A', 'fr-FR',
          statement_timestamp() + interval '1 year'),
        ('${tenantB}', 'catalog-b', 'Catalog B', 'en-US',
          statement_timestamp() + interval '1 year');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaff}', 'catalog_licensor', '${'p'.repeat(64)}');
      insert into categories (id, owner_type, owner_tenant_id, code)
      values ('${categoryA}', 'tenant', '${tenantA}', 'action');
      insert into category_translations (id, category_id, locale, name)
      values ('${uuidV7()}', '${categoryA}', 'fr-FR', 'Action');
      insert into tags (id, owner_type, owner_tenant_id, code)
      values ('${tagA}', 'tenant', '${tenantA}', 'featured');
      insert into tag_translations (id, tag_id, locale, name)
      values ('${uuidV7()}', '${tagA}', 'fr-FR', 'En vedette');
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, source_url, mime_type,
        checksum, status, transcode_status, duration_seconds, metadata_json
      ) values
        ('${coverA}', 'tenant', '${tenantA}', 'image',
          'https://secret-storage.example/catalog-cover.png', 'image/png',
          '${'a'.repeat(64)}', 'ready', 'not_required', null,
          '{"immutable":true,"private":"never-return"}'::jsonb),
        ('${tenantVideo}', 'tenant', '${tenantA}', 'video',
          'https://secret-storage.example/catalog-tenant.mp4', 'video/mp4',
          '${'b'.repeat(64)}', 'ready', 'ready', 120,
          '{"immutable":true,"private":"never-return"}'::jsonb),
        ('${platformVideo}', 'platform', null, 'video',
          'https://secret-storage.example/catalog-platform.mp4', 'video/mp4',
          '${'c'.repeat(64)}', 'ready', 'ready', 90,
          '{"immutable":true,"private":"never-return"}'::jsonb);
      insert into dramas (
        id, owner_type, owner_tenant_id, code, status, release_at,
        cover_file_id, category_id, total_episodes
      ) values
        ('${percentDrama}', 'tenant', '${tenantA}', 'literal-percent', 'published',
          statement_timestamp() - interval '3 days', '${coverA}', '${categoryA}', 3),
        ('${defaultDrama}', 'tenant', '${tenantA}', 'default-fallback', 'published',
          statement_timestamp() - interval '2 days', null, null, 0),
        ('${licensedDrama}', 'platform', null, 'licensed-english', 'published',
          statement_timestamp() - interval '1 day', null, null, 1),
        ('${expiredDrama}', 'platform', null, 'expired-license', 'published',
          statement_timestamp() - interval '1 day', null, null, 0),
        ('${unlicensedDrama}', 'platform', null, 'no-license', 'published',
          statement_timestamp() - interval '1 day', null, null, 0),
        ('${tenantBDrama}', 'tenant', '${tenantB}', 'cross-tenant', 'published',
          statement_timestamp() - interval '1 day', null, null, 0);
      insert into drama_translations (
        id, drama_id, locale, title, summary, search_keywords
      ) values
        ('${uuidV7()}', '${percentDrama}', 'ja-JP', '100% 本物', '日本語の要約', array['literal percent']),
        ('${uuidV7()}', '${percentDrama}', 'fr-FR', 'Cent pour cent', 'Résumé français', array['pour cent']),
        ('${uuidV7()}', '${percentDrama}', 'en-US', '100% Real', 'English summary', array['percent']),
        ('${uuidV7()}', '${defaultDrama}', 'fr-FR', 'Français par défaut', 'Repli locataire', '{}'),
        ('${uuidV7()}', '${licensedDrama}', 'en-US', 'Licensed English', 'English only', '{}'),
        ('${uuidV7()}', '${expiredDrama}', 'en-US', 'Expired English', 'Hidden', '{}'),
        ('${uuidV7()}', '${unlicensedDrama}', 'en-US', 'Unlicensed English', 'Hidden', '{}'),
        ('${uuidV7()}', '${tenantBDrama}', 'en-US', 'Other Tenant', 'Hidden', '{}');
      insert into drama_tags (drama_id, tag_id)
      values ('${percentDrama}', '${tagA}');
      insert into episodes (
        id, drama_id, episode_no, status, release_at, duration_seconds,
        media_asset_id, preview_seconds
      ) values
        ('${publishedEpisode}', '${percentDrama}', 1, 'published',
          statement_timestamp() - interval '1 day', 120, '${tenantVideo}', 12),
        ('${draftEpisode}', '${percentDrama}', 2, 'draft', null, 120, '${tenantVideo}', 0),
        ('${futureEpisode}', '${percentDrama}', 3, 'published',
          statement_timestamp() + interval '1 day', 120, '${tenantVideo}', 5),
        ('${licensedEpisode}', '${licensedDrama}', 1, 'published',
          statement_timestamp() - interval '1 day', 90, '${platformVideo}', 9);
      insert into episode_translations (id, episode_id, locale, title) values
        ('${uuidV7()}', '${publishedEpisode}', 'ja-JP', '第1話'),
        ('${uuidV7()}', '${publishedEpisode}', 'fr-FR', 'Épisode 1'),
        ('${uuidV7()}', '${draftEpisode}', 'fr-FR', 'Épisode brouillon'),
        ('${uuidV7()}', '${futureEpisode}', 'fr-FR', 'Épisode futur'),
        ('${uuidV7()}', '${licensedEpisode}', 'en-US', 'Episode One');
    `);
    const activeLicense = uuidV7();
    const expiredLicense = uuidV7();
    await database.exec(`
      insert into content_licenses (
        id, tenant_id, license_type, drama_id, starts_at, expires_at,
        status, granted_by
      ) values
        ('${activeLicense}', '${tenantA}', 'drama', '${licensedDrama}',
          statement_timestamp() - interval '1 day',
          statement_timestamp() + interval '1 day', 'active', '${platformStaff}'),
        ('${expiredLicense}', '${tenantA}', 'drama', '${expiredDrama}',
          statement_timestamp() - interval '2 days',
          statement_timestamp() - interval '1 day', 'expired', '${platformStaff}');
      insert into content_license_items (id, tenant_id, license_id, drama_id) values
        ('${uuidV7()}', '${tenantA}', '${activeLicense}', '${licensedDrama}'),
        ('${uuidV7()}', '${tenantA}', '${expiredLicense}', '${expiredDrama}');
      insert into content_point_prices (
        id, tenant_id, target_type, target_id, points_amount
      ) values
        ('${uuidV7()}', '${tenantA}', 'drama', '${percentDrama}', 250),
        ('${uuidV7()}', '${tenantA}', 'episode', '${publishedEpisode}', 50),
        ('${uuidV7()}', '${tenantA}', 'drama', '${licensedDrama}', 350),
        ('${uuidV7()}', '${tenantA}', 'episode', '${licensedEpisode}', 75)
    `);

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
    catalog = new CustomerContentCatalogService(databaseService);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('lists only tenant-owned or currently licensed content with locale fallback', async () => {
    const result = await catalog.listDramas(tenantA, {
      locale: 'ja-JP',
      page: '1',
      pageSize: '50',
    });
    expect(result.total).toBe(3);
    expect(result.items.map((item) => item.id)).toEqual(expect.arrayContaining([
      percentDrama,
      defaultDrama,
      licensedDrama,
    ]));
    expect(result.items.map((item) => item.id)).not.toEqual(expect.arrayContaining([
      expiredDrama,
      unlicensedDrama,
      tenantBDrama,
    ]));
    expect(result.items.find((item) => item.id === percentDrama)).toMatchObject({
      coverMediaId: coverA,
      locale: 'ja-JP',
      pointsAmount: 250,
      title: '100% 本物',
    });
    expect(result.items.find((item) => item.id === defaultDrama)).toMatchObject({
      locale: 'fr-FR',
      title: 'Français par défaut',
    });
    expect(result.items.find((item) => item.id === licensedDrama)).toMatchObject({
      locale: 'en-US',
      title: 'Licensed English',
    });
    expect(JSON.stringify(result)).not.toContain('secret-storage');
    expect(JSON.stringify(result)).not.toContain('never-return');
    expect(JSON.stringify(result)).not.toContain('checksum');
  });

  it('escapes LIKE wildcards and parameterizes category and tag filters', async () => {
    const literalPercent = await catalog.listDramas(tenantA, {
      q: '100%',
      pageSize: 50,
    });
    expect(literalPercent.items.map((item) => item.id)).toEqual([percentDrama]);
    const category = await catalog.listDramas(tenantA, { category: 'ACTION' });
    expect(category.items.map((item) => item.id)).toEqual([percentDrama]);
    const categoryById = await catalog.listDramas(tenantA, { category: categoryA });
    expect(categoryById.items.map((item) => item.id)).toEqual([percentDrama]);
    const tag = await catalog.listDramas(tenantA, { tag: 'featured' });
    expect(tag.items.map((item) => item.id)).toEqual([percentDrama]);
  });

  it('returns only published, currently released episodes and safe media identifiers', async () => {
    const detail = await catalog.getDrama(tenantA, percentDrama, 'ja-JP');
    expect(detail).toMatchObject({
      code: 'literal-percent',
      coverMediaId: coverA,
      id: percentDrama,
      locale: 'ja-JP',
      summary: '日本語の要約',
      title: '100% 本物',
      totalEpisodes: 3,
    });
    expect(detail.episodes).toEqual([{
      durationSeconds: 120,
      episodeNo: 1,
      id: publishedEpisode,
      locale: 'ja-JP',
      mediaAssetId: tenantVideo,
      previewSeconds: 12,
      pointsAmount: 50,
      title: '第1話',
      tracks: [],
    }]);
    expect(JSON.stringify(detail)).not.toContain('secret-storage');
    expect(JSON.stringify(detail)).not.toContain('never-return');
    expect(JSON.stringify(detail)).not.toContain('checksum');

    const licensed = await catalog.getDrama(tenantA, licensedDrama, 'ko-KR');
    expect(licensed.title).toBe('Licensed English');
    expect(licensed.pointsAmount).toBe(350);
    expect(licensed.episodes).toEqual([expect.objectContaining({
      id: licensedEpisode,
      locale: 'en-US',
      mediaAssetId: platformVideo,
      pointsAmount: 75,
    })]);
  });

  it('rejects cross-tenant, unlicensed, and DB-time-expired content', async () => {
    for (const dramaId of [tenantBDrama, unlicensedDrama, expiredDrama]) {
      await expect(catalog.getDrama(tenantA, dramaId, 'en-US'))
        .rejects.toBeInstanceOf(NotFoundException);
    }
  });

  it('strictly bounds anonymous query input', async () => {
    await expect(catalog.listDramas(tenantA, { q: 'x'.repeat(101) }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(catalog.listDramas(tenantA, { q: ['duplicate', 'query'] }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(catalog.listDramas(tenantA, { locale: 'de-DE' }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(catalog.listDramas(tenantA, { pageSize: 51 }))
      .rejects.toBeInstanceOf(BadRequestException);
    await expect(catalog.listDramas(tenantA, { tag: 'bad tag!' }))
      .rejects.toBeInstanceOf(BadRequestException);
  });

  it('uses a DB-authoritative user-site gate for list and detail', async () => {
    await database.exec(`
      update tenants set user_site_enabled = false where id = '${tenantA}'
    `);
    try {
      await expect(catalog.listDramas(tenantA, {}))
        .rejects.toBeInstanceOf(ForbiddenException);
      await expect(catalog.getDrama(tenantA, percentDrama, undefined))
        .rejects.toBeInstanceOf(ForbiddenException);
    } finally {
      await database.exec(`
        update tenants set user_site_enabled = true where id = '${tenantA}'
      `);
    }
  });

  it('retains forced content RLS under a non-owner tenant role', async () => {
    const rls = await database.query<{ forced: boolean; row_security: boolean }>(`
      select relrowsecurity as row_security, relforcerowsecurity as forced
      from pg_class where relname in (
        'dramas', 'drama_translations', 'episodes', 'episode_translations',
        'drama_tags', 'media_assets'
      )
    `);
    expect(rls.rows).toHaveLength(6);
    expect(rls.rows.every((row) => row.row_security && row.forced)).toBe(true);
    await database.exec(`
      create role customer_catalog_probe nosuperuser nobypassrls;
      grant usage on schema app, public to customer_catalog_probe;
      grant select on dramas to customer_catalog_probe;
      set role customer_catalog_probe;
      begin;
      set local app.access_scope = 'tenant';
      set local app.tenant_id = '${tenantA}'
    `);
    const visible = await database.query<{ id: string }>(`
      select id from dramas where status = 'published' order by id
    `);
    expect(visible.rows.map((row) => row.id)).toEqual([
      percentDrama,
      defaultDrama,
      licensedDrama,
    ].sort());
    await database.exec('rollback; reset role');
  });
});
