import { describe, expect, it } from 'vitest';

import { parseMajorAmount } from './finance-ui';

describe('finance amount conversion', () => {
  it('converts decimal currencies to minor units without floating point arithmetic', () => {
    expect(parseMajorAmount('12.34', 'USD')).toBe(1234);
    expect(parseMajorAmount('0.01', 'CNY')).toBe(1);
    expect(parseMajorAmount('90000000000000.00', 'EUR')).toBe(9_000_000_000_000_000);
  });

  it('keeps zero-decimal currencies as integer minor units', () => {
    expect(parseMajorAmount('123', 'JPY')).toBe(123);
    expect(parseMajorAmount('456', 'KRW')).toBe(456);
    expect(() => parseMajorAmount('1.1', 'JPY')).toThrow('只能输入整数');
  });

  it('rejects ambiguous, zero, over-precision, and unsafe values', () => {
    for (const value of ['0', '01.00', '1.001', 'NaN', '-1', '90000000000000.01']) {
      expect(() => parseMajorAmount(value, 'USD')).toThrow();
    }
  });
});
