import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifiedRequestCountry } from './trusted-country';
import { TenantContextService, currentRequestCountry } from './tenant-context.service';

describe('trusted request country', () => {
  const key = 'unit-test-edge-key-32-characters-minimum';
  const time = '1800000000';
  const request = {
    method: 'GET', url: '/api/v1/customer/content/dramas',
    headers: { host: 'agent.example.test', 'x-nightflix-country': 'US',
      'x-nightflix-geo-time': time, 'x-nightflix-geo-signature': '' },
  };
  request.headers['x-nightflix-geo-signature'] = createHmac('sha256', key)
    .update([time, 'US', 'GET', request.headers.host, request.url].join('\n')).digest('hex');
  it('requires a fresh, path/host/country bound ingress signature', () => {
    expect(verifiedRequestCountry(request, key, Number(time) * 1000)).toBe('US');
    for (const changed of [
      { ...request, method: 'POST' },
      { ...request, url: '/different' },
      { ...request, headers: { ...request.headers, host: 'another.example.test' } },
      { ...request, headers: { ...request.headers, 'x-nightflix-country': 'GB' } },
      { ...request, headers: { ...request.headers, 'x-nightflix-geo-signature': '0'.repeat(64) } },
      { ...request, headers: { host: 'agent.example.test', 'cf-ipcountry': 'US' } },
    ]) expect(verifiedRequestCountry(changed, key, Number(time) * 1000)).toBeUndefined();
    expect(verifiedRequestCountry(request, key, Number(time) * 1000 + 31000)).toBeUndefined();
    expect(verifiedRequestCountry(request, 'weak', Number(time) * 1000)).toBeUndefined();
  });
  it('isolates simultaneous requests and leaves workers without inferred geolocation', async () => {
    const context = new TenantContextService();
    expect(currentRequestCountry()).toBeUndefined();
    await Promise.all(['US', 'GB'].map((country) => context.run({ host: 'x', country }, async () => {
      await Promise.resolve();
      expect(currentRequestCountry()).toBe(country);
    })));
    expect(currentRequestCountry()).toBeUndefined();
  });
});
