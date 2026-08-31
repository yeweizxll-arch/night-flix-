import { describe, expect, it } from 'vitest';

import { canAdvanceTlsStatus } from './site-settings-ui';

describe('site settings UI helpers', () => {
  it('allows platform TLS progression for verified subdomains as well as custom domains', () => {
    expect(canAdvanceTlsStatus({
      enabled: true,
      tlsStatus: 'pending',
      verification: { status: 'verified' },
    }, true)).toBe(true);
    expect(canAdvanceTlsStatus({
      enabled: true,
      tlsStatus: 'active',
      verification: { status: 'verified' },
    }, true)).toBe(false);
    expect(canAdvanceTlsStatus({
      enabled: true,
      tlsStatus: 'pending',
      verification: { status: 'pending' },
    }, true)).toBe(false);
  });
});
