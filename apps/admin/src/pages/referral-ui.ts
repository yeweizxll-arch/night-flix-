export function formatBpsAsPercent(bps: number): string {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error('佣金比例数据无效');
  }
  const whole = Math.floor(bps / 100);
  const fraction = String(bps % 100).padStart(2, '0');
  return `${whole}.${fraction}`;
}

export function parsePercentToBps(raw: string): number {
  const value = raw.trim();
  const match = /^(0|[1-9]\d{0,2})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error('佣金比例最多保留两位小数');
  const bps = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (bps < 0 || bps > 10_000) throw new Error('佣金比例必须在 0% 到 100% 之间');
  return bps;
}
