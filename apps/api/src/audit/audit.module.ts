import { Module } from '@nestjs/common';

import { PlatformAuditController, TenantAuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({
  controllers: [PlatformAuditController, TenantAuditController],
  providers: [AuditService],
})
export class AuditModule {}
