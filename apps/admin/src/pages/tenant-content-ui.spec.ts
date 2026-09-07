import { describe, expect, it } from 'vitest';

import {
  contentUploadHeaders,
  validateContentUploadIntent,
} from './content-upload-ui';
import {
  MAX_IMPORT_BYTES,
  isTenantDramaEditable,
  readContentImportFile,
  safeExportFilename,
  safeImportErrors,
} from './tenant-content-ui';

const uuid = '018f6f18-6d29-7d85-8f39-91a713913f4b';
const isUuid = (value: string) => value === uuid;

describe('tenant content browser safety helpers', () => {
  it('allows editing and republishing unpublished private dramas, never published or deleted ones', () => {
    for (const status of ['draft', 'rejected', 'unpublished']) {
      expect(isTenantDramaEditable({ status })).toBe(true);
      expect(isTenantDramaEditable({ status, deletedAt: '2026-09-07T00:00:00Z' })).toBe(false);
    }
    for (const status of ['pending_review', 'approved', 'published']) {
      expect(isTenantDramaEditable({ status })).toBe(false);
    }
  });
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
    expect(safeImportErrors({ code: 'INVALID', databaseCode: '42501' })).toContain('提供任务编号');
    expect(safeImportErrors({ source: 'inline', importedRows: 1, errorRows: 0 })).toBe('成功部数：1；失败行数：0');
    expect(safeImportErrors({ rowCount: 3, episodeCount: 60 })).toBe('提交部数：3；剧集数：60');
    expect(safeImportErrors(['Drama code already exists'])).toBe('短剧编号已存在，请更换编号后重试');
    expect(safeImportErrors([])).toBe('—');
  });
});
