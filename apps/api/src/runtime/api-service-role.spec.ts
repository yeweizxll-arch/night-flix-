import { describe, expect, it } from 'vitest';

import {
  isRouteAllowed,
  resolveApiServiceRole,
  serviceName,
} from './api-service-role';

describe('API service boundaries', () => {
  it.each([
    ['web', '/api/v1/customer/bootstrap', true],
    ['web', '/api/v1/payments/webhooks/config-1', true],
    ['web', '/api/v1/tenant/auth/login', false],
    ['web', '/api/v1/platform/merchants', false],
    ['admin', '/api/v1/platform/merchants', true],
    ['admin', '/api/v1/customer/bootstrap', false],
    ['admin', '/api/v1/tenant/content/dramas', false],
    ['agent', '/api/v1/tenant/content/dramas', true],
    ['agent', '/api/v1/customer/bootstrap', false],
    ['agent', '/api/v1/platform/merchants', false],
    ['agent', '/api/v1/health/ready?probe=1', true],
  ] as const)('%s isolates %s', (role, path, allowed) => {
    expect(isRouteAllowed(role, path)).toBe(allowed);
  });

  it('requires an explicit production role', () => {
    expect(() => resolveApiServiceRole({ NODE_ENV: 'production' })).toThrow(
      'DRAMA_SERVICE_ROLE is required in production',
    );
    expect(resolveApiServiceRole({ DRAMA_SERVICE_ROLE: 'admin' })).toBe('admin');
    expect(serviceName('agent')).toBe('drama-saas-agent');
  });
});
