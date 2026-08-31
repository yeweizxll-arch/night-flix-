import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import {
  PlatformContentLibraryController,
  PlatformContentLicensingController,
  TenantContentLicensingController,
} from './content-licensing.controller';
import type { ContentLicensingService } from './content-licensing.service';

describe('content licensing controller policies', () => {
  it.each([
    [PlatformContentLibraryController, 'listDramas', 'platform', 'read', 'content.license.read'],
    [PlatformContentLicensingController, 'listPackages', 'platform', 'read', 'content.license.read'],
    [PlatformContentLicensingController, 'createPackage', 'platform', 'write', 'content.license.manage'],
    [PlatformContentLicensingController, 'replacePackageItems', 'platform', 'write', 'content.license.manage'],
    [PlatformContentLicensingController, 'listLicenses', 'platform', 'read', 'content.license.read'],
    [PlatformContentLicensingController, 'grantLicense', 'platform', 'write', 'content.license.manage'],
    [PlatformContentLicensingController, 'revokeLicense', 'platform', 'write', 'content.license.manage'],
    [TenantContentLicensingController, 'listLicensedDramas', 'tenant', 'read', 'content.drama.read'],
  ] as const)(
    '%s.%s requires the expected scope and permission',
    (controller, method, scope, mode, permission) => {
      const handler = Reflect.get(
        controller.prototype,
        method,
      ) as (...args: never[]) => unknown;
      const requirement = Reflect.getMetadata(
        ACCESS_REQUIREMENT_METADATA,
        handler,
      ) as AccessRequirement;
      expect(requirement).toEqual({ mode, permissions: [permission], scope });
      expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
    },
  );

  it('forwards Idempotency-Key from the HTTP header to a platform command', () => {
    const service = {
      grantLicense: vi.fn(),
    };
    const controller = new PlatformContentLicensingController(
      service as unknown as ContentLicensingService,
    );
    const input = {
      dramaId: '018f2f45-7f5e-7e70-b17f-f6e773572201',
      expiresAt: '2027-01-01T00:00:00.000Z',
      licenseType: 'drama' as const,
      startsAt: '2026-09-01T00:00:00.000Z',
      tenantId: '018f2f45-7f5e-7e70-b17f-f6e773572202',
    };
    const principal: AccessPrincipal = {
      permissions: ['content.license.manage'],
      scope: 'platform',
      subjectId: '018f2f45-7f5e-7e70-b17f-f6e773572203',
    };
    const request = {
      headers: { 'idempotency-key': 'grant-command-key' },
      ip: '127.0.0.1',
    } as unknown as FastifyRequest;

    controller.grantLicense(input, principal, request);

    expect(service.grantLicense).toHaveBeenCalledWith(
      input,
      expect.objectContaining({
        actorId: principal.subjectId,
        idempotencyKey: 'grant-command-key',
        ip: '127.0.0.1',
      }),
    );
  });
});
