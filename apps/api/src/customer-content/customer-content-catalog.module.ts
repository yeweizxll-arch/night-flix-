import { Module } from '@nestjs/common';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';

import { CustomerContentCatalogController } from './customer-content-catalog.controller';
import { CustomerContentCatalogService } from './customer-content-catalog.service';

@Module({
  imports: [CustomerAuthModule],
  controllers: [CustomerContentCatalogController],
  providers: [CustomerContentCatalogService],
  exports: [CustomerContentCatalogService],
})
export class CustomerContentCatalogModule {}
