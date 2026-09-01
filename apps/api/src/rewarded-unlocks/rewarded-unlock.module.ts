import { Module } from '@nestjs/common';

import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { PlaybackModule } from '../playback/playback.module';
import { AdMobSsvVerifierService } from './admob-ssv-verifier.service';
import { RewardedUnlockController } from './rewarded-unlock.controller';
import { RewardedUnlockService } from './rewarded-unlock.service';

@Module({
  imports: [CustomerAuthModule, PlaybackModule],
  controllers: [RewardedUnlockController],
  providers: [AdMobSsvVerifierService, RewardedUnlockService],
})
export class RewardedUnlockModule {}
