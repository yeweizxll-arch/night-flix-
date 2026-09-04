import { spawn } from 'node:child_process';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import sharp from 'sharp';

import { AppBuildExecutionError } from './app-build-executor';
import type { AppBuildTarget } from './app-build.types';

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_ARTIFACT_BYTES = 4_294_967_296;
const COMMAND_TIMEOUT_MS = 20 * 60 * 1_000;
const OUTPUT_LIMIT_BYTES = 128 * 1024;

export interface NativeAppBuildInput {
  androidApplicationId: string;
  appName: string;
  h5Origin: string;
  icon: Buffer;
  iosBundleId: string;
  jobId: string;
  splash?: Buffer;
  target: AppBuildTarget;
}

export interface NativeAppBuildOutput {
  cleanup(): Promise<void>;
  contentType: 'application/vnd.android.package-archive' | 'application/zip';
  filename: string;
  path: string;
}

export class NativeAppBuilder {
  async build(input: NativeAppBuildInput): Promise<NativeAppBuildOutput> {
    const validated = await validateInput(input);
    const templateRoot = await resolveTemplateRoot(process.env.APP_BUILD_TEMPLATE_ROOT);
    const flutter = await resolveFlutterBinary(process.env.APP_BUILD_FLUTTER_BIN);
    const temporaryRoot = await createTemporaryRoot(process.env.APP_BUILD_TMP_ROOT);
    try {
      const built = validated.target === 'android_debug'
        ? await this.buildAndroid(flutter, templateRoot, temporaryRoot, validated)
        : await this.buildIosSimulator(flutter, templateRoot, temporaryRoot, validated);
      const info = await stat(built.path);
      if (!info.isFile() || info.size < 1 || info.size > MAX_ARTIFACT_BYTES) {
        throw new AppBuildExecutionError('build_failed');
      }
      return {
        ...built,
        cleanup: () => cleanupTemporaryRoot(temporaryRoot),
      };
    } catch (error) {
      await cleanupTemporaryRoot(temporaryRoot);
      if (error instanceof AppBuildExecutionError) throw error;
      throw new AppBuildExecutionError('build_failed');
    }
  }

  private async buildAndroid(
    flutter: string,
    templateRoot: string,
    temporaryRoot: string,
    input: Awaited<ReturnType<typeof validateInput>>,
  ): Promise<Omit<NativeAppBuildOutput, 'cleanup'>> {
    const target = join(temporaryRoot, 'flutter_app');
    await copyFlutterTemplate(templateRoot, target);
    const gradlePath = join(target, 'android', 'app', 'build.gradle.kts');
    let gradle = await readFile(gradlePath, 'utf8');
    gradle = replaceRequired(gradle, 'namespace = "com.nightflix.template"',
      `namespace = "${input.androidApplicationId}"`);
    gradle = replaceRequired(gradle, 'applicationId = "com.nightflix.template"',
      `applicationId = "${input.androidApplicationId}"`);
    await writeFile(gradlePath, gradle, 'utf8');

    const oldKotlin = join(
      target, 'android', 'app', 'src', 'main', 'kotlin',
      'com', 'nightflix', 'template', 'MainActivity.kt',
    );
    const packageDirectory = join(
      target, 'android', 'app', 'src', 'main', 'kotlin', ...input.androidApplicationId.split('.'),
    );
    await mkdir(packageDirectory, { recursive: true });
    const kotlin = replaceRequired(
      await readFile(oldKotlin, 'utf8'),
      'package com.nightflix.template',
      `package ${input.androidApplicationId}`,
    );
    await writeFile(join(packageDirectory, 'MainActivity.kt'), kotlin, 'utf8');
    if (dirname(oldKotlin) !== packageDirectory) {
      await rm(oldKotlin, { force: true });
    }

    await writeAndroidManifest(target, input);
    await writeAndroidImages(target, input.icon, input.splash);
    await writeFile(join(target, 'assets', 'brand', 'app-icon-master.png'), input.icon);
    const environment: NodeJS.ProcessEnv = {
      PUB_CACHE: await requiredAbsoluteDirectory(
        process.env.APP_BUILD_PUB_CACHE,
        'APP_BUILD_PUB_CACHE',
      ),
    };
    if (process.env.APP_BUILD_GRADLE_USER_HOME) {
      environment.GRADLE_USER_HOME = await requiredAbsoluteDirectory(
        process.env.APP_BUILD_GRADLE_USER_HOME,
        'APP_BUILD_GRADLE_USER_HOME',
      );
    }
    const buildEnvironmentVariables = buildEnvironment(environment);
    await runFixedCommand(
      flutter,
      ['--suppress-analytics', 'pub', 'get', '--offline'],
      { cwd: target, environment: buildEnvironmentVariables },
    );
    await runFixedCommand(flutter, [
      '--suppress-analytics', 'build', 'apk', '--debug', '--no-pub',
      `--dart-define=API_BASE_URL=${input.h5Origin}`,
    ], { cwd: target, environment: buildEnvironmentVariables });
    const produced = join(target, 'build', 'app', 'outputs', 'flutter-apk', 'app-debug.apk');
    const filename = `${input.jobId}-android-debug.apk`;
    const artifact = join(temporaryRoot, filename);
    await rename(produced, artifact);
    return {
      contentType: 'application/vnd.android.package-archive',
      filename,
      path: artifact,
    };
  }

