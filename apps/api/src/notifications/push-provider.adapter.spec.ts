import { afterEach, describe, expect, it } from 'vitest';

import { FakePushProviderAdapter, PushAdapterRegistry } from './push-provider.adapter';

const originalNodeEnv = process.env.NODE_ENV;
afterEach(() => { process.env.NODE_ENV = originalNodeEnv; });

describe('push provider adapter boundary', () => {
  it('never silently falls back when a tenant provider adapter is absent', () => {
    expect(() => new PushAdapterRegistry([]).require('apns')).toThrow(/no push was sent/);
  });

  it('forbids the fake adapter in production', () => {
    process.env.NODE_ENV = 'production';
    expect(() => new FakePushProviderAdapter('fcm')).toThrow(/forbidden/);
  });
});
