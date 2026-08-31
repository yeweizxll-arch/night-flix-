import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';

const VERSION = 'nc1';
const PROVIDER_VERSION = 'nc2';
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export type PushProvider = 'apns' | 'fcm';
export type PushProviderEnvironment = 'production' | 'sandbox';
export type PushPlatform = 'android' | 'ios';

export interface NotificationKeyring {
  activeVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

export type PushProviderCredentials =
  | {
      bundleId: string;
      environment: PushProviderEnvironment;
      keyId: string;
      privateKey: string;
      teamId: string;
      type: 'apns';
    }
  | {
      clientEmail: string;
      environment: 'production';
      privateKey: string;
      projectId: string;
      type: 'fcm';
    };

export type NotificationSecretBinding =
  | {
      configId: string;
      environment: PushProviderEnvironment;
      keyVersion: number;
      kind: 'provider_config';
      provider: PushProvider;
      tenantId: string;
    }
  | {
      accountId: string;
      deviceId: string;
      keyVersion: number;
      kind: 'device_token';
      platform: PushPlatform;
      tenantId: string;
      tokenId: string;
    };

export class NotificationSecretCipher {
  private readonly keyring: NotificationKeyring | undefined;

  constructor(keyring?: NotificationKeyring | null) {
    this.keyring = validateKeyring(
      keyring === null ? undefined : (keyring ?? loadNotificationKeyring()),
    );
  }

  get configured(): boolean {
    return Boolean(this.keyring);
  }

  get activeKeyVersion(): number {
    return this.requireKeyring().activeVersion;
  }

  encryptDeviceToken(
    rawToken: unknown,
    binding: Omit<Extract<NotificationSecretBinding, { kind: 'device_token' }>, 'keyVersion'>,
  ): {
    ciphertext: string;
    keyVersion: number;
    tokenDigest: string;
    tokenSha256: string;
  } {
    const token = validateDeviceToken(rawToken);
    const keyring = this.requireKeyring();
    const keyVersion = keyring.activeVersion;
    const versionedBinding = validateBinding({ ...binding, keyVersion });
    return {
      ciphertext: this.encrypt(token, versionedBinding),
      keyVersion,
      tokenDigest: `hmac-sha256.${keyVersion}.${createHmac('sha256', requiredKey(keyring, keyVersion))
        .update(`push-token\0${binding.tenantId}\0${token}`)
        .digest('base64url')}`,
      tokenSha256: createHash('sha256').update(token).digest('hex'),
    };
  }

  decryptDeviceToken(
    ciphertext: string,
    binding: Extract<NotificationSecretBinding, { kind: 'device_token' }>,
  ): string {
    const value = this.decrypt(ciphertext, validateBinding(binding));
    return validateDeviceToken(value);
  }

  encryptProviderCredentials(
    rawCredentials: unknown,
    binding: Omit<Extract<NotificationSecretBinding, { kind: 'provider_config' }>, 'keyVersion'>,
  ): { ciphertext: string; keyVersion: number } {
    const credentials = validateProviderCredentials(
      binding.provider, rawCredentials, binding.environment,
    );
    const keyVersion = this.activeKeyVersion;
    const versionedBinding = validateBinding({ ...binding, keyVersion });
    return {
      ciphertext: this.encrypt(JSON.stringify(credentials), versionedBinding, PROVIDER_VERSION),
      keyVersion,
    };
  }

  decryptProviderCredentials(
    ciphertext: string,
    binding: Extract<NotificationSecretBinding, { kind: 'provider_config' }>,
  ): PushProviderCredentials {
    const validatedBinding = validateBinding(binding);
    let plaintext: string;
    if (ciphertext.startsWith(`${VERSION}.`)) {
      // Compatibility for credentials encrypted before environment became an
      // authenticated field. Legacy rows are migrated as production only.
      if (validatedBinding.kind !== 'provider_config'
        || validatedBinding.environment !== 'production') {
        throw new Error('Notification secret ciphertext authentication failed');
      }
      const { environment: _environment, ...legacyBinding } = validatedBinding;
      plaintext = this.decrypt(ciphertext, legacyBinding, VERSION);
    } else {
      plaintext = this.decrypt(ciphertext, validatedBinding, PROVIDER_VERSION);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plaintext);
    } catch {
      throw new Error('Notification provider credential ciphertext authentication failed');
    }
    return validateProviderCredentials(binding.provider, parsed, binding.environment);
  }