  private async buildIosSimulator(
    flutter: string,
    templateRoot: string,
    temporaryRoot: string,
    input: Awaited<ReturnType<typeof validateInput>>,
  ): Promise<Omit<NativeAppBuildOutput, 'cleanup'>> {
    if (process.platform !== 'darwin') {
      throw new AppBuildExecutionError('builder_unavailable');
    }
    const target = join(temporaryRoot, 'flutter_app');
    await copyFlutterTemplate(templateRoot, target);
    const projectPath = join(target, 'ios', 'Runner.xcodeproj', 'project.pbxproj');
    let project = await readFile(projectPath, 'utf8');
    const matches = project.match(/PRODUCT_BUNDLE_IDENTIFIER = com\.nightflix\.template;/g) ?? [];
    if (matches.length < 1) throw new AppBuildExecutionError('build_failed');
    project = project.replace(
      /PRODUCT_BUNDLE_IDENTIFIER = com\.nightflix\.template;/g,
      `PRODUCT_BUNDLE_IDENTIFIER = ${input.iosBundleId};`,
    );
    project = project.replace(
      /PRODUCT_BUNDLE_IDENTIFIER = com\.nightflix\.template\.RunnerTests;/g,
      `PRODUCT_BUNDLE_IDENTIFIER = ${input.iosBundleId}.RunnerTests;`,
    );
    await writeFile(projectPath, project, 'utf8');

    const infoPath = join(target, 'ios', 'Runner', 'Info.plist');
    let info = await readFile(infoPath, 'utf8');
    info = info.replace(
      /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
      `$1${xmlText(input.appName)}$2`,
    );
    await writeFile(infoPath, info, 'utf8');
    await writeIosImages(target, input.icon, input.splash);
    await writeFile(join(target, 'assets', 'brand', 'app-icon-master.png'), input.icon);

    const buildEnvironmentVariables = buildEnvironment({
      PUB_CACHE: await requiredAbsoluteDirectory(
        process.env.APP_BUILD_PUB_CACHE,
        'APP_BUILD_PUB_CACHE',
      ),
    });
    await runFixedCommand(
      flutter,
      ['--suppress-analytics', 'pub', 'get', '--offline'],
      { cwd: target, environment: buildEnvironmentVariables },
    );
    await runFixedCommand(flutter, [
      '--suppress-analytics', 'build', 'ios', '--simulator', '--debug', '--no-codesign', '--no-pub',
      `--dart-define=API_BASE_URL=${input.h5Origin}`,
    ], {
      cwd: target,
      environment: buildEnvironmentVariables,
    });
    const app = join(target, 'build', 'ios', 'iphonesimulator', 'Runner.app');
    const filename = `${input.jobId}-ios-simulator.zip`;
    const artifact = join(temporaryRoot, filename);
    await runFixedCommand('/usr/bin/ditto', [
      '-c', '-k', '--sequesterRsrc', '--keepParent', app, artifact,
    ], { cwd: temporaryRoot, environment: buildEnvironment() });
    return { contentType: 'application/zip', filename, path: artifact };
  }
}

