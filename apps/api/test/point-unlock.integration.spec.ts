import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import { CommerceCatalogService } from '../src/commerce/commerce-catalog.service';
import { PointUnlockService } from '../src/commerce/point-unlock.service';
import type { CustomerPrincipal } from '../src/customer-auth/customer-auth.types';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773578101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773578102';
const staffA = '018f2f45-7f5e-7e70-b17f-f6e773578103';
const platformStaff = '018f2f45-7f5e-7e70-b17f-f6e773578104';
const customerA = '018f2f45-7f5e-7e70-b17f-f6e773578105';
const customerA2 = '018f2f45-7f5e-7e70-b17f-f6e773578106';
const customerB = '018f2f45-7f5e-7e70-b17f-f6e773578107';
const ownDrama = '018f2f45-7f5e-7e70-b17f-f6e773578108';
const ownEpisode = '018f2f45-7f5e-7e70-b17f-f6e773578109';
const secondDrama = '018f2f45-7f5e-7e70-b17f-f6e77357810a';
const platformDrama = '018f2f45-7f5e-7e70-b17f-f6e77357810b';
const platformLicense = '018f2f45-7f5e-7e70-b17f-f6e77357810c';

let database: PGlite;
let catalog: CommerceCatalogService;
let unlocks: PointUnlockService;

const principalA: CustomerPrincipal = {
  accountId: customerA,
  deviceId: uuidV7(),
  sessionId: uuidV7(),
  tenantId: tenantA,
  username: 'point_customer_a',
};
const principalA2: CustomerPrincipal = {
  accountId: customerA2,
  deviceId: uuidV7(),
  sessionId: uuidV7(),
  tenantId: tenantA,
  username: 'point_customer_a2',
};
const principalB: CustomerPrincipal = {
  accountId: customerB,
  deviceId: uuidV7(),
  sessionId: uuidV7(),
  tenantId: tenantB,
  username: 'point_customer_b',
};

