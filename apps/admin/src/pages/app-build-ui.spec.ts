import { describe, expect, it } from 'vitest';

import {
  appBuildBase,
  eligibleBuildDomains,
  eligibleIconAssets,
  eligibleLaunchAssets,
  formatBuildBytes,
  isSupportedBuildTarget,
  validateAppBuildAssetCompletion,
  validateAppBuildAssetFile,
  validateSecureBuildDownload,
  type AppBuildDownloadResponse,
} from './app-build-ui';

const now = Date.parse('2026-08-23T00:00:00.000Z');
const validDownload: AppBuildDownloadResponse = {
  checksum: `sha256:${'a'.repeat(64)}`,
  contentType: 'application/zip',
  expiresAt: '2026-08-23T00:03:00.000Z',
  filename: 'tenant-ios-simulator.zip',
  sizeBytes: '9007199254740993',
  url: 'https://downloads.example.com/build.zip?signature=short-lived',
};

describe('app build UI helpers', () => {
  it('encodes the merchant id in the platform-only route', () => {
    expect(appBuildBase('tenant/a')).toBe('/api/v1/platform/merchants/tenant%2Fa/app-builds');
  });

  it('only exposes eligible TLS domains and PNG icon candidates', () => {
    expect(eligibleBuildDomains([
      { eligible: false, host: 'pending.example.com', id: '1' },
      { eligible: true, host: 'ready.example.com', id: '2' },
    ]).map((item) => item.id)).toEqual(['2']);
    expect(eligibleIconAssets([
      { buildReady: true, iconCandidate: true, id: 'png', mimeType: 'image/png', purpose: 'app_icon' },
      { buildReady: true, iconCandidate: true, id: 'jpeg', mimeType: 'image/jpeg', purpose: 'app_icon' },
      { buildReady: true, iconCandidate: false, id: 'other', mimeType: 'image/png', purpose: 'app_icon' },
      { buildReady: true, iconCandidate: false, id: 'launch', mimeType: 'image/png', purpose: 'launch_image' },
    ]).map((item) => item.id)).toEqual(['png']);
    expect(eligibleLaunchAssets([
      { buildReady: true, iconCandidate: false, id: 'launch', mimeType: 'image/webp', purpose: 'launch_image' },
      { buildReady: true, iconCandidate: true, id: 'icon', mimeType: 'image/png', purpose: 'app_icon' },
    ]).map((item) => item.id)).toEqual(['launch']);
  });

  it('enforces build-purpose MIME and size limits before hashing', () => {
    expect(validateAppBuildAssetFile({ size: 1024, type: 'image/png' }, 'app_icon')).toBeUndefined();
    expect(validateAppBuildAssetFile({ size: 1024, type: 'image/jpeg' }, 'app_icon')).toContain('PNG');
    expect(validateAppBuildAssetFile({ size: 1024, type: 'image/webp' }, 'launch_image')).toBeUndefined();
    expect(validateAppBuildAssetFile({ size: 25 * 1024 ** 2 + 1, type: 'image/png' }, 'launch_image')).toContain('25 MiB');
  });

  it('only accepts a ready completion bound to the requested file and purpose', () => {
    const expected = {
      checksumSha256: 'a'.repeat(64),
      mediaId: '018f6f18-6d29-7d85-8f39-91a713913f4b',
      purpose: 'app_icon' as const,
      sizeBytes: 2048,
    };
    const completed = {
      ...expected,
      hasAlpha: false,
      height: 1024,
      id: expected.mediaId,
      status: 'ready' as const,
      version: 2,
      width: 1024,
    };
    expect(validateAppBuildAssetCompletion(completed, expected)).toBe(expected.mediaId);
    expect(() => validateAppBuildAssetCompletion({ ...completed, hasAlpha: true }, expected)).toThrow('透明');
    expect(() => validateAppBuildAssetCompletion({ ...completed, purpose: 'launch_image' }, expected)).toThrow('无效');
    expect(() => validateAppBuildAssetCompletion({ ...completed, checksumSha256: 'b'.repeat(64) }, expected)).toThrow('无效');
  });

  it('never treats store targets as an available internal build', () => {
    expect(isSupportedBuildTarget('android_debug')).toBe(true);
    expect(isSupportedBuildTarget('ios_simulator')).toBe(true);
    expect(isSupportedBuildTarget('android_store')).toBe(false);
    expect(isSupportedBuildTarget('testflight')).toBe(false);
  });

  it('formats byte counts without converting large integers to Number', () => {
    expect(formatBuildBytes('1024')).toBe('1.0 KiB');
    expect(formatBuildBytes('9007199254740993')).toBe('8192.0 TiB');
  });

  it('accepts only an unexpired HTTPS download without credentials or fragments', () => {
    expect(validateSecureBuildDownload(validDownload, now)).toBe(validDownload.url);
    for (const url of [
      'http://downloads.example.com/build.zip',
      'https://user:password@downloads.example.com/build.zip',
      'https://downloads.example.com/build.zip#secret',
    ]) {
      expect(() => validateSecureBuildDownload({ ...validDownload, url }, now)).toThrow();
    }
    expect(() => validateSecureBuildDownload({
      ...validDownload,
      expiresAt: '2026-08-22T23:59:00.000Z',
    }, now)).toThrow('已失效');
  });
});
