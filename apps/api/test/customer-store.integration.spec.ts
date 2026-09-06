import { PGlite, type Transaction } from '@electric-sql/pglite';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import type { CustomerPrincipal } from '../src/customer-auth/customer-auth.types';
import { CustomerStoreService } from '../src/customer-store/customer-store.service';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e77358a101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e77358a102';
const staff = '018f2f45-7f5e-7e70-b17f-f6e77358a103';
const accountA = '018f2f45-7f5e-7e70-b17f-f6e77358a104';
const accountAOther = '018f2f45-7f5e-7e70-b17f-f6e77358a105';
const accountB = '018f2f45-7f5e-7e70-b17f-f6e77358a106';
const planActive = '018f2f45-7f5e-7e70-b17f-f6e77358a107';
const planDisabled = '018f2f45-7f5e-7e70-b17f-f6e77358a108';
const topupActive = '018f2f45-7f5e-7e70-b17f-f6e77358a109';
const topupDisabled = '018f2f45-7f5e-7e70-b17f-f6e77358a10a';
const ownCategory = '018f2f45-7f5e-7e70-b17f-f6e77358a10b';
const emptyCategory = '018f2f45-7f5e-7e70-b17f-f6e77358a10c';
const publicCategory = '018f2f45-7f5e-7e70-b17f-f6e77358a10d';
const hiddenPublicCategory = '018f2f45-7f5e-7e70-b17f-f6e77358a10e';
const otherCategory = '018f2f45-7f5e-7e70-b17f-f6e77358a10f';
const ownTag = '018f2f45-7f5e-7e70-b17f-f6e77358a110';
const emptyTag = '018f2f45-7f5e-7e70-b17f-f6e77358a111';
const publicTag = '018f2f45-7f5e-7e70-b17f-f6e77358a112';
const ownDrama = '018f2f45-7f5e-7e70-b17f-f6e77358a113';
const licensedDrama = '018f2f45-7f5e-7e70-b17f-f6e77358a114';
const unlicensedDrama = '018f2f45-7f5e-7e70-b17f-f6e77358a115';
const otherDrama = '018f2f45-7f5e-7e70-b17f-f6e77358a116';
const logo = '018f2f45-7f5e-7e70-b17f-f6e77358a117';
const icon = '018f2f45-7f5e-7e70-b17f-f6e77358a118';
const pointAccountA = '018f2f45-7f5e-7e70-b17f-f6e77358a119';
const pointAccountAOther = '018f2f45-7f5e-7e70-b17f-f6e77358a11a';
const pointAccountB = '018f2f45-7f5e-7e70-b17f-f6e77358a11b';

let database: PGlite;
let store: CustomerStoreService;

const principalA: CustomerPrincipal = {
  accountId: accountA,
  deviceId: uuidV7(),
  sessionId: uuidV7(),
  tenantId: tenantA,
  username: 'store_alice',
};

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

