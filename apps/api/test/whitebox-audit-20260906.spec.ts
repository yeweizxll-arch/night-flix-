// Regression tests converted from audit reproductions as each defect is repaired.
import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import { PublicDramaPoolService } from '../src/public-drama-pool/public-drama-pool.service';
import { CustomerContentCatalogService } from '../src/customer-content/customer-content-catalog.service';
import { CustomerPlaybackAccessService } from '../src/playback/customer-playback-access.service';
import { PointUnlockService } from '../src/commerce/point-unlock.service';
import { RevenueShareService } from '../src/public-drama-pool/revenue-share.service';
import { SUPPORTED_APP_LOCALES } from '@drama/contracts';
import { HlsPlaybackService } from '../src/playback/hls-playback.service';
import { CustomerPlaybackUrlService } from '../src/playback/customer-playback-url.service';
import type { StorageCredentialCipher } from '../src/storage/storage-credentials';
import type { S3CompatibleStorageAdapter } from '../src/storage/s3-compatible.adapter';
import type { PlaybackUrlRateLimiterService } from '../src/playback/playback-url-rate-limiter.service';

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773573101';
const staffId = '018f2f45-7f5e-7e70-b17f-f6e773573103';
const dramaId = '018f2f45-7f5e-7e70-b17f-f6e773573106';
const episodeId = '018f2f45-7f5e-7e70-b17f-f6e773573108';
const accountId = '018f2f45-7f5e-7e70-b17f-f6e773573109';
const platformId = '018f2f45-7f5e-7e70-b17f-f6e773573110';
const principal = { tenantId, accountId, deviceId: staffId, sessionId: staffId, username: 'audit-user' };
let database: PGlite;
let restricted: PublicDramaPoolService;
let restrictedDb: DatabaseService;
let ownerDb: DatabaseService;
let hls: HlsPlaybackService;
let mediaToken: string;
const rootKey = 'shanchuang/work-1/episode-1/master.m3u8';

function tag(transaction: Transaction): DatabaseTransaction {
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let sql = strings[0] ?? '';
    values.forEach((_, index) => { sql += `$${index + 1}${strings[index + 1] ?? ''}`; });
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(query, { json: (value: unknown) => JSON.stringify(value) });
  return query as unknown as DatabaseTransaction;
}

