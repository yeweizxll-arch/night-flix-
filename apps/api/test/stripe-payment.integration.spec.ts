import { PGlite, type Transaction } from '@electric-sql/pglite';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Stripe from 'stripe';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import { PaymentConfigurationService } from '../src/commerce/payment-configuration.service';
import { FakePaymentAdapter, PaymentAdapterRegistry } from '../src/commerce/payment-adapter';
import { PaymentCoreService } from '../src/commerce/payment-core.service';
import { PaymentSecretCipher } from '../src/commerce/payment-secret-cipher';
import { RefundService } from '../src/commerce/refund.service';
import { StripePaymentConfigurationService } from '../src/commerce/stripe-payment-configuration.service';
import {
  STRIPE_API_VERSION,
  StripePaymentAdapter,
} from '../src/commerce/stripe-payment.adapter';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import type { CustomerPrincipal } from '../src/customer-auth/customer-auth.types';

let database: PGlite;
let databaseService: DatabaseService;
let service: StripePaymentConfigurationService;
let listings: PaymentConfigurationService;
let cipher: PaymentSecretCipher;
let stripeAdapter: StripePaymentAdapter;
let checkoutFailuresRemaining = 0;
const checkoutCalls: Array<{ idempotencyKey?: string; parameters: Stripe.Checkout.SessionCreateParams }> = [];
const checkoutSessions = new Map<string, Stripe.Checkout.Session>();
const refundCalls: Array<{ options: Stripe.RequestOptions; parameters: Stripe.RefundCreateParams }> = [];
let checkoutConfigId: string;

