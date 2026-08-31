import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';
import { Injectable } from '@nestjs/common';

import type {
  CommunicationChannel,
  CommunicationCredentials,
  CommunicationProvider,
} from './communication.types';

const VERSION = 'cc1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface CommunicationKeyring { activeVersion: number; keys: ReadonlyMap<number, Buffer> }

export type CommunicationSecretBinding =
  | {
      configId: string; keyVersion: number; kind: 'provider';
      tenantId: string; channel: CommunicationChannel; provider: CommunicationProvider;
    }
  | {
      challengeId: string; jobId: string; keyVersion: number; kind: 'otp';
      tenantId: string; channel: CommunicationChannel; purpose: string;
    }
  | {
      configId: string; jobId: string; keyVersion: number; kind: 'config_test';
      tenantId: string; channel: CommunicationChannel; provider: CommunicationProvider;
    };

@Injectable()
export class CommunicationSecretCipher {
  private readonly keyring: CommunicationKeyring | undefined;

  constructor(keyring?: CommunicationKeyring | null) {
    this.keyring = keyring === null ? undefined : (keyring ?? loadCommunicationKeyring());
    if (this.keyring) {
      if (!Number.isInteger(this.keyring.activeVersion)
        || !this.keyring.keys.has(this.keyring.activeVersion)
        || [...this.keyring.keys.values()].some((key) => key.length !== KEY_BYTES)) {
        throw new Error('Communication keyring is invalid');
      }
    }
  }

  get configured(): boolean { return Boolean(this.keyring); }
  get activeKeyVersion(): number { return this.requireKeyring().activeVersion; }

  encryptCredentials(
    credentials: unknown,
    binding: Omit<Extract<CommunicationSecretBinding, { kind: 'provider' }>, 'keyVersion'>,
  ): { ciphertext: string; keyVersion: number } {
    const value = validateCredentials(binding.provider, credentials);
    return this.encryptJson(value, { ...binding, keyVersion: this.activeKeyVersion });
  }

  decryptCredentials(
    ciphertext: string,
    binding: Extract<CommunicationSecretBinding, { kind: 'provider' }>,
  ): CommunicationCredentials {
    return validateCredentials(binding.provider, this.decryptJson(ciphertext, binding));
  }

  encryptOtpPayload(
    payload: { code: string; destination: string },
    binding: Omit<Extract<CommunicationSecretBinding, { kind: 'otp' }>, 'keyVersion'>,
  ): { ciphertext: string; keyVersion: number } {
    validateOtpPayload(payload, binding.channel);
    return this.encryptJson(payload, { ...binding, keyVersion: this.activeKeyVersion });
  }

  decryptOtpPayload(
    ciphertext: string,
    binding: Extract<CommunicationSecretBinding, { kind: 'otp' }>,
  ): { code: string; destination: string } {
    return validateOtpPayload(this.decryptJson(ciphertext, binding), binding.channel);
  }

  encryptTestPayload(
    payload: { code: string; destination: string },
    binding: Omit<Extract<CommunicationSecretBinding, { kind: 'config_test' }>, 'keyVersion'>,
  ): { ciphertext: string; keyVersion: number } {
    validateOtpPayload(payload, binding.channel);
    return this.encryptJson(payload, { ...binding, keyVersion: this.activeKeyVersion });
  }

  decryptTestPayload(
    ciphertext: string,
    binding: Extract<CommunicationSecretBinding, { kind: 'config_test' }>,
  ): { code: string; destination: string } {
    return validateOtpPayload(this.decryptJson(ciphertext, binding), binding.channel);
  }

