import { describe, expect, it } from 'vitest';
import { revenueMajor, revenueMinor, revenueMoney } from './revenue-ui';

describe('content revenue operator money fields', () => {
  it('formats and parses actual currency units without floating-point loss', () => {
    expect(revenueMinor('9.99', 'USD')).toBe('999');
    expect(revenueMajor('999', 'USD')).toBe('9.99');
    expect(revenueMoney('-123456', 'USD')).toBe('USD -1,234.56');
    expect(revenueMinor('100', 'JPY')).toBe('100');
    expect(revenueMinor('1.234', 'BHD')).toBe('1234');
    expect(revenueMajor('9007199254740993', 'USD')).toBe('90071992547409.93');
  });
  it('rejects excess precision, negative input, and bigint overflow', () => {
    expect(() => revenueMinor('1.234', 'USD')).toThrow();
    expect(() => revenueMinor('1.1', 'JPY')).toThrow();
    expect(() => revenueMinor('-1', 'USD')).toThrow();
    expect(() => revenueMinor('9223372036854775808', 'JPY')).toThrow();
  });
});
