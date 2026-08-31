import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/authentication.module';
import { CustomerAuthModule } from '../customer-auth/customer-auth.module';
import { DatabaseModule } from '../database/database.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import {
  CustomerPrivacyController,
  TenantPrivacyRequestController,
} from './customer-privacy.controller';
import { CustomerPrivacyService } from './customer-privacy.service';
import {
  CustomerLegalDocumentController,
  TenantLegalDocumentController,
} from './legal-document.controller';
import { LegalDocumentService } from './legal-document.service';
import { PrivacyErasureWorkerService } from './privacy-erasure-worker.service';

@Module({
  controllers: [
    CustomerLegalDocumentController,
    TenantLegalDocumentController,
    CustomerPrivacyController,
    TenantPrivacyRequestController,
  ],
  exports: [CustomerPrivacyService, LegalDocumentService, PrivacyErasureWorkerService],
  imports: [AuthenticationModule, CustomerAuthModule, DatabaseModule, TenancyModule],
  providers: [CustomerPrivacyService, LegalDocumentService, PrivacyErasureWorkerService],
})
export class PrivacyModule {}

