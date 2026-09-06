import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Inject,
  Param,
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
import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { uuidV7 } from '../common/uuid-v7';
import { bearerToken } from '../customer-auth/customer-authentication.controller';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { InteractionService } from './interaction.service';
import type {
  CreateBulletCommentInput,
  CreateCommentInput,
  CreateInteractionReportInput,
  CreateSensitiveWordInput,
  InteractionCommandMetadata,
  ModerateInteractionInput,
} from './interaction.types';

@Controller('customer/interactions')
export class CustomerInteractionController {
  constructor(
    @Inject(InteractionService)
    private readonly interactions: InteractionService,
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('comments')
  @PublicEndpoint()
  async listComments(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return this.interactions.listComments(await this.principal(request), query);
  }

  @Get('dramas/:dramaId/summary')
  @PublicEndpoint()
  async dramaSummary(
    @Param('dramaId') dramaId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.interactions.dramaSummary(await this.principal(request), dramaId);
  }

  @Post('dramas/:dramaId/like')
  @PublicEndpoint()
  async addLike(
    @Param('dramaId') dramaId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.interactions.setDramaLike(
      await this.principal(request), dramaId, true, uuidV7(),
    );
  }

  @Delete('dramas/:dramaId/like')
  @PublicEndpoint()
  async removeLike(
    @Param('dramaId') dramaId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.interactions.setDramaLike(
      await this.principal(request), dramaId, false, uuidV7(),
    );
  }

  @Post('comments')
  @PublicEndpoint()
  async createComment(
    @Body() input: CreateCommentInput,
    @Req() request: FastifyRequest,
  ) {
    const idempotencyKey = oneIdempotencyKey(request);
    const principal = await this.principal(request);
    return this.interactions.createComment(
      principal,
      input,
      customerMetadata(principal, request, idempotencyKey),
    );
  }

  @Delete('comments/:commentId')
  @PublicEndpoint()
  async deleteComment(
    @Param('commentId') commentId: string,
    @Req() request: FastifyRequest,
  ) {
    const idempotencyKey = oneIdempotencyKey(request);
    const principal = await this.principal(request);
    return this.interactions.deleteOwnInteraction(
      principal,
      'comment',
      commentId,
      customerMetadata(principal, request, idempotencyKey),
    );
  }

  @Get('bullet-comments')
  @PublicEndpoint()
  async listBulletComments(
    @Query() query: Record<string, unknown>,
    @Req() request: FastifyRequest,
  ) {
    return this.interactions.listBulletComments(await this.principal(request), query);
  }

  @Post('bullet-comments')
  @PublicEndpoint()
  async createBulletComment(
    @Body() input: CreateBulletCommentInput,
    @Req() request: FastifyRequest,
  ) {
    const idempotencyKey = oneIdempotencyKey(request);
    const principal = await this.principal(request);
    return this.interactions.createBulletComment(
      principal,
      input,
      customerMetadata(principal, request, idempotencyKey),
    );
  }

  @Delete('bullet-comments/:bulletCommentId')
  @PublicEndpoint()
  async deleteBulletComment(
    @Param('bulletCommentId') bulletCommentId: string,
    @Req() request: FastifyRequest,
  ) {
    const idempotencyKey = oneIdempotencyKey(request);
    const principal = await this.principal(request);
    return this.interactions.deleteOwnInteraction(
      principal,
      'bullet_comment',
      bulletCommentId,
      customerMetadata(principal, request, idempotencyKey),
    );
  }

  @Post('reports')
  @PublicEndpoint()
  async report(
    @Body() input: CreateInteractionReportInput,
    @Req() request: FastifyRequest,
  ) {
    const idempotencyKey = oneIdempotencyKey(request);
    const principal = await this.principal(request);
    return this.interactions.createReport(
      principal,
      input,
      customerMetadata(principal, request, idempotencyKey),
    );
  }

  private async principal(request: FastifyRequest): Promise<CustomerPrincipal> {
    const context = this.tenantContext.current();
    if (!context?.tenantId) {
      throw new BadRequestException('A verified tenant domain is required');
    }
    if (context.tenantStatus !== 'active') {
      throw new ForbiddenException('Tenant is not available');
    }
    return this.authentication.authenticateAccess(
      context.tenantId,
      bearerToken(request),
    );
  }
}

@Controller('tenant/interactions')
export class TenantInteractionController {
  constructor(
    @Inject(InteractionService)
    private readonly interactions: InteractionService,
  ) {}

  @Get('moderation')
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.interaction.read'],
    scope: 'tenant',
  })
  listModeration(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.interactions.listModerationQueue(
      'tenant',
      tenantId(principal),
      query,
    );
  }

  @Post('moderation/:targetType/:targetId/actions')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.interaction.manage'],
    scope: 'tenant',
  })
  moderate(
    @Param('targetType') targetType: string,
    @Param('targetId') targetId: string,
    @Body() input: ModerateInteractionInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.interactions.moderate(
      'tenant',
      tenantId(principal),
      targetType,
      targetId,
      input,
      staffMetadata('tenant', principal, request),
    );
  }

  @Get('sensitive-words')
  @RequirePermissions({
    mode: 'read',
    permissions: ['tenant.interaction.read'],
    scope: 'tenant',
  })
  listSensitiveWords(
    @Query() query: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal,
  ) {
    return this.interactions.listSensitiveWords('tenant', tenantId(principal), query);
  }

  @Post('sensitive-words')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.sensitive_word.manage'],
    scope: 'tenant',
  })
  createSensitiveWord(
    @Body() input: CreateSensitiveWordInput,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.interactions.createSensitiveWord(
      'tenant', tenantId(principal), input,
      staffMetadata('tenant', principal, request),
    );
  }

  @Delete('sensitive-words/:wordId')
  @RequirePermissions({
    mode: 'write',
    permissions: ['tenant.sensitive_word.manage'],
    scope: 'tenant',
  })
  disableSensitiveWord(
    @Param('wordId') wordId: string,
    @CurrentPrincipal() principal: AccessPrincipal,
    @Req() request: FastifyRequest,
  ) {
    return this.interactions.disableSensitiveWord(
      'tenant', tenantId(principal), wordId,
      staffMetadata('tenant', principal, request),
    );
  }
}

function customerMetadata(
  principal: CustomerPrincipal,
  request: FastifyRequest,
  idempotencyKey: string,
): InteractionCommandMetadata {
  return {
    actorId: principal.accountId,
    actorType: 'user',
    idempotencyKey,
    ip: request.ip,
    requestId: uuidV7(),
    scope: 'tenant',
  };
}

function staffMetadata(
  scope: 'platform' | 'tenant',
  principal: AccessPrincipal,
  request: FastifyRequest,
): InteractionCommandMetadata {
  if (principal.scope !== scope) throw new ForbiddenException('Staff scope is invalid');
  return {
    actorId: principal.subjectId,
    actorType: scope === 'platform' ? 'platform_staff' : 'tenant_staff',
    idempotencyKey: oneIdempotencyKey(request),
    ip: request.ip,
    requestId: uuidV7(),
    scope,
  };
}

function tenantId(principal: AccessPrincipal): string {
  if (principal.scope !== 'tenant' || !principal.tenantId) {
    throw new ForbiddenException('Tenant principal is required');
  }
  return principal.tenantId;
}

function oneIdempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key'];
  if (Array.isArray(value)) {
    if (value.length !== 1) {
      throw new BadRequestException('Idempotency-Key header is ambiguous');
    }
    return value[0] ?? '';
  }
  if (typeof value !== 'string') {
    throw new BadRequestException('Idempotency-Key header is required');
  }
  return value;
}