describe('2026-09-06 white-box audit regressions', () => {
  beforeAll(async () => {
    vi.stubEnv('PLAYBACK_HLS_KEY', 'whitebox-hls-test-secret-at-least-32-bytes');
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const name of (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort()) {
      await database.exec((await readFile(resolve(directory, name), 'utf8'))
        .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
        .replace(/\bcitext\b/g, 'text'));
    }
    await database.exec(`
      CREATE ROLE audit_tenant NOSUPERUSER NOBYPASSRLS;
      GRANT USAGE ON SCHEMA public, app TO audit_tenant;
      GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO audit_tenant;
      GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA app TO audit_tenant;
      INSERT INTO tenants (id, code, name, expires_at)
      VALUES ('${tenantId}', 'audit-one', 'Audit tenant', statement_timestamp() + interval '1 year');
      INSERT INTO tenant_staff (id, tenant_id, username, password_hash)
      VALUES ('${staffId}', '${tenantId}', 'audit-staff', '${'p'.repeat(64)}');
      INSERT INTO dramas (id, owner_type, owner_tenant_id, code, status, total_episodes)
      VALUES ('${dramaId}', 'platform', null, 'audit-drama', 'published', 1);
      INSERT INTO storage_providers(id, owner_type, provider, account_label, bucket, credential_ciphertext, key_version)
      VALUES ('018f2f45-7f5e-7e70-b17f-f6e773573117', 'platform', 's3', 'audit-source', 'audit-media', 'test-ciphertext-platform-credential', 1);
      INSERT INTO media_assets (id, owner_type, kind, storage_provider_id, object_key, mime_type, checksum, status, metadata_json)
      VALUES ('018f2f45-7f5e-7e70-b17f-f6e773573111', 'platform', 'video',
        '018f2f45-7f5e-7e70-b17f-f6e773573117', '${rootKey}', 'application/vnd.apple.mpegurl',
        '${'a'.repeat(64)}', 'ready', '${JSON.stringify({ sourceReference: {
          versionId: 'root-v1', resourceVersions: { [rootKey]: 'root-v1',
            'shanchuang/work-1/episode-1/key.bin': 'key-v1', 'shanchuang/work-1/episode-1/segment.ts': 'segment-v1' },
        } })}');
      INSERT INTO episodes (id, drama_id, episode_no, status, duration_seconds, media_asset_id)
      VALUES ('${episodeId}', '${dramaId}', 1, 'published', 120, '018f2f45-7f5e-7e70-b17f-f6e773573111');
      INSERT INTO customer_accounts (id, tenant_id, username, password_hash)
      VALUES ('${accountId}', '${tenantId}', 'audit-user', '${'p'.repeat(64)}');
      INSERT INTO episode_translations(id, episode_id, locale, title)
      VALUES ('018f2f45-7f5e-7e70-b17f-f6e773573118', '${episodeId}', 'en-US', 'Episode 1');
      INSERT INTO platform_staff (id, username, password_hash)
      VALUES ('${platformId}', 'audit-platform', '${'p'.repeat(64)}');
      INSERT INTO point_accounts (id, tenant_id, account_id)
      VALUES ('018f2f45-7f5e-7e70-b17f-f6e773573112', '${tenantId}', '${accountId}');
      INSERT INTO point_ledger (id, tenant_id, account_id, point_account_id,
        entry_type, delta, balance_after, reference_type, reference_id, idempotency_key,
        created_by_type, created_by)
      VALUES ('018f2f45-7f5e-7e70-b17f-f6e773573113', '${tenantId}', '${accountId}',
        '018f2f45-7f5e-7e70-b17f-f6e773573112', 'adjustment', 1000, 0,
        'manual_adjustment', '${dramaId}', 'audit-seed', 'platform_staff', '${platformId}');
    `);
    restrictedDb = {
      inTenantContext: <T>(tenant: string, callback: (sql: DatabaseTransaction) => Promise<T>) =>
        database.transaction(async (tx) => {
          await tx.exec('SET LOCAL ROLE audit_tenant');
          await tx.query("select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)", [tenant]);
          return callback(tag(tx));
        }),
    } as unknown as DatabaseService;
    restricted = new PublicDramaPoolService(restrictedDb);
    ownerDb = {
      inPlatformContext: <T>(callback: (sql: DatabaseTransaction) => Promise<T>) =>
        database.transaction((tx) => callback(tag(tx))),
      inTenantContext: <T>(tenant: string, callback: (sql: DatabaseTransaction) => Promise<T>) =>
        database.transaction(async (tx) => {
          await tx.query("select set_config('app.tenant_id', $1, true)", [tenant]);
          return callback(tag(tx));
        }),
    } as unknown as DatabaseService;
  }, 120_000);

  afterAll(async () => { vi.unstubAllEnvs(); await database?.close(); });

  it('WB-01: restricted tenant approves and publishes without gaining public write access', async () => {
    const metadata = { actorId: staffId, requestId: crypto.randomUUID(), ip: '127.0.0.1' };
    const reviewed = await restricted.review(tenantId, dramaId, { decision: 'approved' }, metadata);
    expect(reviewed.status).toBe('approved');
    const visible = await database.transaction(async (tx) => {
      await tx.exec('SET LOCAL ROLE audit_tenant');
      await tx.query("select set_config('app.tenant_id', $1, true)", [tenantId]);
      return (await tx.query('select id from dramas where id = $1', [dramaId])).rows;
    });
    expect(visible).toHaveLength(1);
    await expect(restricted.publish(tenantId, dramaId, { expectedVersion: reviewed.version }, metadata))
      .resolves.toMatchObject({ status: 'published' });
    const rows = await database.query('select status from tenant_public_drama_publications where drama_id = $1', [dramaId]);
    expect(rows.rows).toEqual([{ status: 'published' }]);
    await restrictedDb.inTenantContext(tenantId, async (sql) => {
      expect(await sql`update dramas set code='illegal-edit' where id=${dramaId} returning id`).toEqual([]);
      expect(await sql`update media_assets set deleted_at=statement_timestamp()
        where id='018f2f45-7f5e-7e70-b17f-f6e773573111' returning id`).toEqual([]);
    });
  });

  it('WB-02: all 15 locales pass both catalog validation and persisted translation constraints', async () => {
    const metadata = { actorId: staffId, requestId: crypto.randomUUID() };
    const configured = await restricted.updateRuntimeConfig(tenantId,
      { supportedLocales: ['en-US', 'es-ES'], expectedVersion: 0 }, metadata);
    expect(configured.supportedLocales).toContain('es-ES');
    const catalog = new CustomerContentCatalogService(restrictedDb);
    for (const locale of SUPPORTED_APP_LOCALES) {
      await database.query(`insert into drama_translations (id, drama_id, locale, title)
        values ($1, $2, $3, $4)`, [crypto.randomUUID(), dramaId, locale, `Title ${locale}`]);
      const page = await catalog.listDramas(tenantId, { locale });
      expect(page.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: dramaId, title: `Title ${locale}` })]));
    }
  });

  it('WB-03: restricted public playback locks shared content without privileged runtime access', async () => {
    await database.exec(`UPDATE tenant_public_drama_publications
      SET status = 'published', published_at = statement_timestamp(), version = version + 1
      WHERE drama_id = '${dramaId}'`);
    const access = new CustomerPlaybackAccessService(restrictedDb);
    expect((await new CustomerContentCatalogService(restrictedDb).getDrama(tenantId, dramaId, 'en-US')).episodes)
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: episodeId })]));
    await expect(access.getAccess(principal, episodeId)).resolves.toMatchObject({ access: 'full' });
    await expect(access.getAccess({ tenantId }, episodeId)).resolves.toMatchObject({ access: 'full' });
    // Control: same data and the owner-based fixture used in existing tests succeed.
    const control = new CustomerPlaybackAccessService(ownerDb);
    expect(await control.getAccess(principal, episodeId)).toMatchObject({ access: 'full' });
  });

  it('WB-04: public-pool publication alone allows a priced unlock without a legacy license', async () => {
    await database.exec(`INSERT INTO content_point_prices
      (id, tenant_id, target_type, target_id, points_amount, status, created_by, updated_by)
      VALUES ('018f2f45-7f5e-7e70-b17f-f6e773573114', '${tenantId}', 'episode', '${episodeId}',
        100, 'active', '${staffId}', '${staffId}')`);
    await expect(new PointUnlockService(ownerDb).unlock(principal, 'episode', episodeId,
      {}, 'audit-public-pool-unlock', crypto.randomUUID()))
      .resolves.toMatchObject({ pointsSpent: 100, balanceAfter: 900, alreadyOwned: false });
    await expect(new CustomerPlaybackAccessService(restrictedDb).getAccess(principal, episodeId))
      .resolves.toMatchObject({ access: 'full' });
  });

  it('does not charge already-owned content or invent cash revenue from a repeated unlock', async () => {
    await database.exec(`INSERT INTO content_licenses
      (id, tenant_id, license_type, drama_id, starts_at, expires_at, status, granted_by)
      VALUES ('018f2f45-7f5e-7e70-b17f-f6e773573115', '${tenantId}', 'drama', '${dramaId}',
        statement_timestamp() - interval '1 day', statement_timestamp() + interval '1 year', 'active', '${platformId}');
      INSERT INTO content_license_items (id, tenant_id, license_id, drama_id)
      VALUES ('018f2f45-7f5e-7e70-b17f-f6e773573116', '${tenantId}',
        '018f2f45-7f5e-7e70-b17f-f6e773573115', '${dramaId}');`);
    const revenue = new RevenueShareService(ownerDb);
    await revenue.upsertPolicy(tenantId, { contentScope: 'public', incomeType: 'coin_unlock',
      headquartersBps: 2000, tenantBps: 5000, creatorBps: 3000, expectedVersion: 0 },
      { actorId: platformId, requestId: crypto.randomUUID() });
    const unlock = await new PointUnlockService(ownerDb).unlock(principal, 'episode', episodeId,
      {}, 'audit-unlock-20260906', crypto.randomUUID());
    expect(unlock).toMatchObject({ pointsSpent: 0, alreadyOwned: true });
    const ledger = await database.query('select id from content_revenue_ledger where tenant_id = $1', [tenantId]);
    expect(ledger.rows).toEqual([]);
  });

  it('NF-11: restricts catalog, owned playback and new sales by trusted request country', async () => {
    await database.query(`update tenant_public_drama_publications
      set allowed_countries=ARRAY['US'], version=version+1 where tenant_id=$1 and drama_id=$2`, [tenantId, dramaId]);
    const catalog = new CustomerContentCatalogService(restrictedDb);
    const playback = new CustomerPlaybackAccessService(restrictedDb);
    expect((await catalog.listDramas(tenantId, {})).items).toEqual([]);
    await expect(playback.getAccess(principal, episodeId)).rejects.toThrow('Published episode is unavailable');
    await expect(new PointUnlockService(ownerDb).unlock(principal, 'episode', episodeId,
      {}, 'unknown-region', crypto.randomUUID())).rejects.toThrow('Point-unlockable content not found');
    await restrictedDb.inTenantContext(tenantId, async (sql) => {
      await sql`select set_config('app.request_country', 'US', true)`;
      expect(await sql`select app.customer_region_allowed(${tenantId}, ${dramaId}) as allowed`)
        .toEqual([{ allowed: true }]);
      await expect(playback.resolveInTransaction(sql, principal, episodeId)).resolves.toMatchObject({ access: 'full' });
      await expect(playback.resolveInTransaction(sql, { tenantId }, episodeId)).resolves.toMatchObject({ access: 'locked' });
      await sql`select set_config('app.request_country', 'GB', true)`;
      await expect(playback.resolveInTransaction(sql, principal, episodeId)).rejects.toThrow('Published episode is unavailable');
    });
    await database.query(`update tenant_public_drama_publications
      set allowed_countries='{}', blocked_countries=ARRAY['US'], version=version+1 where tenant_id=$1 and drama_id=$2`,
      [tenantId, dramaId]);
    await restrictedDb.inTenantContext(tenantId, async (sql) => {
      await sql`select set_config('app.request_country', 'US', true)`;
      expect(await sql`select app.customer_region_allowed(${tenantId}, ${dramaId}) as allowed`).toEqual([{ allowed: false }]);
      await sql`select set_config('app.request_country', 'GB', true)`;
      expect(await sql`select app.customer_region_allowed(${tenantId}, ${dramaId}) as allowed`).toEqual([{ allowed: true }]);
    });
    await database.query(`update tenant_public_drama_publications
      set blocked_countries='{}', version=version+1 where tenant_id=$1 and drama_id=$2`, [tenantId, dramaId]);
  });

  it('NF-10: restricted-role HLS issuance rewrites private keys and segments with pinned versions', async () => {
    const access = new CustomerPlaybackAccessService(restrictedDb);
    const readObject = vi.fn(async (input: { objectKey: string; versionId?: string }) => {
      if (input.objectKey === rootKey) {
        expect(input.versionId).toBe('root-v1');
        return { body: Buffer.from('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST') };
      }
      expect(input.versionId).toBe(input.objectKey.endsWith('.bin') ? 'key-v1' : 'segment-v1');
      return { body: Buffer.from('authorized-media') };
    });
    const cipher = { decrypt: vi.fn(() => ({ accessKeyId: 'unit', secretAccessKey: 'unit', region: 'us-east-1' })) } as unknown as StorageCredentialCipher;
    const storage = { readObject } as unknown as S3CompatibleStorageAdapter;
    hls = new HlsPlaybackService(restrictedDb, access, cipher, storage);
    const urls = new CustomerPlaybackUrlService(restrictedDb, access, cipher, storage,
      { consume: vi.fn(async () => {}) } as unknown as PlaybackUrlRateLimiterService, hls);
    const issued = await urls.issue(principal, episodeId, 180, '127.0.0.1', 'https://agent.example.test');
    mediaToken = new URL(issued.url).searchParams.get('token')!;
    const manifest = await hls.read(mediaToken, tenantId, 'https://agent.example.test');
    const text = manifest.body.toString();
    expect(manifest.contentType).toBe('application/vnd.apple.mpegurl');
    expect(text).not.toContain('URI="key.bin"');
    const resources = [...text.matchAll(/https:\/\/agent\.example\.test\/api\/v1\/customer\/playback\/hls\/resource\?token=([A-Za-z0-9_.-]+)/g)];
    expect(resources).toHaveLength(2);
    for (const resource of resources) {
      expect((await hls.read(resource[1], tenantId, 'https://agent.example.test')).body.toString()).toBe('authorized-media');
    }
    expect(readObject).toHaveBeenCalledTimes(3);
    await expect(hls.read(mediaToken, crypto.randomUUID(), 'https://other.example.test')).rejects.toThrow('another tenant');
    await expect(hls.read(mediaToken + 'x', tenantId, 'https://agent.example.test')).rejects.toThrow('token');
    expect(readObject).toHaveBeenCalledTimes(3);
  });

  it('keeps permanent purchases on ordinary unpublish, rejects new sales and emergency playback', async () => {
    await database.exec(`update tenant_public_drama_publications
      set status='unpublished', unpublished_at=statement_timestamp(), version=version+1
      where tenant_id='${tenantId}' and drama_id='${dramaId}'`);
    const access = new CustomerPlaybackAccessService(restrictedDb);
    await expect(access.getAccess(principal, episodeId)).resolves.toMatchObject({ access: 'full' });
    const viewer = crypto.randomUUID();
    await database.query(`insert into customer_accounts (id, tenant_id, username, password_hash)
      values ($1, $2, 'new-viewer', $3)`, [viewer, tenantId, 'p'.repeat(64)]);
    await expect(access.getAccess({ ...principal, accountId: viewer }, episodeId))
      .resolves.toMatchObject({ access: 'locked' });
    await expect(new PointUnlockService(ownerDb).unlock({ ...principal, accountId: viewer }, 'episode', episodeId,
      {}, 'unpublished-new-sale', crypto.randomUUID())).rejects.toThrow('Published content is unavailable');
    expect((await new CustomerContentCatalogService(restrictedDb).listDramas(tenantId, {})).items).toEqual([]);
    const catalog = new CustomerContentCatalogService(restrictedDb);
    await expect(catalog.getDrama(tenantId, dramaId, 'en-US')).rejects.toThrow('Published drama is unavailable');
    await expect(catalog.getDrama(tenantId, dramaId, 'en-US', viewer)).rejects.toThrow('Published drama is unavailable');
    expect((await catalog.getDrama(tenantId, dramaId, 'en-US', accountId)).episodes).toHaveLength(1);
    expect((await hls.read(mediaToken, tenantId, 'https://agent.example.test')).contentType).toBe('application/vnd.apple.mpegurl');
    await database.query(`update dramas set emergency_takedown_at=statement_timestamp(),
      emergency_takedown_reason='regression test' where id=$1`, [dramaId]);
    await expect(access.getAccess(principal, episodeId)).rejects.toThrow('Published episode is unavailable');
    await expect(hls.read(mediaToken, tenantId, 'https://agent.example.test')).rejects.toThrow('Published episode is unavailable');
  });
});
