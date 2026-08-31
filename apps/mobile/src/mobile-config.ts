export interface MobileTestConfiguration {
  appId: string;
  appName: string;
  serverUrl: string;
}

export function mobileTestConfiguration(
  environment: NodeJS.ProcessEnv,
): MobileTestConfiguration {
  const appId = 'com.drama.saas.test';
  const appName = 'Drama SaaS Test';
  const rawServerUrl = environment.MOBILE_SERVER_URL?.trim();
  if (!rawServerUrl) {
    throw new Error('MOBILE_SERVER_URL is required for the internal test package');
  }

  let url: URL;
  try {
    url = new URL(rawServerUrl);
  } catch {
    throw new Error('MOBILE_SERVER_URL must be a valid URL');
  }
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.port
    || url.pathname !== '/'
    || url.search
    || url.hash
    || url.hostname.length > 253
    || !isPublicDnsName(url.hostname)
  ) {
    throw new Error('MOBILE_SERVER_URL must be a clean public HTTPS origin');
  }

  return { appId, appName, serverUrl: url.origin };
}

function isPublicDnsName(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return false;
  if (!hostname.includes('.') || hostname.length > 253) return false;
  if (/^\d+(?:\.\d+){3}$/.test(hostname) || hostname.includes(':')) return false;
  return hostname.split('.').every((label) => (
    label.length >= 1
    && label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  ));
}