async function validateInput(input: NativeAppBuildInput) {
  if (!input || typeof input !== 'object') throw new AppBuildExecutionError('build_failed');
  if (!/^[0-9a-f-]{36}$/i.test(input.jobId)
    || !/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/.test(input.androidApplicationId)
    || !/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/.test(input.iosBundleId)
    || input.appName.length < 2 || input.appName.length > 50
    || /[\u0000-\u001f\u007f]/.test(input.appName)
    || !Buffer.isBuffer(input.icon) || input.icon.length < 1 || input.icon.length > MAX_IMAGE_BYTES
    || (input.splash !== undefined
      && (!Buffer.isBuffer(input.splash) || input.splash.length < 1
        || input.splash.length > MAX_IMAGE_BYTES))) {
    throw new AppBuildExecutionError('asset_unavailable');
  }
  const origin = cleanHttpsOrigin(input.h5Origin);
  const icon = await sharp(input.icon, { limitInputPixels: 100_000_000 }).metadata()
    .catch(() => undefined);
  if (!icon || icon.format !== 'png' || icon.width !== 1024 || icon.height !== 1024) {
    throw new AppBuildExecutionError('asset_unavailable');
  }
  if (input.target === 'ios_simulator' && icon.hasAlpha) {
    throw new AppBuildExecutionError('asset_unavailable');
  }
  if (input.splash) {
    const splash = await sharp(input.splash, { limitInputPixels: 100_000_000 }).metadata()
      .catch(() => undefined);
    if (!splash || !splash.width || !splash.height
      || splash.width > 10_000 || splash.height > 10_000
      || !['jpeg', 'png', 'webp'].includes(splash.format ?? '')) {
      throw new AppBuildExecutionError('asset_unavailable');
    }
  }
  return { ...input, h5Origin: origin };
}

async function writeAndroidManifest(
  root: string,
  input: Awaited<ReturnType<typeof validateInput>>,
) {
  const path = join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
  const manifest = replaceRequired(
    await readFile(path, 'utf8'),
    'android:label="night_flix"',
    `android:label="${xmlText(input.appName)}"`,
  );
  await writeFile(path, manifest, 'utf8');
}

async function writeAndroidImages(root: string, icon: Buffer, splash?: Buffer) {
  const resourceRoot = join(root, 'android', 'app', 'src', 'main', 'res');
  const files = await collectPngFiles(resourceRoot);
  for (const path of files) {
    const current = await sharp(path).metadata();
    if (!current.width || !current.height) throw new AppBuildExecutionError('build_failed');
    await sharp(icon, { limitInputPixels: 100_000_000 })
      .resize(current.width, current.height, { background: '#080911', fit: 'contain' })
      .png()
      .toFile(`${path}.next`);
    await rename(`${path}.next`, path);
  }
  if (splash) {
    const launchImage = join(resourceRoot, 'drawable', 'launch_image.png');
    await sharp(splash, { limitInputPixels: 100_000_000 })
      .resize(1080, 1920, { fit: 'cover' }).png().toFile(launchImage);
    for (const directory of ['drawable', 'drawable-v21']) {
      const path = join(resourceRoot, directory, 'launch_background.xml');
      const source = await readFile(path, 'utf8');
      const layer = `<?xml version="1.0" encoding="utf-8"?>\n`
        + `<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n`
        + `    <item android:drawable="@android:color/black" />\n`
        + `    <item><bitmap android:gravity="fill" android:src="@drawable/launch_image" /></item>\n`
        + `</layer-list>\n`;
      if (!source.includes('<layer-list')) throw new AppBuildExecutionError('build_failed');
      await writeFile(path, layer, 'utf8');
    }
  }
}

async function writeIosImages(root: string, icon: Buffer, splash?: Buffer) {
  const iconRoot = join(root, 'ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset');
  for (const path of await collectPngFiles(iconRoot)) {
    const current = await sharp(path).metadata();
    if (!current.width || !current.height) throw new AppBuildExecutionError('build_failed');
    await sharp(icon).resize(current.width, current.height, { fit: 'cover' })
      .removeAlpha().png().toFile(`${path}.next`);
    await rename(`${path}.next`, path);
  }
  const splashRoot = join(root, 'ios', 'Runner', 'Assets.xcassets', 'LaunchImage.imageset');
  for (const path of await collectPngFiles(splashRoot)) {
    const current = await sharp(path).metadata();
    if (!current.width || !current.height) throw new AppBuildExecutionError('build_failed');
    await sharp(splash ?? icon)
      .resize(current.width, current.height, {
        background: '#080911', fit: splash ? 'cover' : 'contain',
      })
      .png()
      .toFile(`${path}.next`);
    await rename(`${path}.next`, path);
  }
}

async function collectPngFiles(root: string): Promise<string[]> {
  const { readdir } = await import('node:fs/promises');
  const result: string[] = [];
  const visit = async (directory: string) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && entry.name.endsWith('.png')) result.push(path);
    }
  };
  await visit(root);
  return result;
}

