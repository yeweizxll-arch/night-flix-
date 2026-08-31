import { Module } from '@nestjs/common';

import {
  PlatformAnalyticsController,
  TenantAnalyticsController,
} from './analytics.controller';
import { AnalyticsService } from './analytics.service';

@Module({
  controllers: [PlatformAnalyticsController, TenantAnalyticsController],
  providers: [AnalyticsService],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
