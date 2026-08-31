import { describe, expect, it } from 'vitest';

import { canStartTenantFullRefund } from './RefundManagementPanel';

describe('refund UI eligibility', () => {
  it('only permits paid tenant-direct orders without an existing refund', () => {
    expect(canStartTenantFullRefund({ collectionMode: 'tenant_direct', status: 'paid' }, false)).toBe(true);
    expect(canStartTenantFullRefund({ collectionMode: 'platform_collect', status: 'paid' }, false)).toBe(false);
    expect(canStartTenantFullRefund({ status: 'paid' }, false)).toBe(false);
    expect(canStartTenantFullRefund({ collectionMode: 'tenant_direct', status: 'pending_payment' }, false)).toBe(false);
    expect(canStartTenantFullRefund({ collectionMode: 'tenant_direct', status: 'paid' }, true)).toBe(false);
  });
});