async function copyFlutterTemplate(source: string, target: string) {
  const root = await realpath(source).catch(() => undefined);
  if (!root) throw new AppBuildExecutionError('builder_unavailable');
  await cp(root, target, {
    recursive: true,
    filter: (path) => {
      const pathRelative = relative(root, path);
      if (!pathRelative) return true;
      const parts = pathRelative.split(sep);
      return !parts.some((part) => [
        '.dart_tool', '.git', '.gradle', '.idea', 'Pods', 'build', 'node_modules',
      ].includes(part));
    },
  });
}

async function createTemporaryRoot(configured: string | undefined) {
  const base = configured
    ? await requiredAbsoluteDirectory(configured, 'APP_BUILD_TMP_ROOT')
    : tmpdir();
  return mkdtemp(join(base, 'drama-app-build-'));
}

async function cleanupTemporaryRoot(path: string) {
  if (!basename(path).startsWith('drama-app-build-')) {
    throw new Error('Refusing to clean an unexpected build path');
  }
  await rm(path, { force: true, recursive: true, maxRetries: 3 });
}

async function resolveTemplateRoot(value: string | undefined) {
  if (!value || !isAbsolute(value)) throw new AppBuildExecutionError('builder_unavailable');
  return realpath(value).catch(() => { throw new AppBuildExecutionError('builder_unavailable'); });
}

async function resolveFlutterBinary(value: string | undefined) {
  if (!value || !isAbsolute(value)) throw new AppBuildExecutionError('builder_unavailable');
  const path = await realpath(value).catch(() => undefined);
  if (!path || !(await stat(path)).isFile()) {
    throw new AppBuildExecutionError('builder_unavailable');
  }
  return path;
}

async function requiredAbsoluteDirectory(value: string | undefined, name: string) {
  if (!value || !isAbsolute(value)) throw new AppBuildExecutionError('builder_unavailable');
  const path = await realpath(value).catch(() => undefined);
  if (!path || !(await stat(path)).isDirectory()) {
    throw new AppBuildExecutionError('builder_unavailable');
  }
  if (path.includes('\u0000')) throw new AppBuildExecutionError('builder_unavailable');
  return path;
}

async function runFixedCommand(
  command: string,
  args: string[],
  options: { cwd: string; environment: NodeJS.ProcessEnv },
) {
  await new Promise<void>((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      detached: process.platform !== 'win32',
      env: options.environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let outputBytes = 0;
    const diagnosticChunks: Buffer[] = [];
    const consume = (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (process.env.NODE_ENV !== 'production'
        && process.env.APP_BUILD_DEBUG_OUTPUT === 'true'
        && outputBytes <= OUTPUT_LIMIT_BYTES) {
        diagnosticChunks.push(Buffer.from(chunk));
      }
      if (outputBytes > OUTPUT_LIMIT_BYTES) terminateChild(child.pid);
    };
    child.stdout?.on('data', consume);
    child.stderr?.on('data', consume);
    const timeout = setTimeout(() => terminateChild(child.pid), COMMAND_TIMEOUT_MS);
    child.once('error', () => {
      clearTimeout(timeout);
      rejectPromise(new AppBuildExecutionError('builder_unavailable'));
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      if (diagnosticChunks.length > 0) {
        process.stderr.write(Buffer.concat(diagnosticChunks).toString('utf8'));
      }
      if (code === 0 && outputBytes <= OUTPUT_LIMIT_BYTES) resolvePromise();
      else rejectPromise(new AppBuildExecutionError('build_failed'));
    });
  });
}

function terminateChild(pid: number | undefined) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') process.kill(pid, 'SIGKILL');
    else process.kill(-pid, 'SIGKILL');
  } catch {
    // The child may have exited between the bound check and termination.
  }
}

function buildEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL,
    PATH: process.env.PATH,
    ...extra,
  };
  for (const key of ['ANDROID_HOME', 'ANDROID_SDK_ROOT', 'JAVA_HOME', 'DEVELOPER_DIR']) {
    if (process.env[key]) environment[key] = process.env[key];
  }
  return environment;
}

function cleanHttpsOrigin(value: string) {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new AppBuildExecutionError('build_failed');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port
    || parsed.pathname !== '/' || parsed.search || parsed.hash || !parsed.hostname.includes('.')) {
    throw new AppBuildExecutionError('build_failed');
  }
  return parsed.origin;
}

function replaceRequired(source: string, find: string, replacement: string) {
  if (!source.includes(find)) throw new AppBuildExecutionError('build_failed');
  return source.replace(find, replacement);
}

function xmlText(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
