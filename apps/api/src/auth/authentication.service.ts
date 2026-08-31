import {
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';

import type { AccessScope } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { AuthenticationRepository } from './authentication.repository';
import { AuthenticationRateLimiterService } from './authentication-rate-limiter.service';
import { CryptoWorkLimiterService } from './crypto-work-limiter.service';
import type {
  AuthenticatedSession,
  SessionRequestMetadata,
  StoredSessionPrincipal,
} from './authentication.types';
import { hashPassword, verifyPassword } from './password';
import { createSessionExpiryWindow } from './session-expiry';
import {
  digestToken,
  generateAccessToken,
  generateRefreshToken,
} from './token';

const MAX_LOGIN_LENGTH = 320;
const MAX_LOGIN_PASSWORD_BYTES = 4_096;

@Injectable()
export class AuthenticationService {
  private readonly dummyPasswordHash = hashPassword(
    `invalid-account-${uuidV7()}`,
  );

  constructor(
    @Inject(AuthenticationRepository)
    private readonly repository: AuthenticationRepository,
    @Optional()
    @Inject(AuthenticationRateLimiterService)
    private readonly rateLimiter?: AuthenticationRateLimiterService,
    @Optional()
    @Inject(CryptoWorkLimiterService)
    private readonly cryptoWorkLimiter?: CryptoWorkLimiterService,
  ) {}

  async login(
    scope: AccessScope,
    loginValue: string,
    password: string,
    metadata: SessionRequestMetadata,
    tenantId?: string,
  ): Promise<AuthenticatedSession> {
    const login = normalizeLogin(loginValue);
    assertLoginPassword(password);
    await this.rateLimiter?.consume({
      ip: metadata.ip,
      login,
      scope,
      tenantId,
    });

    const credential = await this.repository.findCredential(scope, login, tenantId);
    const passwordHash = credential?.passwordHash ?? (await this.dummyPasswordHash);
    const verify = () => verifyPassword(password, passwordHash);
    const passwordMatches = this.cryptoWorkLimiter
      ? await this.cryptoWorkLimiter.run(verify)
      : await verify();
    if (!credential || !passwordMatches || credential.status !== 'active') {
      await this.repository
        .recordLoginFailure(
          scope,
          createHash('sha256').update(login).digest('base64url'),
          metadata,
          tenantId,
        )
        .catch(() => undefined);
      throw new UnauthorizedException('Invalid account or password');
    }
    if (credential.mfaEnabled) {
      throw new ForbiddenException({
        code: 'MFA_REQUIRED',
        message: 'Multi-factor authentication is required',
      });
    }
    if (scope === 'tenant' && credential.tenantState === 'suspended') {
      throw new ForbiddenException('Tenant is suspended');
    }

    const nowMs = Date.now();
    const expiry = createSessionExpiryWindow(nowMs);
    const access = generateAccessToken();
    const refresh = generateRefreshToken();
    const principal = await this.repository.createSession(
      {
        absoluteExpiresAt: new Date(expiry.absoluteExpiresAtMs),
        accessExpiresAt: new Date(expiry.accessTokenExpiresAtMs),
        accessTokenHash: access.digest,
        issuedAt: new Date(nowMs),
        refreshExpiresAt: new Date(expiry.refreshTokenExpiresAtMs),
        refreshTokenHash: refresh.digest,
        scope,
        sessionId: uuidV7(nowMs),
        subjectId: credential.id,
        tenantId,
      },
      metadata,
    );

    return {
      accessExpiresAt: new Date(expiry.accessTokenExpiresAtMs),
      accessToken: access.token,
      principal,
      refreshExpiresAt: new Date(expiry.refreshTokenExpiresAtMs),
      refreshToken: refresh.token,
    };
  }

  async refresh(
    scope: AccessScope,
    refreshToken: string,
    metadata: SessionRequestMetadata,
    tenantId?: string,
  ): Promise<AuthenticatedSession> {
    assertRefreshToken(refreshToken);
    const access = generateAccessToken();
    const refresh = generateRefreshToken();
    const rotated = {
      accessExpiresAt: new Date(0),
      accessTokenHash: access.digest,
      refreshExpiresAt: new Date(0),
      refreshTokenHash: refresh.digest,
    };
    const principal = await this.repository.rotateSession(
      scope,
      digestToken(refreshToken),
      rotated,
      metadata,
      tenantId,
    );
    if (!principal) {
      throw new UnauthorizedException('Refresh session is invalid or expired');
    }

    return {
      accessExpiresAt: rotated.accessExpiresAt,
      accessToken: access.token,
      principal,
      refreshExpiresAt: rotated.refreshExpiresAt,
      refreshToken: refresh.token,
    };
  }

  async authenticateAccess(
    accessToken: string,
    tenantId?: string,
  ): Promise<StoredSessionPrincipal> {
    if (!/^atk_[A-Za-z0-9_-]{43}$/.test(accessToken)) {
      throw new UnauthorizedException('Access token is invalid');
    }
    const scope: AccessScope = tenantId ? 'tenant' : 'platform';
    const principal = await this.repository.findByAccessToken(
      scope,
      digestToken(accessToken),
      tenantId,
    );
    if (!principal) {
      throw new UnauthorizedException('Access token is invalid or expired');
    }
    return principal;
  }

  async logout(
    scope: AccessScope,
    refreshToken: string | undefined,
    metadata: SessionRequestMetadata,
    tenantId?: string,
  ): Promise<void> {
    if (!refreshToken || !/^rtk_[A-Za-z0-9_-]{43}$/.test(refreshToken)) {
      return;
    }
    await this.repository.revokeByRefreshToken(
      scope,
      digestToken(refreshToken),
      metadata,
      tenantId,
    );
  }
}

function normalizeLogin(value: string): string {
  if (typeof value !== 'string') {
    throw new UnauthorizedException('Invalid account or password');
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > MAX_LOGIN_LENGTH) {
    throw new UnauthorizedException('Invalid account or password');
  }
  return normalized;
}

function assertLoginPassword(password: string): void {
  if (
    typeof password !== 'string' ||
    !password ||
    Buffer.byteLength(password, 'utf8') > MAX_LOGIN_PASSWORD_BYTES
  ) {
    throw new UnauthorizedException('Invalid account or password');
  }
}

function assertRefreshToken(token: string): void {
  if (typeof token !== 'string' || !/^rtk_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new UnauthorizedException('Refresh session is invalid or expired');
  }
}
