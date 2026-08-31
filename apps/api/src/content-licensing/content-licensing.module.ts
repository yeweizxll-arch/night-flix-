import { Module } from '@nestjs/common';

import {
  PlatformContentLibraryController,
  PlatformContentLicensingController,
  TenantContentLicensingController,
} from './content-licensing.controller';
import { ContentLicensingService } from './content-licensing.service';

@Module({
  controllers: [
    PlatformContentLibraryController,
    PlatformContentLicensingController,
    TenantContentLicensingController,
  ],
  providers: [ContentLicensingService],
})
export class ContentLicensingModule {}
