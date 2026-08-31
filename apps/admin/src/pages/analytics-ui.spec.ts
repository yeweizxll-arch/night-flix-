import { describe, expect, it } from 'vitest';

import {
  advanceCursor,
  formatMinorDecimal,
  retreatCursor,
  validateAnalyticsDateRange,
  visibleWithdrawalGroups,
} from './analytics-ui';

describe('analytics money formatting', () => {
  it('formats arbitrary-size decimal strings without Number conversion', () => {
    expect(formatMinorDecimal('900719925474099312345', 'USD'))
      .toBe('USD 9,007,199,254,740,993,123.45');
    expect(formatMinorDecimal('-5', 'EUR')).toBe('EUR -0.05');
    expect(formatMinorDecimal('123456789', 'JPY')).toBe('JPY 123,456,789');
  });

  it('rejects non-integer server amounts', () => {
    expect(() => formatMinorDecimal('1.5', 'USD')).toThrow('Invalid decimal');
  });
});

describe('analytics date range', () => {
  it('accepts a 90-day inclusive range and rejects 91 days', () => {
    expect(validateAnalyticsDateRange('2026-01-02', '2026-04-01', '2026-04-01').valid).toBe(true);
    expect(validateAnalyticsDateRange('2026-01-01', '2026-04-01', '2026-04-01').valid).toBe(false);
  });

  it('rejects invalid, reversed and future ranges', () => {
    expect(validateAnalyticsDateRange('2026-02-30', '2026-03-01', '2026-03-01').valid).toBe(false);
    expect(validateAnalyticsDateRange('2026-03-02', '2026-03-01', '2026-03-02').valid).toBe(false);
    expect(validateAnalyticsDateRange('2026-03-01', '2026-03-03', '2026-03-02').valid).toBe(false);
  });
});

describe('analytics cursor state', () => {
  it('preserves opaque cursors for safe previous/next navigation', () => {
    const first = { current: undefined, history: [] };
    const second = advanceCursor(first, 'opaque-page-2');
    const third = advanceCursor(second, 'opaque-page-3');
    expect(second).toEqual({ current: 'opaque-page-2', history: [undefined] });
    expect(retreatCursor(third)).toEqual(second);
    expect(retreatCursor(second)).toEqual(first);
  });
});

describe('analytics withdrawal grouping', () => {
  it('keeps one total count per status while retaining every currency amount', () => {
    const rows = visibleWithdrawalGroups([
      {
        amounts: [
          { amountMinor: '100', currency: 'USD' as const },
          { amountMinor: '200', currency: 'EUR' as const },
        ],
        count: 3,
        status: 'submitted',
      },
      { amounts: [], count: 0, status: 'paid' },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.count).toBe(3);
    expect(rows[0]?.amounts.map((amount) => amount.currency)).toEqual(['USD', 'EUR']);
  });
});
