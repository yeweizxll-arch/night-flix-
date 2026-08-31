import { Module } from '@nestjs/common';

import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import {
  CustomerReferralController,
  TenantReferralController,
} from './referral.controller';
import {
  ReferralService,
  ReferralSettlementWorkerService,
} from './referral.service';

@Module({
  imports: [CustomerAuthModule],
  controllers: [CustomerReferralController, TenantReferralController],
  providers: [ReferralService, ReferralSettlementWorkerService],
  exports: [ReferralService, ReferralSettlementWorkerService],
})
export class ReferralModule {}
