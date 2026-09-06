import 'reflect-metadata';

import { UnauthorizedException } from '@nestjs/common';
import { HEADERS_METADATA } from '@nestjs/common/constants';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import type { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { TenantContextService } from '../tenancy/tenant-context.service';
import type { CustomerPlaybackAccessService } from './customer-playback-access.service';
import type { CustomerPlaybackUrlService } from './customer-playback-url.service';
import { PlaybackController } from './playback.controller';
import type { PlaybackService } from './playback.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const episodeId = '33333333-3333-4333-8333-333333333333';
const accessToken = `atk_${'a'.repeat(43)}`;

describe('PlaybackController', () => {
  it('marks every manually customer-authenticated endpoint public', () => {
    for (const method of [
      'access',
      'addFavorite',
      'favorites',
      'history',
      'playbackUrl',
      'removeFavorite',
      'upsertProgress',
    ] as const) {
      expect(Reflect.getMetadata(
        PUBLIC_ENDPOINT_METADATA,
        PlaybackController.prototype[method],
      )).toBe(true);
    }
  });

  it('manually authenticates URL issuance and marks the response no-store', async () => {
    const issue = vi.fn(async () => ({ access: 'full', url: 'https://signed.example.test' }));
    const authenticateAccess = vi.fn(async () => ({ accountId, tenantId, username: 'viewer' }));
    const controller = makeController({}, { authenticateAccess }, { issue });

    await expect(controller.playbackUrl(
      episodeId,
      '180',
      request({ authorization: `Bearer ${accessToken}` }),
    )).resolves.toMatchObject({ access: 'full' });
    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, tenantId }),
      episodeId,
      '180',
      '203.0.113.10',
      'https://undefined',
    );
    expect(Reflect.getMetadata(
      HEADERS_METADATA,
      PlaybackController.prototype.playbackUrl,
    )).toContainEqual({ name: 'Cache-Control', value: 'no-store' });

    await expect(controller.playbackUrl(episodeId, undefined, request()))
      .resolves.toMatchObject({ access: 'full' });
    expect(issue).toHaveBeenLastCalledWith({ tenantId }, episodeId, undefined, '203.0.113.10', 'https://undefined');
    expect(authenticateAccess).toHaveBeenCalledTimes(1);
  });

  it('allows guest policy resolution but validates any supplied bearer token', async () => {
    const getAccess = vi.fn(async () => ({ access: 'locked' }));
    const authenticateAccess = vi.fn(async () => ({
      accountId,
      tenantId,
      username: 'viewer',
    }));
    const controller = makeController({ getAccess }, { authenticateAccess });

    await expect(controller.access(episodeId, request()))
      .resolves.toEqual({ access: 'locked' });
    expect(authenticateAccess).not.toHaveBeenCalled();
    expect(getAccess).toHaveBeenCalledWith({ tenantId }, episodeId);
    await expect(controller.access(episodeId, request({ authorization: 'invalid' })))
      .rejects.toBeInstanceOf(UnauthorizedException);
    await expect(controller.upsertProgress({ dramaId: episodeId, episodeId, positionSeconds: 0 }, request()))
      .rejects.toBeInstanceOf(UnauthorizedException);

    await expect(controller.access(
      episodeId,
      request({ authorization: `Bearer ${accessToken}` }),
    )).resolves.toEqual({ access: 'locked' });
    expect(authenticateAccess).toHaveBeenCalledWith(tenantId, accessToken);
    expect(getAccess).toHaveBeenCalledWith(
      expect.objectContaining({ accountId, tenantId }),
      episodeId,
    );
  });
});

function makeController(
  playbackAccess: Record<string, unknown>,
  authentication: Record<string, unknown>,
  playbackUrls: Record<string, unknown> = {},
): PlaybackController {
  return new PlaybackController(
    {} as PlaybackService,
    playbackAccess as unknown as CustomerPlaybackAccessService,
    playbackUrls as unknown as CustomerPlaybackUrlService,
    authentication as unknown as CustomerAuthenticationService,
    {
      current: vi.fn(() => ({ tenantId, tenantStatus: 'active' })),
    } as unknown as TenantContextService,
  );
}

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return { headers, ip: '203.0.113.10' } as FastifyRequest;
}
