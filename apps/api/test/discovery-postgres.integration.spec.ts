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

const url = process.env.NIGHTFLIX_PG_TEST_URL;
const suffix = uuidV7().replaceAll('-', '');
const dbName = `nf_features_${suffix}`;
const role = `nf_runtime_${suffix}`;
const tenantA = uuidV7(), tenantB = uuidV7(), privateA = uuidV7(), privateB = uuidV7(), shared = uuidV7();
const accountA = uuidV7(), accountB = uuidV7(), staff = uuidV7();
const principal = { tenantId: tenantA, accountId: accountA, username: 'viewer', deviceId: uuidV7(), sessionId: uuidV7() };
let owner: Sql, admin: Sql, database: DatabaseService;
let discovery: TenantDramaDiscoveryService, catalog: CustomerContentCatalogService, playback: PlaybackService, interactions: InteractionService;
let created = false, roleCreated = false;
const savedEnvironment = { DATABASE_URL: process.env.DATABASE_URL, PLATFORM_DATABASE_URL: process.env.PLATFORM_DATABASE_URL,
  TENANT_RESOLVER_DATABASE_URL: process.env.TENANT_RESOLVER_DATABASE_URL };

describe.skipIf(!url)('real PostgreSQL discovery and interaction boundary', () => {
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
    source.username = role; source.password = 'local-test-only';
    process.env.DATABASE_URL = source.toString();
    delete process.env.PLATFORM_DATABASE_URL;
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
