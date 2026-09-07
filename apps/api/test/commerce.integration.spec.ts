import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import { CommerceCatalogService } from '../src/commerce/commerce-catalog.service';
import { CommerceOrderService } from '../src/commerce/commerce-order.service';
import type { CommerceOrderInput } from '../src/commerce/commerce.types';
import type { CustomerPrincipal } from '../src/customer-auth/customer-auth.types';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';

let database: PGlite;
let catalog: CommerceCatalogService;
let orders: CommerceOrderService;

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773574101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773574102';
const tenantStaffA = '018f2f45-7f5e-7e70-b17f-f6e773574103';
const platformStaff = '018f2f45-7f5e-7e70-b17f-f6e773574104';
const customerA = '018f2f45-7f5e-7e70-b17f-f6e773574105';
const customerB = '018f2f45-7f5e-7e70-b17f-f6e773574106';
const customerA2 = '018f2f45-7f5e-7e70-b17f-f6e77357410e';
const tenantDrama = '018f2f45-7f5e-7e70-b17f-f6e773574107';
const tenantEpisode = '018f2f45-7f5e-7e70-b17f-f6e773574108';
const unpublishedDrama = '018f2f45-7f5e-7e70-b17f-f6e773574109';
const tenantBDrama = '018f2f45-7f5e-7e70-b17f-f6e77357410a';
const platformDrama = '018f2f45-7f5e-7e70-b17f-f6e77357410b';
const tenantVideo = '018f2f45-7f5e-7e70-b17f-f6e77357410c';
const licenseId = '018f2f45-7f5e-7e70-b17f-f6e77357410d';

let membershipPlanId: string;
let pointsPackageId: string;
let createdOrderId: string;

const principal: CustomerPrincipal = {
  accountId: customerA,
  deviceId: '018f2f45-7f5e-7e70-b17f-f6e773574121',
  sessionId: '018f2f45-7f5e-7e70-b17f-f6e773574122',
  tenantId: tenantA,
  username: 'commerce_customer',
};

