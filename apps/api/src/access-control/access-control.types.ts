export const ACCESS_SCOPES = ['platform', 'tenant'] as const;

export type AccessScope = (typeof ACCESS_SCOPES)[number];

export const ACCESS_MODES = ['read', 'write'] as const;

export type AccessMode = (typeof ACCESS_MODES)[number];

export const TENANT_ACCESS_STATES = ['active', 'expired', 'suspended'] as const;

export type TenantAccessState = (typeof TENANT_ACCESS_STATES)[number];

/**
 * The authenticated identity installed on a request by the authentication layer.
 * Tenant state must be resolved from current server-side state, rather than trusted
 * from a long-lived client token, so expiry and suspension take effect promptly.
 */
export interface AccessPrincipal {
  readonly subjectId: string;
  readonly scope: AccessScope;
  readonly permissions: readonly string[];
  readonly tenantId?: string;
  readonly tenantState?: TenantAccessState;
}

export interface AccessRequirement {
  readonly scope: AccessScope;
  readonly mode: AccessMode;
  readonly permissions: readonly string[];
}

export interface AccessControlledRequest {
  readonly method?: string;
  readonly principal?: unknown;
}
