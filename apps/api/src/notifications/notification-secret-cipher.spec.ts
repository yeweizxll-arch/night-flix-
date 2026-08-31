import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadNotificationKeyring,
  NotificationSecretCipher,
} from './notification-secret-cipher';

const key = randomBytes(32);
const keyring = { activeVersion: 7, keys: new Map([[7, key]]) };

describe('NotificationSecretCipher', () => {
  const originalEnvironment = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnvironment };
  });

  it('encrypts device tokens without plaintext and binds every identity field through AAD', () => {
    const cipher = new NotificationSecretCipher(keyring);
    const binding = {
      accountId: '018f2f45-7f5e-7e70-b17f-f6e77357c001',
      deviceId: '018f2f45-7f5e-7e70-b17f-f6e77357c002',
      kind: 'device_token' as const,
      platform: 'ios' as const,
      tenantId: '018f2f45-7f5e-7e70-b17f-f6e77357c003',
      tokenId: '018f2f45-7f5e-7e70-b17f-f6e77357c004',
    };
    const encrypted = cipher.encryptDeviceToken('device-token-secret-value', binding);
    expect(encrypted.ciphertext).not.toContain('device-token-secret-value');
    expect(encrypted.tokenDigest).toMatch(/^hmac-sha256\.7\.[A-Za-z0-9_-]{43}$/);
    expect(encrypted.tokenSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(cipher.decryptDeviceToken(encrypted.ciphertext, {
      ...binding, keyVersion: encrypted.keyVersion,
    })).toBe('device-token-secret-value');
    expect(() => cipher.decryptDeviceToken(encrypted.ciphertext, {
      ...binding,
      accountId: '018f2f45-7f5e-7e70-b17f-f6e77357c099',
      keyVersion: encrypted.keyVersion,
    })).toThrow(/authentication failed/);
  });

  it('binds provider credentials to tenant, provider, config and key version', () => {
    const cipher = new NotificationSecretCipher(keyring);
    const binding = {
      configId: '018f2f45-7f5e-7e70-b17f-f6e77357c010',
      environment: 'production' as const,
      kind: 'provider_config' as const,
      provider: 'fcm' as const,
      tenantId: '018f2f45-7f5e-7e70-b17f-f6e77357c011',
    };
    const secret = { type: 'fcm', projectId: 'project-123',
      clientEmail: 'push@example.com', environment: 'production', privateKey: 'x'.repeat(64) };
    const encrypted = cipher.encryptProviderCredentials(secret, binding);
    expect(encrypted.ciphertext).not.toContain('push@example.com');
    expect(cipher.decryptProviderCredentials(encrypted.ciphertext, {
      ...binding, keyVersion: encrypted.keyVersion,
    })).toEqual(secret);
    expect(() => cipher.decryptProviderCredentials(encrypted.ciphertext, {
      ...binding, provider: 'apns', keyVersion: encrypted.keyVersion,
    })).toThrow(/authentication failed/);
    expect(() => cipher.decryptProviderCredentials(encrypted.ciphertext, {
      ...binding, environment: 'sandbox', keyVersion: encrypted.keyVersion,
    })).toThrow(/authentication failed/);
  });

  it('requires an explicitly configured 32-byte keyring in production', () => {
    process.env = { NODE_ENV: 'production' };
    expect(() => loadNotificationKeyring(process.env)).toThrow(/must be configured together/);
    const key = randomBytes(32).toString('base64');
    expect(loadNotificationKeyring({ NODE_ENV: 'production',
      NOTIFICATION_ACTIVE_KEY_VERSION: '2',
      NOTIFICATION_MASTER_KEYS: JSON.stringify({ 2: key }) })).toMatchObject({ activeVersion: 2 });
  });

  it('reads legacy nc1 provider secrets only as the migration default production environment', () => {
    const cipher = new NotificationSecretCipher(keyring);
    const binding = {
      configId: '018f2f45-7f5e-7e70-b17f-f6e77357c020',
      keyVersion: 7,
      kind: 'provider_config' as const,
      provider: 'fcm' as const,
      tenantId: '018f2f45-7f5e-7e70-b17f-f6e77357c021',
    };
    const plaintext = JSON.stringify({ type: 'fcm', projectId: 'legacy-project',
      clientEmail: 'legacy@example.com', privateKey: 'x'.repeat(64) });
    const iv = randomBytes(12);
    const legacy = createCipheriv('aes-256-gcm', key, iv);
    legacy.setAAD(Buffer.from(JSON.stringify(binding)));
    const ciphertext = Buffer.concat([legacy.update(plaintext), legacy.final()]);
    const envelope = ['nc1', '7', iv.toString('base64url'), ciphertext.toString('base64url'),
      legacy.getAuthTag().toString('base64url')].join('.');

    expect(cipher.decryptProviderCredentials(envelope, {
      ...binding, environment: 'production',
    })).toMatchObject({ environment: 'production', projectId: 'legacy-project' });
    expect(() => cipher.decryptProviderCredentials(envelope, {
      ...binding, environment: 'sandbox',
    })).toThrow(/authentication failed/);
  });
});
