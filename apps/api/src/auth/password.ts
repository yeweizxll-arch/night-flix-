import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const PASSWORD_HASH_ALGORITHM = 'scrypt';
const PASSWORD_HASH_VERSION = '1';
const MIN_PASSWORD_BYTES = 1;
const MAX_PASSWORD_BYTES = 4_096;
const MIN_COST = 16_384;
const MAX_COST = 1_048_576;
const MIN_BLOCK_SIZE = 1;
const MAX_BLOCK_SIZE = 32;
const MIN_PARALLELIZATION = 1;
const MAX_PARALLELIZATION = 16;
const MIN_KEY_LENGTH = 32;
const MAX_KEY_LENGTH = 64;
const MIN_SALT_LENGTH = 16;
const MAX_SALT_LENGTH = 64;
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;
const SCRYPT_MEMORY_HEADROOM_BYTES = 1024 * 1024;

export interface PasswordHashOptions {
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
  saltLength: number;
  maxMemoryBytes: number;
}

export const DEFAULT_PASSWORD_HASH_OPTIONS: Readonly<PasswordHashOptions> =
  Object.freeze({
    cost: 32_768,
    blockSize: 8,
    parallelization: 1,
    keyLength: 32,
    saltLength: 16,
    maxMemoryBytes: 64 * 1024 * 1024,
  });

interface ParsedPasswordHash {
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
  salt: Buffer;
  derivedKey: Buffer;
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
}

function assertPassword(password: string): void {
  if (typeof password !== 'string') {
    throw new TypeError('Password must be a string');
  }

  const passwordBytes = Buffer.byteLength(password, 'utf8');
  if (passwordBytes < MIN_PASSWORD_BYTES || passwordBytes > MAX_PASSWORD_BYTES) {
    throw new RangeError(
      `Password must contain ${MIN_PASSWORD_BYTES} to ${MAX_PASSWORD_BYTES} UTF-8 bytes`,
    );
  }
}

function requiredScryptMemoryBytes(
  cost: number,
  blockSize: number,
  parallelization: number,
  keyLength: number,
): number {
  const required =
    128 * cost * blockSize +
    128 * blockSize * parallelization +
    keyLength +
    SCRYPT_MEMORY_HEADROOM_BYTES;

  if (!Number.isSafeInteger(required) || required > MAX_SCRYPT_MEMORY_BYTES) {
    throw new RangeError('Scrypt parameters require too much memory');
  }

  return required;
}

function validateScryptParameters(
  options: Pick<
    PasswordHashOptions,
    'cost' | 'blockSize' | 'parallelization' | 'keyLength'
  >,
): number {
  assertIntegerInRange(options.cost, MIN_COST, MAX_COST, 'cost');
  if ((options.cost & (options.cost - 1)) !== 0) {
    throw new RangeError('cost must be a power of two');
  }

  assertIntegerInRange(
    options.blockSize,
    MIN_BLOCK_SIZE,
    MAX_BLOCK_SIZE,
    'blockSize',
  );
  assertIntegerInRange(
    options.parallelization,
    MIN_PARALLELIZATION,
    MAX_PARALLELIZATION,
    'parallelization',
  );
  assertIntegerInRange(
    options.keyLength,
    MIN_KEY_LENGTH,
    MAX_KEY_LENGTH,
    'keyLength',
  );

  return requiredScryptMemoryBytes(
    options.cost,
    options.blockSize,
    options.parallelization,
    options.keyLength,
  );
}

function resolveOptions(
  supplied: Partial<PasswordHashOptions>,
): PasswordHashOptions {
  const options = { ...DEFAULT_PASSWORD_HASH_OPTIONS, ...supplied };
  const requiredMemory = validateScryptParameters(options);

  assertIntegerInRange(
    options.saltLength,
    MIN_SALT_LENGTH,
    MAX_SALT_LENGTH,
    'saltLength',
  );
  assertIntegerInRange(
    options.maxMemoryBytes,
    requiredMemory,
    MAX_SCRYPT_MEMORY_BYTES,
    'maxMemoryBytes',
  );

  return options;
}

