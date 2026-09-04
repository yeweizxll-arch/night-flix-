export const API_SERVICE_ROLES = ['web', 'admin', 'agent'] as const;

export type ApiServiceRole = (typeof API_SERVICE_ROLES)[number] | 'all';

const ROLE_PREFIXES: Record<Exclude<ApiServiceRole, 'all'>, readonly string[]> = {
  web: ['/api/v1/customer', '/api/v1/payments/webhooks'],
  admin: ['/api/v1/platform'],
  agent: ['/api/v1/tenant'],
};

export function resolveApiServiceRole(
  environment: NodeJS.ProcessEnv = process.env,
): ApiServiceRole {
  const configured = environment.DRAMA_SERVICE_ROLE?.trim().toLowerCase();
  if (!configured) {
    if (environment.NODE_ENV === 'production') {
      throw new Error('DRAMA_SERVICE_ROLE is required in production');
    }
    return 'all';
  }
  if (!API_SERVICE_ROLES.includes(configured as (typeof API_SERVICE_ROLES)[number])) {
    throw new Error('DRAMA_SERVICE_ROLE must be web, admin, or agent');
  }
  return configured as (typeof API_SERVICE_ROLES)[number];
}

export function isRouteAllowed(role: ApiServiceRole, requestUrl: string): boolean {
  if (role === 'all') return true;
  const pathname = new URL(requestUrl, 'http://service.local').pathname;
  if (matchesPrefix(pathname, '/api/v1/health')) return true;
  return ROLE_PREFIXES[role].some((prefix) => matchesPrefix(pathname, prefix));
}

export function serviceName(role: ApiServiceRole): string {
  return role === 'all' ? 'drama-saas-api' : `drama-saas-${role}`;
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}
