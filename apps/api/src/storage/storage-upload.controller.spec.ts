import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import {
  PlatformStorageUploadController,
  TenantStorageUploadController,
} from './storage-upload.controller';
import type { StorageUploadService } from './storage-upload.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const actorId = '22222222-2222-4222-8222-222222222222';
const mediaId = '33333333-3333-4333-8333-333333333333';
const principal = {
  authenticationMethod: 'session',
  permissions: ['content.drama.create'],
  scope: 'tenant',
  subjectId: actorId,
  tenantId,
} as AccessPrincipal;
const input = {
  checksumSha256: '00'.repeat(32),
  contentType: 'image/png',
  kind: 'image' as const,
  providerId: '44444444-4444-4444-8444-444444444444',
  sizeBytes: 12,
};
const platformPrincipal = {
  authenticationMethod: 'session',
  permissions: ['platform.content.manage'],
  scope: 'platform',
  subjectId: actorId,
} as AccessPrincipal;

describe('TenantStorageUploadController', () => {
  it('passes the tenant and the single Idempotency-Key to create', async () => {
    const createTenantUploadIntent = vi.fn(async () => ({ ok: true }));
    const controller = new TenantStorageUploadController({
      createTenantUploadIntent,
    } as unknown as StorageUploadService);

    await expect(controller.create(
      input,
      principal,
      request({ 'idempotency-key': 'upload-command-0001' }),
    )).resolves.toEqual({ ok: true });
    expect(createTenantUploadIntent).toHaveBeenCalledWith(
      tenantId,
      input,
      expect.objectContaining({
        actorId,
        idempotencyKey: 'upload-command-0001',
        ip: '203.0.113.10',
      }),
    );
  });

  it('rejects a missing or ambiguous Idempotency-Key before invoking the service', () => {
    const createTenantUploadIntent = vi.fn();
    const controller = new TenantStorageUploadController({
      createTenantUploadIntent,
    } as unknown as StorageUploadService);

    expect(() => controller.create(input, principal, request({}))).toThrow(BadRequestException);
    expect(() => controller.create(
      input,
      principal,
      request({ 'idempotency-key': ['one-key-1', 'second-key-2'] }),
    )).toThrow(/ambiguous/);
    expect(createTenantUploadIntent).not.toHaveBeenCalled();
  });

  it('allows completion without a command key because media state is idempotent', async () => {
    const completeTenantUpload = vi.fn(async () => ({ id: mediaId, status: 'ready' }));
    const controller = new TenantStorageUploadController({
      completeTenantUpload,
    } as unknown as StorageUploadService);

    await expect(controller.complete(mediaId, principal, request({}))).resolves.toMatchObject({
      id: mediaId,
      status: 'ready',
    });
    expect(completeTenantUpload).toHaveBeenCalledWith(
      tenantId,
      mediaId,
      expect.objectContaining({ actorId, idempotencyKey: undefined }),
    );
  });
});

describe('PlatformStorageUploadController', () => {
  it.each(['create', 'complete'] as const)(
    '%s requires platform content management permission',
    (method) => {
      const handler = Reflect.get(
        PlatformStorageUploadController.prototype,
        method,
      ) as (...args: never[]) => unknown;
      expect(Reflect.getMetadata(ACCESS_REQUIREMENT_METADATA, handler)).toEqual({
        mode: 'write',
        permissions: ['platform.content.manage'],
        scope: 'platform',
      } satisfies AccessRequirement);
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
    },
  );

  it('forces platform scope and a command key for create and complete', async () => {
    const createPlatformUploadIntent = vi.fn(async () => ({ ok: true }));
    const completePlatformUpload = vi.fn(async () => ({ id: mediaId, status: 'ready' }));
    const controller = new PlatformStorageUploadController({
      completePlatformUpload,
      createPlatformUploadIntent,
    } as unknown as StorageUploadService);

    await controller.create(input, platformPrincipal, request({
      'idempotency-key': 'platform-upload-create',
    }));
    await controller.complete(mediaId, platformPrincipal, request({
      'idempotency-key': 'platform-upload-complete',
    }));
    expect(createPlatformUploadIntent).toHaveBeenCalledWith(
      input,
      expect.objectContaining({ actorId, idempotencyKey: 'platform-upload-create' }),
    );
    expect(completePlatformUpload).toHaveBeenCalledWith(
      mediaId,
      expect.objectContaining({ actorId, idempotencyKey: 'platform-upload-complete' }),
    );
  });

  it('rejects missing and array command keys', () => {
    const controller = new PlatformStorageUploadController({} as StorageUploadService);
    expect(() => controller.create(input, platformPrincipal, request({}))).toThrow(
      BadRequestException,
    );
    expect(() => controller.create(input, platformPrincipal, request({
      'idempotency-key': ['only-one-array-entry'],
    }))).toThrow(/ambiguous/);
  });
});

function request(headers: FastifyRequest['headers']): FastifyRequest {
  return {
    headers,
    ip: '203.0.113.10',
  } as FastifyRequest;
}
