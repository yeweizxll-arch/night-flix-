export type PaymentScope = 'platform' | 'tenant';
export type CollectionMode = 'platform_collect' | 'tenant_direct';
export type StripeMode = 'live' | 'test';
export type StripeTestStatus = 'failed' | 'passed' | 'untested';

export interface PaymentConfigRecord {
  accountId?: string | null;
  id: string;
  label: string;
  mode?: StripeMode | null;
  ownerType?: 'platform' | 'tenant';
  provider: string;
  publicMetadata: Record<string, unknown>;
  status: 'active' | 'disabled';
  testStatus?: StripeTestStatus | null;
  version: number;
}

export function stripeCollectionMode(
  scope: PaymentScope,
): CollectionMode {
  return scope === 'platform' ? 'platform_collect' : 'tenant_direct';
}

export function stripeCreatePath(apiBase: string, scope: PaymentScope): string {
  return scope === 'platform' ? `${apiBase}/stripe` : `${apiBase}/configs/stripe`;
}

export function stripeActionPath(
  apiBase: string,
  scope: PaymentScope,
  configId: string,
  action: 'credentials' | 'disable' | 'enable' | 'test',
): string {
  const prefix = scope === 'platform'
    ? `${apiBase}/${encodeURIComponent(configId)}/stripe`
    : `${apiBase}/configs/${encodeURIComponent(configId)}/stripe`;
  return `${prefix}/${action}`;
}

export function canManageConfig(
  config: PaymentConfigRecord,
  scope: PaymentScope,
): boolean {
  return scope === 'platform' || config.ownerType === 'tenant';
}

export function configMatchesMode(
  config: PaymentConfigRecord,
  mode: CollectionMode,
): boolean {
  if (config.status !== 'active') return false;
  return mode === 'platform_collect'
    ? config.ownerType === 'platform'
    : config.ownerType === 'tenant';
}

export function stripeSummary(config: PaymentConfigRecord): {
  accountId: string;
  mode: StripeMode;
  testStatus: StripeTestStatus;
} | undefined {
  if (
    config.provider !== 'stripe'
    || typeof config.accountId !== 'string'
    || (config.mode !== 'test' && config.mode !== 'live')
    || !['failed', 'passed', 'untested'].includes(String(config.testStatus))
  ) return undefined;
  return {
    accountId: config.accountId,
    mode: config.mode,
    testStatus: config.testStatus as StripeTestStatus,
  };
}

export function isVersionConflict(reason: unknown): boolean {
  return Boolean(
    reason
    && typeof reason === 'object'
    && 'status' in reason
    && (reason as { status?: unknown }).status === 409,
  );
}
