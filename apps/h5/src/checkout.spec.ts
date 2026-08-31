import { describe, expect, it, vi } from 'vitest';

import type { CustomerRequestInit, StorageLike } from './api/client';
import type { CommerceOrderInput, CommerceOrderSummary, CommerceQuote, PaymentAttempt } from './api/types';
import {
  beginHostedCheckout,
  formatMinorAmount,
  readPendingCheckout,
  validatedStripeCheckoutUrl,
  type CheckoutApi,
} from './checkout';

const ORDER_ID = '018f2f45-7f5e-7e70-b17f-f6e77357d001';
const ATTEMPT_ID = '018f2f45-7f5e-7e70-b17f-f6e77357d002';
const PRODUCT_ID = '018f2f45-7f5e-7e70-b17f-f6e77357d003';
const expiresAt = '2030-01-01T00:00:00.000Z';
const keys = {
  order: '018f2f45-7f5e-7e70-b17f-f6e77357d010',
  payment: '018f2f45-7f5e-7e70-b17f-f6e77357d011',
};

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

const input: CommerceOrderInput = {
  currency: 'USD', locale: 'en-US', productId: PRODUCT_ID, productType: 'drama',
};
const quote: CommerceQuote = {
  currency: 'USD', locale: 'en-US',
  product: { id: PRODUCT_ID, name: 'Drama', type: 'drama' }, totalMinor: 1299,
};
const order: CommerceOrderSummary = {
  createdAt: '2029-12-31T23:00:00.000Z', currency: 'USD', expiresAt: '2030-01-01T00:00:00.321Z',
  id: ORDER_ID, item: { ...quote.product, unitAmountMinor: 1299 }, locale: 'en-US',
  orderNo: 'ORD1', orderType: 'drama', status: 'pending_payment', totalMinor: 1299,
};
const attempt: PaymentAttempt = {
  amountMinor: 1299,
  checkoutAction: { expiresAt, type: 'redirect', url: 'https://checkout.stripe.com/c/pay/cs_test_123?prefilled_email=x' },
  collectionMode: 'tenant_direct', createdAt: order.createdAt, currency: 'USD',
  externalPaymentId: 'cs_test_123', id: ATTEMPT_ID, orderId: ORDER_ID, status: 'pending',
};

describe('Stripe Hosted Checkout safety', () => {
  it('accepts only an unexpired exact Stripe HTTPS origin', () => {
    expect(validatedStripeCheckoutUrl(attempt.checkoutAction, Date.parse('2029-01-01')))
      .toBe(attempt.checkoutAction?.url);
    for (const url of [
      'http://checkout.stripe.com/c/pay/x',
      'https://checkout.stripe.com.evil.test/c/pay/x',
      'https://checkout.stripe.com:444/c/pay/x',
      'https://user@checkout.stripe.com/c/pay/x',
      'https://checkout.stripe.com/c/pay/x#token',
    ]) {
      expect(validatedStripeCheckoutUrl({ expiresAt, type: 'redirect', url }, Date.parse('2029-01-01')))
        .toBeUndefined();
    }
    expect(validatedStripeCheckoutUrl(attempt.checkoutAction, Date.parse(expiresAt)))
      .toBeUndefined();
  });

  it('uses no-store, sends no client amount or return URL, and redirects only to the action', async () => {
    const calls: Array<{ init?: CustomerRequestInit; path: string }> = [];
    const request = vi.fn(async (path: string, init?: CustomerRequestInit) => {
      calls.push({ init, path });
      return calls.length === 1 ? order : attempt;
    });
    const api = { request: request as unknown as CheckoutApi['request'] };
    const storage = new MemoryStorage();
    const redirect = vi.fn();
    await expect(beginHostedCheckout({
      api, idempotencyKeys: keys, now: Date.parse('2029-01-01'), orderInput: input, quote, redirect, storage,
    })).resolves.toMatchObject({ status: 'redirected' });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.init?.cache === 'no-store')).toBe(true);
    expect(calls[0]?.init?.json).toEqual(input);
    expect(calls[1]?.init?.json).toEqual({});
    expect(new Headers(calls[0]?.init?.headers).get('idempotency-key')).toBe(keys.order);
    expect(new Headers(calls[1]?.init?.headers).get('idempotency-key')).toBe(keys.payment);
    expect(JSON.stringify(calls)).not.toMatch(/amountMinor|successUrl|cancelUrl|checkout/i);
    expect(redirect).toHaveBeenCalledOnce();
    expect(redirect).toHaveBeenCalledWith(attempt.checkoutAction?.url);
    expect(readPendingCheckout(storage, ORDER_ID)).toMatchObject({ attemptId: ATTEMPT_ID, orderId: ORDER_ID });
  });

  it('does not fallback when checkoutAction is absent or unsafe', async () => {
    const unsafeAttempt: PaymentAttempt = {
      ...attempt,
      checkoutAction: { ...attempt.checkoutAction!, url: 'https://example.com/pay' },
      collectionMode: 'platform_collect',
    };
    const responses: Array<CommerceOrderSummary | PaymentAttempt> = [order, unsafeAttempt];
    const request = vi.fn(async () => responses.shift() as CommerceOrderSummary | PaymentAttempt);
    const api = { request: request as unknown as CheckoutApi['request'] };
    const redirect = vi.fn();
    await expect(beginHostedCheckout({
      api, idempotencyKeys: keys, now: Date.parse('2029-01-01'), orderInput: input, quote,
      redirect, storage: new MemoryStorage(),
    })).resolves.toMatchObject({ status: 'unavailable' });
    expect(redirect).not.toHaveBeenCalled();
  });

  it('stops before payment when the server order price changed', async () => {
    const request = vi.fn(async () => ({ ...order, totalMinor: 1499 }));
    const api = { request: request as unknown as CheckoutApi['request'] };
    const redirect = vi.fn();
    await expect(beginHostedCheckout({
      api, idempotencyKeys: keys, orderInput: input, quote, redirect, storage: new MemoryStorage(),
    })).resolves.toMatchObject({ status: 'price_changed' });
    expect(request).toHaveBeenCalledOnce();
    expect(redirect).not.toHaveBeenCalled();
  });

  it('formats server minor amounts without floating-point conversion', () => {
    expect(formatMinorAmount(123456789, 'USD')).toBe('USD 1,234,567.89');
    expect(formatMinorAmount(123456789, 'JPY')).toBe('JPY 123,456,789');
  });
});
