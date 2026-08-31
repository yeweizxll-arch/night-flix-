import { Module } from '@nestjs/common';

import { TenantCommunicationController } from './communication.controller';
import {
  CommunicationAdapterRegistry,
  ResendCommunicationAdapter,
  TwilioCommunicationAdapter,
} from './communication-provider.adapter';
import { CommunicationSecretCipher } from './communication-secret-cipher';
import { CommunicationTestRateLimiterService } from './communication-test-rate-limiter.service';
import { CommunicationWorkerService } from './communication-worker.service';
import { OtpDeliveryService } from './otp-delivery.service';
import { TenantCommunicationService } from './tenant-communication.service';

@Module({
  controllers: [TenantCommunicationController],
  providers: [
    {
      provide: CommunicationSecretCipher,
      useFactory: () => new CommunicationSecretCipher(),
    },
    CommunicationTestRateLimiterService,
    CommunicationWorkerService,
    OtpDeliveryService,
    TenantCommunicationService,
    {
      provide: CommunicationAdapterRegistry,
      useFactory: () => new CommunicationAdapterRegistry([
        new ResendCommunicationAdapter(), new TwilioCommunicationAdapter(),
      ]),
    },
  ],
  exports: [CommunicationSecretCipher, CommunicationWorkerService, OtpDeliveryService],
})
export class CommunicationModule {}
