import { Global, Module } from '@nestjs/common';

import { DatabaseModule } from '../database/database.module';
import { TenantContextService } from './tenant-context.service';
import { TenantDirectoryService } from './tenant-directory.service';

@Global()
@Module({
  imports: [DatabaseModule],
  providers: [TenantContextService, TenantDirectoryService],
  exports: [TenantContextService, TenantDirectoryService],
})
export class TenancyModule {}
