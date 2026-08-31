import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'fp1';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export interface PayoutAccountSnapshot {
  accountHolder: string;
  accountNumber: string;
  bankName: string;
  countryCode: string;
  routingCode?: string;
}

export interface FinancePayoutKeyring {
  activeVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

export class FinancePayoutCipher {
  private readonly keyring: FinancePayoutKeyring | undefined;

  constructor(keyring?: FinancePayoutKeyring | null) {
    this.keyring = validateKeyring(keyring === null ? undefined : (keyring ?? loadKeyring()));
  }

  get configured(): boolean {
    return Boolean(this.keyring);
  }

  encrypt(
    input: PayoutAccountSnapshot,
    binding: { tenantId: string; withdrawalId: string },
  ): { ciphertext: string; fingerprint: string; keyVersion: number } {
    const snapshot = validatePayoutAccount(input);
    const keyring = this.requireKeyring();
    const keyVersion = keyring.activeVersion;
    const key = keyring.keys.get(keyVersion);
    if (!key) throw new Error('Finance payout encryption key is unavailable');
    validateBinding(binding);
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(binding, keyVersion));
    const plaintext = Buffer.from(JSON.stringify(snapshot), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    plaintext.fill(0);
    return {
      ciphertext: [
        VERSION,
        String(keyVersion),
        iv.toString('base64url'),
        encrypted.toString('base64url'),
        tag.toString('base64url'),
      ].join('.'),
      fingerprint: `${snapshot.bankName} ••••${snapshot.accountNumber.slice(-4)}`,
      keyVersion,
    };
  }

  decrypt(
    ciphertext: string,
    keyVersion: number,
    binding: { tenantId: string; withdrawalId: string },
  ): PayoutAccountSnapshot {
    validateBinding(binding);
    const keyring = this.requireKeyring();
    const parts = ciphertext.split('.');
    if (parts.length !== 5 || parts[0] !== VERSION || Number(parts[1]) !== keyVersion) {
      throw new Error('Finance payout ciphertext is invalid');
    }
    const key = keyring.keys.get(keyVersion);
    if (!key) throw new Error('Finance payout decryption key is unavailable');
    try {
      const iv = Buffer.from(parts[2] ?? '', 'base64url');
      const encrypted = Buffer.from(parts[3] ?? '', 'base64url');
      const tag = Buffer.from(parts[4] ?? '', 'base64url');
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES || encrypted.length < 2) {
        throw new Error('invalid envelope');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(aad(binding, keyVersion));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      try {
        return validatePayoutAccount(JSON.parse(plaintext.toString('utf8')) as unknown);
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new Error('Finance payout ciphertext authentication failed');
    }
  }

  private requireKeyring(): FinancePayoutKeyring {
    if (!this.keyring) throw new Error('Finance payout encryption is not configured');
    return this.keyring;
  }
}

function loadKeyring(environment: NodeJS.ProcessEnv = process.env): FinancePayoutKeyring | undefined {
  const encoded = environment.FINANCE_PAYOUT_MASTER_KEYS;
  const active = environment.FINANCE_PAYOUT_ACTIVE_KEY_VERSION;
  if (!encoded || !active) {
    if (!encoded && !active && environment.NODE_ENV !== 'production') return undefined;
    throw new Error(
      'FINANCE_PAYOUT_MASTER_KEYS and FINANCE_PAYOUT_ACTIVE_KEY_VERSION must be configured together',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error('FINANCE_PAYOUT_MASTER_KEYS must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('FINANCE_PAYOUT_MASTER_KEYS must be a JSON object');
  }
  const keys = new Map<number, Buffer>();
  for (const [versionValue, keyValue] of Object.entries(parsed)) {
    const version = positiveInteger(versionValue);
    if (typeof keyValue !== 'string') throw new Error('Finance payout key must be base64');
    const key = Buffer.from(keyValue, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== keyValue) {
      throw new Error(`Finance payout key version ${version} must contain 32 bytes`);
    }
    keys.set(version, key);
  }
  return validateKeyring({ activeVersion: positiveInteger(active), keys });
}

function validateKeyring(keyring: FinancePayoutKeyring | undefined): FinancePayoutKeyring | undefined {
  if (!keyring) return undefined;
  const activeVersion = positiveInteger(keyring.activeVersion);
  if (!(keyring.keys instanceof Map) || keyring.keys.size < 1 || keyring.keys.size > 32) {
    throw new Error('Finance payout keyring must contain 1 to 32 keys');
  }
  const keys = new Map<number, Buffer>();
  for (const [version, key] of keyring.keys) {
    if (!Number.isSafeInteger(version) || version < 1 || !Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
      throw new Error('Finance payout keyring is invalid');
    }
    keys.set(version, Buffer.from(key));
  }
  if (!keys.has(activeVersion)) throw new Error('Active finance payout key is unavailable');
  return { activeVersion, keys };
}

function validatePayoutAccount(input: unknown): PayoutAccountSnapshot {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('payoutAccount is invalid');
  }
  const value = input as Record<string, unknown>;
  const result: PayoutAccountSnapshot = {
    accountHolder: bounded(value.accountHolder, 'accountHolder', 2, 200),
    accountNumber: bounded(value.accountNumber, 'accountNumber', 4, 64),
    bankName: bounded(value.bankName, 'bankName', 2, 200),
    countryCode: bounded(value.countryCode, 'countryCode', 2, 2).toUpperCase(),
  };
  if (!/^[A-Z]{2}$/.test(result.countryCode)) throw new TypeError('countryCode is invalid');
  if (value.routingCode !== undefined) {
    result.routingCode = bounded(value.routingCode, 'routingCode', 2, 64);
  }
  return result;
}

function bounded(value: unknown, field: string, minimum: number, maximum: number): string {
  if (typeof value !== 'string') throw new TypeError(`${field} is invalid`);
  const normalized = value.trim();
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || /[\u0000\r\n]/.test(normalized)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function validateBinding(binding: { tenantId: string; withdrawalId: string }): void {
  if (!isUuid(binding.tenantId) || !isUuid(binding.withdrawalId)) {
    throw new TypeError('Finance payout binding is invalid');
  }
}

function aad(binding: { tenantId: string; withdrawalId: string }, keyVersion: number): Buffer {
  return Buffer.from([
    'finance-payout', VERSION, keyVersion, binding.tenantId, binding.withdrawalId,
  ].join('|'), 'utf8');
}

function positiveInteger(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new Error('Finance payout key version is invalid');
  }
  return parsed;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
