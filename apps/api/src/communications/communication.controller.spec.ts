import 'reflect-metadata';

import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { TenantCommunicationController } from './communication.controller';
import type { TenantCommunicationService } from './tenant-communication.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const staffId = '22222222-2222-4222-8222-222222222222';
const principal = { permissions: [], roles: [], scope: 'tenant', subjectId: staffId,
  tenantId } as AccessPrincipal;

describe('TenantCommunicationController', () => {
  it.each([
    ['list', 'read', 'tenant.communication.read'],
    ['upsert', 'write', 'tenant.communication.manage'],
    ['test', 'write', 'tenant.communication.manage'],
    ['enable', 'write', 'tenant.communication.manage'],
    ['disable', 'write', 'tenant.communication.manage'],
  ] as const)('%s enforces its scoped permission', (method, mode, permission) => {
    const requirement = Reflect.getMetadata(
      ACCESS_REQUIREMENT_METADATA,
      TenantCommunicationController.prototype[method],
    ) as AccessRequirement;
    expect(requirement).toEqual({ mode, permissions: [permission], scope: 'tenant' });
  });

  it('rejects every array-form Idempotency-Key before write work', () => {
    const upsertConfig = vi.fn();
    const controller = new TenantCommunicationController({ upsertConfig } as unknown as TenantCommunicationService);
    expect(() => controller.upsert('email', { credentials: {}, expectedVersion: 0 }, principal,
      request({ 'idempotency-key': ['even-one-value'] }))).toThrow(BadRequestException);
    expect(upsertConfig).not.toHaveBeenCalled();
  });

  it('passes only server actor metadata and optimistic version inputs', () => {
    const setConfigStatus = vi.fn();
    const controller = new TenantCommunicationController({ setConfigStatus } as unknown as TenantCommunicationService);
    controller.enable('email', { expectedVersion: 3 }, principal,
      request({ 'idempotency-key': 'communication-enable-3' }));
    expect(setConfigStatus).toHaveBeenCalledWith(
      tenantId, 'email', true, 3,
      expect.objectContaining({ actorId: staffId, idempotencyKey: 'communication-enable-3',
        ip: '203.0.113.10', requestId: expect.any(String) }),
    );
  });
});

function request(headers: FastifyRequest['headers'] = {}): FastifyRequest {
  return { headers, ip: '203.0.113.10' } as FastifyRequest;
}