  private encrypt(
    plaintextValue: string,
    binding: NotificationSecretBinding,
    envelopeVersion = VERSION,
  ): string {
    const key = requiredKey(this.requireKeyring(), binding.keyVersion);
    const plaintext = Buffer.from(plaintextValue, 'utf8');
    if (plaintext.length < 8 || plaintext.length > 12_000) {
      plaintext.fill(0);
      throw new Error('Notification secret plaintext is invalid');
    }
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    cipher.setAAD(aad(binding));
    try {
      const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return [
        envelopeVersion,
        String(binding.keyVersion),
        iv.toString('base64url'),
        encrypted.toString('base64url'),
        cipher.getAuthTag().toString('base64url'),
      ].join('.');
    } finally {
      plaintext.fill(0);
    }
  }

  private decrypt(
    ciphertext: string,
    binding: { keyVersion: number },
    envelopeVersion = VERSION,
  ): string {
    if (typeof ciphertext !== 'string' || ciphertext.length > 16_384) {
      throw new Error('Notification secret ciphertext is invalid');
    }
    const parts = ciphertext.split('.');
    if (
      parts.length !== 5
      || parts[0] !== envelopeVersion
      || Number(parts[1]) !== binding.keyVersion
    ) {
      throw new Error('Notification secret ciphertext is invalid');
    }
    try {
      const iv = Buffer.from(parts[2] ?? '', 'base64url');
      const encrypted = Buffer.from(parts[3] ?? '', 'base64url');
      const tag = Buffer.from(parts[4] ?? '', 'base64url');
      if (
        iv.length !== IV_BYTES || tag.length !== TAG_BYTES
        || encrypted.length < 8 || encrypted.length > 12_000
      ) {
        throw new Error('invalid envelope');
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        requiredKey(this.requireKeyring(), binding.keyVersion),
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
      throw new Error('Notification secret ciphertext authentication failed');
    }
  }

  private requireKeyring(): NotificationKeyring {
    if (!this.keyring) throw new Error('Notification secret encryption is not configured');
    return this.keyring;
  }
}

export function loadNotificationKeyring(
  environment: NodeJS.ProcessEnv = process.env,
): NotificationKeyring | undefined {
  const encoded = environment.NOTIFICATION_MASTER_KEYS;
  const active = environment.NOTIFICATION_ACTIVE_KEY_VERSION;
  if (!encoded || !active) {
    if (!encoded && !active && environment.NODE_ENV !== 'production') return undefined;
    throw new Error(
      'NOTIFICATION_MASTER_KEYS and NOTIFICATION_ACTIVE_KEY_VERSION must be configured together',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    throw new Error('NOTIFICATION_MASTER_KEYS must be a JSON object');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('NOTIFICATION_MASTER_KEYS must be a JSON object');
  }
  const keys = new Map<number, Buffer>();
  for (const [versionValue, encodedKey] of Object.entries(parsed)) {
    const version = positiveInteger(versionValue, 'Notification key version');
    if (typeof encodedKey !== 'string') throw new Error('Notification key must be base64');
    const key = Buffer.from(encodedKey, 'base64');
    if (key.length !== KEY_BYTES || key.toString('base64') !== encodedKey) {
      throw new Error(`Notification key version ${version} must contain exactly 32 bytes`);
    }
    keys.set(version, key);
  }
  const activeVersion = positiveInteger(active, 'NOTIFICATION_ACTIVE_KEY_VERSION');
  if (!keys.has(activeVersion)) throw new Error('Active notification key version is unavailable');
  return { activeVersion, keys };
}

function validateKeyring(value: NotificationKeyring | undefined): NotificationKeyring | undefined {
  if (!value) return undefined;
  const activeVersion = positiveInteger(value.activeVersion, 'Notification active key version');
  const keys = new Map<number, Buffer>();
  for (const [versionValue, keyValue] of value.keys) {
    const version = positiveInteger(versionValue, 'Notification key version');
    if (!Buffer.isBuffer(keyValue) || keyValue.length !== KEY_BYTES) {
      throw new Error(`Notification key version ${version} must contain exactly 32 bytes`);
    }
    keys.set(version, Buffer.from(keyValue));
  }
  if (!keys.has(activeVersion)) throw new Error('Active notification key version is unavailable');
  return { activeVersion, keys };
}

function validateProviderCredentials(
  provider: PushProvider,
  value: unknown,
  boundEnvironment: PushProviderEnvironment,
): PushProviderCredentials {
  if (!isRecord(value)) throw new TypeError('Provider credentials are invalid');
  if (provider === 'apns') {
    exactKeys(value, ['bundleId', 'environment', 'keyId', 'privateKey', 'teamId', 'type']);
    if (value.type !== undefined && value.type !== 'apns') throw new TypeError('type is invalid');
    if (value.environment !== undefined && value.environment !== boundEnvironment) {
      throw new TypeError('environment is invalid');
    }
    return {
      bundleId: text(value.bundleId, 'bundleId', 3, 255),
      environment: boundEnvironment,
      keyId: text(value.keyId, 'keyId', 3, 64),
      privateKey: text(value.privateKey, 'privateKey', 32, 8_000),
      teamId: text(value.teamId, 'teamId', 3, 64),
      type: 'apns',
    };
  }
  if (boundEnvironment !== 'production') throw new TypeError('environment is invalid');
  exactKeys(value, ['clientEmail', 'environment', 'privateKey', 'projectId', 'type']);
  if (value.type !== undefined && value.type !== 'fcm') throw new TypeError('type is invalid');
  if (value.environment !== undefined && value.environment !== 'production') {
    throw new TypeError('environment is invalid');
  }
  const clientEmail = text(value.clientEmail, 'clientEmail', 3, 320).toLowerCase();
  if (!clientEmail.includes('@')) throw new TypeError('clientEmail is invalid');
  return {
    clientEmail,
    environment: 'production',
    privateKey: text(value.privateKey, 'privateKey', 32, 8_000),
    projectId: text(value.projectId, 'projectId', 3, 255),
    type: 'fcm',
  };
}

function validateDeviceToken(value: unknown): string {
  const token = text(value, 'deviceToken', 16, 4_096);
  if (/\s/.test(token)) throw new TypeError('deviceToken is invalid');
  return token;
}

function validateBinding(value: NotificationSecretBinding): NotificationSecretBinding {
  if (!isRecord(value)) throw new TypeError('Notification secret binding is invalid');
  const keyVersion = positiveInteger(value.keyVersion, 'keyVersion');
  const tenantId = uuid(value.tenantId, 'tenantId');
  if (value.kind === 'provider_config') {
    if (value.provider !== 'apns' && value.provider !== 'fcm') {
      throw new TypeError('provider is invalid');
    }
    return {
      configId: uuid(value.configId, 'configId'),
      environment: pushEnvironment(value.environment),
      keyVersion,
      kind: 'provider_config',
      provider: value.provider,
      tenantId,
    };
  }
  if (value.kind === 'device_token') {
    if (value.platform !== 'android' && value.platform !== 'ios') {
      throw new TypeError('platform is invalid');
    }
    return {
      accountId: uuid(value.accountId, 'accountId'),
      deviceId: uuid(value.deviceId, 'deviceId'),
      keyVersion,
      kind: 'device_token',
      platform: value.platform,
      tenantId,
      tokenId: uuid(value.tokenId, 'tokenId'),
    };
  }
  throw new TypeError('Notification secret kind is invalid');
}

function aad(binding: object): Buffer {
  return Buffer.from(JSON.stringify(binding), 'utf8');
}

function pushEnvironment(value: unknown): PushProviderEnvironment {
  if (value !== 'production' && value !== 'sandbox') {
    throw new TypeError('environment is invalid');
  }
  return value;
}

function requiredKey(keyring: NotificationKeyring, version: number): Buffer {
  const key = keyring.keys.get(version);
  if (!key) throw new Error('Notification encryption key is unavailable');
  return key;
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 2_147_483_647) {
    throw new Error(`${field} is invalid`);
  }
  return parsed;
}

function uuid(value: unknown, field: string): string {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new TypeError(`${field} must be a UUID`);
  }
  return value;
}

function text(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new TypeError(`${field} is invalid`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new TypeError(`${field} is invalid`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new TypeError('Provider credentials contain unsupported fields');
  }
}
