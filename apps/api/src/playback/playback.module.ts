import { Module } from '@nestjs/common';

import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { StorageModule } from '../storage';
import { CustomerPlaybackAccessService } from './customer-playback-access.service';
import { CustomerPlaybackUrlService } from './customer-playback-url.service';
import { PlaybackUrlRateLimiterService } from './playback-url-rate-limiter.service';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';

@Module({
  imports: [CustomerAuthModule, StorageModule],
  controllers: [PlaybackController],
  providers: [
    CustomerPlaybackAccessService,
    CustomerPlaybackUrlService,
    PlaybackService,
    PlaybackUrlRateLimiterService,
  ],
  exports: [CustomerPlaybackAccessService, PlaybackService],
})
export class PlaybackModule {}
