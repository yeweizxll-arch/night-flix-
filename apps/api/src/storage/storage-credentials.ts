import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto';

const ENCODING_VERSION = 'sc1';
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const MAX_KEY_VERSION = 2_147_483_647;

export interface S3StorageCredentials {
  accessKeyId: string;
  forcePathStyle?: boolean;
  region: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface StorageCredentialBinding {
  keyVersion: number;
  ownerTenantId: string | null;
  ownerType: 'platform' | 'tenant';
  providerId: string;
}

export interface StorageMasterKeyring {
  activeVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

export class StorageCredentialCipher {
  private readonly keyring: StorageMasterKeyring | undefined;

  constructor(keyring?: StorageMasterKeyring | null) {
    const resolved = keyring === null ? undefined : (keyring ?? loadStorageMasterKeyring());
    this.keyring = resolved ? validateKeyring(resolved) : undefined;
  }

  get configured(): boolean {
    return Boolean(this.keyring);
  }

  get activeKeyVersion(): number {
    return this.requireKeyring().activeVersion;
  }

  encrypt(
    rawCredentials: S3StorageCredentials,
    rawBinding: Omit<StorageCredentialBinding, 'keyVersion'> & { keyVersion?: number },
  ): { ciphertext: string; keyVersion: number } {
    const credentials = validateCredentials(rawCredentials);
    const keyring = this.requireKeyring();
    const keyVersion = rawBinding.keyVersion ?? keyring.activeVersion;
    const binding = validateBinding({ ...rawBinding, keyVersion });
    const key = keyring.keys.get(keyVersion);
    if (!key) throw new Error('Storage credential encryption key is unavailable');

    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(bindingAad(binding));
    const plaintext = Buffer.from(JSON.stringify(credentials), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    plaintext.fill(0);

    return {
      ciphertext: [
        ENCODING_VERSION,
        String(keyVersion),
        iv.toString('base64url'),
        encrypted.toString('base64url'),
        tag.toString('base64url'),
      ].join('.'),
      keyVersion,
    };
  }

  decrypt(ciphertext: string, rawBinding: StorageCredentialBinding): S3StorageCredentials {
    const binding = validateBinding(rawBinding);
    if (typeof ciphertext !== 'string' || ciphertext.length > 16_384) {
      throw new Error('Storage credential ciphertext is invalid');
    }
    const parts = ciphertext.split('.');
    if (parts.length !== 5 || parts[0] !== ENCODING_VERSION) {
      throw new Error('Storage credential ciphertext is invalid');
    }
    const encodedVersion = parseKeyVersion(parts[1]);
    if (encodedVersion !== binding.keyVersion) {
      throw new Error('Storage credential key version does not match its record');
    }
    const key = this.requireKeyring().keys.get(encodedVersion);
    if (!key) throw new Error('Storage credential decryption key is unavailable');

    try {
      const iv = decodeBase64Url(parts[2], IV_BYTES);
      const encrypted = decodeBase64Url(parts[3]);
      const tag = decodeBase64Url(parts[4], TAG_BYTES);
      if (encrypted.length < 2 || encrypted.length > 12_000) {
        throw new Error('invalid encrypted length');
      }
      const decipher = createDecipheriv('aes-256-gcm', key, iv, {
        authTagLength: TAG_BYTES,
      });
      decipher.setAAD(bindingAad(binding));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(encrypted), decipher.final()]);
      try {
        return validateCredentials(JSON.parse(plaintext.toString('utf8')) as unknown);
      } finally {
        plaintext.fill(0);
      }
    } catch {
      throw new Error('Storage credential ciphertext authentication failed');
    }
  }

