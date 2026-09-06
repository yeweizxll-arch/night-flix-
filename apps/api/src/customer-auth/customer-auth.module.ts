import { Module } from '@nestjs/common';

import { AuthenticationModule } from '../auth/authentication.module';
import { CommunicationModule } from '../communications';
import { CustomerAccountController } from './customer-account.controller';
import { CustomerAuthenticationController } from './customer-authentication.controller';
import { CustomerAuthenticationService } from './customer-authentication.service';
import { CustomerOtpService } from './customer-otp.service';
import { OidcVerifier } from './oidc-verifier';

@Module({
  imports: [AuthenticationModule, CommunicationModule],
  controllers: [CustomerAccountController, CustomerAuthenticationController],
  providers: [CustomerAuthenticationService, CustomerOtpService, OidcVerifier],
  exports: [CustomerAuthenticationService],
})
export class CustomerAuthModule {}
