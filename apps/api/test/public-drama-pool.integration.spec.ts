import { PGlite, type Transaction } from '@electric-sql/pglite';
import { ConflictException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import { PublicDramaPoolService } from '../src/public-drama-pool/public-drama-pool.service';
import { RevenueShareService } from '../src/public-drama-pool/revenue-share.service';

const tenantOneId = '018f2f45-7f5e-7e70-b17f-f6e773573101';
const tenantTwoId = '018f2f45-7f5e-7e70-b17f-f6e773573102';
const tenantOneStaffId = '018f2f45-7f5e-7e70-b17f-f6e773573103';
const tenantTwoStaffId = '018f2f45-7f5e-7e70-b17f-f6e773573104';
const platformStaffId = '018f2f45-7f5e-7e70-b17f-f6e773573105';
const publicDramaId = '018f2f45-7f5e-7e70-b17f-f6e773573106';
const privateDramaId = '018f2f45-7f5e-7e70-b17f-f6e773573107';
const publicEpisodeId = '018f2f45-7f5e-7e70-b17f-f6e773573108';

let database: PGlite;
let service: PublicDramaPoolService;
let revenue: RevenueShareService;

function tag(transaction: Transaction): DatabaseTransaction {
  const sqlTag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(sqlTag, { json: (value: unknown) => JSON.stringify(value) });
  return sqlTag as unknown as DatabaseTransaction;
}

function metadata(actorId: string) {
  return { actorId, ip: '127.0.0.1', requestId: crypto.randomUUID() };
}

describe('shared public drama pool', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of filenames) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(source
        .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
        .replace(/\bcitext\b/g, 'text'));
    }
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantOneId}', 'pool-one', 'Pool One', statement_timestamp() + interval '1 year'),
        ('${tenantTwoId}', 'pool-two', 'Pool Two', statement_timestamp() + interval '1 year');
      insert into tenant_staff (id, tenant_id, username, password_hash) values
        ('${tenantOneStaffId}', '${tenantOneId}', 'pool-one-staff', '${'p'.repeat(64)}'),
        ('${tenantTwoStaffId}', '${tenantTwoId}', 'pool-two-staff', '${'p'.repeat(64)}');
      insert into platform_staff (id, username, password_hash)
        values ('${platformStaffId}', 'pool-platform-staff', '${'p'.repeat(64)}');
      insert into dramas (
        id, owner_type, owner_tenant_id, code, status, total_episodes,
        shanchuang_work_id, shanchuang_creator_id, public_revision
      ) values
        ('${publicDramaId}', 'platform', null, 'shared-public-drama', 'published', 1,
          'shanchuang-work-1', 'shanchuang-creator-1', 1),
        ('${privateDramaId}', 'tenant', '${tenantOneId}', 'tenant-private-drama', 'published', 0,
          null, null, null);
      insert into drama_translations (id, drama_id, locale, title, summary) values
        ('018f2f45-7f5e-7e70-b17f-f6e773573109', '${publicDramaId}', 'en-US', 'Shared Drama', 'Shared pool drama'),
        ('018f2f45-7f5e-7e70-b17f-f6e773573110', '${privateDramaId}', 'en-US', 'Private Drama', 'Tenant only');
      insert into media_assets (
        id, owner_type, owner_tenant_id, source_url,
        kind, mime_type, size_bytes, checksum, metadata_json, status
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e773573111', 'platform', null,
        'https://media.example.test/pool/episode.m3u8', 'video',
        'application/vnd.apple.mpegurl', 1024, '${'a'.repeat(64)}',
        '{"immutable":true}'::jsonb, 'ready'
      );
      insert into episodes (
        id, drama_id, episode_no, status, duration_seconds, media_asset_id
      ) values (
        '${publicEpisodeId}', '${publicDramaId}', 1, 'published', 60,
        '018f2f45-7f5e-7e70-b17f-f6e773573111'
      );
      insert into episode_translations (id, episode_id, locale, title)
        values ('018f2f45-7f5e-7e70-b17f-f6e773573112', '${publicEpisodeId}', 'en-US', 'Episode 1');
    `);

    const databaseService = {
      inPlatformContext: <T>(callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction((transaction) => callback(tag(transaction))),
      inTenantContext: <T>(tenantId: string, callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction(async (transaction) => {
          await transaction.query(
            "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
            [tenantId],
          );
          return callback(tag(transaction));
        }),
    } as unknown as DatabaseService;
    service = new PublicDramaPoolService(databaseService);
    revenue = new RevenueShareService(databaseService);
  }, 120_000);

  afterAll(async () => database?.close());

  it('shows only central platform dramas to every tenant', async () => {
    const [first, second] = await Promise.all([
      service.listPool(tenantOneId, 1, 20),
      service.listPool(tenantTwoId, 1, 20),
    ]);
    expect(first.items.map((item) => item.dramaId)).toEqual([publicDramaId]);
    expect(second.items.map((item) => item.dramaId)).toEqual([publicDramaId]);
    expect(first.items.some((item) => item.dramaId === privateDramaId)).toBe(false);
  });

  it('lets tenants independently review, price and publish the same drama', async () => {
    const firstReview = await service.review(
      tenantOneId, publicDramaId, { decision: 'approved' }, metadata(tenantOneStaffId),
    );
    const secondReview = await service.review(
      tenantTwoId, publicDramaId, { decision: 'approved' }, metadata(tenantTwoStaffId),
    );
    const firstPublish = await service.publish(tenantOneId, publicDramaId, {
      allowedCountries: ['US'], dramaPoints: 30,
      episodePoints: [{ episodeId: publicEpisodeId, points: 5 }],
      expectedVersion: firstReview.version,
    }, metadata(tenantOneStaffId));
    const secondPublish = await service.publish(tenantTwoId, publicDramaId, {
      allowedCountries: ['SG'], dramaPoints: 50, expectedVersion: secondReview.version,
    }, metadata(tenantTwoStaffId));
    expect(firstPublish).toMatchObject({ status: 'published', allowedCountries: ['US'] });
    expect(secondPublish).toMatchObject({ status: 'published', allowedCountries: ['SG'] });

    const prices = await database.query<{
      points_amount: string; tenant_id: string;
    }>(`select tenant_id, points_amount::text from content_point_prices
        where target_type = 'drama' and target_id = '${publicDramaId}' order by tenant_id`);
    expect(prices.rows).toEqual([
      { points_amount: '30', tenant_id: tenantOneId },
      { points_amount: '50', tenant_id: tenantTwoId },
    ]);
  });

  it('keeps tenant publication state isolated and uses compare-and-swap versions', async () => {
    const firstPool = await service.listPool(tenantOneId, 1, 20);
    const secondPool = await service.listPool(tenantTwoId, 1, 20);
    expect(firstPool.items[0]).toMatchObject({ publicationStatus: 'published', publicationVersion: 1 });
    expect(secondPool.items[0]).toMatchObject({ publicationStatus: 'published', publicationVersion: 1 });
    await expect(service.unpublish(
      tenantOneId, publicDramaId, { expectedVersion: 0 }, metadata(tenantOneStaffId),
    )).rejects.toBeInstanceOf(ConflictException);
    await service.unpublish(
      tenantOneId, publicDramaId, { expectedVersion: 1 }, metadata(tenantOneStaffId),
    );
    expect((await service.listPool(tenantOneId, 1, 20)).items[0])
      .toMatchObject({ publicationStatus: 'unpublished', publicationVersion: 2 });
    expect((await service.listPool(tenantTwoId, 1, 20)).items[0])
      .toMatchObject({ publicationStatus: 'published', publicationVersion: 1 });
  });

  it('isolates runtime brand, store and advertising configuration', async () => {
    await service.updateRuntimeConfig(tenantOneId, {
      admob: { rewarded: 'test-rewarded-one' },
      allowedCountries: ['US'], deepLinkHost: 'drama.example.com', expectedVersion: 0,
      featureFlags: { rewards: true }, storeProducts: { coins100: 'coins_100' },
      supportedLocales: ['en-US', 'es-ES'],
    }, metadata(tenantOneStaffId));
    expect(await service.getRuntimeConfig(tenantOneId)).toMatchObject({
      admob: { rewarded: 'test-rewarded-one' }, allowedCountries: ['US'], version: 0,
    });
    expect(await service.getRuntimeConfig(tenantTwoId)).toMatchObject({ admob: {}, version: 0 });
  });

  it('snapshots three-party revenue shares and deduplicates source callbacks', async () => {
    const policy = await revenue.upsertPolicy(tenantOneId, {
      contentScope: 'public', creatorBps: 3_000, expectedVersion: 0,
      headquartersBps: 2_000, incomeType: 'coin_unlock', tenantBps: 5_000,
    }, { actorId: platformStaffId, requestId: crypto.randomUUID() });
    expect(policy).toMatchObject({ creatorBps: 3_000, version: 0 });
    const occurredAt = new Date().toISOString();
    const first = await revenue.record({
      currency: 'USD', dramaId: publicDramaId, episodeId: publicEpisodeId,
      grossMinor: 200, incomeType: 'coin_unlock', occurredAt,
      sourceId: 'point-unlock-1', sourceType: 'coin_unlock', tenantId: tenantOneId,
    }, { requestId: crypto.randomUUID() });
    expect(first).toMatchObject({
      creatorMinor: 60, duplicate: false, grossMinor: 200,
      headquartersMinor: 40, tenantMinor: 100,
    });
    const repeated = await revenue.record({
      currency: 'USD', dramaId: publicDramaId, episodeId: publicEpisodeId,
      grossMinor: 200, incomeType: 'coin_unlock', occurredAt,
      sourceId: 'point-unlock-1', sourceType: 'coin_unlock', tenantId: tenantOneId,
    }, { requestId: crypto.randomUUID() });
    expect(repeated).toMatchObject({ duplicate: true, id: first.id });
    const previous = new Date();
    previous.setUTCDate(1);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    previous.setUTCHours(12, 0, 0, 0);
    const month = previous.toISOString().slice(0, 7);
    await revenue.record({
      currency: 'USD', dramaId: publicDramaId, episodeId: publicEpisodeId,
      grossMinor: 500, incomeType: 'coin_unlock', occurredAt: previous.toISOString(),
      sourceId: 'point-unlock-previous-month', sourceType: 'coin_unlock', tenantId: tenantOneId,
    }, { requestId: crypto.randomUUID() });
    const settlement = await revenue.settleMonth(
      tenantOneId, month, 'usd', { actorId: platformStaffId, requestId: crypto.randomUUID() },
    );
    expect(settlement).toMatchObject({
      alreadySettled: false, count: 1, creatorMinor: '150',
      grossMinor: '500', headquartersMinor: '100', tenantMinor: '250',
    });
    expect(await revenue.settleMonth(
      tenantOneId, month, 'USD', { actorId: platformStaffId, requestId: crypto.randomUUID() },
    )).toMatchObject({ alreadySettled: true, count: 1 });
    await expect(revenue.reverse(tenantTwoId, first.id)).rejects.toBeInstanceOf(ConflictException);
    expect(await revenue.reverse(tenantOneId, first.id)).toEqual({ id: first.id, status: 'reversed' });
  });

  it('lets headquarters stop playback everywhere with an emergency takedown', async () => {
    const result = await service.emergencyTakedown(publicDramaId, {
      expectedVersion: 0, reason: 'Rights holder emergency request',
    }, metadata(platformStaffId));
    expect(result).toMatchObject({ dramaId: publicDramaId, emergencyTakedown: true });
    expect((await service.listPool(tenantOneId, 1, 20)).items).toHaveLength(0);
    const statuses = await database.query<{ drama_status: string; episode_status: string }>(`
      select drama.status as drama_status, episode.status as episode_status
      from dramas as drama inner join episodes as episode on episode.drama_id = drama.id
      where drama.id = '${publicDramaId}'
    `);
    expect(statuses.rows[0]).toEqual({ drama_status: 'unpublished', episode_status: 'unpublished' });
  });
});