  private requireKeyring(): StorageMasterKeyring {
    if (!this.keyring) {
      throw new Error('Storage credential encryption is not configured');
    }
    return this.keyring;
  }
}

export function loadStorageMasterKeyring(
  environment: NodeJS.ProcessEnv = process.env,
): StorageMasterKeyring | undefined {
  const encodedKeys = environment.STORAGE_CREDENTIAL_MASTER_KEYS;
  const activeValue = environment.STORAGE_ACTIVE_KEY_VERSION;
  if (!encodedKeys || !activeValue) {
    if (!encodedKeys && !activeValue && environment.NODE_ENV !== 'production') {
      return undefined;
    }
    throw new Error(
      environment.NODE_ENV === 'production'
        ? 'STORAGE_CREDENTIAL_MASTER_KEYS and STORAGE_ACTIVE_KEY_VERSION are required in production'
        : 'STORAGE_CREDENTIAL_MASTER_KEYS and STORAGE_ACTIVE_KEY_VERSION must be configured together',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encodedKeys);
  } catch {
    throw new Error('STORAGE_CREDENTIAL_MASTER_KEYS must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('STORAGE_CREDENTIAL_MASTER_KEYS must be a JSON object');
  }

  const keys = new Map<number, Buffer>();
  for (const [versionValue, encodedKey] of Object.entries(parsed)) {
    const version = parseKeyVersion(versionValue);
    if (typeof encodedKey !== 'string') {
      throw new Error(`Storage master key version ${version} must be base64 text`);
    }
    const key = decodeCanonicalBase64(encodedKey, KEY_BYTES);
    keys.set(version, key);
  }
  return validateKeyring({
    activeVersion: parseKeyVersion(activeValue),
    keys,
  });
}

function validateKeyring(keyring: StorageMasterKeyring): StorageMasterKeyring {
  const activeVersion = parseKeyVersion(keyring.activeVersion);
  if (!(keyring.keys instanceof Map) || keyring.keys.size < 1 || keyring.keys.size > 32) {
    throw new Error('Storage master keyring must contain 1 to 32 keys');
  }
  const keys = new Map<number, Buffer>();
  for (const [rawVersion, rawKey] of keyring.keys) {
    const version = parseKeyVersion(rawVersion);
    if (!Buffer.isBuffer(rawKey) || rawKey.length !== KEY_BYTES) {
      throw new Error(`Storage master key version ${version} must contain 32 bytes`);
    }
    keys.set(version, Buffer.from(rawKey));
  }
  if (!keys.has(activeVersion)) {
    throw new Error('STORAGE_ACTIVE_KEY_VERSION is not present in the keyring');
  }
  return { activeVersion, keys };
}

function validateBinding(raw: StorageCredentialBinding): StorageCredentialBinding {
  if (!raw || typeof raw !== 'object') throw new TypeError('Credential binding is required');
  if (!isUuid(raw.providerId)) throw new TypeError('providerId must be a UUID');
  if (raw.ownerType !== 'platform' && raw.ownerType !== 'tenant') {
    throw new TypeError('Credential owner type is invalid');
  }
  if (
    (raw.ownerType === 'platform' && raw.ownerTenantId !== null)
    || (raw.ownerType === 'tenant' && !isUuid(raw.ownerTenantId))
  ) {
    throw new TypeError('Credential owner scope is invalid');
  }
  return {
    keyVersion: parseKeyVersion(raw.keyVersion),
    ownerTenantId: raw.ownerTenantId,
    ownerType: raw.ownerType,
    providerId: raw.providerId.toLowerCase(),
  };
}

function validateCredentials(raw: unknown): S3StorageCredentials {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('Storage credentials are invalid');
  }
  const value = raw as Record<string, unknown>;
  const accessKeyId = boundedSecret(value.accessKeyId, 'accessKeyId', 3, 256);
  const secretAccessKey = boundedSecret(value.secretAccessKey, 'secretAccessKey', 16, 512);
  const region = boundedText(value.region, 'region', 1, 100);
  const sessionToken = value.sessionToken === undefined
    ? undefined
    : boundedSecret(value.sessionToken, 'sessionToken', 1, 8_192);
  if (value.forcePathStyle !== undefined && typeof value.forcePathStyle !== 'boolean') {
    throw new TypeError('forcePathStyle must be boolean');
  }
  return {
    accessKeyId,
    forcePathStyle: value.forcePathStyle as boolean | undefined,
    region,
    secretAccessKey,
    sessionToken,
  };
}

function bindingAad(binding: StorageCredentialBinding): Buffer {
  return Buffer.from([
    'storage-credentials',
    ENCODING_VERSION,
    String(binding.keyVersion),
    binding.providerId,
    binding.ownerType,
    binding.ownerTenantId ?? 'platform',
  ].join('|'), 'utf8');
}

function boundedSecret(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== 'string'
    || value.length < minimum
    || value.length > maximum
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function boundedText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new TypeError(`${field} is invalid`);
  const normalized = value.trim();
  if (
    normalized.length < minimum
    || normalized.length > maximum
    || !/^[A-Za-z0-9._-]+$/.test(normalized)
  ) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function parseKeyVersion(value: unknown): number {
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1 || result > MAX_KEY_VERSION) {
    throw new Error('Storage key version is invalid');
  }
  return result;
}

function decodeBase64Url(value: string | undefined, expectedLength?: number): Buffer {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid base64url');
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.toString('base64url') !== value) throw new Error('non-canonical base64url');
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    throw new Error('invalid decoded length');
  }
  return decoded;
}

function decodeCanonicalBase64(value: string, expectedLength: number): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error('Storage master keys must use canonical base64');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== expectedLength || decoded.toString('base64') !== value) {
    throw new Error(`Storage master keys must decode to ${expectedLength} bytes`);
  }
  return decoded;
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
