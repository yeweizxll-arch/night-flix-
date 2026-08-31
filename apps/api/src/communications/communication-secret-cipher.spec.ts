import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';

import {
  CommunicationSecretCipher,
  loadCommunicationKeyring,
} from './communication-secret-cipher';

const keyring = { activeVersion: 4, keys: new Map([[4, randomBytes(32)]]) };
const tenantId = '11111111-1111-4111-8111-111111111111';
const configId = '22222222-2222-4222-8222-222222222222';
const challengeId = '33333333-3333-4333-8333-333333333333';
const jobId = '44444444-4444-4444-8444-444444444444';

describe('CommunicationSecretCipher', () => {
  const environment = { ...process.env };
  afterEach(() => { process.env = { ...environment }; });

  it('encrypts provider credentials and binds tenant/channel/provider/config/key-version AAD', () => {
    const cipher = new CommunicationSecretCipher(keyring);
    const binding = { channel: 'email' as const, configId, kind: 'provider' as const,
      provider: 'resend' as const, tenantId };
    const credentials = { apiKey: `re_${'a'.repeat(32)}`,
      fromEmail: 'security@example.com', type: 'resend' as const };
    const encrypted = cipher.encryptCredentials(credentials, binding);
    expect(encrypted.ciphertext).not.toContain(credentials.apiKey);
    expect(encrypted.ciphertext).not.toContain(credentials.fromEmail);
    expect(cipher.decryptCredentials(encrypted.ciphertext, {
      ...binding, keyVersion: encrypted.keyVersion,
    })).toEqual(credentials);
    expect(() => cipher.decryptCredentials(encrypted.ciphertext, {
      ...binding, tenantId: '55555555-5555-4555-8555-555555555555',
      keyVersion: encrypted.keyVersion,
    })).toThrow(/authentication failed/);
  });

  it('keeps code and destination encrypted and binds the entire OTP identity', () => {
    const cipher = new CommunicationSecretCipher(keyring);
    const binding = { challengeId, channel: 'email' as const, jobId,
      kind: 'otp' as const, purpose: 'password_reset', tenantId };
    const encrypted = cipher.encryptOtpPayload(
      { code: '123456', destination: '+tag@example.com' }, binding,
    );
    expect(encrypted.ciphertext).not.toContain('123456');
    expect(encrypted.ciphertext).not.toContain('+tag@example.com');
    expect(cipher.decryptOtpPayload(encrypted.ciphertext, {
      ...binding, keyVersion: encrypted.keyVersion,
    })).toEqual({ code: '123456', destination: '+tag@example.com' });
    expect(() => cipher.decryptOtpPayload(encrypted.ciphertext, {
      ...binding, purpose: 'login', keyVersion: encrypted.keyVersion,
    })).toThrow(/authentication failed/);
  });

  it('strictly requires a valid production keyring', () => {
    expect(() => loadCommunicationKeyring({ NODE_ENV: 'production' })).toThrow(/required/);
    const key = randomBytes(32).toString('base64');
    expect(loadCommunicationKeyring({ NODE_ENV: 'production',
      COMMUNICATION_ACTIVE_KEY_VERSION: '2',
      COMMUNICATION_MASTER_KEYS: JSON.stringify({ 2: key }) })).toMatchObject({ activeVersion: 2 });
    expect(() => loadCommunicationKeyring({ NODE_ENV: 'production',
      COMMUNICATION_ACTIVE_KEY_VERSION: '2',
      COMMUNICATION_MASTER_KEYS: JSON.stringify({ 2: 'bad' }) })).toThrow(/32 bytes/);
  });
});
