import { describe, expect, it } from 'vitest';
import { amountNumber, signedAmountNumber } from './commerce-validation';

describe('stored monetary amounts', () => {
  it('preserves signed ledger changes without allowing negative balances or prices', () => {
    expect(signedAmountNumber('-100')).toBe(-100);
    expect(signedAmountNumber(100n)).toBe(100);
    expect(signedAmountNumber(0)).toBe(0);
    expect(() => amountNumber('-100')).toThrow();
  });

  it.each(['1.5', 'NaN', 'Infinity', '9007199254740992', '-9007199254740992'])(
    'rejects invalid or unsafe signed ledger value %s', (value) => {
      expect(() => signedAmountNumber(value)).toThrow();
    },
  );
});
