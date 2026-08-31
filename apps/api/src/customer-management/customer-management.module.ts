import { Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CustomerManagementService } from './customer-management.service';
import { PlatformCustomerController } from './platform-customer.controller';
import { TenantCustomerController } from './tenant-customer.controller';

@Module({
  controllers: [PlatformCustomerController, TenantCustomerController],
  exports: [CustomerManagementService],
  imports: [DatabaseModule, TenancyModule],
  providers: [CustomerManagementService],
})
export class CustomerManagementModule {}
