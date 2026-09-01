import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { bearerToken } from '../customer-auth/customer-authentication.controller';
import { CustomerAuthenticationService } from '../customer-auth/customer-authentication.service';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { AdMobSsvVerifierService } from './admob-ssv-verifier.service';
import { RewardedUnlockService } from './rewarded-unlock.service';
import type { CreateRewardedUnlockChallengeInput } from './rewarded-unlock.types';

@Controller('customer/rewarded-unlocks')
export class RewardedUnlockController {
  constructor(
    @Inject(RewardedUnlockService) private readonly rewards: RewardedUnlockService,
    @Inject(AdMobSsvVerifierService) private readonly verifier: AdMobSsvVerifierService,
    @Inject(CustomerAuthenticationService)
    private readonly authentication: CustomerAuthenticationService,
    @Inject(TenantContextService)
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('callbacks/admob')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async admobCallback(@Req() request: FastifyRequest) {
    const reward = await this.verifier.verify(request.raw.url ?? '');
    await this.rewards.grantVerifiedReward(reward);
    return { ok: true };
  }

  @Post('episodes/:episodeId/challenges')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async createChallenge(
    @Param('episodeId') episodeId: string,
    @Body() input: CreateRewardedUnlockChallengeInput,
    @Req() request: FastifyRequest,
  ) {
    return this.rewards.createChallenge(await this.principal(request), episodeId, input);
  }

  @Get(':challengeId')
  @PublicEndpoint()
  @Header('Cache-Control', 'no-store')
  async status(
    @Param('challengeId') challengeId: string,
    @Req() request: FastifyRequest,
  ) {
    return this.rewards.status(await this.principal(request), challengeId);
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
      context.tenantId, bearerToken(request),
    );
  }
}
