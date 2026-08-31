import { Module } from '@nestjs/common';

import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import {
  CustomerInteractionController,
  PlatformInteractionController,
  TenantInteractionController,
} from './interaction.controller';
import { InteractionRateLimiterService } from './interaction-rate-limiter.service';
import { InteractionService } from './interaction.service';

@Module({
  imports: [CustomerAuthModule],
  controllers: [
    CustomerInteractionController,
    PlatformInteractionController,
    TenantInteractionController,
  ],
  providers: [InteractionRateLimiterService, InteractionService],
  exports: [InteractionService],
})
export class InteractionModule {}
