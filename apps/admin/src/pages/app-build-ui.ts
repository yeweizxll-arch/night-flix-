export type AppBuildTarget = 'android_debug' | 'ios_simulator';
export type AppBuildStatus = 'cancelled' | 'failed' | 'processing' | 'queued' | 'succeeded';
export type AppBuildAssetPurpose = 'app_icon' | 'launch_image';

export interface AppBuildDomainOption {
  eligible: boolean;
  host: string;
  id: string;
}

export interface AppBuildAssetOption {
  buildReady: boolean;
  iconCandidate: boolean;
  id: string;
  mimeType: string;
  purpose: AppBuildAssetPurpose;
}

export interface AppBuildAssetCompletion {
  checksumSha256: string;
  hasAlpha: boolean;
  height: number;
  id: string;
  purpose: AppBuildAssetPurpose;
  sizeBytes: number;
  status: 'ready';
  version: number;
  width: number;
}

export interface AppBuildDownloadResponse {
  checksum: string;
  contentType: 'application/vnd.android.package-archive' | 'application/zip';
  expiresAt: string;
  filename: string;
  sizeBytes: string;
  url: string;
}

export const buildTargetLabels: Record<AppBuildTarget, string> = {
  android_debug: 'Android 调试 APK',
  ios_simulator: 'iOS 模拟器包',
};

export const buildStatusLabels: Record<AppBuildStatus, string> = {
  cancelled: '已取消',
  failed: '失败',
  processing: '构建中',
  queued: '排队中',
  succeeded: '已完成',
};

export function appBuildBase(tenantId: string): string {
  return `/api/v1/platform/merchants/${encodeURIComponent(tenantId)}/app-builds`;
}

export function eligibleBuildDomains<T extends AppBuildDomainOption>(domains: T[]): T[] {
  return domains.filter((domain) => domain.eligible);
}

export function eligibleIconAssets<T extends AppBuildAssetOption>(assets: T[]): T[] {
  return assets.filter((asset) => asset.buildReady && asset.purpose === 'app_icon'
    && asset.iconCandidate && asset.mimeType === 'image/png');
}

export function eligibleLaunchAssets<T extends AppBuildAssetOption>(assets: T[]): T[] {
  return assets.filter((asset) => asset.buildReady && asset.purpose === 'launch_image'
    && ['image/jpeg', 'image/png', 'image/webp'].includes(asset.mimeType));
}

export function validateAppBuildAssetFile(
  file: Pick<File, 'size' | 'type'>,
  purpose: AppBuildAssetPurpose,
): string | undefined {
  const allowed = purpose === 'app_icon'
    ? ['image/png']
    : ['image/jpeg', 'image/png', 'image/webp'];
  if (!allowed.includes(file.type)) {
    return purpose === 'app_icon'
      ? '应用图标必须是 PNG 文件'
      : '启动图仅支持 PNG、JPEG 或 WebP';
  }
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > 25 * 1024 ** 2) {
    return '图片大小必须在 1 B 到 25 MiB 之间';
  }
  return undefined;
}

export function validateAppBuildAssetCompletion(
  completed: AppBuildAssetCompletion,
  expected: {
    checksumSha256: string;
    mediaId: string;
    purpose: AppBuildAssetPurpose;
    sizeBytes: number;
  },
): string {
  if (completed.id !== expected.mediaId || completed.purpose !== expected.purpose
    || completed.status !== 'ready' || completed.checksumSha256 !== expected.checksumSha256
    || completed.sizeBytes !== expected.sizeBytes || !Number.isInteger(completed.version)
    || completed.version < 1 || !Number.isInteger(completed.width) || completed.width < 1
    || !Number.isInteger(completed.height) || completed.height < 1
    || typeof completed.hasAlpha !== 'boolean') {
    throw new Error('服务端返回了无效的构建资产');
  }
  if (expected.purpose === 'app_icon'
    && (completed.width !== 1024 || completed.height !== 1024 || completed.hasAlpha)) {
    throw new Error('应用图标未通过 1024×1024 无透明通道校验');
  }
  return completed.id;
}

export function isSupportedBuildTarget(value: string): value is AppBuildTarget {
  return value === 'android_debug' || value === 'ios_simulator';
}

export function formatBuildBytes(value: string): string {
  if (!/^\d+$/.test(value)) return '—';
  const bytes = BigInt(value);
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let divisor = 1n;
  let unit = 0;
  while (unit < units.length - 1 && bytes >= divisor * 1024n) {
    divisor *= 1024n;
    unit += 1;
  }
  if (unit === 0) return `${bytes.toString()} ${units[unit]}`;
  const tenths = (bytes * 10n + divisor / 2n) / divisor;
  return `${(tenths / 10n).toString()}.${(tenths % 10n).toString()} ${units[unit]}`;
}

export function validateSecureBuildDownload(
  response: AppBuildDownloadResponse,
  now = Date.now(),
): string {
  if (!['application/vnd.android.package-archive', 'application/zip'].includes(response.contentType)) {
    throw new Error('下载文件类型不安全');
  }
  if (!/^[^/\\\u0000-\u001f]{1,160}$/.test(response.filename)) {
    throw new Error('下载文件名不安全');
  }
  if (!/^\d+$/.test(response.sizeBytes) || !/^sha256:[a-f0-9]{64}$/.test(response.checksum)) {
    throw new Error('下载文件元数据无效');
  }
  const expiresAt = Date.parse(response.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now || expiresAt > now + 5 * 60_000) {
    throw new Error('下载链接已失效');
  }
  if (response.url.length > 16_384) throw new Error('下载链接无效');
  let parsed: URL;
  try {
    parsed = new URL(response.url);
  } catch {
    throw new Error('下载链接无效');
  }
  if (
    parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash
  ) {
    throw new Error('下载链接不安全');
  }
  return parsed.toString();
}
