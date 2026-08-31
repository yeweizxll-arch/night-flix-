import { Injectable } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

const ENVELOPE_VERSION = 'pc1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type StripeMode = 'live' | 'test';
export interface PaymentConfigOwner {
  ownerType: 'platform' | 'tenant';
  tenantId: string | null;
}

export interface PaymentKeyring {
  activeVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

export interface StripeCredentials {
  accountId: string;
  mode: StripeMode;
  secretKey: string;
  webhookSecret: string;
}

export type PaymentSecretBinding = PaymentConfigOwner & {
  accountId: string;
  configId: string;
  credentialKeyVersion: number;
  mode: StripeMode;
  secretVersion: number;
  valueKind: 'secret_key' | 'webhook_secret';
};

@Injectable()
export class PaymentSecretCipher {
  private readonly keyring: PaymentKeyring | undefined;

  constructor(keyring?: PaymentKeyring | null) {
    this.keyring = validateKeyring(
      keyring === null ? undefined : (keyring ?? loadPaymentKeyring()),
    );
  }

  get configured(): boolean {
    return Boolean(this.keyring);
  }

  get activeKeyVersion(): number {
    return this.requireKeyring().activeVersion;
  }

  encryptStripeCredentials(
    rawCredentials: unknown,
    binding: Omit<
      PaymentSecretBinding,
      'credentialKeyVersion' | 'valueKind'
    >,
  ): {
    credentialKeyVersion: number;
    secretKeyCiphertext: string;
    webhookSecretCiphertext: string;
  } {
    validateOwner(binding);
    const credentials = validateStripeCredentials(rawCredentials, binding);
    const credentialKeyVersion = this.activeKeyVersion;
    return {
      credentialKeyVersion,
      secretKeyCiphertext: this.encrypt(credentials.secretKey, {
        ...binding,
        credentialKeyVersion,
        valueKind: 'secret_key',
      }),
      webhookSecretCiphertext: this.encrypt(credentials.webhookSecret, {
        ...binding,
        credentialKeyVersion,
        valueKind: 'webhook_secret',
      }),
    };
  }

  decryptStripeCredentials(
    encrypted: {
      secretKeyCiphertext: string;
      webhookSecretCiphertext: string;
    },
    binding: Omit<PaymentSecretBinding, 'valueKind'>,
  ): StripeCredentials {
    validateOwner(binding);
    const credentials = {
      accountId: binding.accountId,
      mode: binding.mode,
      secretKey: this.decrypt(encrypted.secretKeyCiphertext, {
        ...binding,
        valueKind: 'secret_key',
      }),
      webhookSecret: this.decrypt(encrypted.webhookSecretCiphertext, {
        ...binding,
        valueKind: 'webhook_secret',
      }),
    };
    return validateStripeCredentials(credentials, binding);
  }

