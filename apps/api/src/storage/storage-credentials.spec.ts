import { describe, expect, it } from 'vitest';

import {
  loadStorageMasterKeyring,
  StorageCredentialCipher,
} from './storage-credentials';

const providerId = '018f2f48-6a9d-7b23-8c4d-1234567890ab';
const tenantId = '018f2f48-6a9d-7b23-8c4d-1234567890ac';
const credentials = {
  accessKeyId: 'AKIDEXAMPLE',
  forcePathStyle: true,
  region: 'us-east-1',
  secretAccessKey: 'secret-value-that-must-never-leak',
  sessionToken: 'temporary-session-token',
};

function cipher() {
  return new StorageCredentialCipher({
    activeVersion: 2,
    keys: new Map([
      [1, Buffer.alloc(32, 1)],
      [2, Buffer.alloc(32, 2)],
    ]),
  });
}

describe('StorageCredentialCipher', () => {
  it('encrypts nondeterministically and authenticates provider scope', () => {
    const service = cipher();
    const binding = {
      ownerTenantId: tenantId,
      ownerType: 'tenant' as const,
      providerId,
    };
    const first = service.encrypt(credentials, binding);
    const second = service.encrypt(credentials, binding);

    expect(first.keyVersion).toBe(2);
    expect(first.ciphertext).toMatch(/^sc1\.2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    expect(first.ciphertext).not.toContain(credentials.secretAccessKey);
    expect(service.decrypt(first.ciphertext, { ...binding, keyVersion: 2 })).toEqual(credentials);
  });

  it('rejects ciphertext tampering and cross-tenant/provider swaps', () => {
    const service = cipher();
    const encrypted = service.encrypt(credentials, {
      keyVersion: 1,
      ownerTenantId: tenantId,
      ownerType: 'tenant',
      providerId,
    });
    const last = encrypted.ciphertext.at(-1) === 'A' ? 'B' : 'A';
    const tampered = `${encrypted.ciphertext.slice(0, -1)}${last}`;

    expect(() => service.decrypt(tampered, {
      keyVersion: 1,
      ownerTenantId: tenantId,
      ownerType: 'tenant',
      providerId,
    })).toThrow('authentication failed');
    expect(() => service.decrypt(encrypted.ciphertext, {
      keyVersion: 1,
      ownerTenantId: '018f2f48-6a9d-7b23-8c4d-1234567890ad',
      ownerType: 'tenant',
      providerId,
    })).toThrow('authentication failed');
    expect(() => service.decrypt(encrypted.ciphertext, {
      keyVersion: 1,
      ownerTenantId: tenantId,
      ownerType: 'tenant',
      providerId: '018f2f48-6a9d-7b23-8c4d-1234567890ae',
    })).toThrow('authentication failed');
  });

  it('enforces the database key version independently of ciphertext', () => {
    const service = cipher();
    const encrypted = service.encrypt(credentials, {
      keyVersion: 1,
      ownerTenantId: null,
      ownerType: 'platform',
      providerId,
    });
    expect(() => service.decrypt(encrypted.ciphertext, {
      keyVersion: 2,
      ownerTenantId: null,
      ownerType: 'platform',
      providerId,
    })).toThrow('key version does not match');
  });

  it('does not install a development fallback key', () => {
    expect(loadStorageMasterKeyring({ NODE_ENV: 'development' })).toBeUndefined();
    const service = new StorageCredentialCipher(null);
    expect(service.configured).toBe(false);
    expect(() => service.activeKeyVersion).toThrow('not configured');
  });

  it('fails closed when production keys are absent or malformed', () => {
    expect(() => loadStorageMasterKeyring({ NODE_ENV: 'production' })).toThrow(
      'required in production',
    );
    expect(() => loadStorageMasterKeyring({
      NODE_ENV: 'production',
      STORAGE_ACTIVE_KEY_VERSION: '1',
      STORAGE_CREDENTIAL_MASTER_KEYS: JSON.stringify({ 1: 'not-a-32-byte-key' }),
    })).toThrow();
  });

  it('loads a versioned keyring from canonical base64 environment values', () => {
    const loaded = loadStorageMasterKeyring({
      NODE_ENV: 'production',
      STORAGE_ACTIVE_KEY_VERSION: '2',
      STORAGE_CREDENTIAL_MASTER_KEYS: JSON.stringify({
        1: Buffer.alloc(32, 1).toString('base64'),
        2: Buffer.alloc(32, 2).toString('base64'),
      }),
    });
    expect(loaded?.activeVersion).toBe(2);
    expect(loaded?.keys.get(2)).toEqual(Buffer.alloc(32, 2));
  });
});
