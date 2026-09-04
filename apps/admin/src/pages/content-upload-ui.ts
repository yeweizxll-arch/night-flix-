export interface ContentUploadIntent {
  expiresAt: string;
  id: string;
  method: 'PUT';
  requiredHeaders: Record<string, string>;
  status: string;
  uploadUrl: string;
}

export function validateContentUploadFile(
  file: Pick<File, 'name' | 'size' | 'type'>,
  kind: 'file' | 'image' | 'video',
): string | undefined {
  const allowed = kind === 'image'
    ? new Set(['image/avif', 'image/jpeg', 'image/png', 'image/webp'])
    : kind === 'video'
      ? new Set(['video/mp4', 'video/quicktime', 'video/webm'])
      : new Set([
          'audio/aac', 'audio/flac', 'audio/m4a', 'audio/mp4', 'audio/mpeg',
          'audio/ogg', 'audio/wav', 'text/vtt',
        ]);
  const maximum = kind === 'image' ? 25 * 1024 ** 2 : kind === 'video' ? 2 * 1024 ** 3 : 100 * 1024 ** 2;
  if (!allowed.has(file.type)) return '文件 MIME 类型不在允许范围内';
  if (file.size < 1 || file.size > maximum) return '文件大小超出当前媒体类型限制';
  const extension = contentFileExtension(file.name);
  if (extension && !/^[a-z0-9]{1,16}$/.test(extension)) return '文件扩展名无效';
  return undefined;
}

export function contentFileExtension(name: string): string | undefined {
  const last = name.lastIndexOf('.');
  return last < 0 ? undefined : name.slice(last + 1).trim().toLowerCase() || undefined;
}

export function validateContentUploadIntent(
  intent: ContentUploadIntent,
  file: Pick<File, 'size' | 'type'>,
  isUuid: (value: string) => boolean,
): void {
  if (!isUuid(intent.id) || intent.method !== 'PUT' || intent.status !== 'uploading') {
    throw new Error('服务端返回了无效的上传任务');
  }
  let url: URL;
  try { url = new URL(intent.uploadUrl); }
  catch { throw new Error('服务端返回了无效的上传地址'); }
  const expiry = Date.parse(intent.expiresAt);
  if (url.protocol !== 'https:' || url.username || url.password
    || !Number.isFinite(expiry) || expiry <= Date.now()) {
    throw new Error('上传地址不安全或已过期');
  }
  const headers = normalizedUploadHeaders(intent.requiredHeaders);
  if (headers['content-length'] !== String(file.size) || headers['content-type'] !== file.type) {
    throw new Error('上传任务与所选文件不一致');
  }
}

export function contentUploadHeaders(
  required: Record<string, string>,
  file: Pick<File, 'size' | 'type'>,
): Headers {
  const normalized = normalizedUploadHeaders(required);
  if (normalized['content-length'] !== String(file.size)
    || normalized['content-type'] !== file.type) {
    throw new Error('上传任务文件大小或类型不一致');
  }
  const allowed = new Set([
    'content-type',
    'if-none-match',
    'x-amz-checksum-sha256',
    'x-amz-meta-upload-id',
  ]);
  const headers = new Headers();
  for (const [name, value] of Object.entries(normalized)) {
    if (name === 'content-length') continue;
    if (!allowed.has(name)) throw new Error('上传任务包含不支持的请求头');
    headers.set(name, value);
  }
  return headers;
}

export function formatContentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

function normalizedUploadHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
}
