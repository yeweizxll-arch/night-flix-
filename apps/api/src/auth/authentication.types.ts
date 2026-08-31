import type { AccessPrincipal, AccessScope } from '../access-control';

export interface AuthenticationCredential {
  id: string;
  loginName: string;
  passwordHash: string;
  status: 'active' | 'disabled' | 'locked';
  tenantState?: 'active' | 'expired' | 'suspended';
  mfaEnabled: boolean;
}

export interface SessionRequestMetadata {
  ip?: string;
  requestId: string;
  userAgentHash?: string;
}

export interface AuthenticatedSession {
  accessExpiresAt: Date;
  accessToken: string;
  principal: AccessPrincipal & { displayName: string; sessionId: string };
  refreshExpiresAt: Date;
  refreshToken: string;
}

export interface StoredSessionPrincipal {
  displayName: string;
  permissions: string[];
  scope: AccessScope;
  sessionId: string;
  subjectId: string;
  tenantId?: string;
  tenantState?: 'active' | 'expired' | 'suspended';
}

export interface NewSessionRecord {
  absoluteExpiresAt: Date;
  accessExpiresAt: Date;
  accessTokenHash: string;
  issuedAt: Date;
  refreshExpiresAt: Date;
  refreshTokenHash: string;
  scope: AccessScope;
  sessionId: string;
  subjectId: string;
  tenantId?: string;
}

export interface RotatedSessionRecord {
  accessExpiresAt: Date;
  accessTokenHash: string;
  refreshExpiresAt: Date;
  refreshTokenHash: string;
}
