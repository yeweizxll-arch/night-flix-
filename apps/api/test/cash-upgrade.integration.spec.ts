import { PGlite } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const tenant = '018f2f45-7f5e-7e70-b17f-f6e773570301';
const account = '018f2f45-7f5e-7e70-b17f-f6e773570302';
const wallet = '018f2f45-7f5e-7e70-b17f-f6e773570303';
const compatible = (sql: string) => sql.replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '').replace(/\bcitext\b/g, 'text');
describe('cash provenance upgrade of an existing wallet', () => {
  it('replays the immutable ledger without re-crediting or losing coins and is safe to rerun', async () => {
    const db = new PGlite();
    try {
      const directory = resolve(process.cwd(), '../../database/migrations');
      for (const file of (await readdir(directory)).filter(f => f.endsWith('.sql') && f < '0038').sort())
        await db.exec(compatible(await readFile(resolve(directory, file), 'utf8')));
      await db.exec(`insert into tenants(id, code, name, expires_at) values ('${tenant}', 'upgrade', 'Upgrade', now() + interval '1 year');
        insert into customer_accounts(id, tenant_id, username, password_hash) values ('${account}', '${tenant}', 'upgrade-user', '${'x'.repeat(64)}');
        insert into point_accounts(id, tenant_id, account_id) values ('${wallet}', '${tenant}', '${account}');
        insert into point_ledger(id, tenant_id, account_id, point_account_id, entry_type, delta, balance_after,
          reference_type, reference_id, idempotency_key, created_by_type, created_at) values
          ('018f2f45-7f5e-7e70-b17f-f6e773570304', '${tenant}', '${account}', '${wallet}', 'adjustment', 10, 0,
            'audit_credit', '${account}', 'upgrade-credit', 'system', now() - interval '2 days'),
          ('018f2f45-7f5e-7e70-b17f-f6e773570305', '${tenant}', '${account}', '${wallet}', 'adjustment', -3, 0,
            'audit_spend', '${account}', 'upgrade-spend', 'system', now() - interval '1 day');`);
      const migration = compatible(await readFile(resolve(directory, '0038_cash_provenance_and_revenue.sql'), 'utf8'));
      await db.exec(migration); await db.exec(migration);
      expect((await db.query('select balance::text from point_accounts')).rows).toEqual([{ balance: '7' }]);
      expect((await db.query('select remaining::text, is_cash from point_cash_lots')).rows).toEqual([{ remaining: '7', is_cash: false }]);
      expect((await db.query('select id from content_cash_sources')).rows).toHaveLength(0);
      expect((await db.query('select tenant_id from content_revenue_legacy_review')).rows).toHaveLength(0);
      expect((await db.query('select id from point_ledger')).rows).toHaveLength(2);
    } finally { await db.close(); }
  }, 30000);
});
