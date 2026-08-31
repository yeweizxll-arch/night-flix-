import { isIP } from 'node:net';

export function validateStorageEndpoint(
  endpointValue: string,
  environment: NodeJS.ProcessEnv = process.env,
): URL {
  const endpoint = validatePublicHttpsOrigin(endpointValue);
  const hostname = normalizeHostname(endpoint.hostname);
  const allowlist = parseAllowlist(environment.STORAGE_ENDPOINT_HOST_ALLOWLIST);
  if (environment.NODE_ENV === 'production' && allowlist.length === 0) {
    throw new Error('STORAGE_ENDPOINT_HOST_ALLOWLIST is required for custom endpoints in production');
  }
  if (allowlist.length > 0 && !allowlist.some((entry) => matchesAllowlist(hostname, entry))) {
    throw new TypeError('Storage endpoint hostname is not allowlisted');
  }
  return endpoint;
}

export function validatePublicHttpsOrigin(endpointValue: string): URL {
  let endpoint: URL;
  try {
    endpoint = new URL(endpointValue);
  } catch {
    throw new TypeError('Storage endpoint is invalid');
  }
  if (
    endpoint.protocol !== 'https:'
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || endpoint.pathname !== '/'
    || !endpoint.hostname
  ) {
    throw new TypeError('Storage endpoint must be a credential-free HTTPS origin');
  }
  const hostname = normalizeHostname(endpoint.hostname);
  assertPublicHostname(hostname);
  return endpoint;
}

function parseAllowlist(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const entries = value.split(',').map((item) => item.trim().toLowerCase());
  if (entries.length > 100 || entries.some((entry) => !isValidAllowlistEntry(entry))) {
    throw new Error('STORAGE_ENDPOINT_HOST_ALLOWLIST is invalid');
  }
  return [...new Set(entries)];
}

function isValidAllowlistEntry(value: string): boolean {
  const hostname = value.startsWith('*.') ? value.slice(2) : value;
  return hostname.length >= 3
    && hostname.length <= 253
    && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])$/.test(hostname)
    && !hostname.includes('..')
    && isIP(hostname) === 0;
}

function matchesAllowlist(hostname: string, entry: string): boolean {
  if (!entry.startsWith('*.')) return hostname === entry;
  const suffix = entry.slice(1);
  return hostname.endsWith(suffix) && hostname.length > suffix.length;
}

function normalizeHostname(value: string): string {
  return value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

function assertPublicHostname(hostname: string): void {
  if (
    hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || hostname.endsWith('.internal')
  ) {
    throw new TypeError('Storage endpoint must use a public hostname');
  }
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const octets = hostname.split('.').map(Number);
    const [first = 0, second = 0] = octets;
    if (
      first === 0
      || first === 10
      || first === 127
      || (first === 100 && second >= 64 && second <= 127)
      || (first === 169 && second === 254)
      || (first === 172 && second >= 16 && second <= 31)
      || (first === 192 && second === 0)
      || (first === 192 && second === 168)
      || (first === 198 && (second === 18 || second === 19))
      || first >= 224
    ) {
      throw new TypeError('Storage endpoint must use a public hostname');
    }
  }
  if (
    ipVersion === 6
    && (
      hostname === '::'
      || hostname === '::1'
      || hostname.startsWith('::ffff:')
      || hostname.startsWith('fc')
      || hostname.startsWith('fd')
      || /^fe[89ab]/.test(hostname)
      || /^fe[c-f]/.test(hostname)
      || hostname.startsWith('ff')
    )
  ) {
    throw new TypeError('Storage endpoint must use a public hostname');
  }
}
