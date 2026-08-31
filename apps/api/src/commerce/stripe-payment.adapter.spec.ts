import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import Stripe from 'stripe';
import { describe, expect, it, vi } from 'vitest';

import type {
  CreateAdapterPaymentInput,
  PaymentProviderContext,
} from './payment-adapter';
import { PaymentAdapterDefinitiveError } from './payment-adapter';
import {
  STRIPE_API_VERSION,
  StripeAccountMismatchError,
  StripePaymentAdapter,
  StripeProviderUnavailableError,
} from './stripe-payment.adapter';

const attemptId = '018f2f45-7f5e-7e70-b17f-f6e773574011';
const orderId = '018f2f45-7f5e-7e70-b17f-f6e773574012';
const refundId = '018f2f45-7f5e-7e70-b17f-f6e773574013';
const expiresAt = new Date('2026-08-22T03:00:00.000Z');
const context: PaymentProviderContext = {
  configId: '018f2f45-7f5e-7e70-b17f-f6e773574014',
  configVersion: 3,
  credentials: {
    accountId: 'acct_TestAccount123',
    mode: 'test',
    secretKey: `sk_test_${'a'.repeat(32)}`,
    webhookSecret: `whsec_${'b'.repeat(32)}`,
  },
  providerId: '018f2f45-7f5e-7e70-b17f-f6e773574015',
  secretVersion: 2,
};

function session(overrides: Partial<Stripe.Checkout.Session> = {}): Stripe.Checkout.Session {
  return {
    amount_total: 1234,
    client_reference_id: attemptId,
    currency: 'usd',
    expires_at: Math.floor(expiresAt.getTime() / 1000),
    id: 'cs_test_12345678',
    metadata: { attemptId, orderId },
    mode: 'payment',
    object: 'checkout.session',
    payment_status: 'unpaid',
    status: 'open',
    url: 'https://checkout.stripe.com/c/pay/cs_test_12345678',
    ...overrides,
  } as Stripe.Checkout.Session;
}