describe('customer store and wallet read models', () => {
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
    await seed();
    const databaseService = {
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        const tagged = transactionTag(transaction);
        await tagged`
          select
            set_config('app.access_scope', 'tenant', true),
            set_config('app.tenant_id', ${tenantId}, true)
        `;
        return callback(tagged);
      }),
    } as unknown as DatabaseService;
    store = new CustomerStoreService(databaseService);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('returns only safe bootstrap fields and uses a stable closed-site error', async () => {
    const result = await store.bootstrap(tenantA, {});
    expect(result).toMatchObject({
      capabilities: {
        appleSignIn: false,
        googleSignIn: false,
        inAppPurchases: false,
        nativePurchaseReceiptVerification: false,
      },
      defaultLocale: 'fr-FR',
      iconMediaAssetId: icon,
      logoMediaAssetId: logo,
      onlineOnly: true,
      siteName: 'Boutique A',
      supportedLocales: ['zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR',
        'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR'],
      theme: { accentColor: '#abcdef', colorMode: 'dark', primaryColor: '#123456' },
    });
    expect(JSON.stringify(result)).not.toMatch(/object_key|source_url|provider|secret/i);
    await expect(store.bootstrap(tenantA, { secret: 'probe' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await database.exec(`update tenants set user_site_enabled = false where id = '${tenantA}'`);
    const closed = await store.bootstrap(tenantA, {}).catch((error: unknown) => error);
    expect(closed).toBeInstanceOf(ForbiddenException);
    expect((closed as ForbiddenException).getResponse()).toMatchObject({
      code: 'CUSTOMER_SITE_UNAVAILABLE',
      statusCode: 403,
    });
    await database.exec(`update tenants set user_site_enabled = true where id = '${tenantA}'`);
  });

  it('publishes active catalog prices with deterministic locale and currency fallback', async () => {
    const usd = await store.commerceCatalog(tenantA, {
      currency: 'USD',
      locale: 'ja-JP',
    });
    expect(usd.membershipPlans).toEqual([expect.objectContaining({
      code: 'premium',
      locale: 'en-US',
      name: 'Premium',
      prices: [{ amountMinor: '9000000000000000', currency: 'USD' }],
    })]);
    expect(usd.pointsTopupPackages).toEqual([expect.objectContaining({
      bonusPoints: '50',
      code: 'coins-500',
      locale: 'fr-FR',
      pointsAmount: '500',
      prices: [{ amountMinor: '799', currency: 'USD' }],
    })]);
    const all = await store.commerceCatalog(tenantA, {});
    expect(all.membershipPlans[0]?.prices).toEqual([
      { amountMinor: '1200', currency: 'JPY' },
      { amountMinor: '9000000000000000', currency: 'USD' },
    ]);
    expect(JSON.stringify(all)).not.toContain('disabled-plan');
    expect(JSON.stringify(all)).not.toContain('disabled-topup');
    await expect(store.commerceCatalog(tenantA, { currency: 'usd' })).rejects
      .toBeInstanceOf(BadRequestException);
    await expect(store.commerceCatalog(tenantA, { amount: '1' } as never)).rejects
      .toBeInstanceOf(BadRequestException);
  });

  it('only returns active navigation values used by currently visible published content', async () => {
    const categories = await store.categories(tenantA, { locale: 'ja-JP' });
    expect(categories.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ownCategory, locale: 'fr-FR', name: 'Action FR' }),
      expect.objectContaining({ id: publicCategory, locale: 'en-US', name: 'Public' }),
    ]));
    expect(categories.items.map((item) => item.id)).not.toEqual(expect.arrayContaining([
      emptyCategory,
      hiddenPublicCategory,
      otherCategory,
    ]));
    const tags = await store.tags(tenantA, { locale: 'ja-JP' });
    expect(tags.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: ownTag, locale: 'fr-FR' }),
      expect.objectContaining({ id: publicTag, locale: 'en-US' }),
    ]));
    expect(tags.items.map((item) => item.id)).not.toContain(emptyTag);
  });

  it('masks contacts and isolates wallet, ledger cursors, and entitlement summaries by account', async () => {
    expect(await store.accountMe(principalA, {})).toEqual({
      accountId: accountA,
      email: { masked: 'a***@example.com', verified: true },
      phone: { masked: '+***5678', verified: true },
      username: 'store_alice',
    });
    expect(await store.pointWallet(principalA, {})).toMatchObject({
      balancePoints: '8999999999999995',
    });
    const first = await store.pointLedger(principalA, { pageSize: '1' });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]).toMatchObject({
      balanceAfterPoints: '8999999999999995',
      deltaPoints: '-5',
    });
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await store.pointLedger(principalA, {
      cursor: first.nextCursor,
      pageSize: 1,
    });
    expect(second.items).toEqual([
      expect.objectContaining({
        balanceAfterPoints: '9000000000000000',
        deltaPoints: '9000000000000000',
      }),
    ]);
    expect(JSON.stringify(first)).not.toContain('other-account');
    await expect(store.pointLedger({
      ...principalA,
      accountId: accountAOther,
      username: 'store_other',
    }, {
      cursor: first.nextCursor,
      pageSize: 1,
    })).rejects.toThrow(/cursor is invalid/);

    const active = await store.entitlements(principalA, {
      locale: 'ja-JP',
      status: 'active',
    });
    expect(active.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: 'premium',
        locale: 'en-US',
        productId: planActive,
        status: 'active',
        title: 'Premium',
        type: 'membership',
      }),
      expect.objectContaining({ productId: licensedDrama, type: 'drama' }),
    ]));
    expect(active.items).toHaveLength(2);
    const expired = await store.entitlements(principalA, { status: 'expired' });
    expect(expired.items).toEqual([
      expect.objectContaining({ productId: ownDrama, status: 'expired', type: 'drama' }),
    ]);
    expect(JSON.stringify(active)).not.toContain('other-account');
    expect(JSON.stringify(active)).not.toContain('must-not-return');
    const entitlementPage = await store.entitlements(principalA, {
      pageSize: 1,
      status: 'active',
    });
    expect(entitlementPage.nextCursor).toEqual(expect.any(String));
    await database.exec(`update tenants set default_locale = 'en-US' where id = '${tenantA}'`);
    await expect(store.entitlements(principalA, {
      cursor: entitlementPage.nextCursor,
      pageSize: 1,
      status: 'active',
    })).rejects.toThrow(/cursor does not match/);
    await database.exec(`update tenants set default_locale = 'fr-FR' where id = '${tenantA}'`);
    await expect(store.pointLedger(principalA, { pageSize: '101' })).rejects
      .toBeInstanceOf(BadRequestException);
    await expect(store.entitlements(principalA, { status: 'all' })).rejects
      .toBeInstanceOf(BadRequestException);
  });

  it('fails closed while the site is off and enforces tenant RLS for a non-owner role', async () => {
    await database.exec(`update tenants set platform_site_enabled = false where id = '${tenantA}'`);
    await expect(store.pointWallet(principalA, {})).rejects.toBeInstanceOf(ForbiddenException);
    await expect(store.commerceCatalog(tenantA, {})).rejects.toBeInstanceOf(ForbiddenException);
    await database.exec(`update tenants set platform_site_enabled = true where id = '${tenantA}'`);

    await database.exec(`
      create role customer_store_probe nologin;
      grant usage on schema public, app to customer_store_probe;
      grant select on tenants, customer_accounts, point_accounts, point_ledger,
        entitlements, membership_plans, membership_plan_translations,
        categories, tags, dramas to customer_store_probe;
      set role customer_store_probe;
      begin;
      set local app.access_scope = 'tenant';
      set local app.tenant_id = '${tenantA}';
    `);
    const customers = await database.query<{ tenant_id: string }>(
      'select tenant_id::text from customer_accounts order by id',
    );
    expect(new Set(customers.rows.map((row) => row.tenant_id))).toEqual(new Set([tenantA]));
    const points = await database.query<{ tenant_id: string }>(
      'select tenant_id::text from point_accounts order by id',
    );
    expect(new Set(points.rows.map((row) => row.tenant_id))).toEqual(new Set([tenantA]));
    const rights = await database.query<{ tenant_id: string }>(
      'select tenant_id::text from entitlements order by id',
    );
    expect(new Set(rights.rows.map((row) => row.tenant_id))).toEqual(new Set([tenantA]));
    await database.exec('rollback; reset role');
  });
});

