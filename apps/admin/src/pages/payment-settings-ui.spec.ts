import { describe, expect, it } from 'vitest';

import {
  canManageConfig,
  configMatchesMode,
  stripeActionPath,
  stripeCreatePath,
  stripeSummary,
  type PaymentConfigRecord,
} from './payment-settings-ui';

const tenantStripe: PaymentConfigRecord = {
  accountId: 'acct_12345678',
  id: '018f2f45-7f5e-7e70-b17f-f6e77357d001',
  label: 'Stripe test',
  mode: 'test',
  ownerType: 'tenant',
  provider: 'stripe',
  publicMetadata: { ui: 'hosted_checkout' },
  status: 'active',
  testStatus: 'passed',
  version: 2,
};

describe('payment settings UI helpers', () => {
  it('keeps platform and tenant Stripe endpoints isolated', () => {
    expect(stripeCreatePath('/api/v1/platform/payments/configs', 'platform'))
      .toBe('/api/v1/platform/payments/configs/stripe');
    expect(stripeActionPath(
      '/api/v1/tenant/commerce/payments',
      'tenant',
      tenantStripe.id,
      'credentials',
    )).toBe(`/api/v1/tenant/commerce/payments/configs/${tenantStripe.id}/stripe/credentials`);
  });

  it('only lets tenants manage their own configs and route to active configs', () => {
    expect(canManageConfig(tenantStripe, 'tenant')).toBe(true);
    expect(canManageConfig({ ...tenantStripe, ownerType: 'platform' }, 'tenant')).toBe(false);
    expect(configMatchesMode(tenantStripe, 'tenant_direct')).toBe(true);
    expect(configMatchesMode({ ...tenantStripe, status: 'disabled' }, 'tenant_direct')).toBe(false);
    expect(configMatchesMode({ ...tenantStripe, ownerType: 'platform' }, 'platform_collect')).toBe(true);
  });

  it('projects only non-secret Stripe metadata for display', () => {
    const summary = stripeSummary({
      ...tenantStripe,
      publicMetadata: {
        secretKey: 'sk_test_must_not_render',
        webhookSecret: 'whsec_must_not_render',
      },
    });
    expect(summary).toEqual({
      accountId: 'acct_12345678',
      mode: 'test',
      testStatus: 'passed',
    });
    expect(JSON.stringify(summary)).not.toMatch(/sk_test|whsec|secret/i);
  });
});
