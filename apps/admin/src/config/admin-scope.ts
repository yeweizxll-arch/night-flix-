export type AdminScope = 'platform' | 'tenant';

function resolveAdminScope(): AdminScope {
  const value = import.meta.env.VITE_ADMIN_SCOPE?.trim() || 'platform';
  if (value !== 'platform' && value !== 'tenant') {
    throw new Error('VITE_ADMIN_SCOPE must be platform or tenant');
  }
  return value;
}

export const ADMIN_SCOPE = resolveAdminScope();
export const AUTH_API_BASE = `/api/v1/${ADMIN_SCOPE}/auth`;
