import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

import { NestFactory } from '@nestjs/core';

import { AppBuildWorkerService } from '../app-builds';
import type { AppBuildTarget } from '../app-builds/app-build.types';
import { DatabaseService } from '../database/database.service';
import { AppBuildWorkerModule } from '../workers/app-build-worker.module';

async function main(): Promise<void> {
  if (process.env.APP_BUILD_WORKER_ENABLED !== 'true'
    || process.env.APP_BUILD_EXECUTOR !== 'local') {
    throw new Error(
      'The dedicated app-build worker requires APP_BUILD_WORKER_ENABLED=true '
      + 'and APP_BUILD_EXECUTOR=local',
    );
  }
  const application = await NestFactory.createApplicationContext(AppBuildWorkerModule, {
    logger: ['error', 'warn', 'log'],
  });
  let stopping = false;
  let registered = false;
  let heartbeatError: unknown;
  let heartbeatRunning = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let builds: AppBuildWorkerService | undefined;
  let workerId: string | undefined;
  const stop = () => { stopping = true; };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await application.get(DatabaseService).validateProductionSecurity();
    const workerService = application.get(AppBuildWorkerService);
    builds = workerService;
    const capabilities = await detectCapabilities();
    workerId = process.env.WORKER_ID?.trim()
      || `app-build-worker:${process.pid}:${randomUUID()}`;
    await workerService.registerHeartbeat(capabilities, workerId);
    registered = true;
    await workerService.recoverStaleLocks();

    const pollIntervalMs = integerEnvironment(
      'APP_BUILD_POLL_INTERVAL_MS', 2_000, 500, 60_000,
    );
    heartbeat = setInterval(() => {
      if (stopping || heartbeatRunning || !workerId) return;
      heartbeatRunning = true;
      void workerService.registerHeartbeat(capabilities, workerId)
        .catch((error: unknown) => {
          heartbeatError = error;
          stopping = true;
        })
        .finally(() => { heartbeatRunning = false; });
    }, 10_000);
    heartbeat.unref();
    while (!stopping) {
      const result = await workerService.processAvailable(1, workerId);
      if (result.claimed === 0) await wait(pollIntervalMs);
    }
    if (heartbeatError) throw heartbeatError;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    if (registered && builds && workerId) {
      await builds.unregisterHeartbeat(workerId).catch(() => undefined);
    }
    await application.close();
  }
}

async function detectCapabilities(): Promise<AppBuildTarget[]> {
  const templateRoot = await requiredDirectory(
    'APP_BUILD_TEMPLATE_ROOT', process.env.APP_BUILD_TEMPLATE_ROOT,
  );
  await requiredFile(
    'Flutter executable',
    await requiredAbsoluteFile('APP_BUILD_FLUTTER_BIN', process.env.APP_BUILD_FLUTTER_BIN),
  );
  await requiredFile('Flutter pubspec', join(templateRoot, 'pubspec.yaml'));
  await requiredDirectory('APP_BUILD_PUB_CACHE', process.env.APP_BUILD_PUB_CACHE);
  const providerId = process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID?.trim() ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(providerId)) {
    throw new Error('APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID is invalid');
  }

  const capabilities: AppBuildTarget[] = [];
  const androidSdk = process.env.ANDROID_HOME?.trim() || process.env.ANDROID_SDK_ROOT?.trim();
  if (androidSdk) {
    await requiredDirectory('Android SDK', androidSdk);
    await requiredFile(
      'Flutter Android project', join(templateRoot, 'android', 'app', 'build.gradle.kts'),
    );
    if (process.env.APP_BUILD_GRADLE_USER_HOME?.trim()) {
      await requiredDirectory(
        'APP_BUILD_GRADLE_USER_HOME', process.env.APP_BUILD_GRADLE_USER_HOME,
      );
    }
    capabilities.push('android_debug');
  }

  const pod = process.env.APP_BUILD_COCOAPODS_BIN?.trim();
  if (process.platform === 'darwin' && pod) {
    await requiredFile(
      'CocoaPods executable',
      await requiredAbsoluteFile('APP_BUILD_COCOAPODS_BIN', pod),
    );
    await requiredDirectory(
      'Flutter iOS project', join(templateRoot, 'ios', 'Runner.xcodeproj'),
    );
    await requiredFile('xcodebuild', '/usr/bin/xcodebuild');
    await requiredFile('ditto', '/usr/bin/ditto');
    capabilities.push('ios_simulator');
  }
  if (capabilities.length === 0) {
    throw new Error('No usable Android or iOS Simulator app-build toolchain is configured');
  }
  return capabilities;
}

async function requiredAbsoluteFile(name: string, value: string | undefined): Promise<string> {
  const path = value?.trim() ?? '';
  if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute file`);
  return path;
}

async function requiredDirectory(name: string, value: string | undefined): Promise<string> {
  const path = value?.trim() ?? '';
  if (!path || !isAbsolute(path)) throw new Error(`${name} must be an absolute directory`);
  const details = await stat(path).catch(() => undefined);
  if (!details?.isDirectory()) throw new Error(`${name} must be an existing directory`);
  return path;
}

async function requiredFile(name: string, path: string): Promise<void> {
  const details = await stat(path).catch(() => undefined);
  if (!details?.isFile()) throw new Error(`${name} is unavailable`);
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
