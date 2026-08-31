import { Module } from '@nestjs/common';

import {
  PlatformPublicDramaPoolController,
  TenantAppRuntimeConfigController,
  TenantPublicDramaPoolController,
} from './public-drama-pool.controller';
import { PublicDramaPoolService } from './public-drama-pool.service';
import { PlatformContentRevenueController } from './revenue-share.controller';
import { RevenueShareService } from './revenue-share.service';

@Module({
  controllers: [
    PlatformPublicDramaPoolController,
    PlatformContentRevenueController,
    TenantAppRuntimeConfigController,
    TenantPublicDramaPoolController,
  ],
  providers: [PublicDramaPoolService, RevenueShareService],
  exports: [PublicDramaPoolService, RevenueShareService],
})
export class PublicDramaPoolModule {}
