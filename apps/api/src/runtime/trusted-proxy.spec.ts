import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { resolveTrustProxy } from './trusted-proxy';

describe('trusted reverse proxies', () => {
  it('rejects blanket and hop-count trust', () => {
    for (const value of ['true', '1', '2', '0.0.0.0/0', 'example.com', '127.0.0.1,']) {
      expect(() => resolveTrustProxy({ TRUST_PROXY: value })).toThrow();
    }
    expect(resolveTrustProxy({})).toBe(false);
  });
  it('ignores forwarding headers from an untrusted origin', async () => {
    const app = Fastify({ trustProxy: resolveTrustProxy({ TRUST_PROXY: '10.20.0.0/24' }) });
    app.get('/', (request) => ({ host: request.host, ip: request.ip }));
    const response = await app.inject({ url: '/', remoteAddress: '198.51.100.5',
      headers: { host: 'actual.example', 'x-forwarded-host': 'forged.example', 'x-forwarded-for': '127.0.0.1' } });
    expect(response.json()).toEqual({ host: 'actual.example', ip: '198.51.100.5' });
    await app.close();
  });
});
