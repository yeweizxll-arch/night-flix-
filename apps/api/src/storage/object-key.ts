import { randomBytes } from 'node:crypto';

const SAFE_EXTENSION = /^[a-z0-9]{1,16}$/;

export function generateStorageObjectKey(
  kind: 'file' | 'image' | 'video',
  extensionValue?: string,
): string {
  if (kind !== 'file' && kind !== 'image' && kind !== 'video') {
    throw new TypeError('Storage object kind is invalid');
  }
  const extension = normalizeExtension(extensionValue);
  const scopePrefix = randomBytes(12).toString('base64url');
  const entropy = randomBytes(32).toString('base64url');
  return `tenant-media/${scopePrefix}/${kind}/${entropy}${extension ? `.${extension}` : ''}`;
}

function normalizeExtension(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError('File extension is invalid');
  const normalized = value.trim().toLowerCase().replace(/^\./, '');
  if (!SAFE_EXTENSION.test(normalized)) {
    throw new TypeError('File extension is invalid');
  }
  return normalized;
}
