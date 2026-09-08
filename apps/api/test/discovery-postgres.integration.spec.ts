// Optional real PostgreSQL gate. The supplied URL must point to an isolated local
// scratch cluster; this suite creates its own database and non-owner runtime role.
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { uuidV7 } from '../src/common/uuid-v7';
import { DatabaseService } from '../src/database/database.service';
import { TenantDramaDiscoveryService } from '../src/content/tenant-drama-discovery';
import { CustomerContentCatalogService } from '../src/customer-content/customer-content-catalog.service';
import { PlaybackService } from '../src/playback/playback.service';
import { CustomerPlaybackAccessService } from '../src/playback/customer-playback-access.service';
import { InteractionService } from '../src/interactions/interaction.service';
import type { InteractionRateLimiterService } from '../src/interactions/interaction-rate-limiter.service';
import { ContentService } from '../src/content/content.service';
import { PointUnlockService } from '../src/commerce/point-unlock.service';
import { OutboxPublisherService } from '../src/outbox/outbox-publisher.service';
import type { RedisService } from '../src/redis/redis.service';

const url = process.env.NIGHTFLIX_PG_TEST_URL;
const suffix = uuidV7().replaceAll('-', '');
const dbName = `nf_features_${suffix}`;
const role = `nf_runtime_${suffix}`;
const platformRole = `${role}_p`;
const tenantA = uuidV7(), tenantB = uuidV7(), privateA = uuidV7(), privateB = uuidV7(), shared = uuidV7();
const accountA = uuidV7(), accountB = uuidV7(), staff = uuidV7();
const principal = { tenantId: tenantA, accountId: accountA, username: 'viewer', deviceId: uuidV7(), sessionId: uuidV7() };
let owner: Sql, admin: Sql, database: DatabaseService;
let discovery: TenantDramaDiscoveryService, catalog: CustomerContentCatalogService, playback: PlaybackService, interactions: InteractionService;
let created = false, roleCreated = false, platformRoleCreated = false;
const savedEnvironment = { DATABASE_URL: process.env.DATABASE_URL, PLATFORM_DATABASE_URL: process.env.PLATFORM_DATABASE_URL,
  TENANT_RESOLVER_DATABASE_URL: process.env.TENANT_RESOLVER_DATABASE_URL };

