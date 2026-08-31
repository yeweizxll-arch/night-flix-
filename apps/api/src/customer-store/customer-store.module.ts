import { Module } from '@nestjs/common';

import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { StorageModule } from '../storage';
import { CustomerAssetController } from './customer-asset.controller';
import { CustomerAssetRateLimiterService } from './customer-asset-rate-limiter.service';
import { CustomerAssetService } from './customer-asset.service';
import {
  CustomerBootstrapController,
  CustomerNavigationController,
  CustomerReadModelController,
  CustomerStoreCatalogController,
} from './customer-store.controller';
import { CustomerStoreService } from './customer-store.service';

@Module({
  imports: [CustomerAuthModule, StorageModule],
  controllers: [
    CustomerAssetController,
    CustomerBootstrapController,
    CustomerStoreCatalogController,
    CustomerNavigationController,
    CustomerReadModelController,
  ],
  providers: [CustomerAssetRateLimiterService, CustomerAssetService, CustomerStoreService],
  exports: [CustomerAssetService, CustomerStoreService],
})
export class CustomerStoreModule {}
