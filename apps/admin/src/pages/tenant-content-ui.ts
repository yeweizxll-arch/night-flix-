export const MAX_IMPORT_BYTES = 1024 * 1024;

export async function readContentImportFile(file: File): Promise<string> {
  if (file.size < 2 || file.size > MAX_IMPORT_BYTES) {
    throw new Error('导入文件必须为纯文本且不超过 1 MiB');
  }
  const payload = await file.text();
  if (new Blob([payload]).size < 2 || new Blob([payload]).size > MAX_IMPORT_BYTES) {
    throw new Error('导入内容必须为 UTF-8 纯文本且不超过 1 MiB');
  }
  if (payload.includes('\0')) throw new Error('导入内容不能包含 NUL 字符');
  return payload;
}

export function safeExportFilename(value: string, format: 'csv' | 'json'): string {
  const basename = value.split(/[\\/]/).at(-1)?.trim() ?? '';
  const safe = basename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160);
  return safe && safe.toLowerCase().endsWith(`.${format}`)
    ? safe
    : `content-export.${format}`;
}

export function safeImportErrors(value: unknown): string {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string')
      .map((item) => item.slice(0, 500)).join('；') || '导入失败';
  }
  if (typeof value === 'string') return value.slice(0, 1000);
  if (value && typeof value === 'object') {
    try { return JSON.stringify(value).slice(0, 2000); }
    catch { return '导入失败'; }
  }
  return '—';
}
