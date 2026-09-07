// Opt-in real HTTP/PostgreSQL companion for Flutter's settings emulator suite.
// No production endpoints or mail transports are changed. Each run owns its DB.
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres, { type Sql } from 'postgres';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { hashPassword } from '../src/auth/password';
import { uuidV7 } from '../src/common/uuid-v7';
import { OtpDeliveryService } from '../src/communications/otp-delivery.service';

const enabled = process.env.NIGHTFLIX_SETTINGS_EMULATOR === '1';
const suffix = uuidV7().replaceAll('-', '');
const dbName = `nf_settings_${suffix}`;
const roles = ['tenant', 'platform', 'resolver'].map(kind => `nf_${kind}_${suffix}`);
const tenant = uuidV7(), staff = uuidV7();
let admin: Sql, owner: Sql, app: NestFastifyApplication;
let created = false;
const createdRoles: string[] = [];
const codes = new Map<string, string>();
let failNext = '';
let native: { action?: string; done?: boolean; error?: string } = {};
let finish: () => void;
const finished = new Promise<void>(resolve => { finish = resolve; });

describe.skipIf(!enabled)('local Android settings with real API and PostgreSQL', () => {
  beforeAll(async () => {
    const url = new URL(process.env.NIGHTFLIX_PG_TEST_URL ?? '');
    if (url.hostname !== '127.0.0.1' || url.pathname !== '/nightflix_local_features' || process.env.NODE_ENV === 'production') {
      throw new Error('Only the isolated local scratch PostgreSQL cluster is allowed');
    }
    admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
    await admin.unsafe(`create database ${dbName} template template0 encoding 'UTF8'`);
    created = true;
    url.pathname = `/${dbName}`;
    owner = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql')).sort()) {
      await owner.unsafe(await readFile(resolve(directory, name), 'utf8'));
    }
    // Normally created by the migration CLI; runtime grants explicitly protect it.
    await owner`create table schema_migrations (name text primary key)`;
    await owner`insert into tenants (id, code, name, expires_at) values
      (${tenant}, 'settings-emulator', 'Local settings QA', now() + interval '1 year')`;
    await owner`insert into platform_staff (id, username, password_hash) values
      (${staff}, 'settings-fixture', ${await hashPassword('Local-fixture-only-123')})`;
    await owner`insert into tenant_domains (id, tenant_id, host, type, verification_token, verified_at, tls_status, is_primary, created_by)
      values (${uuidV7()}, ${tenant}, '127.0.0.1', 'custom', 'local-fixture-verified-domain', statement_timestamp(), 'active', true, ${staff})`;
    for (const name of ['viewer', 'notifications', 'password', 'reset', 'export', 'erase']) {
      await owner`insert into customer_accounts (id, tenant_id, username, email, email_verified_at, password_hash)
        values (${uuidV7()}, ${tenant}, ${name}, ${`${name}@example.test`}, statement_timestamp(), ${await hashPassword('Local-password-123')})`;
    }
    for (const locale of ['en-US', 'zh-CN']) {
      for (const type of ['privacy', 'terms']) {
        const id = uuidV7();
        await owner`insert into tenant_legal_document_versions (id, tenant_id, document_type, locale, version_no, title, body_markdown, required_for_registration, created_by)
          values (${id}, ${tenant}, ${type}, ${locale}, 1, ${type === 'privacy' ? 'QA Privacy Policy' : 'QA Terms'},
            ${`Local test document: ${type}. No real personal information is collected by this fixture.`}, true, ${staff})`;
        await owner`update tenant_legal_document_versions set status = 'published', row_version = 1,
          published_by = ${staff}, published_at = transaction_timestamp(), effective_at = transaction_timestamp() where id = ${id}`;
      }
    }
    for (const role of roles) {
      await owner.unsafe(`create role ${role} login password 'local-test-only' nosuperuser nobypassrls`);
      createdRoles.push(role);
    }
    let grants = await readFile(resolve(process.cwd(), '../../deploy/test-server/runtime-grants.sql'), 'utf8');
    for (const [index, kind] of ['tenant', 'platform', 'resolver'].entries()) grants = grants.replaceAll(`nf_${kind}`, roles[index]!);
    await owner.unsafe(grants);
    for (const [index, name] of ['DATABASE_URL', 'PLATFORM_DATABASE_URL', 'TENANT_RESOLVER_DATABASE_URL'].entries()) {
      url.username = roles[index]!; url.password = 'local-test-only';
      process.env[name] = url.toString();
    }
    process.env.NODE_ENV = 'test';
    delete process.env.REDIS_URL;
    process.env.CUSTOMER_OTP_HMAC_SECRET = 'local-settings-emulator-only-hmac-secret';
    process.env.CUSTOMER_UNIVERSAL_OTP_ENABLED = 'false';
    process.env.CUSTOMER_OTP_EXPOSE_CODE = 'false';
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(OtpDeliveryService).useValue({
        enqueueOtp: async (_: unknown, input: { destination: string; purpose: string; code: string }) => {
          if (!input.destination.endsWith('@example.test')) throw new Error('Fixture addresses only');
          codes.set(`${input.destination}:${input.purpose}`, input.code);
          return true;
        },
      }).compile();
    app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useLogger(['error']);
    await app.register(cookie);
    app.setGlobalPrefix('api/v1');
    const server = app.getHttpAdapter().getInstance();
    server.addHook('onRequest', async (request, reply) => {
      if (failNext && request.url.startsWith(failNext)) {
        failNext = ''; await reply.code(503).send({ message: 'Local injected failure' });
      }
    });
    server.post<{ Body: { path: string } }>('/__qa/fail-next', async request => {
      if (!request.body.path.startsWith('/api/v1/customer/')) throw new Error('Customer fixture endpoints only');
      failNext = request.body.path; return { ok: true };
    });
    server.get<{ Querystring: { email: string; purpose: string } }>('/__qa/code', async request =>
      ({ code: codes.get(`${request.query.email}:${request.query.purpose}`) }));
    server.get('/__qa/native', async () => native);
    server.post<{ Body: { action?: string; done?: boolean; error?: string } }>('/__qa/native', async request => {
      const input = request.body;
      if (input.action && !['system-settings', 'share-export'].includes(input.action)) throw new Error('Unknown native checkpoint');
      native = input.action ? { action: input.action, done: false } : { ...native, done: true, error: input.error };
      return native;
    });
    server.post<{ Params: { name: string }; Body: { png: string } }>('/__qa/screenshots/:name', async request => {
      if (!/^[a-z0-9-]+$/.test(request.params.name)) throw new Error('Invalid screenshot name');
      const directory = resolve(process.cwd(), '../flutter_app/build/settings-emulator');
      const bytes = Buffer.from(request.body.png, 'base64');
      if (bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('PNG required');
      await mkdir(directory, { recursive: true });
      await writeFile(resolve(directory, `${request.params.name}.png`), bytes);
      return { ok: true };
    });
    server.get('/__qa/state', async () => ({
      accounts: await owner`select username, status from customer_accounts where tenant_id = ${tenant} order by username`,
      preferences: await owner`select marketing_in_app_enabled, marketing_push_enabled from customer_notification_preferences where tenant_id = ${tenant}`,
      feedback: await owner`select body from customer_feedback where tenant_id = ${tenant}`,
      erasures: await owner`select status from customer_privacy_requests where tenant_id = ${tenant}`,
    }));
    server.post('/__qa/finish', async () => { setTimeout(finish, 100); return { ok: true }; });
    await app.listen(4326, '127.0.0.1');
    const health = await server.inject({ url: '/api/v1/customer/bootstrap', headers: { host: '127.0.0.1:4326' } });
    expect(health.statusCode, health.body).toBe(200);
    console.log('SETTINGS_EMULATOR_API_READY http://127.0.0.1:4326');
  }, 120_000);

  it('serves the emulator until the host ends the isolated run', async () => {
    await finished;
  }, 3_600_000);

  afterAll(async () => {
    await app?.close();
    await owner?.end();
    if (created) await admin.unsafe(`drop database ${dbName}`);
    for (const role of createdRoles) await admin.unsafe(`drop role ${role}`);
    await admin?.end();
  }, 30_000);
});
