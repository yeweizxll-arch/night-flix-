import { describe, expect, it } from 'vitest';

import { mobileTestConfiguration } from './mobile-config';

describe('mobile internal test configuration', () => {
  it('accepts one exact clean merchant HTTPS origin', () => {
    expect(mobileTestConfiguration({
      MOBILE_SERVER_URL: 'https://video.merchant.example/',
    })).toEqual({
      appId: 'com.drama.saas.test',
      appName: 'Drama SaaS Test',
      serverUrl: 'https://video.merchant.example',
    });
  });

  it.each([
    'http://video.merchant.example',
    'https://user@video.merchant.example',
    'https://video.merchant.example:444',
    'https://video.merchant.example/path',
    'https://127.0.0.1',
    'https://localhost',
  ])('rejects unsafe or ambiguous origins: %s', (serverUrl) => {
    expect(() => mobileTestConfiguration({ MOBILE_SERVER_URL: serverUrl }))
      .toThrow('MOBILE_SERVER_URL');
  });

  it('never starts without an explicit server origin', () => {
    expect(() => mobileTestConfiguration({})).toThrow('MOBILE_SERVER_URL is required');
  });
});