const firstTenantId = '018f2f45-7f5e-7e70-b17f-f6e773574101';
const secondTenantId = '018f2f45-7f5e-7e70-b17f-f6e773574102';
const firstStaffId = '018f2f45-7f5e-7e70-b17f-f6e773574103';
const secondStaffId = '018f2f45-7f5e-7e70-b17f-f6e773574104';
const platformStaffId = '018f2f45-7f5e-7e70-b17f-f6e773574105';
const tenantAccount = 'acct_TenantStripe123';
const platformAccount = 'acct_PlatformStripe1';
const customerId = '018f2f45-7f5e-7e70-b17f-f6e773574106';
const customerPrincipal: CustomerPrincipal = {
  accountId: customerId,
  deviceId: '018f2f45-7f5e-7e70-b17f-f6e773574107',
  sessionId: '018f2f45-7f5e-7e70-b17f-f6e773574108',
  tenantId: firstTenantId,
  username: 'stripe_customer',
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

function tenantCredentials(secretSuffix: string) {
  return {
    accountId: tenantAccount,
    mode: 'test',
    secretKey: `sk_test_tenant_${secretSuffix}_${'a'.repeat(20)}`,
    webhookSecret: `whsec_tenant_${secretSuffix}_${'b'.repeat(20)}`,
  };
}

describe('Stripe payment configuration security', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of filenames) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(source
        .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
        .replace(/\bcitext\b/g, 'text'));
    }
    await database.exec(`
      insert into tenants (id, code, name, expires_at)
      values
        ('${firstTenantId}', 'stripe-one', 'Stripe One', statement_timestamp() + interval '1 year'),
        ('${secondTenantId}', 'stripe-two', 'Stripe Two', statement_timestamp() + interval '1 year');
      insert into tenant_staff (id, tenant_id, username, password_hash)
      values
        ('${firstStaffId}', '${firstTenantId}', 'stripe-owner-one', '${'p'.repeat(64)}'),
        ('${secondStaffId}', '${secondTenantId}', 'stripe-owner-two', '${'p'.repeat(64)}');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaffId}', 'stripe-platform', '${'p'.repeat(64)}');
      insert into customer_accounts (
        id, tenant_id, username, email, email_verified_at, password_hash
      ) values (
        '${customerId}', '${firstTenantId}', 'stripe_customer',
        'stripe-customer@example.com', statement_timestamp(), '${'x'.repeat(64)}'
      );
      insert into tenant_domains (
        id, tenant_id, host, type, verification_token, verified_at,
        tls_status, is_primary, created_by
      ) values (
        '${uuidV7()}', '${firstTenantId}', 'stripe-one.example.com', 'custom',
        '${'v'.repeat(32)}', statement_timestamp(), 'active', true, '${firstStaffId}'
      );
    `);
    databaseService = {
      inPlatformContext: <T>(callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ) => database.transaction(async (transaction) => {
        await transaction.query(
          "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
          [tenantId],
        );
        return callback(transactionTag(transaction));
      }),
    } as unknown as DatabaseService;
    cipher = new PaymentSecretCipher({
      activeVersion: 4,
      keys: new Map([[4, randomBytes(32)]]),
    });
    const retrieveCurrent = vi.fn(async function (this: { secretKey?: string }) {
      return { id: this.secretKey?.includes('platform') ? platformAccount : tenantAccount };
    });
    stripeAdapter = new StripePaymentAdapter((secretKey) => ({
      accounts: { retrieveCurrent: retrieveCurrent.bind({ secretKey }) },
      checkout: { sessions: {
        create: vi.fn(async (
          parameters: Stripe.Checkout.SessionCreateParams,
          options: Stripe.RequestOptions,
        ) => {
          checkoutCalls.push({ idempotencyKey: options.idempotencyKey, parameters });
          if (checkoutFailuresRemaining > 0) {
            checkoutFailuresRemaining -= 1;
            throw new Error(`raw-provider-${secretKey}`);
          }
          const id = `cs_test_${String(parameters.client_reference_id).replaceAll('-', '')}`;
          const line = parameters.line_items?.[0];
          const created = {
            amount_total: line?.price_data?.unit_amount,
            client_reference_id: parameters.client_reference_id,
            currency: line?.price_data?.currency,
            expires_at: parameters.expires_at,
            id,
            metadata: parameters.metadata,
            mode: 'payment',
            object: 'checkout.session',
            payment_status: 'unpaid',
            status: 'open',
            url: `https://checkout.stripe.com/c/pay/${id}`,
          } as Stripe.Checkout.Session;
          checkoutSessions.set(id, created);
          return created;
        }),
        retrieve: vi.fn(async (id: string) => checkoutSessions.get(id)),
      } },
      refunds: { create: vi.fn(async (
        parameters: Stripe.RefundCreateParams,
        options: Stripe.RequestOptions,
      ) => {
        refundCalls.push({ options, parameters });
        const refundReference = parameters.metadata && typeof parameters.metadata === 'object'
          ? parameters.metadata.refundId
          : undefined;
        return {
          amount: parameters.amount,
          created: Math.floor(Date.now() / 1000),
          currency: 'usd',
          id: `re_${String(refundReference).replaceAll('-', '')}`,
          object: 'refund',
          payment_intent: parameters.payment_intent,
          status: 'pending',
        } as Stripe.Refund;
      }) },
      webhooks: new Stripe(secretKey, {
        apiVersion: STRIPE_API_VERSION,
        telemetry: false,
      }).webhooks,
    } as unknown as Stripe));
    service = new StripePaymentConfigurationService(databaseService, cipher, stripeAdapter);
    listings = new PaymentConfigurationService(databaseService);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('creates, tests and enables tenant and platform accounts without exposing secrets', async () => {
    const tenant = await service.createTenant(
      firstTenantId,
      firstStaffId,
      { label: 'Tenant Stripe', ...tenantCredentials('v1') },
      'stripe-config-create-tenant-0001',
      uuidV7(),
    );
    expect(tenant).toMatchObject({
      accountId: tenantAccount,
      collectionMode: 'tenant_direct',
      mode: 'test',
      providerCode: 'stripe',
      status: 'disabled',
      testStatus: 'untested',
      version: 0,
    });
    expect(JSON.stringify(tenant)).not.toMatch(/sk_test|whsec|cipher/i);

    const disabledTenantListing = await listings.listTenantPaymentConfigs(firstTenantId);
    expect(disabledTenantListing.configs).toContainEqual(expect.objectContaining({
      id: tenant.id,
      ownerType: 'tenant',
      status: 'disabled',
      testStatus: 'untested',
    }));
    expect(JSON.stringify(disabledTenantListing)).not.toMatch(/sk_test|whsec|ciphertext/i);

    const tested = await service.testTenant(
      firstTenantId, firstStaffId, tenant.id, { expectedVersion: 0 },
      'stripe-config-test-tenant-0001', uuidV7(),
    );
    expect(tested).toMatchObject({ status: 'disabled', testStatus: 'passed', version: 1 });
    const enabled = await service.setTenantStatus(
      firstTenantId, firstStaffId, tenant.id, true, { expectedVersion: 1 },
      'stripe-config-enable-tenant-0001', uuidV7(),
    );
    expect(enabled).toMatchObject({ status: 'active', testStatus: 'passed', version: 2 });

    const platform = await service.createPlatform(
      platformStaffId,
      {
        accountId: platformAccount,
        label: 'Platform Stripe',
        mode: 'test',
        secretKey: `sk_test_platform_${'c'.repeat(24)}`,
        webhookSecret: `whsec_platform_${'d'.repeat(24)}`,
      },
      'stripe-config-create-platform-0001',
      uuidV7(),
    );
    expect(platform).toMatchObject({
      accountId: platformAccount,
      collectionMode: 'platform_collect',
      status: 'disabled',
    });

    const listed = await listings.listTenantPaymentConfigs(firstTenantId);
    expect(listed.configs).toContainEqual(expect.objectContaining({
      accountId: tenantAccount,
      id: tenant.id,
      provider: 'stripe',
    }));
    expect(listed.configs).not.toContainEqual(expect.objectContaining({ id: platform.id }));
    expect(JSON.stringify(listed)).not.toMatch(/sk_test|whsec|ciphertext/i);

    const stored = await database.query<{
      secret_key_ciphertext: string;
      webhook_secret_ciphertext: string;
    }>(`select secret_key_ciphertext, webhook_secret_ciphertext
      from payment_config_secret_versions where payment_config_id = '${tenant.id}'`);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]?.secret_key_ciphertext).not.toContain('sk_test');
    expect(stored.rows[0]?.webhook_secret_ciphertext).not.toContain('whsec');
    const evidence = await database.query<{ value: string }>(`
      select coalesce(string_agg(after_json::text, ''), '') as value
      from audit_logs where resource_id in ('${tenant.id}', '${platform.id}')
    `);
    expect(evidence.rows[0]?.value).not.toMatch(/sk_test|whsec|ciphertext/i);
  });

  it('rotates only within the immutable account/mode and keeps the old webhook secret for 30 days', async () => {
    const config = await service.createTenant(
      firstTenantId, firstStaffId,
      { label: 'Rotating Stripe', ...tenantCredentials('rotate1') },
      'stripe-config-create-rotate-0001', uuidV7(),
    );
    await expect(service.rotateTenant(
      firstTenantId, firstStaffId, config.id,
      { ...tenantCredentials('other'), accountId: 'acct_Different12345', expectedVersion: 0 },
      'stripe-config-rotate-account-0001', uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);

    const rotated = await service.rotateTenant(
      firstTenantId, firstStaffId, config.id,
      { ...tenantCredentials('rotate2'), expectedVersion: 0 },
      'stripe-config-rotate-good-0001', uuidV7(),
    );
    expect(rotated).toMatchObject({
      accountId: tenantAccount,
      status: 'disabled',
      testStatus: 'untested',
      version: 1,
    });
    const versions = await database.query<{
      remaining_days: string;
      secret_version: number;
      status: string;
    }>(`
      select secret_version, status,
        coalesce(extract(epoch from (verify_webhooks_until - statement_timestamp())) / 86400, 0)::text
          as remaining_days
      from payment_config_secret_versions where payment_config_id = '${config.id}'
      order by secret_version
    `);
    expect(versions.rows.map(({ secret_version, status }) => ({ secret_version, status })))
      .toEqual([
        { secret_version: 1, status: 'grace' },
        { secret_version: 2, status: 'active' },
      ]);
    expect(Number(versions.rows[0]?.remaining_days)).toBeGreaterThan(29.9);
    await expect(service.setTenantStatus(
      firstTenantId, firstStaffId, config.id, true, { expectedVersion: 1 },
      'stripe-config-enable-untested-0001', uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);
  });

  it('blocks cross-tenant administration, idempotency drift, and tenant reads of ciphertext', async () => {
    const config = await service.createTenant(
      firstTenantId, firstStaffId,
      { label: 'Isolated Stripe', ...tenantCredentials('isolated') },
      'stripe-config-create-isolated-0001', uuidV7(),
    );
    await expect(service.rotateTenant(
      secondTenantId, secondStaffId, config.id,
      { ...tenantCredentials('cross'), expectedVersion: 0 },
      'stripe-config-cross-tenant-0001', uuidV7(),
    )).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.createTenant(
      firstTenantId, firstStaffId,
      { label: 'Different request', ...tenantCredentials('different') },
      'stripe-config-create-isolated-0001', uuidV7(),
    )).rejects.toBeInstanceOf(ConflictException);

    await database.exec(`
      create role stripe_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to stripe_tenant_probe;
      grant select on payment_config_secret_versions to stripe_tenant_probe;
      set role stripe_tenant_probe;
      begin;
      set local app.access_scope = 'tenant';
      set local app.tenant_id = '${firstTenantId}'
    `);
    const hidden = await database.query('select * from payment_config_secret_versions');
    expect(hidden.rows).toHaveLength(0);
    await database.exec('rollback; reset role');
  });

  it('enforces the 30-minute hosted boundary and recovers 5xx with one provider key', async () => {
    const config = await service.createTenant(
      firstTenantId, firstStaffId,
      { label: 'Checkout Stripe', ...tenantCredentials('checkout') },
      'stripe-config-create-checkout-0001', uuidV7(),
    );
    const tested = await service.testTenant(
      firstTenantId, firstStaffId, config.id, { expectedVersion: 0 },
      'stripe-config-test-checkout-0001', uuidV7(),
    );
    const enabled = await service.setTenantStatus(
      firstTenantId, firstStaffId, config.id, true, { expectedVersion: tested.version },
      'stripe-config-enable-checkout-0001', uuidV7(),
    );
    checkoutConfigId = config.id;
    await listings.setTenantRouting(
      firstTenantId, config.id, 'tenant_direct', firstStaffId, uuidV7(),
      'stripe-routing-checkout-0001',
    );
    expect(enabled.status).toBe('active');
    const payments = new PaymentCoreService(
      databaseService,
      new PaymentAdapterRegistry(new FakePaymentAdapter(), stripeAdapter),
      undefined,
      cipher,
    );

    const tooShort = await insertOrderWithExpiry('29 minutes 59 seconds', 1200);
    await expect(payments.createPayment(
      customerPrincipal,
      tooShort,
      { successUrl: 'https://attacker.example/paid' },
      'stripe-payment-client-url-0001',
      uuidV7(),
      'stripe-one.example.com',
    )).rejects.toThrow(/does not accept client-provided fields/i);
    await expect(payments.createPayment(
      customerPrincipal, tooShort, {}, 'stripe-payment-short-0001', uuidV7(),
      'stripe-one.example.com',
    )).rejects.toBeInstanceOf(ConflictException);
    const shortAttempts = await database.query<{ count: string }>(`
      select count(*)::text as count from payment_attempts where order_id = '${tooShort}'
    `);
    expect(shortAttempts.rows[0]?.count).toBe('0');

    const orderId = await insertOrderWithExpiry('60 minutes', 2200);
    checkoutFailuresRemaining = 1;
    const callsBefore = checkoutCalls.length;
    await expect(payments.createPayment(
      customerPrincipal, orderId, {}, 'stripe-payment-recovery-0001', uuidV7(),
      'untrusted-attacker.example.com',
    )).rejects.toThrow(/temporarily unavailable/i);
    const initialized = await database.query<{
      attempt_id: string;
      command_status: string;
      status: string;
    }>(`
      select attempt.id as attempt_id, attempt.status, command.status as command_status
      from payment_attempts as attempt
      inner join command_idempotency as command
        on command.resource_type = 'payment_attempt' and command.resource_id = attempt.id
      where attempt.order_id = '${orderId}'
    `);
    expect(initialized.rows[0]).toMatchObject({ command_status: 'processing', status: 'initialized' });

    const recovered = await payments.createPayment(
      customerPrincipal, orderId, {}, 'stripe-payment-recovery-0001', uuidV7(),
      'untrusted-attacker.example.com',
    );
    expect(recovered.checkoutAction).toMatchObject({
      expiresAt: expect.any(String),
      type: 'redirect',
      url: expect.stringMatching(/^https:\/\/checkout\.stripe\.com\//),
    });
    const providerCalls = checkoutCalls.slice(callsBefore);
    expect(providerCalls).toHaveLength(2);
    expect(new Set(providerCalls.map((call) => call.idempotencyKey)))
      .toEqual(new Set([initialized.rows[0]?.attempt_id]));
    for (const call of providerCalls) {
      expect(call.parameters.success_url).toMatch(/^https:\/\/stripe-one\.example\.com\//);
      expect(call.parameters.cancel_url).toMatch(/^https:\/\/stripe-one\.example\.com\//);
      expect(call.parameters.expires_at).toBe(Math.floor(Date.parse(
        recovered.checkoutAction!.expiresAt,
      ) / 1000));
    }
    const persisted = await database.query<{ evidence: string }>(`
      select concat_ws(' ',
        coalesce((select string_agg(response_json::text, '') from command_idempotency
          where resource_id = '${recovered.id}'), ''),
        coalesce((select string_agg(after_json::text, '') from audit_logs
          where resource_id = '${recovered.id}'), ''),
        coalesce((select checkout_reference from payment_attempts
          where id = '${recovered.id}'), '')
      ) as evidence
    `);
    expect(persisted.rows[0]?.evidence).not.toMatch(/checkout\.stripe\.com|sk_test|whsec|raw-provider/i);

    await expect(payments.createPayment(
      customerPrincipal, orderId, {}, 'stripe-payment-recovery-0001', uuidV7(),
      'stripe-one.example.com',
    )).resolves.toMatchObject({ id: recovered.id, checkoutAction: recovered.checkoutAction });
  });

  it('keeps refund acceptance pending until a signed Stripe terminal event arrives', async () => {
    expect(checkoutConfigId).toBeTruthy();
    const registry = new PaymentAdapterRegistry(new FakePaymentAdapter(), stripeAdapter);
    const refunds = new RefundService(databaseService, registry, cipher);
    const payments = new PaymentCoreService(
      databaseService, registry, undefined, cipher, refunds,
    );
    const orderId = await insertOrderWithExpiry('60 minutes', 3300);
    const attempt = await payments.createPayment(
      customerPrincipal, orderId, {}, 'stripe-refund-payment-0001', uuidV7(),
      'stripe-one.example.com',
    );
    const storedSession = checkoutSessions.get(attempt.externalPaymentId);
    if (!storedSession) throw new Error('Checkout fixture was not created');
    const paymentIntentId = `pi_${attempt.id.replaceAll('-', '')}`;
    const paymentEvent = {
      account: tenantAccount,
      created: Math.floor(Date.now() / 1000),
      data: { object: {
        ...storedSession,
        payment_intent: paymentIntentId,
        payment_status: 'paid',
      } },
      id: 'evt_checkout_refund_12345678',
      livemode: false,
      object: 'event',
      type: 'checkout.session.completed',
    };
    const paymentRaw = Buffer.from(JSON.stringify(paymentEvent));
    await expect(payments.handleWebhook(
      checkoutConfigId,
      paymentRaw,
      stripeSignature(paymentRaw, tenantCredentials('checkout').webhookSecret),
      'stripe',
    )).resolves.toEqual({ duplicate: false, status: 'processed' });

    const refund = await refunds.createTenantRefund(
      firstTenantId,
      firstStaffId,
      orderId,
      { reason: 'Customer approved full Stripe refund' },
      'stripe-refund-command-0001',
      uuidV7(),
    );
    expect(refund).toMatchObject({
      amountMinor: 3300,
      orderId,
      status: 'processing',
    });
    const providerCall = refundCalls.at(-1);
    expect(providerCall?.options.idempotencyKey).toBe(refund.id);
    expect(providerCall?.parameters).toMatchObject({
      amount: 3300,
      payment_intent: paymentIntentId,
    });
    const beforeWebhook = await database.query<{ order_status: string; transactions: string }>(`
      select status as order_status,
        (select count(*)::text from payment_transactions
          where order_id = '${orderId}' and transaction_type = 'refund') as transactions
      from orders where id = '${orderId}'
    `);
    expect(beforeWebhook.rows[0]).toEqual({ order_status: 'paid', transactions: '0' });

    const externalRefundId = `re_${refund.id.replaceAll('-', '')}`;
    const refundEvent = {
      account: tenantAccount,
      created: Math.floor(Date.now() / 1000),
      data: { object: {
        amount: 3300,
        created: Math.floor(Date.now() / 1000),
        currency: 'usd',
        id: externalRefundId,
        metadata: { refundId: refund.id },
        object: 'refund',
        payment_intent: paymentIntentId,
        status: 'succeeded',
      } },
      id: 'evt_refund_succeeded_12345678',
      livemode: false,
      object: 'event',
      type: 'refund.updated',
    };
    const refundRaw = Buffer.from(JSON.stringify(refundEvent));
    const signature = stripeSignature(refundRaw, tenantCredentials('checkout').webhookSecret);
    await expect(payments.handleWebhook(
      checkoutConfigId, refundRaw, signature, 'stripe',
    )).resolves.toEqual({ duplicate: false, status: 'processed' });
    await expect(payments.handleWebhook(
      checkoutConfigId, refundRaw, signature, 'stripe',
    )).resolves.toEqual({ duplicate: true, status: 'processed' });
    const reusedRaw = Buffer.from(JSON.stringify({
      ...refundEvent,
      created: refundEvent.created + 1,
    }));
    await expect(payments.handleWebhook(
      checkoutConfigId,
      reusedRaw,
      stripeSignature(reusedRaw, tenantCredentials('checkout').webhookSecret),
      'stripe',
    )).resolves.toEqual({ duplicate: true, status: 'rejected' });
    const completed = await database.query<{
      order_status: string;
      refund_status: string;
      transactions: string;
    }>(`
      select commerce_order.status as order_status, refund.status as refund_status,
        (select count(*)::text from payment_transactions
          where order_id = commerce_order.id and transaction_type = 'refund') as transactions
      from orders as commerce_order
      inner join payment_refunds as refund on refund.order_id = commerce_order.id
      where commerce_order.id = '${orderId}'
    `);
    expect(completed.rows[0]).toEqual({
      order_status: 'refunded',
      refund_status: 'succeeded',
      transactions: '1',
    });
    const alerts = await database.query<{ count: string }>(`
      select count(*)::text as count from outbox_events
      where aggregate_type = 'payment_webhook'
        and event_type = 'PaymentWebhookEventReuseDetected'
        and payload_json ->> 'refundId' = '${refund.id}'
    `);
    expect(alerts.rows[0]?.count).toBe('1');
  });
});

function stripeSignature(raw: Buffer, secret: string): string {
  return new Stripe(`sk_test_${'s'.repeat(32)}`, {
    apiVersion: STRIPE_API_VERSION,
    telemetry: false,
  }).webhooks.generateTestHeaderString({
    payload: raw.toString('utf8'),
    secret,
  });
}

async function insertOrderWithExpiry(expiryInterval: string, amountMinor: number): Promise<string> {
  const id = uuidV7();
  const productId = uuidV7();
  const orderNo = `ORD${id.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
  await database.exec(`
    insert into orders (
      id, tenant_id, account_id, order_no, order_type, currency,
      subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
    ) values (
      '${id}', '${firstTenantId}', '${customerId}', '${orderNo}', 'membership', 'USD',
      ${amountMinor}, ${amountMinor}, 'en-US', '{"username":"stripe_customer"}'::jsonb,
      statement_timestamp() + interval '${expiryInterval}'
    );
    insert into order_items (
      id, tenant_id, order_id, line_no, item_type, product_id, currency,
      unit_amount_minor, total_amount_minor, product_snapshot_json
    ) values (
      '${uuidV7()}', '${firstTenantId}', '${id}', 1, 'membership', '${productId}', 'USD',
      ${amountMinor}, ${amountMinor}, '{"durationDays":30}'::jsonb
    )
  `);
  return id;
}
