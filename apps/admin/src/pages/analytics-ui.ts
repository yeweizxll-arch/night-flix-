export type AnalyticsCurrency = 'CNY' | 'USD' | 'EUR' | 'JPY' | 'KRW';

export interface CursorState {
  current?: string;
  history: Array<string | undefined>;
}

export interface WithdrawalSummaryGroup {
  amounts: Array<{ amountMinor: string; currency: AnalyticsCurrency }>;
  count: number;
  status: string;
}

export function formatMinorDecimal(value: string, currency: AnalyticsCurrency): string {
  if (!/^-?\d+$/.test(value)) throw new Error('Invalid decimal minor amount');
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const fractionDigits = currency === 'JPY' || currency === 'KRW' ? 0 : 2;
  const padded = unsigned.padStart(fractionDigits + 1, '0');
  const integerPart = fractionDigits ? padded.slice(0, -fractionDigits) : padded;
  const fractionPart = fractionDigits ? padded.slice(-fractionDigits) : '';
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${currency} ${negative ? '-' : ''}${grouped}${fractionPart ? `.${fractionPart}` : ''}`;
}

export function validateAnalyticsDateRange(
  from: string,
  to: string,
  today: string,
): { error?: string; valid: boolean } {
  const fromDate = calendarDate(from);
  const toDate = calendarDate(to);
  const todayDate = calendarDate(today);
  if (!fromDate || !toDate || !todayDate) return { error: '请输入有效日期', valid: false };
  if (fromDate > toDate) return { error: '开始日期不能晚于结束日期', valid: false };
  if (toDate > todayDate) return { error: '结束日期不能晚于今天', valid: false };
  const days = Math.round((toDate - fromDate) / 86_400_000) + 1;
  if (days > 90) return { error: '日期范围不能超过 90 天', valid: false };
  return { valid: true };
}

export function advanceCursor(state: CursorState, nextCursor: string): CursorState {
  if (!nextCursor) return state;
  return { current: nextCursor, history: [...state.history, state.current] };
}

export function retreatCursor(state: CursorState): CursorState {
  if (!state.history.length) return state;
  const history = state.history.slice(0, -1);
  return { current: state.history.at(-1), history };
}

export function visibleWithdrawalGroups<T extends WithdrawalSummaryGroup>(groups: T[]): T[] {
  return groups.filter((group) => group.count > 0 || group.amounts.length > 0);
}

function calendarDate(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const [year, month, day] = value.split('-').map(Number);
  const timestamp = Date.UTC(year ?? 0, (month ?? 0) - 1, day);
  const date = new Date(timestamp);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day) return undefined;
  return timestamp;
}