async function seed(): Promise<void> {
  await database.exec(`
    insert into tenants (
      id, code, name, site_name, default_locale, timezone, expires_at, theme_json
    ) values
      ('${tenantA}', 'store-a', 'Store A', 'Boutique A', 'fr-FR', 'Europe/Paris',
        statement_timestamp() + interval '1 year',
        '{"primaryColor":"#123456","accentColor":"#ABCDEF","colorMode":"dark"}'),
      ('${tenantB}', 'store-b', 'Store B', null, 'en-US', 'UTC',
        statement_timestamp() + interval '1 year', '{}');
    insert into platform_staff (id, username, password_hash)
    values ('${staff}', 'store_operator', '${'p'.repeat(64)}');
    insert into media_assets (
      id, owner_type, owner_tenant_id, kind, source_url, checksum,
      status, transcode_status, metadata_json
    ) values
      ('${logo}', 'tenant', '${tenantA}', 'image',
        'https://assets.example.test/logo.png', '${'a'.repeat(64)}',
        'ready', 'not_required', '{"immutable":true}'),
      ('${icon}', 'tenant', '${tenantA}', 'image',
        'https://assets.example.test/icon.png', '${'b'.repeat(64)}',
        'ready', 'not_required', '{"immutable":true}');
    update tenants set logo_media_asset_id = '${logo}', icon_media_asset_id = '${icon}'
    where id = '${tenantA}';

    insert into membership_plans (id, tenant_id, code, duration_days, status) values
      ('${planActive}', '${tenantA}', 'premium', 30, 'active'),
      ('${planDisabled}', '${tenantA}', 'disabled-plan', 7, 'disabled');
    insert into membership_plan_translations (
      id, tenant_id, plan_id, locale, name, description
    ) values
      ('${uuidV7()}', '${tenantA}', '${planActive}', 'en-US', 'Premium', 'Premium access'),
      ('${uuidV7()}', '${tenantA}', '${planDisabled}', 'en-US', 'Disabled', 'Hidden');
    insert into membership_plan_prices (
      tenant_id, plan_id, currency, amount_minor, status
    ) values
      ('${tenantA}', '${planActive}', 'USD', 9000000000000000, 'active'),
      ('${tenantA}', '${planActive}', 'JPY', 1200, 'active'),
      ('${tenantA}', '${planActive}', 'EUR', 800, 'disabled'),
      ('${tenantA}', '${planDisabled}', 'USD', 100, 'active');
    insert into points_topup_packages (
      id, tenant_id, code, points_amount, bonus_points, status
    ) values
      ('${topupActive}', '${tenantA}', 'coins-500', 500, 50, 'active'),
      ('${topupDisabled}', '${tenantA}', 'disabled-topup', 100, 0, 'disabled');
    insert into points_topup_package_translations (
      id, tenant_id, package_id, locale, name, description
    ) values
      ('${uuidV7()}', '${tenantA}', '${topupActive}', 'fr-FR', '500 pièces', 'Recharge'),
      ('${uuidV7()}', '${tenantA}', '${topupDisabled}', 'en-US', 'Hidden', 'Hidden');
    insert into points_topup_package_prices (
      tenant_id, package_id, currency, amount_minor, status
    ) values
      ('${tenantA}', '${topupActive}', 'USD', 799, 'active'),
      ('${tenantA}', '${topupDisabled}', 'USD', 99, 'active');

    insert into categories (id, owner_type, owner_tenant_id, code, sort_order) values
      ('${ownCategory}', 'tenant', '${tenantA}', 'action', 1),
      ('${emptyCategory}', 'tenant', '${tenantA}', 'empty', 2),
      ('${publicCategory}', 'platform', null, 'public', 3),
      ('${hiddenPublicCategory}', 'platform', null, 'unlicensed', 4),
      ('${otherCategory}', 'tenant', '${tenantB}', 'other', 5);
    insert into category_translations (id, category_id, locale, name) values
      ('${uuidV7()}', '${ownCategory}', 'fr-FR', 'Action FR'),
      ('${uuidV7()}', '${emptyCategory}', 'en-US', 'Empty'),
      ('${uuidV7()}', '${publicCategory}', 'en-US', 'Public'),
      ('${uuidV7()}', '${hiddenPublicCategory}', 'en-US', 'Unlicensed'),
      ('${uuidV7()}', '${otherCategory}', 'en-US', 'Other');
    insert into tags (id, owner_type, owner_tenant_id, code) values
      ('${ownTag}', 'tenant', '${tenantA}', 'featured'),
      ('${emptyTag}', 'tenant', '${tenantA}', 'empty-tag'),
      ('${publicTag}', 'platform', null, 'public-tag');
    insert into tag_translations (id, tag_id, locale, name) values
      ('${uuidV7()}', '${ownTag}', 'fr-FR', 'En vedette'),
      ('${uuidV7()}', '${emptyTag}', 'en-US', 'Empty tag'),
      ('${uuidV7()}', '${publicTag}', 'en-US', 'Public tag');
    insert into dramas (
      id, owner_type, owner_tenant_id, code, category_id, status, release_at
    ) values
      ('${ownDrama}', 'tenant', '${tenantA}', 'own-show', '${ownCategory}', 'published',
        statement_timestamp() - interval '1 day'),
      ('${licensedDrama}', 'platform', null, 'licensed-show', '${publicCategory}', 'published',
        statement_timestamp() - interval '1 day'),
      ('${unlicensedDrama}', 'platform', null, 'unlicensed-show', '${hiddenPublicCategory}',
        'published', statement_timestamp() - interval '1 day'),
      ('${otherDrama}', 'tenant', '${tenantB}', 'other-show', '${otherCategory}', 'published',
        statement_timestamp() - interval '1 day');
    insert into drama_translations (id, drama_id, locale, title, summary) values
      ('${uuidV7()}', '${ownDrama}', 'fr-FR', 'Série locale', 'Locale'),
      ('${uuidV7()}', '${licensedDrama}', 'en-US', 'Licensed show', 'Public'),
      ('${uuidV7()}', '${unlicensedDrama}', 'en-US', 'Hidden show', 'Hidden'),
      ('${uuidV7()}', '${otherDrama}', 'en-US', 'Other show', 'Other');
    insert into drama_tags (drama_id, tag_id) values
      ('${ownDrama}', '${ownTag}'),
      ('${licensedDrama}', '${publicTag}');
  `);
  const license = uuidV7();
  await database.exec(`
    insert into content_licenses (
      id, tenant_id, license_type, drama_id, starts_at, expires_at, status, granted_by
    ) values (
      '${license}', '${tenantA}', 'drama', '${licensedDrama}',
      statement_timestamp() - interval '1 day', statement_timestamp() + interval '30 days',
      'active', '${staff}'
    );
    insert into content_license_items (id, tenant_id, license_id, drama_id)
    values ('${uuidV7()}', '${tenantA}', '${license}', '${licensedDrama}');

    insert into customer_accounts (
      id, tenant_id, username, email, phone, password_hash,
      email_verified_at, phone_verified_at
    ) values
      ('${accountA}', '${tenantA}', 'store_alice', 'alice@example.com', '+819012345678',
        '${'x'.repeat(64)}', statement_timestamp(), statement_timestamp()),
      ('${accountAOther}', '${tenantA}', 'store_other', 'other-a@example.com', null,
        '${'y'.repeat(64)}', statement_timestamp(), null),
      ('${accountB}', '${tenantB}', 'store_bob', 'bob@example.com', null,
        '${'z'.repeat(64)}', statement_timestamp(), null);
    insert into point_accounts (id, tenant_id, account_id) values
      ('${pointAccountA}', '${tenantA}', '${accountA}'),
      ('${pointAccountAOther}', '${tenantA}', '${accountAOther}'),
      ('${pointAccountB}', '${tenantB}', '${accountB}');
    insert into point_ledger (
      id, tenant_id, account_id, point_account_id, entry_type, delta,
      balance_after, reference_type, reference_id, idempotency_key,
      created_at, created_by_type, created_by
    ) values
      ('${uuidV7()}', '${tenantA}', '${accountA}', '${pointAccountA}', 'adjustment',
        9000000000000000, 0, 'manual_test', '${uuidV7()}', 'store-ledger-a-first',
        statement_timestamp() - interval '2 minutes', 'platform_staff', '${staff}'),
      ('${uuidV7()}', '${tenantA}', '${accountA}', '${pointAccountA}', 'purchase',
        -5, 0, 'manual_test', '${uuidV7()}', 'store-ledger-a-second',
        statement_timestamp() - interval '1 minute', 'platform_staff', '${staff}'),
      ('${uuidV7()}', '${tenantA}', '${accountAOther}', '${pointAccountAOther}', 'adjustment',
        77, 0, 'manual_test', '${uuidV7()}', 'other-account-ledger',
        statement_timestamp(), 'platform_staff', '${staff}'),
      ('${uuidV7()}', '${tenantB}', '${accountB}', '${pointAccountB}', 'adjustment',
        88, 0, 'manual_test', '${uuidV7()}', 'store-ledger-b-first',
        statement_timestamp(), 'platform_staff', '${staff}');
  `);
  await seedEntitlement(accountA, 'membership', planActive, 'active', 'a');
  await seedEntitlement(accountA, 'drama', ownDrama, 'expired', 'b');
  await seedEntitlement(accountA, 'drama', licensedDrama, 'active', 'e');
  await seedEntitlement(accountAOther, 'membership', planActive, 'active', 'c');
  await seedEntitlement(accountB, 'drama', otherDrama, 'active', 'd', tenantB);
}

