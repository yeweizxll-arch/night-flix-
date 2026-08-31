import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import {
  CurrentPrincipal,
  RequirePermissions,
  type AccessPrincipal,
} from '../access-control';
import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { uuidV7 } from '../common/uuid-v7';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { LegalDocumentService } from './legal-document.service';

@Controller('customer/legal/documents')
export class CustomerLegalDocumentController {
  constructor(
    @Inject(LegalDocumentService)
    private readonly legal: LegalDocumentService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('current')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  current(@Query() query: Record<string, unknown>) {
    return this.legal.current(this.verifiedTenantId(), query);
  }

  @Get(':documentId')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  detail(
    @Param('documentId') documentId: string,
    @Query() query: Record<string, unknown>,
  ) {
    if (Object.keys(query).length > 0) throw new BadRequestException('Query is not supported');
    return this.legal.detail(this.verifiedTenantId(), documentId);
  }

  private verifiedTenantId(): string {
    const context = this.tenantContext.current();
    if (!context?.tenantId) throw new BadRequestException('A verified tenant domain is required');
    if (context.tenantStatus !== 'active') throw new ForbiddenException('Tenant is unavailable');
    return context.tenantId;
  }
}

@Controller('tenant/legal/documents')
export class TenantLegalDocumentController {
  constructor(
    @Inject(LegalDocumentService)
    private readonly legal: LegalDocumentService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get()
  @RequirePermissions({
    mode: 'read', permissions: ['tenant.legal.read'], scope: 'tenant',
  })
  list(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.legal.list(this.actor(principal), query);
  }

  @Post()
  @RequirePermissions({
    mode: 'write', permissions: ['tenant.legal.manage'], scope: 'tenant',
  })
  create(
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.legal.create(this.actor(principal), input, commandMetadata(request));
  }

  @Patch(':documentId')
  @RequirePermissions({
    mode: 'write', permissions: ['tenant.legal.manage'], scope: 'tenant',
  })
  update(
    @Param('documentId') documentId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.legal.update(
      this.actor(principal), documentId, input, commandMetadata(request),
    );
  }

  @Post(':documentId/publish')
  @RequirePermissions({
    mode: 'write', permissions: ['tenant.legal.manage'], scope: 'tenant',
  })
  publish(
    @Param('documentId') documentId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.legal.publish(
      this.actor(principal), documentId, input, commandMetadata(request),
    );
  }

  @Delete(':documentId')
  @RequirePermissions({
    mode: 'write', permissions: ['tenant.legal.manage'], scope: 'tenant',
  })
  removeDraft(
    @Param('documentId') documentId: string,
    @Body() input: unknown,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.legal.removeDraft(
      this.actor(principal), documentId, input, commandMetadata(request),
    );
  }

  private actor(principal: AccessPrincipal) {
    const tenantId = this.tenantContext.current()?.tenantId;
    if (!tenantId || principal.scope !== 'tenant' || principal.tenantId !== tenantId) {
      throw new ForbiddenException('Verified tenant access is required');
    }
    return { actorId: principal.subjectId, tenantId };
  }
}

export function commandMetadata(request: FastifyRequest) {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) {
    throw new BadRequestException('Idempotency-Key must be provided exactly once');
  }
  return { idempotencyKey: value, requestId: uuidV7() };
}
