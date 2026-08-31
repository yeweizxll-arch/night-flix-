import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { CurrentPrincipal, RequirePermissions, type AccessPrincipal } from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { TenantCommunicationService } from './tenant-communication.service';
import type {
  CommunicationMutationMetadata,
  TestCommunicationConfigInput,
  UpsertCommunicationConfigInput,
} from './communication.types';

@Controller('tenant/communications/configs')
export class TenantCommunicationController {
  constructor(
    @Inject(TenantCommunicationService)
    private readonly communications: TenantCommunicationService,
  ) {}

  @Get()
  @RequirePermissions({ mode: 'read', permissions: ['tenant.communication.read'], scope: 'tenant' })
  list(@CurrentPrincipal() principal: AccessPrincipal) {
    return this.communications.listConfigs(tenantId(principal));
  }

  @Put(':channel')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.communication.manage'], scope: 'tenant' })
  upsert(
    @Param('channel') channel: string,
    @Body() input: UpsertCommunicationConfigInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.communications.upsertConfig(
      tenantId(principal), channel, input, metadata(principal, request),
    );
  }

  @Post(':channel/test')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.communication.manage'], scope: 'tenant' })
  test(
    @Param('channel') channel: string,
    @Body() input: TestCommunicationConfigInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.communications.testConfig(
      tenantId(principal), channel, input, metadata(principal, request),
    );
  }

  @Post(':channel/enable')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.communication.manage'], scope: 'tenant' })
  enable(
    @Param('channel') channel: string,
    @Body() input: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    exactVersionBody(input);
    return this.communications.setConfigStatus(
      tenantId(principal), channel, true, input.expectedVersion, metadata(principal, request),
    );
  }

  @Post(':channel/disable')
  @RequirePermissions({ mode: 'write', permissions: ['tenant.communication.manage'], scope: 'tenant' })
  disable(
    @Param('channel') channel: string,
    @Body() input: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    exactVersionBody(input);
    return this.communications.setConfigStatus(
      tenantId(principal), channel, false, input.expectedVersion, metadata(principal, request),
    );
  }
}

function tenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new ForbiddenException('Tenant principal is required');
  }
  return principal.tenantId;
}
function metadata(
  principal: AccessPrincipal,
  request: FastifyRequest,
): CommunicationMutationMetadata {
  return { actorId: principal.subjectId, idempotencyKey: oneIdempotencyKey(request),
    ip: request.ip, requestId: uuidV7() };
}
function oneIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) {
    throw new BadRequestException('Idempotency-Key header is ambiguous');
  }
  if (typeof value !== 'string') throw new BadRequestException('Idempotency-Key header is required');
  return value;
}
function exactVersionBody(value: Record<string, unknown>): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => key !== 'expectedVersion')) {
    throw new BadRequestException('Body contains unsupported fields');
  }
}
