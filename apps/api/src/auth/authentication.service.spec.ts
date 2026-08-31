import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthenticationRepository } from './authentication.repository';
import { AuthenticationService } from './authentication.service';
import type { StoredSessionPrincipal } from './authentication.types';
import { hashPassword } from './password';
import { generateRefreshToken } from './token';

const metadata = { requestId: '018f2f45-7f5e-7e70-b17f-f6e77357c004' };
const principal: StoredSessionPrincipal = {
  displayName: 'root-admin',
  permissions: ['platform.dashboard.read'],
  scope: 'platform',
  sessionId: '018f2f45-7f5e-7e70-b17f-f6e77357c001',
  subjectId: '018f2f45-7f5e-7e70-b17f-f6e77357c002',
};

describe('AuthenticationService', () => {
  let repository: {
    createSession: ReturnType<typeof vi.fn>;
    findByAccessToken: ReturnType<typeof vi.fn>;
    findCredential: ReturnType<typeof vi.fn>;
    revokeByRefreshToken: ReturnType<typeof vi.fn>;
    recordLoginFailure: ReturnType<typeof vi.fn>;
    rotateSession: ReturnType<typeof vi.fn>;
  };
  let service: AuthenticationService;

  beforeEach(() => {
    repository = {
      createSession: vi.fn().mockResolvedValue(principal),
      findByAccessToken: vi.fn().mockResolvedValue(principal),
      findCredential: vi.fn(),
      revokeByRefreshToken: vi.fn().mockResolvedValue(undefined),
      recordLoginFailure: vi.fn().mockResolvedValue(undefined),
      rotateSession: vi.fn(),
    };
    service = new AuthenticationService(
      repository as unknown as AuthenticationRepository,
    );
  });

  it('creates only hashed session tokens after a valid password', async () => {
    repository.findCredential.mockResolvedValue({
      id: principal.subjectId,
      loginName: 'root-admin',
      mfaEnabled: false,
      passwordHash: await hashPassword('a secure administrator password'),
      status: 'active',
    });

    const session = await service.login(
      'platform',
      ' Root-Admin ',
      'a secure administrator password',
      metadata,
    );

    expect(session.accessToken).toMatch(/^atk_/);
    expect(session.refreshToken).toMatch(/^rtk_/);
    expect(repository.findCredential).toHaveBeenCalledWith(
      'platform',
      'root-admin',
      undefined,
    );
    expect(repository.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        accessTokenHash: expect.stringMatching(/^sha256\$/),
        refreshTokenHash: expect.stringMatching(/^sha256\$/),
      }),
      metadata,
    );
    const stored = repository.createSession.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(stored)).not.toContain(session.accessToken);
    expect(JSON.stringify(stored)).not.toContain(session.refreshToken);
  });

  it('uses the same public error for an unknown account and a wrong password', async () => {
    repository.findCredential.mockResolvedValue(undefined);
    await expect(
      service.login('platform', 'missing', 'wrong password', metadata),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    repository.findCredential.mockResolvedValue({
      id: principal.subjectId,
      loginName: 'root-admin',
      mfaEnabled: false,
      passwordHash: await hashPassword('correct password'),
      status: 'active',
    });
    await expect(
      service.login('platform', 'root-admin', 'wrong password', metadata),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('does not silently bypass an account configured for MFA', async () => {
    repository.findCredential.mockResolvedValue({
      id: principal.subjectId,
      loginName: 'root-admin',
      mfaEnabled: true,
      passwordHash: await hashPassword('correct password'),
      status: 'active',
    });

    await expect(
      service.login('platform', 'root-admin', 'correct password', metadata),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rotates refresh and access tokens together', async () => {
    repository.rotateSession.mockImplementation(
      (_scope, _digest, rotated: { accessExpiresAt: Date; refreshExpiresAt: Date }) => {
        rotated.accessExpiresAt = new Date(Date.now() + 60_000);
        rotated.refreshExpiresAt = new Date(Date.now() + 120_000);
        return Promise.resolve(principal);
      },
    );
    const oldRefresh = generateRefreshToken().token;

    const result = await service.refresh('platform', oldRefresh, metadata);

    expect(result.refreshToken).not.toBe(oldRefresh);
    expect(repository.rotateSession).toHaveBeenCalledWith(
      'platform',
      expect.stringMatching(/^sha256\$/),
      expect.objectContaining({
        accessTokenHash: expect.stringMatching(/^sha256\$/),
        refreshTokenHash: expect.stringMatching(/^sha256\$/),
      }),
      metadata,
      undefined,
    );
  });

  it('returns tokens for only one of two concurrent refresh attempts', async () => {
    let consumed = false;
    repository.rotateSession.mockImplementation(
      async (
        _scope,
        _digest,
        rotated: { accessExpiresAt: Date; refreshExpiresAt: Date },
      ) => {
        if (consumed) {
          return undefined;
        }
        consumed = true;
        await Promise.resolve();
        rotated.accessExpiresAt = new Date(Date.now() + 60_000);
        rotated.refreshExpiresAt = new Date(Date.now() + 120_000);
        return principal;
      },
    );
    const refreshToken = generateRefreshToken().token;

    const results = await Promise.allSettled([
      service.refresh('platform', refreshToken, metadata),
      service.refresh('platform', refreshToken, metadata),
    ]);

    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(({ status }) => status === 'rejected');
    expect(rejected).toMatchObject({
      status: 'rejected',
      reason: expect.any(UnauthorizedException),
    });
    expect(repository.rotateSession).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed bearer and refresh tokens before querying storage', async () => {
    await expect(service.authenticateAccess('bad')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(service.refresh('platform', 'bad', metadata)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(repository.findByAccessToken).not.toHaveBeenCalled();
    expect(repository.rotateSession).not.toHaveBeenCalled();
  });
});
