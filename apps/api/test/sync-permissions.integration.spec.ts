import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('executes both permission cleanup queries with PostgreSQL parsing and preserves valid grants', async () => {
  const source = await readFile(resolve('src/cli/sync-permissions.ts'), 'utf8');
  const queries = [...source.matchAll(/`\s*(delete from role_permissions[^`]+)`/g)]
    .map(match => match[1]!.replace(/\$\{permissionId\}/g, '$1'));
  expect(queries).toHaveLength(2);
  const database = new PGlite();
  try {
    await database.exec(`
      create table roles (id text primary key, scope_type text, is_system boolean, name text);
      create table role_permissions (role_id text, permission_id text);
      insert into roles values
        ('platform', 'platform', true, 'platform_super_admin'),
        ('tenant', 'tenant', true, 'tenant_owner');
      insert into role_permissions values
        ('platform', 'platform.read'), ('tenant', 'tenant.read'),
        ('tenant', 'platform.read'), ('platform', 'tenant.read');
    `);
    expect((await database.query(queries[0]!, ['platform.read'])).rows).toEqual([{ role_id: 'tenant' }]);
    expect((await database.query(queries[1]!, ['tenant.read'])).rows).toEqual([{ role_id: 'platform' }]);
    expect((await database.query('select * from role_permissions order by role_id')).rows).toEqual([
      { role_id: 'platform', permission_id: 'platform.read' },
      { role_id: 'tenant', permission_id: 'tenant.read' },
    ]);
  } finally { await database.close(); }
}, 30000);
