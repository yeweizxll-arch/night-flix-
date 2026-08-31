export type CustomerDevicePlatform = 'android' | 'h5' | 'ios' | 'web';

export interface CustomerRequestMetadata {
  idempotencyKey?: unknown;
  ip?: string;
  requestId: string;
  userAgentHash?: string;
}

export interface ChangeCustomerPasswordInput {
  currentPassword?: unknown;
  newPassword?: unknown;
}

export interface ResetCustomerPasswordInput {
  channel?: unknown;
  destination?: unknown;
  newPassword?: unknown;
  verificationToken?: unknown;
}

export interface RegisterCustomerInput {
  email?: string;
  emailVerificationToken?: string;
  password: string;
  phone?: string;
  phoneVerificationToken?: string;
  legalConsents?: unknown;
  legalLocale?: unknown;
  username: string;
}

export interface CustomerLoginInput {
  deviceLabel?: string;
  devicePlatform: CustomerDevicePlatform;
  deviceToken?: string;
  identifier: string;
  password: string;
}

export interface CustomerPrincipal {
  accountId: string;
  deviceId: string;
  sessionId: string;
  tenantId: string;
  username: string;
}

export interface CustomerSessionResponse {
  accessExpiresAt: string;
  accessToken: string;
  deviceToken?: string;
  principal: CustomerPrincipal;
  refreshExpiresAt: string;
  refreshToken: string;
}

export type CustomerOtpPurpose =
  | 'login'
  | 'password_reset'
  | 'verify_email'
  | 'verify_phone';

export interface CreateCustomerOtpInput {
  accountId?: string;
  channel: 'email' | 'phone';
  destination: string;
  purpose: CustomerOtpPurpose;
}

export interface VerifyCustomerOtpInput extends CreateCustomerOtpInput {
  challengeId: string;
  code: string;
}
