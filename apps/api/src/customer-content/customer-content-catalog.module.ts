import { Module } from '@nestjs/common';

import { CustomerContentCatalogController } from './customer-content-catalog.controller';
import { CustomerContentCatalogService } from './customer-content-catalog.service';

@Module({
  controllers: [CustomerContentCatalogController],
  providers: [CustomerContentCatalogService],
  exports: [CustomerContentCatalogService],
})
export class CustomerContentCatalogModule {}
