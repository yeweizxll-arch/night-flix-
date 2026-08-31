import { Module } from '@nestjs/common';

import { FinancePayoutCipher } from './finance-payout-cipher';
import { PlatformFinanceController, TenantFinanceController } from './finance.controller';
import { FinanceService } from './finance.service';

@Module({
  controllers: [TenantFinanceController, PlatformFinanceController],
  providers: [
    FinanceService,
    {
      provide: FinancePayoutCipher,
      useFactory: () => new FinancePayoutCipher(),
    },
  ],
  exports: [FinanceService],
})
export class FinanceModule {}
