import { Module } from '@nestjs/common';

import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { StorageModule } from '../storage';
import { CustomerPlaybackAccessService } from './customer-playback-access.service';
import { CustomerPlaybackUrlService } from './customer-playback-url.service';
import { PlaybackUrlRateLimiterService } from './playback-url-rate-limiter.service';
import { PlaybackController } from './playback.controller';
import { PlaybackService } from './playback.service';
import { HlsPlaybackService } from './hls-playback.service';
import { HlsPlaybackController } from './hls-playback.controller';

@Module({
  imports: [CustomerAuthModule, StorageModule],
  controllers: [PlaybackController, HlsPlaybackController],
  providers: [
    CustomerPlaybackAccessService,
    CustomerPlaybackUrlService,
    PlaybackService,
    PlaybackUrlRateLimiterService,
    HlsPlaybackService,
  ],
  exports: [CustomerPlaybackAccessService, PlaybackService],
})
export class PlaybackModule {}
