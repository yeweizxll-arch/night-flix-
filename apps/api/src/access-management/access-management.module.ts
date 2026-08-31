import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/authentication.module';
import { AccessManagementService } from './access-management.service';
import { PlatformStaffController } from './platform-staff.controller';
import { PlatformAccessManagementController } from './platform-access-management.controller';
import { StaffManagementService } from './staff-management.service';
import { TenantStaffController } from './tenant-staff.controller';
import { TenantAccessManagementController } from './tenant-access-management.controller';

@Module({
  imports: [AuthenticationModule],
  controllers: [
    PlatformAccessManagementController,
    PlatformStaffController,
    TenantAccessManagementController,
    TenantStaffController,
  ],
  providers: [AccessManagementService, StaffManagementService],
})
export class AccessManagementModule {}