describe.skipIf(!url)('real PostgreSQL discovery and interaction boundary', () => {
  it('charges once for 40 concurrent unlocks with repeated and distinct request keys', async () => {
    const wallet = uuidV7();
    await owner`insert into point_accounts (id, tenant_id, account_id) values (${wallet}, ${tenantA}, ${accountA})`;
    await owner`insert into point_ledger (id, tenant_id, account_id, point_account_id, entry_type, delta,
      balance_after, reference_type, reference_id, idempotency_key, created_by_type, created_by)
      values (${uuidV7()}, ${tenantA}, ${accountA}, ${wallet}, 'adjustment', 1000, 0,
      'manual_adjustment', ${uuidV7()}, ${uuidV7()}, 'platform_staff', ${staff})`;
    await owner`insert into content_point_prices (id, tenant_id, target_type, target_id, points_amount)
      values (${uuidV7()}, ${tenantA}, 'drama', ${privateA}, 300)`;
    const unlock = new PointUnlockService(database);
    const key = uuidV7();
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) =>
      unlock.unlock(principal, 'drama', privateA, {}, i < 20 ? key : uuidV7(), uuidV7())));
    expect(new Set(results.map(row => row.entitlementId)).size).toBe(1);
    expect((await owner`select balance::integer as balance from point_accounts where id = ${wallet}`)[0]?.balance).toBe(700);
    expect((await owner`select count(*)::integer as n from point_unlocks where account_id = ${accountA}`)[0]?.n).toBe(1);
    expect((await owner`select count(*)::integer as n from point_ledger where point_account_id = ${wallet} and entry_type = 'purchase'`)[0]?.n).toBe(1);
  });

  it('isolates 200 concurrent tenant transactions across pooled connections', async () => {
    const started = performance.now();
    await Promise.all(Array.from({ length: 200 }, async (_, index) => {
      const tenant = index % 2 ? tenantA : tenantB;
      const expected = index % 2 ? accountA : accountB;
      await database.inTenantContext(tenant, async tx => {
        const accounts = await tx<{ id: string }[]>`select id from customer_accounts`;
        expect(accounts.map(row => row.id)).toEqual([expected]);
        const [context] = await tx`select current_setting('app.tenant_id') as tenant`;
        expect(context?.tenant).toBe(tenant);
      });
    }));
    console.info(`200 tenant transactions: ${Math.round(performance.now() - started)}ms; local only, not a production capacity claim`);
  });

  it('cancels slow SQL and lock waits, rolls back, and reuses the pool', async () => {
    const names = ['DATABASE_STATEMENT_TIMEOUT_MS', 'DATABASE_LOCK_TIMEOUT_MS'] as const;
    const previous = names.map(name => process.env[name]);
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = '500';
    process.env.DATABASE_LOCK_TIMEOUT_MS = '100';
    const bounded = new DatabaseService();
    names.forEach((name, i) => { if (previous[i] === undefined) delete process.env[name]; else process.env[name] = previous[i]; });
    try {
      await expect(bounded.inTenantContext(tenantA, async tx => {
        await tx`update customer_accounts set username = 'must-rollback' where id = ${accountA}`;
        await tx`select pg_sleep(1)`;
      })).rejects.toMatchObject({ code: '57014' });
      expect((await owner`select username from customer_accounts where id = ${accountA}`)[0]?.username).toBe('viewer-a');
      await owner.begin(async tx => {
        await tx`select id from customer_accounts where id = ${accountA} for update`;
        await expect(bounded.inTenantContext(tenantA, q => q`select id from customer_accounts where id = ${accountA} for update`))
          .rejects.toMatchObject({ code: '55P03' });
      });
      expect(await bounded.ping()).toBe(true);
    } finally { await bounded.onApplicationShutdown(); }
  });

  it('handles 30 buyers and 300 duplicate purchases without mixing balances or overspending', async () => {
    const buyers = Array.from({ length: 30 }, () => ({ account: uuidV7(), wallet: uuidV7(), key: uuidV7() }));
    for (const buyer of buyers) {
      await owner`insert into customer_accounts (id, tenant_id, username, password_hash)
        values (${buyer.account}, ${tenantA}, ${buyer.account}, ${'x'.repeat(64)})`;
      await owner`insert into point_accounts (id, tenant_id, account_id) values (${buyer.wallet}, ${tenantA}, ${buyer.account})`;
      await owner`insert into point_ledger (id, tenant_id, account_id, point_account_id, entry_type, delta,
        balance_after, reference_type, reference_id, idempotency_key, created_by_type, created_by)
        values (${uuidV7()}, ${tenantA}, ${buyer.account}, ${buyer.wallet}, 'adjustment', 500, 0,
        'manual_adjustment', ${uuidV7()}, ${uuidV7()}, 'platform_staff', ${staff})`;
    }
    const unlock = new PointUnlockService(database);
    const started = performance.now();
    const results = await Promise.all(buyers.flatMap(buyer => Array.from({ length: 10 }, () =>
      unlock.unlock({ ...principal, accountId: buyer.account }, 'drama', privateA, {}, buyer.key, uuidV7()))));
    expect(new Set(results.map(row => row.entitlementId)).size).toBe(30);
    const balances = await owner`select balance::integer as balance from point_accounts where id in ${owner(buyers.map(b => b.wallet))}`;
    expect(balances).toHaveLength(30);
    expect(balances.every(row => row.balance === 200)).toBe(true);
    console.info(`30 buyers / 300 unlock calls: ${Math.round(performance.now() - started)}ms; local DB only`);
    // Each buyer now has only 200 coins: a different 300-coin target must fail.
    const other = uuidV7();
    await owner`insert into dramas (id, owner_type, owner_tenant_id, code, status) values (${other}, 'tenant', ${tenantA}, 'insufficient', 'published')`;
    await owner`insert into content_point_prices (id, tenant_id, target_type, target_id, points_amount) values (${uuidV7()}, ${tenantA}, 'drama', ${other}, 300)`;
    const rejected = await Promise.allSettled(buyers.map(buyer =>
      unlock.unlock({ ...principal, accountId: buyer.account }, 'drama', other, {}, uuidV7(), uuidV7())));
    expect(rejected.every(result => result.status === 'rejected' && result.reason instanceof ConflictException)).toBe(true);
    expect((await owner`select count(*)::integer as n from point_unlocks where target_id = ${other}`)[0]?.n).toBe(0);
  });

  it('concurrent workers claim each pending event once in the healthy delivery path', async () => {
    const deliveries = new Map<string, number>();
    const redis = { appendStream: async (_stream: string, fields: Record<string, string>) => {
      deliveries.set(fields.eventId!, (deliveries.get(fields.eventId!) ?? 0) + 1);
      return '1-0';
    } } as unknown as RedisService;
    const workers = Array.from({ length: 4 }, () => new OutboxPublisherService(database, redis));
    await Promise.all(workers.map(async worker => {
      while (true) {
        const result = await worker.publishAvailable();
        expect(result.failed).toBe(0);
        if (!result.claimed) break;
      }
    }));
    expect(deliveries.size).toBeGreaterThanOrEqual(30);
    expect([...deliveries.values()].every(count => count === 1)).toBe(true);
    // Transport crash/retry remains at-least-once; consumers must deduplicate eventId.
  });

  it('categorizes exactly the 90 test shows without changing another tenant', async () => {
    const targetTenant = '01a076ee-40c2-7cfe-8fc9-ce03682a286e';
    await owner`insert into tenants (id, code, name, expires_at) values (${targetTenant}, 'category-seed-qa', 'Category QA', now() + interval '1 year')`;
    for (let n = 1; n <= 90; n++) {
      const id = uuidV7();
      await owner`insert into dramas (id, owner_type, owner_tenant_id, code, status)
        values (${id}, 'tenant', ${targetTenant}, ${`scv2-show-${String(n).padStart(2, '0')}`}, 'published')`;
      await owner`insert into drama_translations (id, drama_id, locale, title)
        values (${uuidV7()}, ${id}, 'zh-CN', ${`${['校园爱情', '古风伤感', '中式玄幻', '废土近未来战争', '测试剧情'][n % 5]} · ${n}`})`;
    }
    const script = (await readFile(resolve(process.cwd(), '../../deploy/test-server/seed-test-categories-20260908.sql'), 'utf8'))
      .replace(/^\\set.*$/gm, '');
    await owner.unsafe(script);
    expect((await owner`select count(*)::integer as n from dramas where owner_tenant_id = ${targetTenant} and category_id is not null`)[0]?.n).toBe(90);
    expect((await catalog.listDramas(targetTenant, { category: 'romance', pageSize: 50 })).items).toHaveLength(18);
    expect((await owner`select category_id from dramas where id = ${privateA}`)[0]?.category_id).toBeNull();
  });
  it('allows only private tenant track writes under actual non-owner RLS', async () => {
    const provider = uuidV7(), asset = uuidV7(), privateDrama = uuidV7(), episode = uuidV7();
    const publicEpisode = uuidV7(), publicAsset = uuidV7();
    await owner.unsafe(`grant execute on function app.scope_can_reference(text, uuid, text, uuid), app.content_target_matches_scope(text, uuid, text, uuid) to ${role}`);
    await owner`insert into storage_providers (id, owner_type, owner_tenant_id, provider, account_label, bucket, credential_ciphertext)
      values (${provider}, 'tenant', ${tenantA}, 's3', 'Track QA', 'track-qa', ${'x'.repeat(64)})`;
    await owner`insert into media_assets (id, owner_type, owner_tenant_id, kind, storage_provider_id, object_key, mime_type, size_bytes, checksum, status)
      values (${asset}, 'tenant', ${tenantA}, 'file', ${provider}, 'qa.vtt', 'text/vtt', 50, ${'a'.repeat(64)}, 'ready')`;
    await owner`insert into media_assets (id, owner_type, kind, source_url, mime_type, checksum, metadata_json, status)
      values (${publicAsset}, 'platform', 'video', 'https://media.example.test/qa.mp4', 'video/mp4', ${'a'.repeat(64)}, '{"immutable":true}', 'ready')`;
    await owner`insert into dramas (id, owner_type, owner_tenant_id, code) values (${privateDrama}, 'tenant', ${tenantA}, 'pg-track-private')`;
    await owner`insert into episodes (id, drama_id, episode_no, media_asset_id) values (${episode}, ${privateDrama}, 1, ${publicAsset}), (${publicEpisode}, ${shared}, 1, ${publicAsset})`;
    const content = new ContentService(database);
    const input = { expectedVersion: 0, type: 'subtitle', locale: 'zh-CN', label: '中文字幕', mediaAssetId: asset, isDefault: true };
    const metadata = { actorId: staff, idempotencyKey: uuidV7(), requestId: uuidV7() };
    const track = await content.saveTenantEpisodeTrack(tenantA, privateDrama, episode, input, metadata);
    expect((await content.getTenantDrama(tenantA, privateDrama)).episodes[0]?.tracks?.[0]?.id).toBe(track.id);
    await expect(content.getTenantDrama(tenantB, privateDrama)).rejects.toBeInstanceOf(NotFoundException);
    await expect(database.inTenantContext(tenantB, tx => tx`
      insert into episode_media_tracks (id, episode_id, track_type, locale, label, media_asset_id)
      values (${uuidV7()}, ${episode}, 'subtitle', 'en-US', 'Other', ${asset})
    `)).rejects.toThrow();
    await expect(database.inTenantContext(tenantA, tx => tx`
      insert into episode_media_tracks (id, episode_id, track_type, locale, label, media_asset_id)
      values (${uuidV7()}, ${publicEpisode}, 'subtitle', 'en-US', 'Public override', ${asset})
    `)).rejects.toThrow();
    const denied = await database.inTenantContext(tenantB, tx => tx`
      update episode_media_tracks set label = 'Other tenant' where id = ${track.id} returning id
    `);
    expect(denied).toHaveLength(0);
    await content.saveTenantEpisodeTrack(tenantA, privateDrama, episode, { expectedVersion: track.dramaVersion }, { ...metadata, idempotencyKey: uuidV7(), requestId: uuidV7() }, track.id);
    expect((await content.getTenantDrama(tenantA, privateDrama)).episodes[0]?.tracks?.[0]?.status).toBe('disabled');
  });
  beforeAll(async () => {
    const source = new URL(url!);
    if (source.hostname !== '127.0.0.1' || source.pathname !== '/nightflix_local_features') {
      throw new Error('Use only 127.0.0.1/nightflix_local_features in a disposable local cluster');
    }
    admin = postgres(source.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${dbName} template template0 encoding 'UTF8'`); created = true;
    source.pathname = `/${dbName}`;
    owner = postgres(source.toString(), { max: 1, onnotice: () => {} });
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const name of (await readdir(directory)).filter(name => name.endsWith('.sql')).sort()) {
      await owner.unsafe(await readFile(resolve(directory, name), 'utf8'));
    }
    await owner.unsafe(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantA}', 'pg-a', 'Agent A', now() + interval '1 year'), ('${tenantB}', 'pg-b', 'Agent B', now() + interval '1 year');
      insert into platform_staff (id, username, password_hash) values ('${staff}', 'pg-admin', '${'x'.repeat(64)}');
      insert into customer_accounts (id, tenant_id, username, password_hash) values
        ('${accountA}', '${tenantA}', 'viewer-a', '${'x'.repeat(64)}'), ('${accountB}', '${tenantB}', 'viewer-b', '${'x'.repeat(64)}');
      insert into dramas (id, owner_type, owner_tenant_id, code, status, release_at) values
        ('${privateA}', 'tenant', '${tenantA}', 'private-a', 'published', now() - interval '3 days'),
        ('${privateB}', 'tenant', '${tenantB}', 'private-b', 'published', now() - interval '2 days'),
        ('${shared}', 'platform', null, 'shared', 'published', now() - interval '1 day');
      insert into drama_translations (id, drama_id, locale, title) values
        ('${uuidV7()}', '${privateA}', 'en-US', 'A'), ('${uuidV7()}', '${privateB}', 'en-US', 'B'), ('${uuidV7()}', '${shared}', 'en-US', 'Shared');
    `);
    for (const tenant of [tenantA, tenantB]) {
      const license = uuidV7();
      await owner`insert into content_licenses (id, tenant_id, license_type, drama_id, starts_at, expires_at, status, granted_by)
        values (${license}, ${tenant}, 'drama', ${shared}, now() - interval '1 day', now() + interval '1 day', 'active', ${staff})`;
      await owner`insert into content_license_items (id, tenant_id, license_id, drama_id) values (${uuidV7()}, ${tenant}, ${license}, ${shared})`;
    }
    await owner.unsafe(`create role ${role} login password 'local-test-only' nosuperuser nobypassrls;`); roleCreated = true;
    await owner.unsafe(`grant usage on schema app, public to ${role}; grant select, insert, update, delete on all tables in schema public to ${role};`);
    await owner.unsafe(`create role ${platformRole} login password 'local-test-only' nosuperuser nobypassrls`); platformRoleCreated = true;
    await owner.unsafe(`grant usage on schema app, public to ${platformRole}; grant select, insert, update, delete on all tables in schema public to ${platformRole}`);
    await owner`insert into app.database_access_principals (role_name, access_scope) values (${platformRole}, 'platform')`;
    source.username = platformRole; source.password = 'local-test-only';
    process.env.PLATFORM_DATABASE_URL = source.toString();
    source.username = role; source.password = 'local-test-only';
    process.env.DATABASE_URL = source.toString();
    delete process.env.TENANT_RESOLVER_DATABASE_URL;
    database = new DatabaseService();
    discovery = new TenantDramaDiscoveryService(database);
    catalog = new CustomerContentCatalogService(database);
    playback = new PlaybackService(database, new CustomerPlaybackAccessService(database));
    interactions = new InteractionService(database, { consume: async () => {} } as unknown as InteractionRateLimiterService);
    const [identity] = await database.sql`select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user`;
    expect(identity).toMatchObject({ name: role, rolsuper: false, rolbypassrls: false });
  }, 60000);

  afterAll(async () => {
    await database?.onApplicationShutdown();
    await owner?.end();
    if (created) await admin.unsafe(`drop database ${dbName}`);
    if (roleCreated) await admin.unsafe(`drop role ${role}`);
    if (platformRoleCreated) await admin.unsafe(`drop role ${platformRole}`);
    await admin?.end();
    for (const [key, value] of Object.entries(savedEnvironment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  it('saves private and public weights through real runtime RLS, without changing heat', async () => {
    await discovery.set(tenantA, privateA, { weight: 500, pinnedRank: 0, expectedVersion: 0 }, staff, uuidV7());
    expect((await catalog.listDramas(tenantA, { sort: 'popular' })).items[0]).toMatchObject({ id: privateA, heat: 0 });
    await discovery.set(tenantA, shared, { weight: 0, pinnedRank: 1, expectedVersion: 0 }, staff, uuidV7());
    expect((await catalog.listDramas(tenantA, { sort: 'popular' })).items[0]?.id).toBe(shared);
    expect(await discovery.get(tenantB, shared)).toEqual({ weight: 0, pinnedRank: 0, version: 0 });
    expect((await catalog.listDramas(tenantB, { sort: 'popular' })).items.map(d => d.id)).not.toContain(privateA);
    await expect(discovery.get(tenantA, privateB)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('serializes concurrent saves and stops an emergency-taken-down pinned drama', async () => {
    const input = { weight: 1, pinnedRank: 0, expectedVersion: 1 };
    const writes = await Promise.allSettled([discovery.set(tenantA, privateA, input, staff, uuidV7()), discovery.set(tenantA, privateA, input, staff, uuidV7())]);
    expect(writes.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(writes.find(r => r.status === 'rejected')).toMatchObject({ reason: expect.any(ConflictException) });
    await owner`update dramas set emergency_takedown_at = now() where id = ${shared}`;
    expect((await catalog.listDramas(tenantA, { sort: 'popular' })).items.map(d => d.id)).not.toContain(shared);
    await owner`update dramas set emergency_takedown_at = null where id = ${shared}`;
  });

  it('persists public following separately from favorites under non-owner RLS', async () => {
    await playback.setFollowing(principal, shared, true);
    await playback.setFollowing(principal, shared, true);
    expect((await playback.following(principal, 1)).items).toEqual([{ dramaId: shared }]);
    expect((await playback.listFavorites(principal, 1, 20)).items).toEqual([]);
    expect((await playback.following({ ...principal, tenantId: tenantB, accountId: accountB }, 1)).items).toEqual([]);
    await playback.setFollowing(principal, shared, false);
    expect((await playback.following(principal, 1)).total).toBe(0);
  });

  it('serves real public interaction counts to guests, with emergency restrictions', async () => {
    await interactions.setDramaLike(principal, shared, true, uuidV7());
    const guest = { tenantId: tenantA };
    expect(await interactions.dramaSummary(guest, shared)).toMatchObject({ likeCount: 1, isLiked: false });
    expect((await catalog.listDramas(tenantA, { sort: 'popular' })).items.find(d => d.id === shared)?.heat).toBeGreaterThan(190);
    await owner`update dramas set emergency_takedown_at = now() where id = ${shared}`;
    try { await expect(interactions.dramaSummary(guest, shared)).rejects.toBeInstanceOf(NotFoundException); }
    finally { await owner`update dramas set emergency_takedown_at = null where id = ${shared}`; }
  });

  it('records feedback and replies exactly once without cross-tenant disclosure', async () => {
    const metadata = { idempotencyKey: uuidV7(), requestId: uuidV7(), ip: '127.0.0.1', actorId: accountA,
      actorType: 'user' as const, scope: 'tenant' as const };
    const input = { body: '播放器有问题', locale: 'zh-CN' };
    const result = await interactions.sendFeedback(principal, input, metadata);
    expect(await interactions.sendFeedback(principal, input, metadata)).toEqual(result);
    expect((await interactions.feedback(tenantA, accountA, 1)).items[0]?.body).toBe(input.body);
    expect((await interactions.feedback(tenantB, undefined, 1)).items).toEqual([]);
    const replyMetadata = { ...metadata, actorId: staff, actorType: 'tenant_staff' as const };
    await interactions.replyFeedback(tenantA, result.id, { reply: '已收到，正在处理' }, replyMetadata);
    await interactions.replyFeedback(tenantA, result.id, { reply: '已收到，正在处理' }, replyMetadata);
    const rows = await database.inTenantContext(tenantA, sql => sql`select body from customer_inbox_messages where account_id = ${accountA}`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe('已收到，正在处理');
    await expect(database.inTenantContext(tenantA, sql => sql`
      insert into customer_inbox_messages (id, tenant_id, account_id, category, source_type, locale, title, body)
      values (${uuidV7()}, ${tenantA}, ${accountA}, 'transactional', 'system', 'en-US', 'Forged', 'Must fail')
    `)).rejects.toThrow(/row-level security/);
  });

  it('ranks newly published old drafts as new and preserves first publication on later edits', async () => {
    const id = uuidV7();
    await owner`insert into dramas (id, owner_type, owner_tenant_id, code, status, created_at)
      values (${id}, 'tenant', ${tenantA}, 'old-draft-new-release', 'draft', now() - interval '60 days')`;
    await owner`insert into drama_translations (id, drama_id, locale, title) values (${uuidV7()}, ${id}, 'en-US', 'New release')`;
    await owner`update dramas set status = 'published' where id = ${id}`;
    const first = (await catalog.listDramas(tenantA, { sort: 'latest' })).items[0];
    expect(first?.id).toBe(id);
    await owner`update dramas set status = 'unpublished' where id = ${id}`;
    await owner`update dramas set status = 'published' where id = ${id}`;
    expect((await catalog.listDramas(tenantA, { sort: 'latest' })).items[0]?.publishedAt).toBe(first?.publishedAt);
  });
});
