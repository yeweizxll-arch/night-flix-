import { Module } from '@nestjs/common';
import { AuthenticationModule } from '../auth/authentication.module';
import { AdObservationController, AdObservationService } from './ad-observation.controller';

import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { PlaybackModule } from '../playback/playback.module';
import { AdMobSsvVerifierService } from './admob-ssv-verifier.service';
import { RewardedUnlockController } from './rewarded-unlock.controller';
import { RewardedUnlockService } from './rewarded-unlock.service';

@Module({
  imports: [CustomerAuthModule, PlaybackModule, AuthenticationModule],
  controllers: [RewardedUnlockController, AdObservationController],
  providers: [AdMobSsvVerifierService, RewardedUnlockService, AdObservationService],
})
export class RewardedUnlockModule {}
