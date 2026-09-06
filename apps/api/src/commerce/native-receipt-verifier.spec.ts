import { describe, expect, it } from 'vitest';
import { storeMoney, verifiedApplePurchase, verifiedGooglePurchase, verifiedGoogleHistoricalRefund, type VerifiedNativePurchase } from './native-receipt-verifier';
import { createHash } from 'node:crypto';
import type { NativeStoreConfig } from './native-store-config';
const config: NativeStoreConfig = { applicationId: 'com.tenant.test', environment: 'Sandbox',
  products: { coins: { kind: 'points_topup', productId: '018f2f45-7f5e-7e70-b17f-f6e773573108' },
    member: { kind: 'membership', productId: '018f2f45-7f5e-7e70-b17f-f6e773573109' } } };
const now = Date.now();
describe('verified store receipts', () => {
  it('refunds the original Google renewal, never the latest successful order', () => {
    const previous: VerifiedNativePurchase = { store: 'google', applicationId: config.applicationId, environment: 'Sandbox',
      externalId: 'GPA.old..0', originalId: 'token', productId: 'member', accountBinding: 'account', kind: 'membership',
      currency: 'USD', grossMinor: '199', netMinor: null, refundedMinor: '0', status: 'inactive',
      tokenHash: createHash('sha256').update('token').digest('hex'), purchasedAt: new Date(now - 90000),
      expiresAt: new Date(now - 10000), observedAt: new Date(now) };
    const order = { orderId: previous.externalId, purchaseToken: 'token', state: 'REFUNDED',
      total: { currencyCode: 'USD', units: '1', nanos: 990000000 }, lineItems: [{ productId: 'member' }] };
    expect(verifiedGoogleHistoricalRefund(order, config, 'token', previous)).toMatchObject({
      externalId: previous.externalId, status: 'refunded', refundedMinor: '199', expiresAt: previous.expiresAt,
    });
    for (const invalid of [{ orderId: 'GPA.old..1' }, { purchaseToken: 'other' }, { state: 'PROCESSED' }]) {
      expect(() => verifiedGoogleHistoricalRefund({ ...order, ...invalid }, config, 'token', previous)).toThrow();
    }
  });
  it('converts currency exponents without floating point loss and rejects invalid precision', () => {
    expect(storeMoney('USD', 1990n, 1000n)).toBe('199');
    expect(storeMoney('JPY', 199000n, 1000n)).toBe('199');
    expect(storeMoney('KWD', 1990n, 1000n)).toBe('1990');
    expect(() => storeMoney('USD', 1991n, 1000n)).toThrow();
    expect(() => storeMoney('XXX', -1n, 1000n)).toThrow();
  });
  it('enforces Apple application, environment, ownership, quantity and subscription expiry', () => {
    const receipt = { bundleId: config.applicationId, environment: config.environment, transactionId: '1234', originalTransactionId: '1234',
      productId: 'coins', quantity: 1, appAccountToken: '018f2f45-7f5e-7e70-b17f-f6e773573101',
      inAppOwnershipType: 'PURCHASED', type: 'Consumable', price: 1990, currency: 'USD', purchaseDate: now - 1000, signedDate: now };
    expect(verifiedApplePurchase(receipt, config)).toMatchObject({ grossMinor: '199', status: 'active', kind: 'points_topup' });
    for (const invalid of [{ bundleId: 'com.other.app' }, { environment: 'Production' }, { quantity: 2 },
      { appAccountToken: undefined }, { inAppOwnershipType: 'FAMILY_SHARED' }, { type: 'Non-Consumable' }, { productId: 'unknown' }]) {
      expect(() => verifiedApplePurchase({ ...receipt, ...invalid }, config)).toThrow();
    }
    expect(verifiedApplePurchase({ ...receipt, revocationDate: now }, config)).toMatchObject({ status: 'refunded', refundedMinor: '199' });
    expect(() => verifiedApplePurchase({ ...receipt, productId: 'member', type: 'Auto-Renewable Subscription' }, config)).toThrow();
  });
  it('uses Google paid order amounts and handles partial refunds without trusting client prices', () => {
    const purchase = { productLineItem: [{ productId: 'coins' }], orderId: 'GPA.1',
      obfuscatedExternalAccountId: '018f2f45-7f5e-7e70-b17f-f6e773573101', testPurchaseContext: {},
      purchaseStateContext: { purchaseState: 'PURCHASED' } };
    const order = { orderId: 'GPA.1', purchaseToken: 'token', state: 'PROCESSED', createTime: new Date(now - 1000).toISOString(),
      lastEventTime: new Date(now).toISOString(), total: { currencyCode: 'USD', units: '1', nanos: 990000000 },
      lineItems: [{ productId: 'coins', oneTimePurchaseDetails: { quantity: 1 } }] };
    expect(verifiedGooglePurchase(purchase, order, config, 'coins', 'token')).toMatchObject({ grossMinor: '199', refundedMinor: '0', status: 'active' });
    const partial = { ...order, state: 'PARTIALLY_REFUNDED', orderHistory: { partialRefundEvents: [{ state: 'PROCESSED_SUCCESSFULLY',
      refundDetails: { total: { currencyCode: 'USD', units: '0', nanos: 500000000 } } }] } };
    expect(verifiedGooglePurchase(purchase, partial, config, 'coins', 'token').refundedMinor).toBe('50');
    for (const invalid of [{ orderId: 'GPA.other' }, { purchaseToken: 'other' }, { state: 'PENDING' },
      { lineItems: [{ productId: 'coins', oneTimePurchaseDetails: { quantity: 2 } }] }]) {
      expect(() => verifiedGooglePurchase(purchase, { ...order, ...invalid }, config, 'coins', 'token')).toThrow();
    }
    expect(() => verifiedGooglePurchase({ ...purchase, testPurchaseContext: undefined }, order, config, 'coins', 'token')).toThrow();
  });
});
