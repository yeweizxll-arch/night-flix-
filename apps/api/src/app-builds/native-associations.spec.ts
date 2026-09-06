import { describe, expect, it } from 'vitest';
import { nativeAssociations } from './native-associations';
import { validateNativeRelease, type NativeAppBuildInput } from './native-app-builder';
const input: NativeAppBuildInput = { androidApplicationId: 'com.tenant.a', iosBundleId: 'com.tenant.a', appName: 'Tenant',
  h5Origin: 'https://watch.example.com', icon: Buffer.alloc(0), jobId: 'build-test', target: 'android_debug' };
describe('tenant native release identity', () => {
  it('generates platform-bound association files and never invents a signing fingerprint', () => {
    const release = { admobAppId: 'ca-app-pub-1111111111111111~1111111111', deepLinkHost: 'watch.example.com',
      androidLinkCertificateSha256: [Array(32).fill('AB').join(':')], iosTeamId: 'ABCDEFG123' };
    const android = nativeAssociations(input, release)!;
    expect(android.name).toBe('assetlinks.json');
    expect(JSON.parse(android.contents)[0].target).toEqual({ namespace: 'android_app', package_name: 'com.tenant.a',
      sha256_cert_fingerprints: release.androidLinkCertificateSha256 });
    const ios = nativeAssociations({ ...input, target: 'ios_simulator' }, release)!;
    expect(JSON.parse(ios.contents).applinks.details[0].appIDs).toEqual(['ABCDEFG123.com.tenant.a']);
    expect(() => nativeAssociations(input, { ...release, androidLinkCertificateSha256: [] })).toThrow();
    expect(nativeAssociations(input, { admobAppId: release.admobAppId })).toBeUndefined();
  });
  it('fails before invoking the toolchain for shared/test IDs, missing signing and foreign Firebase apps', async () => {
    const release = { admobAppId: 'ca-app-pub-1111111111111111~1111111111' };
    await expect(validateNativeRelease(input, release)).rejects.toThrow('signing profile');
    await expect(validateNativeRelease({ ...input, androidApplicationId: 'com.nightflix.template' }, release)).rejects.toThrow('tenant application');
    await expect(validateNativeRelease(input, { admobAppId: 'ca-app-pub-3940256099942544~3347511713' })).rejects.toThrow('non-test');
    await expect(validateNativeRelease(input, { ...release, firebaseOptions: {
      apiKey: 'a'.repeat(32), appId: '1:123456789:android:abc123', messagingSenderId: '123456789',
      projectId: 'tenant-example', androidPackageName: 'com.other.tenant',
    } })).rejects.toThrow('does not match');
  });
});
