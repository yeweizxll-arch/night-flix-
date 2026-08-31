import { Module } from '@nestjs/common';

import { AuthenticationRepository } from './authentication.repository';
import { AuthenticationService } from './authentication.service';
import {
  PlatformAuthenticationController,
  TenantAuthenticationController,
} from './authentication.controller';
import { PlatformHostPolicyService } from './platform-host-policy.service';
import { AuthenticationRateLimiterService } from './authentication-rate-limiter.service';
import { CryptoWorkLimiterService } from './crypto-work-limiter.service';

@Module({
  controllers: [
    PlatformAuthenticationController,
    TenantAuthenticationController,
  ],
  providers: [
    AuthenticationRepository,
    AuthenticationRateLimiterService,
    AuthenticationService,
    CryptoWorkLimiterService,
    PlatformHostPolicyService,
  ],
  exports: [
    AuthenticationRateLimiterService,
    AuthenticationService,
    CryptoWorkLimiterService,
    PlatformHostPolicyService,
  ],
})
export class AuthenticationModule {}
