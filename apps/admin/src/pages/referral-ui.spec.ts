import { describe, expect, it } from 'vitest';

import { formatBpsAsPercent, parsePercentToBps } from './referral-ui';

describe('referral basis-point conversion', () => {
  it('converts percentages to basis points without floating point rounding', () => {
    expect(parsePercentToBps('0.01')).toBe(1);
    expect(parsePercentToBps('1.25')).toBe(125);
    expect(parsePercentToBps('100.00')).toBe(10_000);
  });

  it('formats every valid basis-point value exactly', () => {
    expect(formatBpsAsPercent(1)).toBe('0.01');
    expect(formatBpsAsPercent(125)).toBe('1.25');
    expect(formatBpsAsPercent(10_000)).toBe('100.00');
  });

  it('rejects over-precision, ambiguous, negative, and out-of-range values', () => {
    for (const value of ['1.001', '01.00', '-1', '100.01', 'NaN', '']) {
      expect(() => parsePercentToBps(value)).toThrow();
    }
  });
});
