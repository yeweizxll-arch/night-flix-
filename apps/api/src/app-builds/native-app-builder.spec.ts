import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import sharp from 'sharp';
import { describe, expect, it } from 'vitest';

import { NativeAppBuilder } from './native-app-builder';

const smokeTargets = process.env.RUN_NATIVE_APP_BUILD_SMOKE_TARGETS
  ?.split(',')
  .filter((value): value is 'android_debug' | 'ios_simulator' =>
    value === 'android_debug' || value === 'ios_simulator') ?? [];
const execFileAsync = promisify(execFile);

describe('NativeAppBuilder', () => {
  it('rejects an iOS icon with alpha before invoking native tooling', async () => {
    const icon = await sharp({
      create: { background: { alpha: 0.5, b: 1, g: 2, r: 3 }, channels: 4, height: 1024, width: 1024 },
    }).png().toBuffer();
    await expect(new NativeAppBuilder().build({
      androidApplicationId: 'com.example.test',
      appName: 'Example Test',
      h5Origin: 'https://video.example.test',
      icon,
      iosBundleId: 'com.example.test',
      jobId: '018f2f45-7f5e-7e70-b17f-f6e7735d0201',
      target: 'ios_simulator',
    })).rejects.toMatchObject({ code: 'asset_unavailable' });
  });

  it.runIf(smokeTargets.length > 0)('builds real isolated Flutter artifacts', async () => {
    const icon = await sharp({
      create: { background: '#2563eb', channels: 3, height: 1024, width: 1024 },
    }).png().toBuffer();
    const builder = new NativeAppBuilder();
    for (const target of smokeTargets) {
      const output = await builder.build({
        androidApplicationId: 'com.example.generatedtest',
        appName: 'Generated Test',
        h5Origin: 'https://video.example.test',
        icon,
        iosBundleId: 'com.example.generatedtest',
        jobId: target === 'android_debug'
          ? '018f2f45-7f5e-7e70-b17f-f6e7735d0202'
          : '018f2f45-7f5e-7e70-b17f-f6e7735d0203',
        target,
      });
      try {
        expect(output.path).toMatch(target === 'android_debug' ? /\.apk$/ : /\.zip$/);
        if (target === 'android_debug') {
          const androidHome = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
          expect(androidHome).toBeTruthy();
          const aapt2 = process.env.APP_BUILD_AAPT2_BIN;
          expect(aapt2).toBeTruthy();
          const inspected = await execFileAsync(aapt2!, [
            'dump', 'xmltree', output.path, '--file', 'AndroidManifest.xml',
          ]);
          expect(inspected.stdout).toContain('package="com.example.generatedtest"');
        } else {
          const extracted = await mkdtemp(join(tmpdir(), 'app-build-smoke-'));
          try {
            await execFileAsync('/usr/bin/unzip', ['-q', output.path, '-d', extracted]);
            const plist = join(extracted, 'App.app', 'Info.plist');
            const bundleId = await execFileAsync('/usr/bin/plutil', [
              '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist,
            ]);
            const displayName = await execFileAsync('/usr/bin/plutil', [
              '-extract', 'CFBundleDisplayName', 'raw', '-o', '-', plist,
            ]);
            expect(bundleId.stdout.trim()).toBe('com.example.generatedtest');
            expect(displayName.stdout.trim()).toBe('Generated Test');
          } finally {
            await rm(extracted, { force: true, recursive: true });
          }
        }
      } finally {
        await output.cleanup();
      }
    }
  }, 30 * 60_000);
});
