import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let db: PGlite;
const tenant = '018f2f45-7f5e-7e70-b17f-f6e773579101';
const other = '018f2f45-7f5e-7e70-b17f-f6e773579102';
const publicStore = '018f2f45-7f5e-7e70-b17f-f6e773579103';
const privateStore = '018f2f45-7f5e-7e70-b17f-f6e773579104';
const otherStore = '018f2f45-7f5e-7e70-b17f-f6e773579105';

async function insertMedia(tx: Transaction, scope: 'platform' | 'tenant', provider: string) {
  const id = randomUUID();
  await tx.query(`insert into media_assets(id, owner_type, owner_tenant_id, kind, storage_provider_id,
    object_key, mime_type, size_bytes, checksum, status) values ($1,$2,$3,'image',$4,$5,'image/png',256,$6,'uploading')`,
  [id, scope, scope === 'platform' ? null : tenant, provider, `images/${id}.png`, 'sha256:' + 'a'.repeat(64)]);
  return id;
}
async function role(tx: Transaction, scope: 'platform' | 'tenant') {
  await tx.exec(`SET LOCAL ROLE nf_${scope}`);
  await tx.query("select set_config('app.access_scope',$1,true),set_config('app.tenant_id',$2,true)",
    [scope, scope === 'tenant' ? tenant : '']);
}

describe('deployed runtime content/storage helper privileges', () => {
  beforeAll(async () => {
    db = new PGlite();
    const dir = resolve(process.cwd(), '../../database/migrations');
    for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) {
      await db.exec((await readFile(resolve(dir, name), 'utf8'))
        .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '').replace(/\bcitext\b/g, 'text'));
    }
    await db.exec(`CREATE ROLE nf_tenant NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE nf_platform NOSUPERUSER NOBYPASSRLS;
      CREATE ROLE nf_resolver NOSUPERUSER NOBYPASSRLS;
      CREATE TABLE schema_migrations(id integer);
      INSERT INTO tenants(id,code,name,expires_at) VALUES
        ('${tenant}','disk-one','One',now()+interval '1 year'),('${other}','disk-two','Two',now()+interval '1 year');
      INSERT INTO storage_providers(id,owner_type,owner_tenant_id,provider,account_label,bucket,credential_ciphertext) VALUES
        ('${publicStore}','platform',null,'s3','Public','public-bucket','test-only-placeholder-credential'),
        ('${privateStore}','tenant','${tenant}','s3','Private','private-bucket','test-only-placeholder-credential'),
        ('${otherStore}','tenant','${other}','s3','Other','other-bucket','test-only-placeholder-credential');`);
    await db.exec(await readFile(resolve(process.cwd(), '../../deploy/test-server/runtime-grants.sql'), 'utf8'));
    // Verify the surgical repair is idempotent with the full provisioning file.
    await db.exec(await readFile(resolve(process.cwd(), '../../deploy/test-server/storage-runtime-grants.sql'), 'utf8'));
  }, 60000);
  afterAll(async () => { await db?.close(); });

  it('reproduces the upload 500 cause when the nested helper grant is missing', async () => {
    await expect(db.transaction(async tx => {
      await tx.exec('REVOKE EXECUTE ON FUNCTION app.scope_can_reference(text,uuid,text,uuid) FROM nf_platform');
      await role(tx, 'platform');
      await insertMedia(tx, 'platform', publicStore);
    })).rejects.toThrow(/permission denied for function scope_can_reference/);
  });

  it.each(['platform', 'tenant'] as const)('allows %s uploads and content target checks with the real grants', async scope => {
    await db.transaction(async tx => {
      await role(tx, scope);
      const id = await insertMedia(tx, scope, scope === 'platform' ? publicStore : privateStore);
      const target = await tx.query<{ allowed: boolean }>('select app.content_target_matches_scope($1,$2,\'media_asset\',$3) as allowed',
        [scope, scope === 'platform' ? null : tenant, id]);
      expect(target.rows[0]?.allowed).toBe(true);
      await tx.query("update media_assets set status='ready',version=version+1 where id=$1", [id]);
    });
  });

  it('continues rejecting cross-tenant storage references and platform-scope forgery', async () => {
    await expect(db.transaction(async tx => {
      await role(tx, 'tenant');
      await insertMedia(tx, 'tenant', otherStore);
    })).rejects.toThrow(/outside its scope/);
    await db.transaction(async tx => {
      await role(tx, 'tenant');
      await tx.exec("select set_config('app.access_scope','platform',true)");
      expect((await tx.query('select id from storage_providers where id=$1', [otherStore])).rows).toHaveLength(0);
    });
  });

  it('does not give resolver execution or runtime database ownership/bypass', async () => {
    const privileges = await db.query<{ allowed: boolean }>(`select has_function_privilege('nf_resolver',
      'app.scope_can_reference(text,uuid,text,uuid)','EXECUTE') as allowed`);
    expect(privileges.rows[0]?.allowed).toBe(false);
    const roles = await db.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper,rolbypassrls from pg_roles where rolname in ('nf_tenant','nf_platform')");
    expect(roles.rows).toHaveLength(2);
    expect(roles.rows.every(r => !r.rolsuper && !r.rolbypassrls)).toBe(true);
  });
});