  private encrypt(plaintextValue: string, binding: PaymentSecretBinding): string {
    const plaintext = Buffer.from(plaintextValue, 'utf8');
    if (plaintext.length < 16 || plaintext.length > 4096) {
      plaintext.fill(0);
      throw new TypeError('Stripe credential is invalid');
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(
      'aes-256-gcm',
      this.key(binding.credentialKeyVersion),
      iv,
      { authTagLength: TAG_BYTES },
    );
    cipher.setAAD(aad(binding));
    try {
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return [
        ENVELOPE_VERSION,
        binding.credentialKeyVersion,
        iv.toString('base64url'),
        encrypted.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
      ].join('.');
    } finally {
      plaintext.fill(0);
    }
  }

  private decrypt(ciphertext: string, binding: PaymentSecretBinding): string {
    if (typeof ciphertext !== 'string' || ciphertext.length > 16_384) {
      throw new Error('Payment credential ciphertext is invalid');
    }
    const parts = ciphertext.split('.');
    if (
      parts.length !== 5
      || parts[0] !== ENVELOPE_VERSION
      || Number(parts[1]) !== binding.credentialKeyVersion
    ) {
      throw new Error('Payment credential ciphertext is invalid');
    }
    try {
      const iv = Buffer.from(parts[2] ?? '', 'base64url');
      const encrypted = Buffer.from(parts[3] ?? '', 'base64url');
      const tag = Buffer.from(parts[4] ?? '', 'base64url');
      if (
        iv.length !== IV_BYTES || tag.length !== TAG_BYTES
        || encrypted.length < 16 || encrypted.length > 4096
      ) {
        throw new Error('invalid envelope');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.key(binding.credentialKeyVersion),
        iv,
        { authTagLength: TAG_BYTES },
      );
      decipher.setAAD(aad(binding));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      try {
        return plaintext.toString('utf8');
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new Error('Payment credential ciphertext authentication failed');
    }
  }

  private key(version: number): Buffer {
    const key = this.requireKeyring().keys.get(version);
    if (!key) throw new Error('Payment encryption key version is unavailable');
    return key;
  }

  private requireKeyring(): PaymentKeyring {
    if (!this.keyring) throw new Error('Payment secret encryption is not configured');
    return this.keyring;
  }
}

export function loadPaymentKeyring(
  environment: NodeJS.ProcessEnv = process.env,
): PaymentKeyring | undefined {
  const encoded = environment.PAYMENT_MASTER_KEYS;
  const active = environment.PAYMENT_ACTIVE_KEY_VERSION;
  if (!encoded || !active) {
    if (!encoded && !active && environment.NODE_ENV !== 'production') return undefined;
    throw new Error('PAYMENT_MASTER_KEYS and PAYMENT_ACTIVE_KEY_VERSION are required');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error('PAYMENT_MASTER_KEYS must be a JSON object');
  }
  if (!record(parsed)) throw new Error('PAYMENT_MASTER_KEYS must be a JSON object');
  const keys = new Map<number, Buffer>();
  for (const [rawVersion, rawKey] of Object.entries(parsed)) {
    const version = Number(rawVersion);
    if (
      !Number.isInteger(version) || version < 1 || version > 2_147_483_647
      || typeof rawKey !== 'string'
    ) {
      throw new Error('Payment keyring is invalid');
    }
    const key = Buffer.from(rawKey, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== rawKey) {
      throw new Error(`Payment key version ${version} must contain exactly 32 bytes`);
    }
    keys.set(version, key);
  }
  const activeVersion = Number(active);
  return validateKeyring({ activeVersion, keys });
}

function validateKeyring(keyring: PaymentKeyring | undefined): PaymentKeyring | undefined {
  if (!keyring) return undefined;
  if (
    !Number.isInteger(keyring.activeVersion) || keyring.activeVersion < 1
    || !keyring.keys.has(keyring.activeVersion)
    || [...keyring.keys.values()].some((key) => key.length !== KEY_BYTES)
  ) {
    throw new Error('Payment keyring is invalid');
  }
  return keyring;
}

function validateStripeCredentials(
  value: unknown,
  binding: Pick<PaymentSecretBinding, 'accountId' | 'mode'>,
): StripeCredentials {
  if (!record(value)) throw new TypeError('Stripe credentials are invalid');
  rejectUnknown(value, ['accountId', 'mode', 'secretKey', 'webhookSecret']);
  if (
    value.accountId !== binding.accountId
    || value.mode !== binding.mode
    || typeof value.secretKey !== 'string'
    || typeof value.webhookSecret !== 'string'
    || !/^acct_[A-Za-z0-9]{8,64}$/.test(binding.accountId)
    || !/^whsec_[A-Za-z0-9_-]{16,512}$/.test(value.webhookSecret)
  ) {
    throw new TypeError('Stripe credentials are invalid');
  }
  const expectedMode = binding.mode === 'live' ? 'live' : 'test';
  if (!new RegExp(`^(?:sk|rk)_${expectedMode}_[A-Za-z0-9_\\-]{16,512}$`).test(value.secretKey)) {
    throw new TypeError('Stripe credentials do not match the configured mode');
  }
  return {
    accountId: binding.accountId,
    mode: binding.mode,
    secretKey: value.secretKey,
    webhookSecret: value.webhookSecret,
  };
}

function aad(binding: PaymentSecretBinding): Buffer {
  return Buffer.from([
    'stripe', binding.ownerType, binding.tenantId ?? 'platform', binding.configId,
    binding.mode, binding.accountId, binding.secretVersion,
    binding.credentialKeyVersion, binding.valueKind,
  ].join('\0'), 'utf8');
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('Stripe credentials contain unknown fields');
  }
}

function validateOwner(binding: PaymentConfigOwner): void {
  if (
    (binding.ownerType === 'platform' && binding.tenantId !== null)
    || (binding.ownerType === 'tenant'
      && (typeof binding.tenantId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
          .test(binding.tenantId)))
  ) {
    throw new TypeError('Payment secret owner binding is invalid');
  }
}