  private encryptJson(
    value: unknown,
    binding: CommunicationSecretBinding,
  ): { ciphertext: string; keyVersion: number } {
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    if (plaintext.length < 8 || plaintext.length > 12_000) {
      plaintext.fill(0);
      throw new Error('Communication secret plaintext is invalid');
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key(binding.keyVersion), iv, {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(aad(binding));
    try {
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return {
        ciphertext: [VERSION, binding.keyVersion, iv.toString('base64url'),
          encrypted.toString('base64url'), cipher.getAuthTag().toString('base64url')].join('.'),
        keyVersion: binding.keyVersion,
      };
    } finally { plaintext.fill(0); }
  }

  private decryptJson(ciphertext: string, binding: CommunicationSecretBinding): unknown {
    if (typeof ciphertext !== 'string' || ciphertext.length > 16_384) {
      throw new Error('Communication secret ciphertext is invalid');
    }
    const parts = ciphertext.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION || Number(parts[1]) !== binding.keyVersion) {
      throw new Error('Communication secret ciphertext is invalid');
    }
    try {
      const iv = Buffer.from(parts[2] ?? '', 'base64url');
      const encrypted = Buffer.from(parts[3] ?? '', 'base64url');
      const tag = Buffer.from(parts[4] ?? '', 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || encrypted.length < 8) {
        throw new Error('invalid envelope');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key(binding.keyVersion), iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(binding));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      try { return JSON.parse(plaintext.toString('utf8')) as unknown; }
      finally { plaintext.fill(0); }
    } catch {
      throw new Error('Communication secret ciphertext authentication failed');
    }
  }

  private key(version: number): Buffer {
    const key = this.requireKeyring().keys.get(version);
    if (!key) throw new Error('Communication encryption key version is unavailable');
    return key;
  }

  private requireKeyring(): CommunicationKeyring {
    if (!this.keyring) throw new Error('Communication secret encryption is not configured');
    return this.keyring;
  }
}

export function loadCommunicationKeyring(
  environment: NodeJS.ProcessEnv = process.env,
): CommunicationKeyring | undefined {
  const encoded = environment.COMMUNICATION_MASTER_KEYS;
  const active = environment.COMMUNICATION_ACTIVE_KEY_VERSION;
  if (!encoded || !active) {
    if (!encoded && !active && environment.NODE_ENV !== 'production') return undefined;
    throw new Error('COMMUNICATION_MASTER_KEYS and COMMUNICATION_ACTIVE_KEY_VERSION are required');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(encoded); }
  catch { throw new Error('COMMUNICATION_MASTER_KEYS must be a JSON object'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('COMMUNICATION_MASTER_KEYS must be a JSON object');
  }
  const keys = new Map<number, Buffer>();
  for (const [rawVersion, rawKey] of Object.entries(parsed)) {
    const version = Number(rawVersion);
    if (!Number.isInteger(version) || version < 1 || version > 2_147_483_647
      || typeof rawKey !== 'string') throw new Error('Communication keyring is invalid');
    const key = Buffer.from(rawKey, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== rawKey) {
      throw new Error(`Communication key version ${version} must contain exactly 32 bytes`);
    }
    keys.set(version, key);
  }
  const activeVersion = Number(active);
  if (!Number.isInteger(activeVersion) || !keys.has(activeVersion)) {
    throw new Error('Active communication key version is unavailable');
  }
  return { activeVersion, keys };
}

function aad(binding: CommunicationSecretBinding): Buffer {
  const fields = binding.kind === 'provider'
    ? [binding.kind, binding.tenantId, binding.channel, binding.provider,
      binding.configId, binding.keyVersion]
    : binding.kind === 'otp'
      ? [binding.kind, binding.tenantId, binding.channel, binding.purpose,
        binding.challengeId, binding.jobId, binding.keyVersion]
      : [binding.kind, binding.tenantId, binding.channel, binding.provider,
        binding.configId, binding.jobId, binding.keyVersion];
  return Buffer.from(fields.join('\0'), 'utf8');
}

function validateCredentials(
  provider: CommunicationProvider,
  value: unknown,
): CommunicationCredentials {
  if (!record(value)) throw new TypeError('Communication credentials are invalid');
  if (provider === 'resend') {
    rejectUnknown(value, ['apiKey', 'fromEmail', 'type']);
    if (typeof value.apiKey !== 'string' || !/^re_[A-Za-z0-9_-]{16,200}$/.test(value.apiKey)
      || typeof value.fromEmail !== 'string' || value.fromEmail.length > 320
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.fromEmail)) {
      throw new TypeError('Resend credentials are invalid');
    }
    return { apiKey: value.apiKey, fromEmail: value.fromEmail.toLowerCase(), type: 'resend' };
  }
  rejectUnknown(value, ['accountSid', 'authToken', 'fromPhone', 'type']);
  if (typeof value.accountSid !== 'string' || !/^AC[0-9a-fA-F]{32}$/.test(value.accountSid)
    || typeof value.authToken !== 'string' || !/^[A-Za-z0-9_-]{16,200}$/.test(value.authToken)
    || typeof value.fromPhone !== 'string' || !/^\+[1-9][0-9]{7,14}$/.test(value.fromPhone)) {
    throw new TypeError('Twilio credentials are invalid');
  }
  return { accountSid: value.accountSid, authToken: value.authToken,
    fromPhone: value.fromPhone, type: 'twilio' };
}

function validateOtpPayload(value: unknown, channel: CommunicationChannel) {
  if (!record(value) || typeof value.code !== 'string' || !/^[0-9]{6}$/.test(value.code)
    || typeof value.destination !== 'string' || value.destination.length > 320
    || (channel === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.destination))
    || (channel === 'sms' && !/^\+[1-9][0-9]{7,14}$/.test(value.destination))) {
    throw new TypeError('OTP delivery payload is invalid');
  }
  return { code: value.code, destination: value.destination };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('Communication credentials contain unsupported fields');
  }
}
