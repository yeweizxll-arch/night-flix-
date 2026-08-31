import { Module } from '@nestjs/common';

import { DomainTxtVerificationService } from './domain-txt-verification.service';
import { MerchantController } from './merchant.controller';
import { MerchantService } from './merchant.service';
import {
  PlatformMerchantSettingsController,
  TenantMerchantSettingsController,
} from './merchant-settings.controller';
import { MerchantSettingsService } from './merchant-settings.service';

@Module({
  controllers: [
    MerchantController,
    PlatformMerchantSettingsController,
    TenantMerchantSettingsController,
  ],
  providers: [
    DomainTxtVerificationService,
    MerchantService,
    MerchantSettingsService,
  ],
})
export class MerchantModule {}