async function seedEntitlement(
  accountId: string,
  type: 'drama' | 'membership',
  productId: string,
  state: 'active' | 'expired',
  suffix: string,
  tenantId = tenantA,
): Promise<void> {
  const orderId = uuidV7();
  const itemId = uuidV7();
  const entitlementId = uuidV7();
  const orderNo = `ORD${orderId.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
  await database.exec(`
    set session_replication_role = replica;
    insert into orders (
      id, tenant_id, account_id, order_no, order_type, status, currency,
      subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at, paid_at
    ) values (
      '${orderId}', '${tenantId}', '${accountId}', '${orderNo}', '${type}', 'paid', 'USD',
      100, 100, 'en-US', '{"private":"must-not-return"}',
      statement_timestamp() + interval '1 day', statement_timestamp()
    );
    insert into order_items (
      id, tenant_id, order_id, line_no, item_type, product_id, currency,
      unit_amount_minor, total_amount_minor, product_snapshot_json
    ) values (
      '${itemId}', '${tenantId}', '${orderId}', 1, '${type}', '${productId}', 'USD',
      100, 100, '{"label":"${suffix}"}'
    );
    insert into entitlements (
      id, tenant_id, account_id, entitlement_type, product_id,
      source_type, source_order_id, source_order_item_id, starts_at, expires_at
    ) values (
      '${entitlementId}', '${tenantId}', '${accountId}', '${type}', '${productId}',
      'order', '${orderId}', '${itemId}',
      statement_timestamp() - interval '10 days',
      statement_timestamp() ${state === 'active' ? "+ interval '10 days'" : "- interval '1 day'"}
    );
    set session_replication_role = origin;
  `);
}
