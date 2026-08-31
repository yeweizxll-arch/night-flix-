import {
  BadRequestException,
  Body,
  Controller,
  Get,
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
  type AccessPrincipal,
  RequirePermissions,
} from '../access-control';
import { uuidV7 } from '../common/uuid-v7';
import { MerchantService } from './merchant.service';
import type {
  CreateMerchantInput,
  MerchantRecord,
  UpdateMerchantInput,
} from './merchant.types';

@Controller('platform/merchants')
export class MerchantController {
  constructor(
    @Inject(MerchantService)
    private readonly merchants: MerchantService,
  ) {}

  @Get()
  @RequirePermissions({
    scope: 'platform',
    mode: 'read',
    permissions: ['platform.merchant.read'],
  })
  list(@Query() query: Record<string, unknown>) {
    return this.merchants.list(Number(query.page ?? 1), Number(query.pageSize ?? 20));
  }

  @Post()
  @RequirePermissions({
    scope: 'platform',
    mode: 'write',
    permissions: ['platform.merchant.create'],
  })
  create(
    @Body() input: CreateMerchantInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ): Promise<MerchantRecord> {
    return this.merchants.create(input, mutationMetadata(principal, request));
  }

  @Patch(':tenantId/profile')
  @RequirePermissions({
    scope: 'platform',
    mode: 'write',
    permissions: ['platform.merchant.update'],
  })
  updateProfile(
    @Param('tenantId') tenantId: string,
    @Body() input: UpdateMerchantInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ): Promise<MerchantRecord> {
    if (input.status !== undefined || input.expiresAt !== undefined) {
      throw new BadRequestException('Profile endpoint cannot change lifecycle fields');
    }
    return this.merchants.update(
      tenantId,
      input,
      mutationMetadata(principal, request),
    );
  }

  @Patch(':tenantId/lifecycle')
  @RequirePermissions({
    scope: 'platform',
    mode: 'write',
    permissions: ['platform.merchant.status'],
  })
  updateLifecycle(
    @Param('tenantId') tenantId: string,
    @Body() input: UpdateMerchantInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ): Promise<MerchantRecord> {
    if (input.name !== undefined) {
      throw new BadRequestException('Lifecycle endpoint cannot change merchant profile');
    }
    return this.merchants.update(
      tenantId,
      input,
      mutationMetadata(principal, request),
    );
  }
}

function mutationMetadata(
  principal: AccessPrincipal,
  request: FastifyRequest,
) {
  return {
    actorId: principal.subjectId,
    ip: request.ip,
    requestId: uuidV7(),
  };
}
