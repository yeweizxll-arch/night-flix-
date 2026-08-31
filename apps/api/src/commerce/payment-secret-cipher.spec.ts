import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadPaymentKeyring,
  PaymentSecretCipher,
  type PaymentKeyring,
} from './payment-secret-cipher';

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773574001';
const configId = '018f2f45-7f5e-7e70-b17f-f6e773574002';
const accountId = 'acct_TestAccount123';
const credentials = {
  accountId,
  mode: 'test' as const,
  secretKey: `sk_test_${'a'.repeat(32)}`,
  webhookSecret: `whsec_${'b'.repeat(32)}`,
};
const binding = {
  accountId,
  configId,
  mode: 'test' as const,
  ownerType: 'tenant' as const,
  secretVersion: 1,
  tenantId,
};

function keyring(): PaymentKeyring {
  return { activeVersion: 7, keys: new Map([[7, randomBytes(32)]]) };
}

describe('PaymentSecretCipher', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('encrypts separate Stripe secrets and authenticates every ownership field', () => {
    const cipher = new PaymentSecretCipher(keyring());
    const encrypted = cipher.encryptStripeCredentials(credentials, binding);

    expect(encrypted.credentialKeyVersion).toBe(7);
    expect(encrypted.secretKeyCiphertext).not.toContain(credentials.secretKey);
    expect(encrypted.webhookSecretCiphertext).not.toContain(credentials.webhookSecret);
    expect(encrypted.secretKeyCiphertext).not.toBe(encrypted.webhookSecretCiphertext);
    expect(cipher.decryptStripeCredentials(encrypted, {
      ...binding,
      credentialKeyVersion: 7,
    })).toEqual(credentials);

    for (const changed of [
      { ...binding, configId: '018f2f45-7f5e-7e70-b17f-f6e773574003' },
      { ...binding, secretVersion: 2 },
      { ...binding, accountId: 'acct_OtherAccount123' },
      { ...binding, tenantId: '018f2f45-7f5e-7e70-b17f-f6e773574004' },
      { ...binding, ownerType: 'platform' as const, tenantId: null },
    ]) {
      expect(() => cipher.decryptStripeCredentials(encrypted, {
        ...changed,
        credentialKeyVersion: 7,
      })).toThrow(/authentication failed/i);
    }
    expect(() => cipher.decryptStripeCredentials({
      secretKeyCiphertext: encrypted.webhookSecretCiphertext,
      webhookSecretCiphertext: encrypted.secretKeyCiphertext,
    }, { ...binding, credentialKeyVersion: 7 })).toThrow(/authentication failed/i);
  });

  it('rejects mode mismatch, unknown input, invalid owner and unavailable key versions', () => {
    const cipher = new PaymentSecretCipher(keyring());
    expect(() => cipher.encryptStripeCredentials({
      ...credentials,
      secretKey: `sk_live_${'a'.repeat(32)}`,
    }, binding)).toThrow(/mode/i);
    expect(() => cipher.encryptStripeCredentials({ ...credentials, extra: true }, binding))
      .toThrow(/unknown/i);
    expect(() => cipher.encryptStripeCredentials(credentials, {
      ...binding,
      tenantId: 'not-a-uuid',
    })).toThrow(/owner/i);

    const encrypted = cipher.encryptStripeCredentials(credentials, binding);
    expect(() => cipher.decryptStripeCredentials(encrypted, {
      ...binding,
      credentialKeyVersion: 8,
    })).toThrow(/invalid/i);
  });

  it('requires a complete exact 32-byte keyring in production', () => {
    expect(() => loadPaymentKeyring({ NODE_ENV: 'production' })).toThrow(/required/i);
    expect(() => loadPaymentKeyring({
      NODE_ENV: 'production',
      PAYMENT_ACTIVE_KEY_VERSION: '1',
      PAYMENT_MASTER_KEYS: JSON.stringify({ 1: randomBytes(31).toString('base64') }),
    })).toThrow(/32 bytes/i);
    const key = randomBytes(32).toString('base64');
    const loaded = loadPaymentKeyring({
      NODE_ENV: 'production',
      PAYMENT_ACTIVE_KEY_VERSION: '2',
      PAYMENT_MASTER_KEYS: JSON.stringify({ 2: key }),
    });
    expect(loaded?.activeVersion).toBe(2);
    expect(loaded?.keys.get(2)?.toString('base64')).toBe(key);
  });
});
