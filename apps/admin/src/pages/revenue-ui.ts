function currencyDigits(currency: string): number {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
}

export function revenueMajor(minor: string, currency: string): string {
  if (!/^-?\d+$/.test(minor)) throw new Error('金额格式无效');
  const amount = BigInt(minor);
  const digits = currencyDigits(currency);
  const raw = (amount < 0n ? -amount : amount).toString().padStart(digits + 1, '0');
  return `${amount < 0n ? '-' : ''}${digits ? `${raw.slice(0, -digits)}.${raw.slice(-digits)}` : raw}`;
}

export function revenueMoney(minor: string, currency: string): string {
  const [whole, fraction] = revenueMajor(minor, currency).split('.');
  return `${currency} ${whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${fraction === undefined ? '' : `.${fraction}`}`;
}

export function revenueMinor(major: string, currency: string): string {
  const digits = currencyDigits(currency);
  const match = /^(0|[1-9]\d*)(?:\.(\d+))?$/.exec(major.trim());
  if (!match || (match[2]?.length ?? 0) > digits) throw new Error(`${currency} 金额最多保留 ${digits} 位小数`);
  const value = BigInt(match[1]! + (match[2] ?? '').padEnd(digits, '0'));
  if (value > 9223372036854775807n) throw new Error('金额超出支持范围');
  return value.toString();
}

export const revenueIncomeLabels: Record<string, string> = { coin_unlock: '金币解锁', content_ad: '内容广告', membership: '会员' };
export const revenueStatusLabels: Record<string, string> = { pending: '待结算', settled: '已结算', reversed: '已冲正' };
