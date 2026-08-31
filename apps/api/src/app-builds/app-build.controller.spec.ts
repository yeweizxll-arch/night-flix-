import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import { AppBuildController } from './app-build.controller';
import type { AppBuildService } from './app-build.service';

const actorId = '018f2f45-7f5e-7e70-b17f-f6e7735a0101';
const tenantId = '018f2f45-7f5e-7e70-b17f-f6e7735a0102';
const principal: AccessPrincipal = {
  permissions: ['platform.app_build.read', 'platform.app_build.manage'],
  scope: 'platform',
  subjectId: actorId,
};

describe('AppBuildController', () => {
  it.each([
    ['prerequisites', 'read', 'platform.app_build.read'],
    ['profile', 'read', 'platform.app_build.read'],
    ['upsertProfile', 'write', 'platform.app_build.manage'],
    ['jobs', 'read', 'platform.app_build.read'],
    ['job', 'read', 'platform.app_build.read'],
    ['createJob', 'write', 'platform.app_build.manage'],
    ['cancelJob', 'write', 'platform.app_build.manage'],
    ['download', 'write', 'platform.app_build.download'],
    ['createAssetUpload', 'write', 'platform.app_build.manage'],
    ['completeAssetUpload', 'write', 'platform.app_build.manage'],
  ] as const)('%s has exact platform app-build policy', (method, mode, permission) => {
    const handler = Reflect.get(AppBuildController.prototype, method) as (...args: never[]) => unknown;
    const requirement = Reflect.getMetadata(ACCESS_REQUIREMENT_METADATA, handler) as AccessRequirement;
    expect(requirement).toEqual({ mode, permissions: [permission], scope: 'platform' });
    expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
  });

  it('keeps tenant scope in the path and forwards one command key', () => {
    expect(Reflect.getMetadata('path', AppBuildController)).toBe(
      'platform/merchants/:tenantId/app-builds',
    );
    const createJob = vi.fn();
    const controller = new AppBuildController(
      { createJob } as unknown as AppBuildService,
      { issue: vi.fn() } as never,
      { create: vi.fn(), complete: vi.fn() } as never,
    );
    const input = { expectedProfileVersion: 2, target: 'android_debug' as const };
    controller.createJob(tenantId, input, principal, request('app-build-command-0001'));
    expect(createJob).toHaveBeenCalledWith(tenantId, input, expect.objectContaining({
      actorId,
      idempotencyKey: 'app-build-command-0001',
      ip: '203.0.113.72',
    }));
  });

  it('rejects missing or array command keys before service execution', () => {
    const cancelJob = vi.fn();
    const controller = new AppBuildController(
      { cancelJob } as unknown as AppBuildService,
      { issue: vi.fn() } as never,
      { create: vi.fn(), complete: vi.fn() } as never,
    );
    expect(() => controller.cancelJob(
      tenantId, '018f2f45-7f5e-7e70-b17f-f6e7735a0103',
      { expectedVersion: 0 }, principal, request(undefined),
    )).toThrow(BadRequestException);
    expect(() => controller.cancelJob(
      tenantId, '018f2f45-7f5e-7e70-b17f-f6e7735a0103',
      { expectedVersion: 0 }, principal, request(['ambiguous']),
    )).toThrow(BadRequestException);
    expect(cancelJob).not.toHaveBeenCalled();
  });

  it('issues a download only through the tenant-bound job route', () => {
    const issue = vi.fn();
    const controller = new AppBuildController(
      {} as AppBuildService,
      { issue } as never,
      { create: vi.fn(), complete: vi.fn() } as never,
    );
    const jobId = '018f2f45-7f5e-7e70-b17f-f6e7735a0103';
    controller.download(tenantId, jobId, principal, request(undefined));
    expect(issue).toHaveBeenCalledWith(tenantId, jobId, expect.objectContaining({
      actorId,
      ip: '203.0.113.72',
    }));
  });
});

function request(value: string | string[] | undefined): FastifyRequest {
  return {
    headers: { 'idempotency-key': value },
    id: '018f2f45-7f5e-7e70-b17f-f6e7735a0104',
    ip: '203.0.113.72',
  } as unknown as FastifyRequest;
}
