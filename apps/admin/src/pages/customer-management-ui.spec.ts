import { describe, expect, it } from 'vitest';

import { customerResourcePath, isValidTenantId } from './customer-management-ui';

describe('customer management URL safety', () => {
  it('puts an action before the exact platform tenant query', () => {
    expect(customerResourcePath(
      '/api/v1/platform/customers',
      'account/value',
      '018f2f45-7f5e-7e70-b17f-f6e77357d003',
      'status',
    )).toBe(
      '/api/v1/platform/customers/account%2Fvalue/status'
      + '?tenantId=018f2f45-7f5e-7e70-b17f-f6e77357d003',
    );
  });

  it('does not add a platform tenant query to tenant routes', () => {
    expect(customerResourcePath('/api/v1/tenant/customers', 'customer-1', undefined, 'revoke-sessions'))
      .toBe('/api/v1/tenant/customers/customer-1/revoke-sessions');
  });

  it('requires a syntactically valid UUID before platform lookup', () => {
    expect(isValidTenantId('018f2f45-7f5e-7e70-b17f-f6e77357d003')).toBe(true);
    expect(isValidTenantId('all')).toBe(false);
    expect(isValidTenantId('00000000-0000-0000-0000-000000000000')).toBe(false);
  });
});