describe('point content catalog and unlock transaction', () => {
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
    const ownVideo = uuidV7();
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantA}', 'point-a', 'Point A', transaction_timestamp() + interval '1 year'),
        ('${tenantB}', 'point-b', 'Point B', transaction_timestamp() + interval '1 year');
      insert into tenant_staff (id, tenant_id, username, password_hash)
      values ('${staffA}', '${tenantA}', 'point-owner', '${'s'.repeat(64)}');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaff}', 'point-platform', '${'p'.repeat(64)}');
      insert into customer_accounts (id, tenant_id, username, password_hash) values
        ('${customerA}', '${tenantA}', 'point_customer_a', '${'a'.repeat(64)}'),
        ('${customerA2}', '${tenantA}', 'point_customer_a2', '${'b'.repeat(64)}'),
        ('${customerB}', '${tenantB}', 'point_customer_b', '${'c'.repeat(64)}');
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, source_url, checksum,
        status, transcode_status, duration_seconds, metadata_json
      ) values (
        '${ownVideo}', 'tenant', '${tenantA}', 'video',
        'https://media.example.com/point-episode.mp4', '${'d'.repeat(64)}',
        'ready', 'ready', 120, '{"immutable":true}'::jsonb
      );
      insert into dramas (id, owner_type, owner_tenant_id, code, status) values
        ('${ownDrama}', 'tenant', '${tenantA}', 'point-own', 'published'),
        ('${secondDrama}', 'tenant', '${tenantA}', 'point-second', 'published'),
        ('${platformDrama}', 'platform', null, 'point-public', 'published');
      insert into episodes (
        id, drama_id, episode_no, status, duration_seconds, media_asset_id
      ) values (
        '${ownEpisode}', '${ownDrama}', 1, 'published', 120, '${ownVideo}'
      );
      insert into content_licenses (
        id, tenant_id, license_type, drama_id, starts_at, expires_at,
        status, granted_by
      ) values (
        '${platformLicense}', '${tenantA}', 'drama', '${platformDrama}',
        transaction_timestamp() - interval '1 day',
        transaction_timestamp() + interval '30 days', 'active', '${platformStaff}'
      );
      insert into content_license_items (id, tenant_id, license_id, drama_id)
      values ('${uuidV7()}', '${tenantA}', '${platformLicense}', '${platformDrama}');
    `);
    for (const [accountId, points] of [
      [customerA, 1_000],
      [customerA2, 600],
      [customerB, 1_000],
    ] as const) {
      const pointAccountId = uuidV7();
      await database.exec(`
        insert into point_accounts (id, tenant_id, account_id)
        values (
          '${pointAccountId}', '${accountId === customerB ? tenantB : tenantA}', '${accountId}'
        );
        insert into point_ledger (
          id, tenant_id, account_id, point_account_id, entry_type, delta,
          balance_after, reference_type, reference_id, idempotency_key,
          created_by_type, created_by
        ) values (
          '${uuidV7()}', '${accountId === customerB ? tenantB : tenantA}', '${accountId}',
          '${pointAccountId}', 'adjustment', ${points}, 0, 'manual_adjustment',
          '${uuidV7()}', 'point-seed-${accountId}', 'platform_staff', '${platformStaff}'
        )
      `);
    }

    const service = databaseService(database);
    catalog = new CommerceCatalogService(service);
    unlocks = new PointUnlockService(service);
    await catalog.upsertContentPointPrice(
      tenantA,
      { pointsAmount: 300, targetId: ownDrama, targetType: 'drama', version: 0 },
      staffMetadata(),
    );
    await catalog.upsertContentPointPrice(
      tenantA,
      { pointsAmount: 100, targetId: ownEpisode, targetType: 'episode', version: 0 },
      staffMetadata(),
    );
    await catalog.upsertContentPointPrice(
      tenantA,
      { pointsAmount: 800, targetId: secondDrama, targetType: 'drama', version: 0 },
      staffMetadata(),
    );
    await catalog.upsertContentPointPrice(
      tenantA,
      { pointsAmount: 400, targetId: platformDrama, targetType: 'drama', version: 0 },
      staffMetadata(),
    );
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('configures versioned point prices only for sellable content', async () => {
    const listed = await catalog.listTenantCatalog(tenantA);
    expect(listed.contentPointPrices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        pointsAmount: 300,
        targetId: ownDrama,
        targetType: 'drama',
        version: 0,
      }),
    ]));
    await expect(catalog.upsertContentPointPrice(
      tenantA,
      { pointsAmount: 301, targetId: ownDrama, targetType: 'drama', version: 9 },
      staffMetadata(),
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(catalog.upsertContentPointPrice(
      tenantB,
      { pointsAmount: 1, targetId: ownDrama, targetType: 'drama', version: 0 },
      staffMetadata(),
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it('serializes double clicks, replays one command, and never double-charges another key', async () => {
    const [first, replay] = await Promise.all([
      unlocks.unlock(
        principalA, 'drama', ownDrama, {}, 'point-unlock-same-key-0001', uuidV7(),
      ),
      unlocks.unlock(
        principalA, 'drama', ownDrama, {}, 'point-unlock-same-key-0001', uuidV7(),
      ),
    ]);
    expect(replay).toEqual(first);
    expect(first).toMatchObject({
      alreadyOwned: false,
      balanceAfter: 700,
      pointsSpent: 300,
      targetId: ownDrama,
    });
    const secondKey = await unlocks.unlock(
      principalA, 'drama', ownDrama, {}, 'point-unlock-other-key-0001', uuidV7(),
    );
    expect(secondKey).toMatchObject({
      alreadyOwned: true,
      pointsSpent: 0,
      unlockId: first.unlockId,
    });
    expect(await pointBalance(customerA)).toBe('700');
    const counts = await database.query<{ entitlements: string; ledger: string; unlocks: string }>(`
      select
        (select count(*)::text from point_unlocks where account_id = '${customerA}') as unlocks,
        (select count(*)::text from point_ledger
          where account_id = '${customerA}' and reference_type = 'point_unlock') as ledger,
        (select count(*)::text from entitlements
          where account_id = '${customerA}' and source_type = 'point_unlock') as entitlements
    `);
    expect(counts.rows[0]).toEqual({ entitlements: '1', ledger: '1', unlocks: '1' });
    await expect(unlocks.unlock(
      principalA,
      'episode',
      ownEpisode,
      {},
      'point-unlock-same-key-0001',
      uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(() => unlocks.unlock(
      principalA,
      'episode',
      ownEpisode,
      { pointsAmount: 1 },
      'point-client-amount-0001',
      uuidV7(),
    )).toThrow(BadRequestException);
  });

  it('lets a drama entitlement cover episodes and preserves the original price snapshot', async () => {
    await expect(unlocks.unlock(
      principalA, 'episode', ownEpisode, {}, 'point-drama-covers-episode-0001', uuidV7(),
    )).resolves.toMatchObject({ alreadyOwned: true, pointsSpent: 0, unlockId: expect.any(String) });
    expect(await pointBalance(customerA)).toBe('700');

    const episodeUnlock = await unlocks.unlock(
      principalA2, 'episode', ownEpisode, {}, 'point-episode-price-snapshot-0001', uuidV7(),
    );
    expect(episodeUnlock).toMatchObject({ balanceAfter: 500, pointsSpent: 100 });
    await catalog.upsertContentPointPrice(
      tenantA,
      { pointsAmount: 150, targetId: ownEpisode, targetType: 'episode', version: 0 },
      staffMetadata(),
    );
    const snapshots = await database.query<{ points_amount_snapshot: string }>(`
      select points_amount_snapshot::text from point_unlocks where id = '${episodeUnlock.unlockId}'
    `);
    expect(snapshots.rows[0]?.points_amount_snapshot).toBe('100');
  });

  it('rolls back insufficient balances and skips charging an effective member', async () => {
    const before = await pointBalance(customerA);
    await expect(unlocks.unlock(
      principalA, 'drama', secondDrama, {}, 'point-insufficient-0001', uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
    expect(await pointBalance(customerA)).toBe(before);
    const absent = await database.query<{ count: string }>(`
      select count(*)::text as count from point_unlocks
      where tenant_id = '${tenantA}' and account_id = '${customerA}'
        and target_type = 'drama' and target_id = '${secondDrama}'
    `);
    expect(absent.rows[0]?.count).toBe('0');

    await seedMembershipEntitlement(customerA2);
    const memberBalance = await pointBalance(customerA2);
    await expect(unlocks.unlock(
      principalA2, 'drama', secondDrama, {}, 'point-member-owned-0001', uuidV7(),
    )).resolves.toMatchObject({ alreadyOwned: true, pointsSpent: 0, unlockId: null });
    expect(await pointBalance(customerA2)).toBe(memberBalance);
  });

  it('rejects partial or expiring point-unlock fulfillment and rolls its ledger back', async () => {
    const updatedPrice = await catalog.upsertContentPointPrice(
      tenantA,
      { pointsAmount: 200, targetId: secondDrama, targetType: 'drama', version: 0 },
      staffMetadata(),
    );
    const account = await database.query<{ id: string }>(`
      select id from point_accounts where tenant_id = '${tenantA}' and account_id = '${customerA2}'
    `);
    const before = await pointBalance(customerA2);
    const unlockId = uuidV7();
    const pointAccountId = account.rows[0]?.id;
    if (!pointAccountId) throw new Error('Point account fixture is unavailable');
    await expect(database.transaction(async (transaction) => {
      const sql = transactionTag(transaction);
      await sql`
        insert into point_unlocks (
          id, tenant_id, account_id, point_account_id, target_type, target_id,
          drama_id, price_id, price_version_snapshot, points_amount_snapshot
        ) values (
          ${unlockId}, ${tenantA}, ${customerA2}, ${pointAccountId}, 'drama',
          ${secondDrama}, ${secondDrama}, ${updatedPrice.id}, ${updatedPrice.version}, 200
        )
      `;
      await sql`
        insert into point_ledger (
          id, tenant_id, account_id, point_account_id, entry_type, delta,
          balance_after, reference_type, reference_id, idempotency_key,
          created_by_type, created_by
        ) values (
          ${uuidV7()}, ${tenantA}, ${customerA2}, ${pointAccountId}, 'purchase',
          -200, 0, 'point_unlock', ${unlockId}, 'point-tampered-source-0001',
          'user', ${customerA2}
        )
      `;
      await sql`
        insert into entitlements (
          id, tenant_id, account_id, entitlement_type, product_id,
          source_type, source_point_unlock_id, starts_at, expires_at
        ) values (
          ${uuidV7()}, ${tenantA}, ${customerA2}, 'drama', ${secondDrama},
          'point_unlock', ${unlockId}, transaction_timestamp(),
          transaction_timestamp() + interval '1 day'
        )
      `;
    })).rejects.toThrow(/matching point unlock/i);
    expect(await pointBalance(customerA2)).toBe(before);
    const absent = await database.query<{ count: string }>(`
      select count(*)::text as count from point_unlocks where id = '${unlockId}'
    `);
    expect(absent.rows[0]?.count).toBe('0');
  });

  it('revalidates public licenses and rejects cross-tenant targets without side effects', async () => {
    await database.exec(`
      update content_licenses
      set status = 'revoked', revoked_at = transaction_timestamp(),
        revoked_by = '${platformStaff}', revoke_reason = 'point unlock authorization test'
      where id = '${platformLicense}'
    `);
    const before = await pointBalance(customerA2);
    await expect(unlocks.unlock(
      principalA2, 'drama', platformDrama, {}, 'point-revoked-license-0001', uuidV7(),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(await pointBalance(customerA2)).toBe(before);
    await expect(unlocks.unlock(
      principalB, 'drama', ownDrama, {}, 'point-cross-tenant-0001', uuidV7(),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(await pointBalance(customerB)).toBe('1000');
  });

  it('keeps unlock, point facts, and entitlements read-only for tenant DB roles', async () => {
    const unlock = await database.query<{
      id: string;
      point_account_id: string;
      price_id: string;
    }>(`
      select id, point_account_id, price_id from point_unlocks
      where tenant_id = '${tenantA}' order by created_at limit 1
    `);
    const row = unlock.rows[0];
    expect(row).toBeDefined();
    const policies = await database.query<{ cmd: string; tablename: string }>(`
      select tablename, cmd from pg_policies
      where policyname in (
        'point_unlocks_tenant_access',
        'point_accounts_tenant_access',
        'point_ledger_tenant_access',
        'entitlements_tenant_access'
      )
      order by tablename
    `);
    expect(policies.rows).toEqual([
      { cmd: 'SELECT', tablename: 'entitlements' },
      { cmd: 'SELECT', tablename: 'point_accounts' },
      { cmd: 'SELECT', tablename: 'point_ledger' },
      { cmd: 'SELECT', tablename: 'point_unlocks' },
    ]);
    await database.exec(`
      create role point_unlock_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to point_unlock_tenant_probe;
      grant select, insert, update, delete on
        point_unlocks, point_accounts, point_ledger, entitlements
      to point_unlock_tenant_probe;
      set role point_unlock_tenant_probe;
      begin;
      set local app.access_scope = 'tenant';
      set local app.tenant_id = '${tenantA}'
    `);
    const visible = await database.query<{ tenant_id: string }>(`
      select distinct tenant_id from point_unlocks
    `);
    expect(visible.rows).toEqual([{ tenant_id: tenantA }]);
    await expectRoleWriteDenied(`
      insert into point_unlocks (
        id, tenant_id, account_id, point_account_id, target_type, target_id,
        drama_id, price_id, price_version_snapshot, points_amount_snapshot
      ) values (
        '${uuidV7()}', '${tenantA}', '${customerA}', '${row?.point_account_id}',
        'drama', '${ownDrama}', '${ownDrama}', '${row?.price_id}', 0, 300
      )
    `);
    await expectRoleWriteDenied(`
      insert into point_ledger (
        id, tenant_id, account_id, point_account_id, entry_type, delta,
        balance_after, reference_type, reference_id, idempotency_key,
        created_by_type, created_by
      ) values (
        '${uuidV7()}', '${tenantA}', '${customerA}', '${row?.point_account_id}',
        'purchase', -1, 0, 'point_unlock', '${row?.id}',
        'point-role-forged-ledger-0001', 'user', '${customerA}'
      )
    `);
    await expectRoleUpdateHidden(`
      update entitlements set revoked_at = transaction_timestamp(),
        revoked_reason = 'tenant forged revoke'
      where tenant_id = '${tenantA}'
    `);
    await database.exec('rollback; reset role');
  });
});

function databaseService(target: PGlite): DatabaseService {
  return {
    inPlatformContext: <T>(
      callback: (transaction: DatabaseTransaction) => Promise<T>,
    ): Promise<T> => target.transaction((transaction) => callback(transactionTag(transaction))),
    inTenantContext: <T>(
      tenantId: string,
      callback: (transaction: DatabaseTransaction) => Promise<T>,
    ): Promise<T> => target.transaction(async (transaction) => {
      await transaction.query(
        "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
        [tenantId],
      );
      return callback(transactionTag(transaction));
    }),
  } as unknown as DatabaseService;
}

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

function staffMetadata() {
  return { actorId: staffA, requestId: uuidV7() };
}

async function pointBalance(accountId: string): Promise<string> {
  const rows = await database.query<{ balance: string }>(`
    select balance::text from point_accounts where account_id = '${accountId}'
  `);
  return rows.rows[0]?.balance as string;
}

async function seedMembershipEntitlement(accountId: string): Promise<void> {
  const planId = uuidV7();
  const orderId = uuidV7();
  const itemId = uuidV7();
  const providerId = uuidV7();
  const configId = uuidV7();
  const attemptId = uuidV7();
  const transactionId = uuidV7();
  const entitlementId = uuidV7();
  const orderNo = `ORD${orderId.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
  await database.exec(`
    insert into membership_plans (id, tenant_id, code, duration_days)
    values ('${planId}', '${tenantA}', 'point-member-${planId.slice(-8)}', 30);
    insert into orders (
      id, tenant_id, account_id, order_no, order_type, currency,
      subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
    ) values (
      '${orderId}', '${tenantA}', '${accountId}', '${orderNo}', 'membership', 'USD',
      100, 100, 'en-US', '{}'::jsonb, transaction_timestamp() + interval '1 day'
    );
    insert into order_items (
      id, tenant_id, order_id, line_no, item_type, product_id, currency,
      unit_amount_minor, total_amount_minor, product_snapshot_json
    ) values (
      '${itemId}', '${tenantA}', '${orderId}', 1, 'membership', '${planId}',
      'USD', 100, 100, '{"durationDays":30}'::jsonb
    );
    insert into payment_providers (id, code, adapter_code)
    values ('${providerId}', 'point-member-${providerId.slice(-8)}', 'fake');
    insert into payment_configs (id, owner_type, provider_id, label)
    values ('${configId}', 'platform', '${providerId}', 'Point membership fixture');
    insert into payment_attempts (
      id, tenant_id, account_id, order_id, provider_id, payment_config_id,
      adapter_code_snapshot, collection_mode, status, currency, amount_minor,
      idempotency_key
    ) values (
      '${attemptId}', '${tenantA}', '${accountId}', '${orderId}', '${providerId}',
      '${configId}', 'fake', 'tenant_direct', 'pending', 'USD', 100,
      'point-member-attempt-${attemptId}'
    );
    insert into payment_transactions (
      id, tenant_id, attempt_id, order_id, provider_id, transaction_type,
      status, external_transaction_id, currency, amount_minor, payload_hash,
      occurred_at
    ) values (
      '${transactionId}', '${tenantA}', '${attemptId}', '${orderId}', '${providerId}',
      'charge', 'succeeded', 'point-member-charge-${transactionId}', 'USD', 100,
      '${'e'.repeat(64)}', transaction_timestamp()
    );
    update payment_attempts set status = 'succeeded',
      succeeded_at = transaction_timestamp(), version = version + 1
    where id = '${attemptId}';
    update orders set status = 'paid', paid_at = transaction_timestamp(), version = version + 1
    where id = '${orderId}';
    insert into entitlements (
      id, tenant_id, account_id, entitlement_type, product_id,
      source_type, source_order_id, source_order_item_id, starts_at, expires_at
    ) values (
      '${entitlementId}', '${tenantA}', '${accountId}', 'membership', '${planId}',
      'order', '${orderId}', '${itemId}', transaction_timestamp(),
      transaction_timestamp() + interval '30 days'
    )
  `);
}

async function expectRoleWriteDenied(sql: string): Promise<void> {
  await database.exec('savepoint point_unlock_write_probe');
  await expect(database.exec(sql)).rejects.toThrow();
  await database.exec('rollback to savepoint point_unlock_write_probe');
}

async function expectRoleUpdateHidden(sql: string): Promise<void> {
  await database.exec('savepoint point_unlock_update_probe');
  const result = await database.exec(sql);
  expect(result[0]?.affectedRows).toBe(0);
  await database.exec('rollback to savepoint point_unlock_update_probe');
}
