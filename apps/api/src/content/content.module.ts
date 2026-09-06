import { Module } from '@nestjs/common';

import { TenantContentController } from './content.controller';
import { ContentService } from './content.service';
import { TenantMediaController } from './media.controller';
import { MediaService } from './media.service';
import { TenantDramaDiscoveryController, TenantDramaDiscoveryService } from './tenant-drama-discovery';
import { TenantContentTaxonomyController } from './tenant-content-taxonomy.controller';
import { TenantContentTaxonomyService } from './tenant-content-taxonomy.service';
import { TenantContentPortabilityController } from './tenant-content-portability.controller';
import {
  TenantContentImportWorkerService,
  TenantContentPortabilityService,
} from './tenant-content-portability.service';

@Module({
  controllers: [
    TenantDramaDiscoveryController,
    TenantContentController,
    TenantMediaController,
    TenantContentTaxonomyController,
    TenantContentPortabilityController,
  ],
  providers: [
    TenantDramaDiscoveryService,
    ContentService,
    MediaService,
    TenantContentTaxonomyService,
    TenantContentPortabilityService,
    TenantContentImportWorkerService,
  ],
  exports: [ContentService, TenantContentImportWorkerService],
})
export class ContentModule {}
