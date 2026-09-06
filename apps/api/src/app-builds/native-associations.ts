import type { NativeAppBuildInput, NativeReleaseConfiguration } from './native-app-builder';

/** Serve the returned file at https://deepLinkHost/.well-known/<name>, without redirects. */
export function nativeAssociations(input: Pick<NativeAppBuildInput, 'androidApplicationId' | 'iosBundleId' | 'target'>,
  release: NativeReleaseConfiguration): { name: string; contents: string } | undefined {
  if (!release.deepLinkHost) return undefined;
  if (input.target === 'android_debug') {
    const fingerprints = release.androidLinkCertificateSha256;
    if (!fingerprints?.length || fingerprints.some(value => !/^(?:[0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}$/.test(value))) {
      throw new Error('Missing verified app-signing fingerprints');
    }
    return { name: 'assetlinks.json', contents: JSON.stringify([{
      relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app',
        package_name: input.androidApplicationId, sha256_cert_fingerprints: fingerprints.map(value => value.toUpperCase()) },
    }], null, 2) };
  }
  if (!/^[A-Z0-9]{10}$/.test(release.iosTeamId ?? '')) throw new Error('Missing iOS team');
  return { name: 'apple-app-site-association', contents: JSON.stringify({
    applinks: { details: [{ appIDs: [release.iosTeamId + '.' + input.iosBundleId], components: [{ '/': '/dramas/*' }] }] },
  }, null, 2) };
}
