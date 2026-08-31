import { Module } from '@nestjs/common';

import {
  PlatformContentReviewController,
  TenantContentController,
} from './content.controller';
import { ContentService } from './content.service';
import { TenantMediaController } from './media.controller';
import { MediaService } from './media.service';
import { TenantContentTaxonomyController } from './tenant-content-taxonomy.controller';
import { TenantContentTaxonomyService } from './tenant-content-taxonomy.service';
import { TenantContentPortabilityController } from './tenant-content-portability.controller';
import {
  TenantContentImportWorkerService,
  TenantContentPortabilityService,
} from './tenant-content-portability.service';

@Module({
  controllers: [
    TenantContentController,
    PlatformContentReviewController,
    TenantMediaController,
    TenantContentTaxonomyController,
    TenantContentPortabilityController,
  ],
  providers: [
    ContentService,
    MediaService,
    TenantContentTaxonomyService,
    TenantContentPortabilityService,
    TenantContentImportWorkerService,
  ],
  exports: [ContentService, TenantContentImportWorkerService],
})
export class ContentModule {}
