import { Module } from '@nestjs/common';

import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { CustomerNotificationService } from './customer-notification.service';
import {
  CustomerNotificationController,
  TenantNotificationController,
} from './notification.controller';
import { NotificationRateLimiterService } from './notification-rate-limiter.service';
import { NotificationSecretCipher } from './notification-secret-cipher';
import { NotificationWorkerService } from './notification-worker.service';
import { PushAdapterRegistry } from './push-provider.adapter';
import {
  ApnsPushProviderAdapter,
  FcmPushProviderAdapter,
} from './real-push-provider.adapters';
import { TenantNotificationService } from './tenant-notification.service';
import { TransactionalNotificationOutboxWorkerService } from './transactional-notification-outbox-worker.service';

@Module({
  imports: [CustomerAuthModule],
  controllers: [CustomerNotificationController, TenantNotificationController],
  providers: [
    CustomerNotificationService,
    NotificationRateLimiterService,
    {
      provide: NotificationSecretCipher,
      useFactory: () => new NotificationSecretCipher(),
    },
    NotificationWorkerService,
    TransactionalNotificationOutboxWorkerService,
    TenantNotificationService,
    { provide: PushAdapterRegistry, useFactory: () => new PushAdapterRegistry([
      new ApnsPushProviderAdapter(), new FcmPushProviderAdapter(),
    ]) },
  ],
  exports: [
    NotificationRateLimiterService,
    NotificationSecretCipher,
    NotificationWorkerService,
    PushAdapterRegistry,
    TenantNotificationService,
    TransactionalNotificationOutboxWorkerService,
  ],
})
export class NotificationModule {}