function deriveKey(
  password: string,
  salt: Buffer,
  parameters: Pick<
    PasswordHashOptions,
    'cost' | 'blockSize' | 'parallelization' | 'keyLength'
  >,
  maxMemoryBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      parameters.keyLength,
      {
        N: parameters.cost,
        r: parameters.blockSize,
        p: parameters.parallelization,
        maxmem: maxMemoryBytes,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(derivedKey);
      },
    );
  });
}

function decodeCanonicalBase64Url(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    return undefined;
  }

  const decoded = Buffer.from(value, 'base64url');
  return decoded.toString('base64url') === value ? decoded : undefined;
}

function parsePasswordHash(encodedHash: string): ParsedPasswordHash | undefined {
  if (typeof encodedHash !== 'string' || encodedHash.length > 512) {
    return undefined;
  }

  const parts = encodedHash.split('$');
  if (
    parts.length !== 5 ||
    parts[0] !== PASSWORD_HASH_ALGORITHM ||
    parts[1] !== PASSWORD_HASH_VERSION
  ) {
    return undefined;
  }

  const parameterMatch = /^N=(\d+),r=(\d+),p=(\d+),l=(\d+)$/.exec(parts[2] ?? '');
  if (!parameterMatch) {
    return undefined;
  }

  const cost = Number(parameterMatch[1]);
  const blockSize = Number(parameterMatch[2]);
  const parallelization = Number(parameterMatch[3]);
  const keyLength = Number(parameterMatch[4]);

  try {
    validateScryptParameters({ cost, blockSize, parallelization, keyLength });
  } catch {
    return undefined;
  }

  const salt = decodeCanonicalBase64Url(parts[3] ?? '');
  const derivedKey = decodeCanonicalBase64Url(parts[4] ?? '');
  if (
    !salt ||
    salt.length < MIN_SALT_LENGTH ||
    salt.length > MAX_SALT_LENGTH ||
    !derivedKey ||
    derivedKey.length !== keyLength
  ) {
    return undefined;
  }

  return { cost, blockSize, parallelization, keyLength, salt, derivedKey };
}

export async function hashPassword(
  password: string,
  suppliedOptions: Partial<PasswordHashOptions> = {},
): Promise<string> {
  assertPassword(password);
  const options = resolveOptions(suppliedOptions);
  const salt = randomBytes(options.saltLength);
  const derivedKey = await deriveKey(password, salt, options, options.maxMemoryBytes);

  return [
    PASSWORD_HASH_ALGORITHM,
    PASSWORD_HASH_VERSION,
    `N=${options.cost},r=${options.blockSize},p=${options.parallelization},l=${options.keyLength}`,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  encodedHash: string,
): Promise<boolean> {
  assertPassword(password);
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) {
    return false;
  }

  const maxMemoryBytes = requiredScryptMemoryBytes(
    parsed.cost,
    parsed.blockSize,
    parsed.parallelization,
    parsed.keyLength,
  );
  const candidate = await deriveKey(password, parsed.salt, parsed, maxMemoryBytes);

  return timingSafeEqual(candidate, parsed.derivedKey);
}

export function needsPasswordRehash(
  encodedHash: string,
  suppliedOptions: Partial<PasswordHashOptions> = {},
): boolean {
  const parsed = parsePasswordHash(encodedHash);
  if (!parsed) {
    return true;
  }

  const options = resolveOptions(suppliedOptions);
  return (
    parsed.cost !== options.cost ||
    parsed.blockSize !== options.blockSize ||
    parsed.parallelization !== options.parallelization ||
    parsed.keyLength !== options.keyLength ||
    parsed.salt.length !== options.saltLength
  );
}
