import {
  MiddlewareConsumer,
  Module,
  NestModule,
  RequestMethod,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';

import { AccessControlGuard } from './access-control';
import { AccessManagementModule } from './access-management';
import { AppBuildModule } from './app-builds';
import { AnalyticsModule } from './analytics/analytics.module';
import { AuditModule } from './audit';
import {
  AuthenticationGuard,
} from './auth/authentication.guard';
import { AuthenticationModule } from './auth/authentication.module';
import { HealthController } from './health/health.controller';
import { InteractionModule } from './interactions/interaction.module';
import { FinanceModule } from './finance/finance.module';
import { MerchantModule } from './merchants/merchant.module';
import { NotificationModule } from './notifications';
import { RedisModule } from './redis/redis.module';
import { DatabaseModule } from './database/database.module';
import { ContentModule } from './content/content.module';
import { ContentLicensingModule } from './content-licensing/content-licensing.module';
import { CommerceModule } from './commerce/commerce.module';
import { CustomerAuthModule } from './customer-auth/customer-auth.module';
import { CustomerContentCatalogModule } from './customer-content/customer-content-catalog.module';
import { CustomerStoreModule } from './customer-store/customer-store.module';
import { CustomerManagementModule } from './customer-management';
import { PlaybackModule } from './playback/playback.module';
import { PlatformContentLibraryModule } from './platform-content-library/platform-content-library.module';
import { PrivacyModule } from './privacy';
import { PublicDramaPoolModule } from './public-drama-pool/public-drama-pool.module';
import { ReferralModule } from './referrals/referral.module';
import { StorageModule } from './storage';
import { TenantContextMiddleware } from './tenancy/tenant-context.middleware';
import { TenancyModule } from './tenancy/tenancy.module';

@Module({
  imports: [
    DatabaseModule,
    AnalyticsModule,
    RedisModule,
    TenancyModule,
    AuthenticationModule,
    MerchantModule,
    ContentModule,
    ContentLicensingModule,
    CommerceModule,
    FinanceModule,
    CustomerAuthModule,
    CustomerContentCatalogModule,
    CustomerStoreModule,
    CustomerManagementModule,
    InteractionModule,
    NotificationModule,
    PlaybackModule,
    PlatformContentLibraryModule,
    PrivacyModule,
    PublicDramaPoolModule,
    ReferralModule,
    StorageModule,
    AccessManagementModule,
    AppBuildModule,
    AuditModule,
  ],
  controllers: [HealthController],
  providers: [
    { provide: APP_GUARD, useClass: AuthenticationGuard },
    { provide: APP_GUARD, useClass: AccessControlGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantContextMiddleware).forRoutes({
      path: '{*path}',
      method: RequestMethod.ALL,
    });
  }
}
