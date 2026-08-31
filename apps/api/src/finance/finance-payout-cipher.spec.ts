import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { FinancePayoutCipher } from './finance-payout-cipher';

const tenantId = '11111111-1111-4111-8111-111111111111';
const withdrawalId = '22222222-2222-4222-8222-222222222222';
const payoutAccount = {
  accountHolder: 'Test Merchant',
  accountNumber: '1234567890123456',
  bankName: 'Security Test Bank',
  countryCode: 'JP',
  routingCode: 'TOKYO001',
};

describe('FinancePayoutCipher', () => {
  it('uses authenticated tenant and withdrawal binding without storing plaintext', () => {
    const cipher = makeCipher();
    const encrypted = cipher.encrypt(payoutAccount, { tenantId, withdrawalId });

    expect(encrypted.ciphertext).toMatch(/^fp1\.7\./);
    expect(encrypted.ciphertext).not.toContain(payoutAccount.accountNumber);
    expect(encrypted.fingerprint).toBe('Security Test Bank ••••3456');
    expect(cipher.decrypt(
      encrypted.ciphertext,
      encrypted.keyVersion,
      { tenantId, withdrawalId },
    )).toEqual(payoutAccount);
  });

  it('rejects ciphertext tampering and cross-tenant or cross-withdrawal replay', () => {
    const cipher = makeCipher();
    const encrypted = cipher.encrypt(payoutAccount, { tenantId, withdrawalId });
    const parts = encrypted.ciphertext.split('.');
    parts[3] = `${parts[3]?.slice(0, -1)}${parts[3]?.endsWith('A') ? 'B' : 'A'}`;

    expect(() => cipher.decrypt(
      parts.join('.'),
      encrypted.keyVersion,
      { tenantId, withdrawalId },
    )).toThrow(/authentication failed/);
    expect(() => cipher.decrypt(
      encrypted.ciphertext,
      encrypted.keyVersion,
      { tenantId: '33333333-3333-4333-8333-333333333333', withdrawalId },
    )).toThrow(/authentication failed/);
    expect(() => cipher.decrypt(
      encrypted.ciphertext,
      encrypted.keyVersion,
      { tenantId, withdrawalId: '44444444-4444-4444-8444-444444444444' },
    )).toThrow(/authentication failed/);
  });
});

function makeCipher(): FinancePayoutCipher {
  return new FinancePayoutCipher({
    activeVersion: 7,
    keys: new Map([[7, randomBytes(32)]]),
  });
}
