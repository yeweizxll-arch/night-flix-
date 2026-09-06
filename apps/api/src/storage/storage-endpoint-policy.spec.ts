import { describe, expect, it } from 'vitest';

import {
  validatePublicHttpsOrigin,
  validateStorageEndpoint,
} from './storage-endpoint-policy';

describe('validateStorageEndpoint', () => {
  it.each([
    'https://127.0.0.1',
    'https://[::1]',
    'https://169.254.169.254',
    'https://[::ffff:127.0.0.1]',
    'https://10.0.0.1',
    'https://[fd00::1]',
  ])('rejects private or special target %s', (endpoint) => {
    expect(() => validateStorageEndpoint(endpoint, { NODE_ENV: 'test' })).toThrow(
      /public hostname/,
    );
  });

  it.each([
    'http://storage.example.com',
    'https://user:pass@storage.example.com',
    'https://storage.example.com/path',
    'https://storage.example.com/?region=1',
    'https://storage.example.com/#fragment',
  ])('rejects an unsafe endpoint shape %s', (endpoint) => {
    expect(() => validateStorageEndpoint(endpoint, { NODE_ENV: 'test' })).toThrow(
      /credential-free HTTPS origin/,
    );
  });

  it('requires and enforces an allowlist for custom production endpoints', () => {
    expect(() => validateStorageEndpoint('https://storage.example.com', {
      NODE_ENV: 'production',
    })).toThrow(/HOST_ALLOWLIST is required/);

    expect(() => validateStorageEndpoint('https://evil.example.net', {
      NODE_ENV: 'production',
      STORAGE_ENDPOINT_HOST_ALLOWLIST: 'storage.example.com,*.objects.example.com',
    })).toThrow(/not allowlisted/);

    expect(validateStorageEndpoint('https://tenant.objects.example.com', {
      NODE_ENV: 'production',
      STORAGE_ENDPOINT_HOST_ALLOWLIST: 'storage.example.com,*.objects.example.com',
    }).hostname).toBe('tenant.objects.example.com');
  });

  it('does not let a wildcard match the suffix apex or sibling labels', () => {
    const environment = {
      NODE_ENV: 'production',
      STORAGE_ENDPOINT_HOST_ALLOWLIST: '*.objects.example.com',
    };
    expect(() => validateStorageEndpoint('https://objects.example.com', environment)).toThrow(
      /not allowlisted/,
    );
    expect(() => validateStorageEndpoint('https://badobjects.example.com', environment)).toThrow(
      /not allowlisted/,
    );
  });

  it('accepts only the explicitly allowlisted public IPv4 gateway', () => {
    const environment = { NODE_ENV: 'production', STORAGE_ENDPOINT_HOST_ALLOWLIST: '47.110.245.29' };
    expect(validateStorageEndpoint('https://47.110.245.29', environment).origin).toBe('https://47.110.245.29');
    expect(() => validateStorageEndpoint('https://47.110.245.30', environment)).toThrow(/not allowlisted/);
    expect(() => validateStorageEndpoint('http://47.110.245.29', environment)).toThrow(/HTTPS origin/);
  });

  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '*.47.110.245.29', '*', 'https://47.110.245.29'])('rejects unsafe allowlist entry %s', (entry) => {
    expect(() => validateStorageEndpoint('https://storage.example.com', {
      NODE_ENV: 'production',
      STORAGE_ENDPOINT_HOST_ALLOWLIST: entry,
    })).toThrow(/HOST_ALLOWLIST is invalid/);
  });
});

describe('validatePublicHttpsOrigin', () => {
  it('accepts a public CDN origin without the storage endpoint allowlist', () => {
    expect(validatePublicHttpsOrigin('https://cdn.example.net').origin)
      .toBe('https://cdn.example.net');
  });

  it.each([
    'http://cdn.example.net',
    'https://user:pass@cdn.example.net',
    'https://cdn.example.net/path',
    'https://127.0.0.1',
  ])('rejects an unsafe CDN origin: %s', (origin) => {
    expect(() => validatePublicHttpsOrigin(origin)).toThrow();
  });
});
