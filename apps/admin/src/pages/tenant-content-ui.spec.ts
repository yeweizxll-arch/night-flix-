import { describe, expect, it } from 'vitest';

import {
  contentUploadHeaders,
  validateContentUploadIntent,
} from './content-upload-ui';
import {
  MAX_IMPORT_BYTES,
  readContentImportFile,
  safeExportFilename,
  safeImportErrors,
} from './tenant-content-ui';

const uuid = '018f6f18-6d29-7d85-8f39-91a713913f4b';
const isUuid = (value: string) => value === uuid;

describe('tenant content browser safety helpers', () => {
  it('enforces the 1 MiB import boundary and rejects NUL text', async () => {
    await expect(readContentImportFile(new File(['[]'], 'content.json'))).resolves.toBe('[]');
    await expect(readContentImportFile(
      new File([new Uint8Array(MAX_IMPORT_BYTES + 1)], 'large.json'),
    )).rejects.toThrow('1 MiB');
    await expect(readContentImportFile(new File(['a\0b'], 'bad.csv'))).rejects.toThrow('NUL');
  });

  it('sanitizes server-provided download names without changing the selected format', () => {
    expect(safeExportFilename('../../客户 数据.csv', 'csv')).toBe('_____.csv');
    expect(safeExportFilename('wrong.json', 'csv')).toBe('content-export.csv');
  });

  it('requires an HTTPS, unexpired upload intent tied to the selected file', () => {
    const file = { size: 3, type: 'image/png' };
    const intent = {
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      id: uuid,
      method: 'PUT' as const,
      requiredHeaders: { 'Content-Length': '3', 'Content-Type': 'image/png' },
      status: 'uploading',
      uploadUrl: 'https://storage.example.test/upload',
    };
    expect(() => validateContentUploadIntent(intent, file, isUuid)).not.toThrow();
    expect(() => validateContentUploadIntent(
      { ...intent, uploadUrl: 'http://storage.example.test/upload' }, file, isUuid,
    )).toThrow('不安全');
    expect(() => contentUploadHeaders(
      { ...intent.requiredHeaders, 'X-Unsafe': 'value' }, file,
    )).toThrow('不支持');
  });

  it('renders import errors as bounded plain text', () => {
    expect(safeImportErrors(['bad code', '<img onerror=alert(1)>']))
      .toBe('bad code；<img onerror=alert(1)>');
    expect(safeImportErrors({ code: 'INVALID' })).toBe('{"code":"INVALID"}');
  });
});
