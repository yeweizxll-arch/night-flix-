import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import { PlatformContentLibraryController } from './platform-content-library.controller';
import type { PlatformContentLibraryService } from './platform-content-library.service';

const actorId = '018f2f45-7f5e-7e70-b17f-f6e773591101';
const dramaId = '018f2f45-7f5e-7e70-b17f-f6e773591102';
const principal: AccessPrincipal = {
  permissions: ['platform.content.read', 'platform.content.manage', 'platform.content.publish'],
  scope: 'platform',
  subjectId: actorId,
};

describe('PlatformContentLibraryController', () => {
  it.each([
    ['listDramas', 'read', 'platform.content.read'],
    ['dramaDetail', 'read', 'platform.content.read'],
    ['createDrama', 'write', 'platform.content.manage'],
    ['updateDrama', 'write', 'platform.content.manage'],
    ['addEpisode', 'write', 'platform.content.manage'],
    ['updateEpisode', 'write', 'platform.content.manage'],
    ['publishDrama', 'write', 'platform.content.publish'],
    ['unpublishDrama', 'write', 'platform.content.publish'],
    ['deleteDrama', 'write', 'platform.content.manage'],
    ['restoreDrama', 'write', 'platform.content.manage'],
    ['listCategories', 'read', 'platform.content.read'],
    ['createCategory', 'write', 'platform.content.manage'],
    ['updateCategory', 'write', 'platform.content.manage'],
    ['deleteCategory', 'write', 'platform.content.manage'],
    ['restoreCategory', 'write', 'platform.content.manage'],
    ['listTags', 'read', 'platform.content.read'],
    ['createTag', 'write', 'platform.content.manage'],
    ['updateTag', 'write', 'platform.content.manage'],
    ['deleteTag', 'write', 'platform.content.manage'],
    ['restoreTag', 'write', 'platform.content.manage'],
  ] as const)('%s is protected by platform policy', (method, mode, permission) => {
    const handler = Reflect.get(
      PlatformContentLibraryController.prototype,
      method,
    ) as (...args: never[]) => unknown;
    const requirement = Reflect.getMetadata(
      ACCESS_REQUIREMENT_METADATA,
      handler,
    ) as AccessRequirement;
    expect(requirement).toEqual({ mode, permissions: [permission], scope: 'platform' });
    expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
  });

  it('uses a non-conflicting management prefix and forwards a single command key', () => {
    expect(Reflect.getMetadata('path', PlatformContentLibraryController)).toBe(
      'platform/content-management',
    );
    const createDrama = vi.fn();
    const controller = new PlatformContentLibraryController({
      createDrama,
    } as unknown as PlatformContentLibraryService);
    const input = {
      code: 'platform-drama',
      translations: [{ locale: 'en-US' as const, title: 'Platform Drama' }],
    };
    controller.createDrama(input, principal, request('content-command-key'));
    expect(createDrama).toHaveBeenCalledWith(input, expect.objectContaining({
      actorId,
      idempotencyKey: 'content-command-key',
      ip: '203.0.113.90',
    }));
  });

  it('rejects missing and any array-valued Idempotency-Key before calling the service', () => {
    const publishDrama = vi.fn();
    const controller = new PlatformContentLibraryController({
      publishDrama,
    } as unknown as PlatformContentLibraryService);
    expect(() => controller.publishDrama(
      dramaId, { expectedVersion: 0 }, principal, request(undefined),
    )).toThrow(BadRequestException);
    expect(() => controller.publishDrama(
      dramaId,
      { expectedVersion: 0 },
      principal,
      request(['one-array-value']),
    )).toThrow(/ambiguous/);
    expect(publishDrama).not.toHaveBeenCalled();
  });
});

function request(value: string | string[] | undefined): FastifyRequest {
  return {
    headers: { 'idempotency-key': value },
    ip: '203.0.113.90',
  } as unknown as FastifyRequest;
}
