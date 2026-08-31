import { Module } from '@nestjs/common';

import { OutboxModule } from '../outbox/outbox.module';
import { ContentScheduleWorkerService } from '../content/content-schedule-worker.service';
import { ReferralModule } from '../referrals/referral.module';
import { NotificationModule } from '../notifications';
import { PrivacyModule } from '../privacy/privacy.module';
import { CommunicationModule } from '../communications';
import { ContentModule } from '../content/content.module';

@Module({
  imports: [
    CommunicationModule,
    ContentModule,
    NotificationModule,
    OutboxModule,
    PrivacyModule,
    ReferralModule,
  ],
  providers: [ContentScheduleWorkerService],
})
export class WorkerModule {}