function createInput(): CreateAdapterPaymentInput {
  return {
    amountMinor: 1234,
    attemptId,
    cancelUrl: `https://shop.example.com/payment/cancel?orderId=${orderId}`,
    config: context,
    currency: 'USD',
    expiresAt,
    orderId,
    orderNo: 'ORD123456',
    providerIdempotencyKey: attemptId,
    successUrl: `https://shop.example.com/payment/result?orderId=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
  };
}

describe('StripePaymentAdapter hosted checkout', () => {
  it('uses server facts, exact expiry and stable provider idempotency', async () => {
    const create = vi.fn(async () => session());
    const adapter = new StripePaymentAdapter(() => ({
      checkout: { sessions: { create } },
    } as unknown as Stripe));

    await expect(adapter.createPayment(createInput())).resolves.toEqual({
      checkoutAction: {
        expiresAt: expiresAt.toISOString(),
        type: 'redirect',
        url: 'https://checkout.stripe.com/c/pay/cs_test_12345678',
      },
      externalPaymentId: 'cs_test_12345678',
      status: 'pending',
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      cancel_url: expect.stringMatching(/^https:\/\/shop\.example\.com\//),
      client_reference_id: attemptId,
      expires_at: Math.floor(expiresAt.getTime() / 1000),
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: { name: 'Order ORD123456' },
          unit_amount: 1234,
        },
        quantity: 1,
      }],
      metadata: { attemptId, orderId },
      mode: 'payment',
      payment_method_types: ['card'],
      success_url: expect.stringContaining('{CHECKOUT_SESSION_ID}'),
    }), { idempotencyKey: attemptId });
  });

  it('rejects provider URL/domain and order fact mismatches', async () => {
    for (const invalid of [
      session({ url: 'https://evil.example/cs_test_12345678' }),
      session({ amount_total: 1235 }),
      session({ metadata: { attemptId, orderId: refundId } }),
      session({ expires_at: Math.floor(expiresAt.getTime() / 1000) + 1 }),
    ]) {
      const adapter = new StripePaymentAdapter(() => ({
        checkout: { sessions: { create: vi.fn(async () => invalid) } },
      } as unknown as Stripe));
      await expect(adapter.createPayment(createInput()))
        .rejects.toBeInstanceOf(PaymentAdapterDefinitiveError);
    }
    const adapter = new StripePaymentAdapter(() => ({
      checkout: { sessions: { create: vi.fn() } },
    } as unknown as Stripe));
    await expect(adapter.createPayment({
      ...createInput(),
      successUrl: 'https://shop.example.com/payment/result',
    })).rejects.toBeInstanceOf(PaymentAdapterDefinitiveError);
  });

  it('creates asynchronous refunds against the trusted PaymentIntent', async () => {
    const create = vi.fn(async () => ({
      amount: 500,
      created: 1_777_000_000,
      currency: 'usd',
      id: 're_1234567890',
      status: 'pending',
    } as Stripe.Refund));
    const adapter = new StripePaymentAdapter(() => ({ refunds: { create } } as unknown as Stripe));
    await expect(adapter.refundPayment({
      amountMinor: 500,
      chargeExternalTransactionId: 'pi_1234567890',
      config: context,
      currency: 'USD',
      externalPaymentId: 'cs_test_12345678',
      orderId,
      providerIdempotencyKey: refundId,
      refundId,
    })).resolves.toMatchObject({ externalRefundId: 're_1234567890', status: 'pending' });
    expect(create).toHaveBeenCalledWith({
      amount: 500,
      metadata: { orderId, refundId },
      payment_intent: 'pi_1234567890',
      reason: 'requested_by_customer',
    }, { idempotencyKey: refundId });
  });

  it('tests the exact configured receiving account and hides raw provider failures', async () => {
    const good = new StripePaymentAdapter(() => ({
      accounts: { retrieveCurrent: vi.fn(async () => ({ id: context.credentials!.accountId })) },
    } as unknown as Stripe));
    await expect(good.testCredentials(context)).resolves.toBeUndefined();

    const mismatch = new StripePaymentAdapter(() => ({
      accounts: { retrieveCurrent: vi.fn(async () => ({ id: 'acct_OtherAccount123' })) },
    } as unknown as Stripe));
    await expect(mismatch.testCredentials(context)).rejects.toBeInstanceOf(
      StripeAccountMismatchError,
    );

    const unavailable = new StripePaymentAdapter(() => ({
      accounts: { retrieveCurrent: vi.fn(async () => {
        throw new Error(`raw-${context.credentials!.secretKey}`);
      }) },
    } as unknown as Stripe));
    await expect(unavailable.testCredentials(context)).rejects.toEqual(
      new StripeProviderUnavailableError(),
    );
  });
});

describe('StripePaymentAdapter webhook verification', () => {
  function signedEvent(
    event: Record<string, unknown>,
    timestamp = Math.floor(Date.now() / 1000),
  ) {
    const raw = Buffer.from(JSON.stringify(event));
    const stripe = new Stripe(context.credentials!.secretKey, {
      apiVersion: STRIPE_API_VERSION,
      telemetry: false,
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload: raw.toString('utf8'),
      secret: context.credentials!.webhookSecret,
      timestamp,
    });
    return { raw, signature };
  }

  it('verifies the exact raw body and maps a paid Checkout Session', () => {
    const event = {
      account: context.credentials!.accountId,
      created: 1_777_000_000,
      data: { object: session({ payment_intent: 'pi_1234567890', payment_status: 'paid' }) },
      id: 'evt_1234567890',
      livemode: false,
      object: 'event',
      type: 'checkout.session.completed',
    };
    const { raw, signature } = signedEvent(event);
    const adapter = new StripePaymentAdapter();
    expect(adapter.verifyWebhook(raw, signature, [context])).toMatchObject({
      amountMinor: 1234,
      attemptReference: attemptId,
      eventId: 'evt_1234567890',
      eventType: 'payment.succeeded',
      externalPaymentId: 'cs_test_12345678',
      externalTransactionId: 'pi_1234567890',
      kind: 'payment',
    });
    const changed = Buffer.concat([raw, Buffer.from(' ')]);
    expect(() => adapter.verifyWebhook(changed, signature, [context]))
      .toThrow(UnauthorizedException);
  });

  it('enforces a five-minute signature tolerance without rejecting an old event.created', () => {
    const event = {
      created: 1,
      data: { object: session({ payment_intent: 'pi_1234567890', payment_status: 'paid' }) },
      id: 'evt_1234567890',
      livemode: false,
      object: 'event',
      type: 'checkout.session.completed',
    };
    const adapter = new StripePaymentAdapter();
    const current = signedEvent(event);
    expect(adapter.verifyWebhook(current.raw, current.signature, [context]))
      .toMatchObject({ eventType: 'payment.succeeded' });
    const oldSignature = signedEvent(event, Math.floor(Date.now() / 1000) - 301);
    expect(() => adapter.verifyWebhook(oldSignature.raw, oldSignature.signature, [context]))
      .toThrow(UnauthorizedException);
  });

  it('accepts an unexpired rotated webhook secret but rejects an account mismatch', () => {
    const event = {
      account: context.credentials!.accountId,
      created: 1_777_000_000,
      data: { object: session({ payment_intent: 'pi_1234567890', payment_status: 'paid' }) },
      id: 'evt_rotated_12345678',
      livemode: false,
      object: 'event',
      type: 'checkout.session.completed',
    };
    const signed = signedEvent(event);
    const current = {
      ...context,
      credentials: {
        ...context.credentials!,
        webhookSecret: `whsec_${'c'.repeat(32)}`,
      },
      secretVersion: 3,
    };
    const adapter = new StripePaymentAdapter();
    expect(adapter.verifyWebhook(signed.raw, signed.signature, [current, context]))
      .toMatchObject({ eventId: 'evt_rotated_12345678' });

    const wrongAccount = signedEvent({ ...event, account: 'acct_OtherAccount123' });
    expect(() => adapter.verifyWebhook(
      wrongAccount.raw,
      wrongAccount.signature,
      [context],
    )).toThrow(UnauthorizedException);
  });

  it('rejects unpaid completions, wrong modes and unsupported event types', () => {
    const adapter = new StripePaymentAdapter();
    for (const event of [
      {
        created: 1_777_000_000,
        data: { object: session({ payment_status: 'unpaid' }) },
        id: 'evt_1234567890', livemode: false, object: 'event',
        type: 'checkout.session.completed',
      },
      {
        created: 1_777_000_000,
        data: { object: { id: 'ch_1234567890', object: 'charge' } },
        id: 'evt_1234567890', livemode: false, object: 'event',
        type: 'charge.succeeded',
      },
    ]) {
      const signed = signedEvent(event);
      expect(() => adapter.verifyWebhook(signed.raw, signed.signature, [context]))
        .toThrow(BadRequestException);
    }
    const live = signedEvent({
      created: 1_777_000_000,
      data: { object: session({ payment_intent: 'pi_1234567890', payment_status: 'paid' }) },
      id: 'evt_1234567890', livemode: true, object: 'event',
      type: 'checkout.session.completed',
    });
    expect(() => adapter.verifyWebhook(live.raw, live.signature, [context]))
      .toThrow(UnauthorizedException);
  });

  it('maps refund pending, success and failure without trusting another refund', () => {
    const adapter = new StripePaymentAdapter();
    for (const [type, status, expected] of [
      ['refund.updated', 'pending', 'refund.pending'],
      ['refund.updated', 'succeeded', 'refund.succeeded'],
      ['refund.failed', 'failed', 'refund.failed'],
    ] as const) {
      const signed = signedEvent({
        created: 1_777_000_000,
        data: { object: {
          amount: 500,
          created: 1_777_000_000,
          currency: 'usd',
          id: 're_1234567890',
          metadata: { refundId },
          object: 'refund',
          payment_intent: 'pi_1234567890',
          status,
        } },
        id: `evt_${status}_12345678`,
        livemode: false,
        object: 'event',
        type,
      });
      expect(adapter.verifyWebhook(signed.raw, signed.signature, [context]))
        .toMatchObject({ eventType: expected, refundReference: refundId });
    }
  });
});