const secondPrincipal: CustomerPrincipal = {
  accountId: customerA2,
  deviceId: '018f2f45-7f5e-7e70-b17f-f6e773574123',
  sessionId: '018f2f45-7f5e-7e70-b17f-f6e773574124',
  tenantId: tenantA,
  username: 'commerce_customer_two',
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

function staffMetadata() {
  return { actorId: tenantStaffA, requestId: uuidV7() };
}

function orderMetadata(idempotencyKey: string) {
  return { idempotencyKey, ip: '127.0.0.1', requestId: uuidV7() };
}

describe('commerce catalog, pending orders, points, and entitlements', () => {
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
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantA}', 'commerce-a', 'Commerce A', statement_timestamp() + interval '1 year'),
        ('${tenantB}', 'commerce-b', 'Commerce B', statement_timestamp() + interval '1 year');
      insert into tenant_staff (id, tenant_id, username, password_hash)
      values ('${tenantStaffA}', '${tenantA}', 'commerce-owner', '${'p'.repeat(64)}');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaff}', 'commerce-platform', '${'p'.repeat(64)}');
      insert into customer_accounts (
        id, tenant_id, username, email, email_verified_at, password_hash
      ) values
        ('${customerA}', '${tenantA}', 'commerce_customer', 'buyer@example.com',
          statement_timestamp(), '${'x'.repeat(64)}'),
        ('${customerA2}', '${tenantA}', 'commerce_customer_two', 'buyer-two@example.com',
          statement_timestamp(), '${'z'.repeat(64)}'),
        ('${customerB}', '${tenantB}', 'commerce_other', 'other@example.com',
          statement_timestamp(), '${'y'.repeat(64)}');
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, source_url, checksum,
        status, transcode_status, duration_seconds, metadata_json
      ) values (
        '${tenantVideo}', 'tenant', '${tenantA}', 'video',
        'https://media.example.com/commerce-episode.mp4', '${'a'.repeat(64)}',
        'ready', 'ready', 120, '{"immutable":true}'::jsonb
      );
      insert into dramas (id, owner_type, owner_tenant_id, code, status) values
        ('${tenantDrama}', 'tenant', '${tenantA}', 'commerce-own', 'published'),
        ('${unpublishedDrama}', 'tenant', '${tenantA}', 'commerce-hidden', 'approved'),
        ('${tenantBDrama}', 'tenant', '${tenantB}', 'commerce-cross', 'published'),
        ('${platformDrama}', 'platform', null, 'commerce-public', 'published');
      insert into drama_translations (id, drama_id, locale, title) values
        ('${uuidV7()}', '${tenantDrama}', 'en-US', 'Own Published Drama'),
        ('${uuidV7()}', '${unpublishedDrama}', 'en-US', 'Hidden Drama'),
        ('${uuidV7()}', '${tenantBDrama}', 'en-US', 'Other Tenant Drama'),
        ('${uuidV7()}', '${platformDrama}', 'en-US', 'Licensed Public Drama');
      insert into episodes (
        id, drama_id, episode_no, status, duration_seconds, media_asset_id
      ) values (
        '${tenantEpisode}', '${tenantDrama}', 1, 'published', 120, '${tenantVideo}'
      );
      insert into episode_translations (id, episode_id, locale, title)
      values ('${uuidV7()}', '${tenantEpisode}', 'en-US', 'Paid Episode One');
      insert into content_licenses (
        id, tenant_id, license_type, drama_id, starts_at, expires_at,
        status, granted_by
      ) values (
        '${licenseId}', '${tenantA}', 'drama', '${platformDrama}',
        statement_timestamp() - interval '1 day',
        statement_timestamp() + interval '30 days', 'active', '${platformStaff}'
      );
      insert into content_license_items (id, tenant_id, license_id, drama_id)
      values ('${uuidV7()}', '${tenantA}', '${licenseId}', '${platformDrama}');
    `);

    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        await transaction.query(
          "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
          [tenantId],
        );
        return callback(transactionTag(transaction));
      }),
    } as unknown as DatabaseService;
    catalog = new CommerceCatalogService(databaseService);
    orders = new CommerceOrderService(databaseService);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('searches selectable content without leaking private, draft or unlicensed dramas', async () => {
    const choices = await catalog.contentOptions(tenantA, {});
    expect(choices.items.map(row => row.value).sort()).toEqual([tenantDrama, platformDrama].sort());
    expect((await catalog.contentOptions(tenantB, { selected: tenantDrama })).items.map(row => row.value)).toEqual([tenantBDrama]);
    expect((await catalog.contentOptions(tenantA, { q: 'own published' })).items.map(row => row.value)).toEqual([tenantDrama]);
    expect((await catalog.contentOptions(tenantA, { type: 'episode' })).items).toEqual([
      { value: tenantEpisode, label: 'Own Published Drama · 第 1 集（commerce-own）' },
    ]);
    expect((await catalog.contentOptions(tenantA, { q: "' OR 1=1 --" })).items).toEqual([]);
    await expect(catalog.contentOptions(tenantA, { type: 'unknown' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(catalog.contentOptions(tenantA, { q: ['invalid'] })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('creates localized membership and points catalogs with manual currency prices', async () => {
    const plan = await catalog.createMembershipPlan(
      tenantA,
      {
        code: 'monthly-member',
        durationDays: 30,
        translations: [
          { locale: 'en-US', name: 'Monthly Membership' },
          { locale: 'ja-JP', name: '月間会員' },
        ],
      },
      staffMetadata(),
    );
    membershipPlanId = plan.id;
    await expect(catalog.upsertMembershipPlanPrice(
      tenantA,
      plan.id,
      { amountMinor: 999, currency: 'USD' },
      staffMetadata(),
    )).resolves.toMatchObject({ amountMinor: 999, currency: 'USD' });
    await expect(catalog.updateMembershipPlanStatus(
      tenantA,
      plan.id,
      { status: 'disabled', version: 0 },
      staffMetadata(),
    )).resolves.toMatchObject({ status: 'disabled', version: 1 });
    await expect(catalog.updateMembershipPlanStatus(
      tenantA,
      plan.id,
      { status: 'active', version: 1 },
      staffMetadata(),
    )).resolves.toMatchObject({ status: 'active', version: 2 });
    await expect(catalog.updateMembershipPlanStatus(
      tenantA,
      plan.id,
      { status: 'disabled', version: 0 },
      staffMetadata(),
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(catalog.replaceMembershipPlanTranslations(
      tenantA,
      plan.id,
      {
        translations: [
          { locale: 'en-US', name: 'Monthly Membership Updated' },
          { locale: 'ja-JP', name: '月間会員' },
        ],
        version: 2,
      },
      staffMetadata(),
    )).resolves.toMatchObject({ version: 3 });
    await expect(catalog.replaceMembershipPlanTranslations(
      tenantB,
      plan.id,
      { translations: [{ locale: 'en-US', name: 'Cross Tenant' }], version: 3 },
      staffMetadata(),
    )).rejects.toBeInstanceOf(ConflictException);

    const topup = await catalog.createPointsTopupPackage(
      tenantA,
      {
        bonusPoints: 100,
        code: 'points-1000',
        pointsAmount: 1_000,
        translations: [{ locale: 'en-US', name: '1,000 Points' }],
      },
      staffMetadata(),
    );
    pointsPackageId = topup.id;
    await catalog.upsertPointsTopupPackagePrice(
      tenantA,
      topup.id,
      { amountMinor: 499, currency: 'USD' },
      staffMetadata(),
    );
    await expect(catalog.replacePointsTopupPackageTranslations(
      tenantA,
      topup.id,
      {
        translations: [
          { locale: 'en-US', name: '1,000 Points Updated' },
          { locale: 'zh-CN', name: '1,000 积分' },
        ],
        version: 0,
      },
      staffMetadata(),
    )).resolves.toMatchObject({ version: 1 });

    const listed = await catalog.listTenantCatalog(tenantA);
    expect(listed.membershipPlans[0]).toMatchObject({
      code: 'monthly-member',
      durationDays: 30,
      prices: [{ amountMinor: 999, currency: 'USD', status: 'active' }],
      translations: expect.arrayContaining([
        expect.objectContaining({ name: 'Monthly Membership Updated' }),
      ]),
    });
    expect(listed.pointsTopupPackages[0]).toMatchObject({
      bonusPoints: 100,
      pointsAmount: 1_000,
      prices: [{ amountMinor: 499, currency: 'USD', status: 'active' }],
      translations: expect.arrayContaining([
        expect.objectContaining({ locale: 'zh-CN', name: '1,000 积分' }),
      ]),
    });
  });

  it('prices only own published or currently licensed platform content', async () => {
    await expect(catalog.upsertContentPrice(
      tenantA,
      {
        amountMinor: 299,
        currency: 'USD',
        targetId: tenantDrama,
        targetType: 'drama',
      },
      staffMetadata(),
    )).resolves.toMatchObject({ targetId: tenantDrama, targetType: 'drama' });
    await expect(catalog.upsertContentPrice(
      tenantA,
      {
        amountMinor: 99,
        currency: 'USD',
        targetId: tenantEpisode,
        targetType: 'episode',
      },
      staffMetadata(),
    )).resolves.toMatchObject({ targetId: tenantEpisode, targetType: 'episode' });
    await expect(catalog.upsertContentPrice(
      tenantA,
      {
        amountMinor: 399,
        currency: 'USD',
        targetId: platformDrama,
        targetType: 'drama',
      },
      staffMetadata(),
    )).resolves.toMatchObject({ targetId: platformDrama });
    await expect(orders.quote(principal, {
      currency: 'USD',
      locale: 'en-US',
      productId: platformDrama,
      productType: 'drama',
    })).resolves.toMatchObject({
      product: { id: platformDrama, name: 'Licensed Public Drama' },
      totalMinor: 399,
    });
    await database.exec(`
      update content_licenses
      set
        status = 'revoked',
        revoked_at = statement_timestamp(),
        revoked_by = '${platformStaff}',
        revoke_reason = 'commerce realtime authorization test'
      where id = '${licenseId}'
    `);
    await expect(orders.quote(principal, {
      currency: 'USD',
      locale: 'en-US',
      productId: platformDrama,
      productType: 'drama',
    })).rejects.toThrow(/not found/i);
    await database.exec(`
      update content_licenses
      set status = 'active', revoked_at = null, revoked_by = null, revoke_reason = null
      where id = '${licenseId}'
    `);

    for (const targetId of [unpublishedDrama, tenantBDrama]) {
      await expect(catalog.upsertContentPrice(
        tenantA,
        {
          amountMinor: 100,
          currency: 'USD',
          targetId,
          targetType: 'drama',
        },
        staffMetadata(),
      )).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(catalog.upsertMembershipPlanPrice(
      tenantA,
      membershipPlanId,
      { amountMinor: 9_000_000_000_000_001, currency: 'USD' },
      staffMetadata(),
    )).rejects.toBeInstanceOf(BadRequestException);
  });

  it('quotes server prices, rejects client amounts, and creates an idempotent snapshot', async () => {
    const input: CommerceOrderInput = {
      currency: 'USD',
      locale: 'ja-JP',
      productId: membershipPlanId,
      productType: 'membership',
    };
    await expect(orders.quote(principal, input)).resolves.toMatchObject({
      currency: 'USD',
      product: {
        durationDays: 30,
        id: membershipPlanId,
        name: '月間会員',
        type: 'membership',
      },
      totalMinor: 999,
    });
    await expect(orders.quote(principal, {
      ...input,
      totalMinor: 1,
    } as CommerceOrderInput)).rejects.toBeInstanceOf(BadRequestException);

    const first = await orders.createOrder(
      principal,
      input,
      orderMetadata('commerce-order-key-0001'),
    );
    createdOrderId = first.id;
    expect(first).toMatchObject({
      currency: 'USD',
      orderType: 'membership',
      status: 'pending_payment',
      totalMinor: 999,
    });
    expect(Date.parse(first.expiresAt)).toBeGreaterThan(Date.parse(first.createdAt));
    expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBeGreaterThan(3_599_000);
    expect(Date.parse(first.expiresAt) - Date.parse(first.createdAt)).toBeLessThanOrEqual(3_600_000);
    expect(Date.parse(first.expiresAt) % 1_000).toBe(0);

    await catalog.upsertMembershipPlanPrice(
      tenantA,
      membershipPlanId,
      { amountMinor: 1_299, currency: 'USD' },
      staffMetadata(),
    );
    const replay = await orders.createOrder(
      principal,
      input,
      orderMetadata('commerce-order-key-0001'),
    );
    expect(replay).toEqual(first);
    const detail = await orders.getOrder(principal, first.id);
    expect(detail.totalMinor).toBe(999);
    expect(detail.item.unitAmountMinor).toBe(999);
    expect((await orders.quote(principal, input)).totalMinor).toBe(1_299);

    await expect(orders.createOrder(
      principal,
      { ...input, productId: pointsPackageId, productType: 'points_topup' },
      orderMetadata('commerce-order-key-0001'),
    )).rejects.toBeInstanceOf(ConflictException);
    const list = await orders.listOrders(principal, 1, 20);
    expect(list.total).toBe(1);
    expect(list.items[0]?.id).toBe(first.id);

    const staffList = await orders.listTenantOrders(tenantA, {
      page: 1,
      pageSize: 20,
      q: 'buyer@example.com',
      status: 'pending_payment',
    });
    expect(staffList.total).toBe(1);
    expect(staffList.items[0]).toMatchObject({
      customer: { email: 'buyer@example.com', username: 'commerce_customer' },
      id: first.id,
      subtotalMinor: 999,
      totalMinor: 999,
    });
    expect((await orders.listTenantOrders(tenantA, { q: '%' })).total).toBe(0);
    const staffDetail = await orders.getTenantOrder(tenantA, first.id);
    expect(staffDetail.items).toHaveLength(1);
    expect(staffDetail.items[0]).toMatchObject({
      product: { id: membershipPlanId, name: '月間会員' },
      totalAmountMinor: 999,
      unitAmountMinor: 999,
    });
    await expect(orders.getTenantOrder(tenantB, first.id)).rejects.toThrow(/not found/i);

    const facts = await database.query<{ commands: string; items: string; orders: string }>(`
      select
        (select count(*)::text from orders where id = '${first.id}') as orders,
        (select count(*)::text from order_items where order_id = '${first.id}') as items,
        (select count(*)::text from command_idempotency
          where actor_id = '${customerA}'
            and idempotency_key = 'commerce-order-key-0001') as commands
    `);
    expect(facts.rows[0]).toEqual({ commands: '1', items: '1', orders: '1' });
  });

  it('isolates order detail and idempotency records between accounts in one tenant', async () => {
    const input: CommerceOrderInput = {
      currency: 'USD',
      locale: 'en-US',
      productId: membershipPlanId,
      productType: 'membership',
    };
    await expect(orders.getOrder(secondPrincipal, createdOrderId)).rejects.toThrow(/not found/i);

    const secondOrder = await orders.createOrder(
      secondPrincipal,
      input,
      orderMetadata('commerce-order-key-0001'),
    );
    expect(secondOrder.id).not.toBe(createdOrderId);
    expect(secondOrder.totalMinor).toBe(1_299);
    await expect(orders.getOrder(principal, secondOrder.id)).rejects.toThrow(/not found/i);

    const facts = await database.query<{ account_count: string; command_count: string }>(`
      select
        count(distinct actor_id)::text as account_count,
        count(*)::text as command_count
      from command_idempotency
      where tenant_id = '${tenantA}'
        and idempotency_key = 'commerce-order-key-0001'
    `);
    expect(facts.rows[0]).toEqual({ account_count: '2', command_count: '2' });
  });

  it('rejects new quotes and orders immediately when the tenant becomes unavailable', async () => {
    await database.exec(`update tenants set status = 'suspended' where id = '${tenantA}'`);
    await expect(orders.quote(principal, {
      currency: 'USD',
      locale: 'en-US',
      productId: membershipPlanId,
      productType: 'membership',
    })).rejects.toBeInstanceOf(ConflictException);
    await database.exec(`update tenants set status = 'active' where id = '${tenantA}'`);
    await database.exec(`update tenants set user_site_enabled = false where id = '${tenantA}'`);
    await expect(orders.quote(principal, {
      currency: 'USD',
      locale: 'en-US',
      productId: membershipPlanId,
      productType: 'membership',
    })).rejects.toBeInstanceOf(ConflictException);
    await expect(orders.listOrders(principal, 1, 20))
      .rejects.toBeInstanceOf(ConflictException);
    await database.exec(`update tenants set user_site_enabled = true where id = '${tenantA}'`);
  });

  it('changes point balances only through append-only locked ledger entries', async () => {
    const pointAccountId = uuidV7();
    const ledgerId = uuidV7();
    await expect(database.exec(`
      insert into point_accounts (id, tenant_id, account_id, balance)
      values ('${uuidV7()}', '${tenantA}', '${customerA}', 100)
    `)).rejects.toThrow(/zero balance/i);
    await database.exec(`
      insert into point_accounts (id, tenant_id, account_id)
      values ('${pointAccountId}', '${tenantA}', '${customerA}');
      insert into point_ledger (
        id, tenant_id, account_id, point_account_id, entry_type, delta,
        balance_after, reference_type, reference_id, idempotency_key,
        created_by_type, created_by
      ) values (
        '${ledgerId}', '${tenantA}', '${customerA}', '${pointAccountId}',
        'topup', 100, 0, 'order', '${createdOrderId}',
        'point-ledger-credit-0001', 'user', '${customerA}'
      );
    `);
    const balance = await database.query<{ balance: string; balance_after: string }>(`
      select account.balance::text, ledger.balance_after::text
      from point_accounts as account
      inner join point_ledger as ledger on ledger.point_account_id = account.id
      where account.id = '${pointAccountId}' and ledger.id = '${ledgerId}'
    `);
    expect(balance.rows[0]).toEqual({ balance: '100', balance_after: '100' });
    await expect(database.exec(`
      update point_accounts set balance = 200 where id = '${pointAccountId}'
    `)).rejects.toThrow(/only be changed/i);
    await expect(database.exec(`
      insert into point_ledger (
        id, tenant_id, account_id, point_account_id, entry_type, delta,
        balance_after, reference_type, reference_id, idempotency_key,
        created_by_type, created_by
      ) values (
        '${uuidV7()}', '${tenantA}', '${customerA}', '${pointAccountId}',
        'purchase', -101, 0, 'order', '${createdOrderId}',
        'point-ledger-debit-0001', 'user', '${customerA}'
      )
    `)).rejects.toThrow(/allowed range/i);
    await expect(database.exec(`
      update point_ledger set delta = 1 where id = '${ledgerId}'
    `)).rejects.toThrow();
  });

  it('requires a matching paid order item and keeps one active entitlement per product', async () => {
    const orderItem = await database.query<{ id: string }>(`
      select id from order_items where order_id = '${createdOrderId}'
    `);
    const itemId = orderItem.rows[0]?.id as string;
    await expect(database.exec(`
      insert into entitlements (
        id, tenant_id, account_id, entitlement_type, product_id,
        source_order_id, source_order_item_id, starts_at, expires_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${customerA}', 'membership', '${membershipPlanId}',
        '${createdOrderId}', '${itemId}', statement_timestamp(),
        statement_timestamp() + interval '30 days'
      )
    `)).rejects.toThrow(/paid order item/i);
    const providerId = uuidV7();
    const paymentConfigId = uuidV7();
    const paymentAttemptId = uuidV7();
    await database.exec(`
      insert into payment_providers (id, code, adapter_code)
      values ('${providerId}', 'commerce-test-provider', 'fake');
      insert into payment_configs (
        id, owner_type, provider_id, label
      ) values (
        '${paymentConfigId}', 'platform', '${providerId}', 'Commerce test config'
      );
      insert into payment_attempts (
        id, tenant_id, account_id, order_id, provider_id, payment_config_id,
        adapter_code_snapshot, collection_mode, status, currency, amount_minor,
        idempotency_key
      ) values (
        '${paymentAttemptId}', '${tenantA}', '${customerA}', '${createdOrderId}',
        '${providerId}', '${paymentConfigId}', 'fake', 'platform_collect', 'pending',
        'USD', 999, 'commerce-entitlement-payment-0001'
      );
      insert into payment_transactions (
        id, tenant_id, attempt_id, order_id, provider_id, transaction_type,
        status, external_transaction_id, currency, amount_minor, payload_hash,
        occurred_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${paymentAttemptId}', '${createdOrderId}',
        '${providerId}', 'charge', 'succeeded', 'commerce-charge-0001', 'USD',
        999, '${'b'.repeat(64)}', statement_timestamp()
      );
      update payment_attempts
      set status = 'succeeded', succeeded_at = statement_timestamp(), version = version + 1
      where id = '${paymentAttemptId}';
    `);
    await database.exec(`
      update orders
      set status = 'paid', paid_at = statement_timestamp(), version = version + 1
      where id = '${createdOrderId}';
      insert into entitlements (
        id, tenant_id, account_id, entitlement_type, product_id,
        source_order_id, source_order_item_id, starts_at, expires_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${customerA}', 'membership', '${membershipPlanId}',
        '${createdOrderId}', '${itemId}', statement_timestamp(),
        statement_timestamp() + interval '30 days'
      );
    `);
    const paidStaffDetail = await orders.getTenantOrder(tenantA, createdOrderId);
    expect(paidStaffDetail.collectionMode).toBe('platform_collect');
    const paidStaffList = await orders.listTenantOrders(tenantA, { status: 'paid' });
    expect(paidStaffList.items.find((order) => order.id === createdOrderId)?.collectionMode)
      .toBe('platform_collect');
    await expect(database.exec(`
      insert into entitlements (
        id, tenant_id, account_id, entitlement_type, product_id,
        source_order_id, source_order_item_id, starts_at, expires_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${customerA}', 'membership', '${membershipPlanId}',
        '${createdOrderId}', '${itemId}', statement_timestamp(),
        statement_timestamp() + interval '30 days'
      )
    `)).rejects.toThrow();

    const expiredOrderId = uuidV7();
    const expiredOrderNo = `ORD${expiredOrderId.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
    await database.exec(`
      insert into orders (
        id, tenant_id, account_id, order_no, order_type, currency,
        subtotal_minor, total_minor, locale, customer_snapshot_json,
        created_at, updated_at, expires_at
      ) values (
        '${expiredOrderId}', '${tenantA}', '${customerA}', '${expiredOrderNo}',
        'membership', 'USD', 999, 999, 'en-US', '{}'::jsonb,
        statement_timestamp() - interval '1 hour',
        statement_timestamp() - interval '1 hour',
        statement_timestamp() - interval '30 minutes'
      )
    `);
    const expiredPaymentAttemptId = uuidV7();
    await database.exec(`
      insert into payment_attempts (
        id, tenant_id, account_id, order_id, provider_id, payment_config_id,
        adapter_code_snapshot, collection_mode, status, currency, amount_minor,
        idempotency_key
      ) values (
        '${expiredPaymentAttemptId}', '${tenantA}', '${customerA}', '${expiredOrderId}',
        '${providerId}', '${paymentConfigId}', 'fake', 'platform_collect', 'pending',
        'USD', 999, 'commerce-expired-payment-0001'
      );
      insert into payment_transactions (
        id, tenant_id, attempt_id, order_id, provider_id, transaction_type,
        status, external_transaction_id, currency, amount_minor, payload_hash,
        occurred_at
      ) values (
        '${uuidV7()}', '${tenantA}', '${expiredPaymentAttemptId}', '${expiredOrderId}',
        '${providerId}', 'charge', 'succeeded', 'commerce-expired-charge-0001',
        'USD', 999, '${'c'.repeat(64)}', statement_timestamp()
      );
      update payment_attempts
      set status = 'succeeded', succeeded_at = statement_timestamp(), version = version + 1
      where id = '${expiredPaymentAttemptId}';
    `);
    await expect(database.exec(`
      update orders
      set status = 'paid', paid_at = statement_timestamp(), version = version + 1
      where id = '${expiredOrderId}'
    `)).rejects.toThrow(/expired pending orders/i);
  });

  it('forces RLS and rejects cross-tenant catalog writes for a non-owner role', async () => {
    const tables = [
      'membership_plans',
      'membership_plan_translations',
      'membership_plan_prices',
      'content_prices',
      'points_topup_packages',
      'points_topup_package_translations',
      'points_topup_package_prices',
      'point_accounts',
      'point_ledger',
      'orders',
      'order_items',
      'entitlements',
    ];
    const relationList = tables.map((table) => `'${table}'`).join(',');
    const rls = await database.query<{ forced: boolean; row_security: boolean }>(`
      select relation.relrowsecurity as row_security, relation.relforcerowsecurity as forced
      from pg_class as relation
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public' and relation.relname = any(array[${relationList}])
    `);
    expect(rls.rows).toHaveLength(tables.length);
    expect(rls.rows.every((row) => row.row_security && row.forced)).toBe(true);

    await database.exec(`
      create role commerce_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to commerce_tenant_probe;
      grant select, insert on membership_plans to commerce_tenant_probe;
      set role commerce_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    const visible = await database.query<{ code: string }>(`
      select code::text from membership_plans order by code
    `);
    expect(visible.rows).toEqual([{ code: 'monthly-member' }]);
    await expect(database.exec(`
      insert into membership_plans (id, tenant_id, code, duration_days)
      values ('${uuidV7()}', '${tenantB}', 'cross-tenant-plan', 30)
    `)).rejects.toThrow();
    await database.exec('rollback; reset role');
  });
});
