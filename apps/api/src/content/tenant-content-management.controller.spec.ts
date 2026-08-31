import { BadRequestException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { AccessPrincipal, AccessRequirement } from '../access-control';
import { ACCESS_REQUIREMENT_METADATA } from '../access-control/require-permissions.decorator';
import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import { TenantContentController } from './content.controller';
import type { ContentService } from './content.service';
import { TenantContentPortabilityController } from './tenant-content-portability.controller';
import type { TenantContentPortabilityService } from './tenant-content-portability.service';
import { TenantContentTaxonomyController } from './tenant-content-taxonomy.controller';
import type { TenantContentTaxonomyService } from './tenant-content-taxonomy.service';

const principal: AccessPrincipal = {
  permissions: ['content.drama.create', 'content.drama.read', 'content.drama.update'],
  scope: 'tenant',
  subjectId: '018f2f45-7f5e-7e70-b17f-f6e773572001',
  tenantId: '018f2f45-7f5e-7e70-b17f-f6e773572002',
};

describe('tenant content management controller policy', () => {
  it.each([
    [TenantContentController, 'list', 'read', 'content.drama.read'],
    [TenantContentController, 'detail', 'read', 'content.drama.read'],
    [TenantContentController, 'create', 'write', 'content.drama.create'],
    [TenantContentController, 'update', 'write', 'content.drama.update'],
    [TenantContentController, 'addEpisode', 'write', 'content.drama.update'],
    [TenantContentController, 'updateEpisode', 'write', 'content.drama.update'],
    [TenantContentTaxonomyController, 'categories', 'read', 'content.drama.read'],
    [TenantContentTaxonomyController, 'createCategory', 'write', 'content.drama.update'],
    [TenantContentTaxonomyController, 'updateCategory', 'write', 'content.drama.update'],
    [TenantContentTaxonomyController, 'deleteCategory', 'write', 'content.drama.update'],
    [TenantContentTaxonomyController, 'restoreCategory', 'write', 'content.drama.update'],
    [TenantContentTaxonomyController, 'tags', 'read', 'content.drama.read'],
    [TenantContentTaxonomyController, 'createTag', 'write', 'content.drama.update'],
    [TenantContentTaxonomyController, 'updateTag', 'write', 'content.drama.update'],
    [TenantContentTaxonomyController, 'deleteTag', 'write', 'content.drama.update'],
    [TenantContentTaxonomyController, 'restoreTag', 'write', 'content.drama.update'],
    [TenantContentPortabilityController, 'createImport', 'write', 'content.drama.create'],
    [TenantContentPortabilityController, 'listImports', 'read', 'content.drama.read'],
    [TenantContentPortabilityController, 'importDetail', 'read', 'content.drama.read'],
    [TenantContentPortabilityController, 'export', 'read', 'content.drama.read'],
  ] as const)('%s.%s requires tenant RBAC', (controller, method, mode, permission) => {
    const handler = Reflect.get(controller.prototype, method) as (...args: never[]) => unknown;
    expect(Reflect.getMetadata(ACCESS_REQUIREMENT_METADATA, handler) as AccessRequirement)
      .toEqual({ mode, permissions: [permission], scope: 'tenant' });
    expect(Reflect.getMetadata(PUBLIC_ENDPOINT_METADATA, handler)).toBe(false);
  });

  it('rejects missing or array-valued command keys before content writes', () => {
    const createTenantDrama = vi.fn();
    const controller = new TenantContentController({ createTenantDrama } as unknown as ContentService);
    const input = { code: 'tenant-drama', translations: [{ locale: 'en-US', title: 'Drama' }] };
    expect(() => controller.create(input, principal, request(undefined))).toThrow(BadRequestException);
    expect(() => controller.create(input, principal, request(['one']))).toThrow(BadRequestException);
    expect(createTenantDrama).not.toHaveBeenCalled();
  });

  it('forwards a single command key to taxonomy and import services', () => {
    const create = vi.fn();
    const taxonomy = new TenantContentTaxonomyController({ create } as unknown as TenantContentTaxonomyService);
    taxonomy.createTag({ code: 'tag', translations: [{ locale: 'en-US', name: 'Tag' }] },
      principal, request('tenant-taxonomy-key'));
    expect(create).toHaveBeenCalledWith(principal.tenantId, 'tag', expect.anything(),
      expect.objectContaining({ idempotencyKey: 'tenant-taxonomy-key' }));

    const createImport = vi.fn();
    const portability = new TenantContentPortabilityController(
      { createImport } as unknown as TenantContentPortabilityService,
    );
    portability.createImport({ format: 'json', payload: [] }, principal, request('tenant-import-key'));
    expect(createImport).toHaveBeenCalledWith(principal.tenantId, expect.anything(),
      expect.objectContaining({ idempotencyKey: 'tenant-import-key' }));
  });
});

function request(value: string | string[] | undefined): FastifyRequest {
  return { headers: { 'idempotency-key': value }, ip: '203.0.113.120' } as unknown as FastifyRequest;
}
