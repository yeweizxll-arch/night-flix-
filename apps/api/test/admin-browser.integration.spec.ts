// Opt-in, disposable local HTTP/PostgreSQL fixture for the two real admin UIs.
import { permissionCatalog } from '@drama/contracts';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import postgres, { type Sql } from 'postgres';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { uuidV7 } from '../src/common/uuid-v7';

const enabled = process.env.NIGHTFLIX_ADMIN_BROWSER === '1';
const suffix = uuidV7().replaceAll('-', '');
const dbName = `nf_admin_${suffix}`;
const roles = ['tenant', 'platform', 'resolver'].map(kind => `nf_${kind}_${suffix}`);
const tenantIds = [uuidV7(), uuidV7()];
const staffIds = [uuidV7(), uuidV7(), uuidV7()];
const customerIds = [uuidV7(), uuidV7()];
let admin: Sql, owner: Sql, app: NestFastifyApplication;
let created = false;
const createdRoles: string[] = [];
let finish: () => void;
const finished = new Promise<void>(resolve => { finish = resolve; });
const requests: { method: string; path: string; status: number }[] = [];

describe.skipIf(!enabled)('local two-scope admin browser audit', () => {
  beforeAll(async () => {
    const url = new URL(process.env.NIGHTFLIX_PG_TEST_URL ?? '');
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/nightflix_local_features' || process.env.NODE_ENV === 'production') throw new Error('Local scratch database only');
    admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${dbName} template template0 encoding 'UTF8'`);
    created = true;
    url.pathname = `/${dbName}`;
    owner = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) await owner.unsafe(await readFile(resolve(directory, name), 'utf8'));
    await owner`create table schema_migrations (name text primary key)`;
    const password = await hashPassword('Local-admin-test-123');
    await owner`insert into platform_staff (id, username, password_hash) values (${staffIds[0]!}, 'qa-admin', ${password})`;
    const roleIds = [uuidV7(), uuidV7(), uuidV7()];
    await owner`insert into roles (id, scope_type, name, is_system) values (${roleIds[0]!}, 'platform', 'platform_super_admin', true)`;
    await owner`insert into subject_roles (id, scope_type, subject_type, subject_id, role_id) values (${uuidV7()}, 'platform', 'platform_staff', ${staffIds[0]!}, ${roleIds[0]!})`;
    for (const [i, tenantId] of tenantIds.entries()) {
      const name = i === 0 ? '星河短剧' : '海风剧场';
      await owner`insert into tenants (id, code, name, expires_at) values (${tenantId}, ${`qa-${i}`}, ${name}, statement_timestamp() + interval '1 year')`;
      await owner`insert into tenant_staff (id, tenant_id, username, password_hash) values (${staffIds[i + 1]!}, ${tenantId}, 'qa-owner', ${password})`;
      await owner`insert into roles (id, scope_type, tenant_id, name, is_system) values (${roleIds[i + 1]!}, 'tenant', ${tenantId}, 'tenant_owner', true)`;
      await owner`insert into subject_roles (id, scope_type, tenant_id, subject_type, subject_id, role_id) values (${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff', ${staffIds[i + 1]!}, ${roleIds[i + 1]!})`;
      await owner`insert into tenant_domains (id, tenant_id, host, type, verification_token, verified_at, tls_status, is_primary, created_by)
        values (${uuidV7()}, ${tenantId}, ${i === 0 ? 'tenant-a.localhost' : 'tenant-b.localhost'}, 'custom', 'local-test-domain', statement_timestamp(), 'active', true, ${staffIds[0]!})`;
      await owner`insert into customer_accounts (id, tenant_id, username, email, email_verified_at, password_hash)
        values (${customerIds[i]!}, ${tenantId}, ${`viewer-${i}`}, ${`viewer-${i}@example.test`}, statement_timestamp(), ${password})`;
      await owner`insert into customer_devices (id, tenant_id, account_id, device_token_hash, platform, label)
        values (${uuidV7()}, ${tenantId}, ${customerIds[i]!}, ${randomBytes(32).toString('hex')}, 'android', '本地测试手机')`;
      await owner`insert into customer_feedback (id, tenant_id, account_id, locale, body)
        values (${uuidV7()}, ${tenantId}, ${customerIds[i]!}, 'zh-CN', ${`代理商 ${i + 1} 的测试反馈`})`;
      // Test-only balance; never represents collected revenue or an external payout.
      const balanceId = uuidV7();
      await owner`insert into merchant_balance_accounts (id, tenant_id, currency)
        values (${balanceId}, ${tenantId}, 'USD')`;
      await owner`insert into merchant_balance_ledger (id, tenant_id, balance_account_id, bucket, entry_type,
        delta_minor, balance_after_minor, currency, reference_type, reference_id, idempotency_key)
        values (${uuidV7()}, ${tenantId}, ${balanceId}, 'available', 'adjustment', 10000, 0, 'USD',
        'local_qa_fixture', ${uuidV7()}, ${`qa-balance-${i}`})`;
    }
    for (const permission of permissionCatalog) {
      const pid = uuidV7();
      await owner`insert into permissions (id, code, module, action, description) values (${pid}, ${permission.code}, ${permission.module}, ${permission.action}, '')`;
      if (permission.scope === 'platform') await owner`insert into role_permissions (role_id, permission_id, scope_type, data_scope) values (${roleIds[0]!}, ${pid}, 'platform', 'all')`;
      else for (const [i, tenantId] of tenantIds.entries()) await owner`insert into role_permissions (role_id, permission_id, scope_type, tenant_id, data_scope) values (${roleIds[i + 1]!}, ${pid}, 'tenant', ${tenantId}, 'all')`;
    }
    // Visible seeded content is isolated test data; actual upload tests remain separate.
    for (const [index, tenantId] of [null, ...tenantIds].entries()) {
      const scope = tenantId ? 'tenant' : 'platform';
      const dramaId = uuidV7();
      await owner`insert into dramas (id, owner_type, owner_tenant_id, code, status, total_episodes,
        shanchuang_work_id, shanchuang_creator_id, public_revision)
        values (${dramaId}, ${scope}, ${tenantId}, ${`qa-drama-${index}`}, 'published', 2,
        ${tenantId ? null : 'local-qa-work'}, ${tenantId ? null : 'local-qa-creator'}, ${tenantId ? null : 1})`;
      await owner`insert into drama_translations (id, drama_id, locale, title, summary)
        values (${uuidV7()}, ${dramaId}, 'zh-CN', ${['公共测试剧', '星河私有剧', '海风私有剧'][index]!}, '仅用于本地后台功能验证')`;
      if (tenantId) {
        const commentId = uuidV7();
        await owner`insert into interaction_comments (id, tenant_id, drama_id, account_id, body, status)
          values (${uuidV7()}, ${tenantId}, ${dramaId}, ${customerIds[index - 1]!}, '本地待审评论', 'pending'),
          (${commentId}, ${tenantId}, ${dramaId}, ${customerIds[index - 1]!}, '本地可见评论', 'visible')`;
        await owner`insert into interaction_reports (id, tenant_id, reporter_account_id, target_type, target_id, reason_category, details)
          values (${uuidV7()}, ${tenantId}, ${customerIds[index - 1]!}, 'comment', ${commentId}, 'other', '本地举报功能测试')`;
      }
      for (let no = 1; no <= 2; no++) {
        const mediaId = uuidV7(), episodeId = uuidV7();
        await owner`insert into media_assets (id, owner_type, owner_tenant_id, source_url, kind, mime_type, size_bytes, checksum, metadata_json, status)
          values (${mediaId}, ${scope}, ${tenantId}, ${`https://media.example.test/qa/${mediaId}.m3u8`}, 'video', 'application/vnd.apple.mpegurl', 1024, ${'a'.repeat(64)}, ${owner.json({ immutable: true })}, 'ready')`;
        await owner`insert into episodes (id, drama_id, episode_no, status, duration_seconds, media_asset_id)
          values (${episodeId}, ${dramaId}, ${no}, 'published', 60, ${mediaId})`;
        await owner`insert into episode_translations (id, episode_id, locale, title)
          values (${uuidV7()}, ${episodeId}, 'zh-CN', ${`第 ${no} 集`})`;
      }
    }
    for (const role of roles) {
      await owner.unsafe(`create role ${role} login password 'local-test-only' nosuperuser nobypassrls`);
      createdRoles.push(role);
    }
    let grants = await readFile(resolve(process.cwd(), '../../deploy/test-server/runtime-grants.sql'), 'utf8');
    for (const [i, kind] of ['tenant', 'platform', 'resolver'].entries()) grants = grants.replaceAll(`nf_${kind}`, roles[i]!);
    await owner.unsafe(grants);
    for (const [i, name] of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'TENANT_RESOLVER_DATABASE_URL'].entries()) {
      url.username = roles[i]!; url.password = 'local-test-only'; process.env[name] = url.toString();
    }
    process.env.NODE_ENV = 'test';
    for (const [keys, active] of [
      ['STORAGE_CREDENTIAL_MASTER_KEYS', 'STORAGE_ACTIVE_KEY_VERSION'],
      ['PAYMENT_MASTER_KEYS', 'PAYMENT_ACTIVE_KEY_VERSION'],
      ['NOTIFICATION_MASTER_KEYS', 'NOTIFICATION_ACTIVE_KEY_VERSION'],
      ['COMMUNICATION_MASTER_KEYS', 'COMMUNICATION_ACTIVE_KEY_VERSION'],
      ['FINANCE_PAYOUT_MASTER_KEYS', 'FINANCE_PAYOUT_ACTIVE_KEY_VERSION'],
    ]) {
      process.env[keys!] = JSON.stringify({ 1: randomBytes(32).toString('base64') });
      process.env[active!] = '1';
    }
    process.env.PLATFORM_ADMIN_HOSTS = 'admin.localhost';
    delete process.env.REDIS_URL;
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ bodyLimit: 2 * 1024 * 1024 }));
    app.useLogger(['error']);
    await app.register(cookie);
    app.setGlobalPrefix('api/v1');
    const server = app.getHttpAdapter().getInstance();
    server.addHook('onResponse', async (request, reply) => {
      if (request.url.startsWith('/api/')) requests.push({ method: request.method, path: request.url.split('?')[0]!, status: reply.statusCode });
    });
    server.get('/__qa/state', async () => ({ tenantIds, staffIds, requests,
      dramas: await owner`select id, owner_tenant_id, code, status from dramas`,
      roles: await owner`select id, scope_type, tenant_id, name from roles`,
    }));
    server.post('/__qa/finish', async () => { setTimeout(finish, 100); return { ok: true }; });
    await app.listen(3000, '127.0.0.1');
    console.log('ADMIN_BROWSER_READY: admin.localhost:4541, tenant-a.localhost:4542, tenant-b.localhost:4542');
  }, 120_000);
  it('serves the local browser until explicitly finished', async () => { await finished; }, 28_800_000);
  afterAll(async () => {
    await app?.close(); await owner?.end();
    if (created) await admin.unsafe(`drop database ${dbName}`);
    for (const role of createdRoles) await admin.unsafe(`drop role ${role}`);
    await admin?.end();
  }, 30_000);
});
