import 'reflect-metadata';
import { constants } from 'node:fs';
import { copyFile, readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { NativeAppBuilder, type NativeReleaseConfiguration } from '../app-builds/native-app-builder';
import { nativeAssociations } from '../app-builds/native-associations';

// Run only on a local build machine / dedicated CI. No database, upload or deployment.
async function main() {
  const [configurationPath, outputDirectory] = process.argv.slice(2);
  if (!configurationPath || !outputDirectory || !isAbsolute(configurationPath)
    || !isAbsolute(outputDirectory) || !(await stat(outputDirectory)).isDirectory()) {
    throw new Error('Usage: app:release /absolute/tenant-release.private.json /absolute/output-directory');
  }
  if ((await stat(configurationPath)).size > 64_000) throw new Error('Configuration too large');
  const config = JSON.parse(await readFile(configurationPath, 'utf8')) as {
    androidApplicationId: string; appName: string; apiOrigin: string; iconPath: string;
    iosBundleId: string; platform: 'android' | 'ios'; release: NativeReleaseConfiguration;
  };
  if (!['android', 'ios'].includes(config.platform) || !config.release || !isAbsolute(config.iconPath)) {
    throw new Error('Explicit platform, icon path and private release configuration required');
  }
  const output = await new NativeAppBuilder().build({
    androidApplicationId: config.androidApplicationId, iosBundleId: config.iosBundleId,
    appName: config.appName, h5Origin: config.apiOrigin, icon: await readFile(config.iconPath),
    jobId: randomUUID(), target: config.platform === 'android' ? 'android_debug' : 'ios_simulator',
  }, config.release);
  try {
    const destination = join(outputDirectory, output.filename);
    await copyFile(output.path, destination, constants.COPYFILE_EXCL);
    const sha256 = createHash('sha256').update(await readFile(destination)).digest('hex');
    const association = nativeAssociations({ ...config, target: config.platform === 'android' ? 'android_debug' : 'ios_simulator' }, config.release);
    let associationPath: string | undefined;
    if (association) {
      const directory = join(outputDirectory, output.filename + '.well-known');
      await mkdir(directory);
      associationPath = join(directory, association.name);
      await writeFile(associationPath, association.contents, { flag: 'wx' });
    }
    process.stdout.write(JSON.stringify({ path: destination, sha256, associationPath, deployed: false }) + '\n');
  } finally { await output.cleanup(); }
}
void main().catch(() => {
  // Private credential/configuration contents and native build logs are never echoed.
  process.stderr.write('Tenant release failed. Check the signing profile, SDK and build configuration locally.\n');
  process.exitCode = 1;
});
