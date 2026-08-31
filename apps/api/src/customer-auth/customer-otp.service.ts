import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';

import { AuthenticationRateLimiterService } from '../auth/authentication-rate-limiter.service';
import { digestToken } from '../auth/token';
import { uuidV7 } from '../common/uuid-v7';
import { OtpDeliveryService } from '../communications/otp-delivery.service';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  CreateCustomerOtpInput,
  CustomerRequestMetadata,
  VerifyCustomerOtpInput,
} from './customer-auth.types';
import {
  assertCustomerSiteAvailable,
  assertCustomerTenantActive,
} from './customer-site-policy';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const VERIFICATION_GRANT_PATTERN = /^cvg_[A-Za-z0-9_-]{43}$/;
const PASSWORD_RESET_GRANT_PATTERN = /^prg_[A-Za-z0-9_-]{43}$/;

@Injectable()
export class CustomerOtpService {
  private readonly exposeDevelopmentCode: boolean;
  private readonly hmacKey: Buffer;
  private readonly universalCodeEnabled: boolean;

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(AuthenticationRateLimiterService)
    private readonly rateLimiter: AuthenticationRateLimiterService,
    @Optional()
    @Inject(OtpDeliveryService)
    private readonly delivery?: OtpDeliveryService,
  ) {
    this.universalCodeEnabled = environmentFlag('CUSTOMER_UNIVERSAL_OTP_ENABLED');
    this.exposeDevelopmentCode = environmentFlag('CUSTOMER_OTP_EXPOSE_CODE');
    const production = process.env.NODE_ENV === 'production';
    if (
      production
      && this.universalCodeEnabled
      && !environmentFlag('ALLOW_INSECURE_OTP')
    ) {
      throw new Error(
        'ALLOW_INSECURE_OTP=true is required when universal OTP is enabled in production',
      );
    }
    if (production && this.exposeDevelopmentCode) {
      throw new Error('CUSTOMER_OTP_EXPOSE_CODE cannot be enabled in production');
    }
    const configuredSecret = process.env.CUSTOMER_OTP_HMAC_SECRET;
    if (production && (!configuredSecret || Buffer.byteLength(configuredSecret) < 32)) {
      throw new Error('CUSTOMER_OTP_HMAC_SECRET must contain at least 32 bytes');
    }
    this.hmacKey = configuredSecret
      ? Buffer.from(configuredSecret, 'utf8')
      : randomBytes(32);
  }

  async createChallenge(
    tenantId: string,
    rawInput: CreateCustomerOtpInput,
    metadata: CustomerRequestMetadata,
  ): Promise<{
    challengeId: string;
    deliveryRequired: boolean;
    developmentCode?: string;
    expiresAt: string;
  }> {
    assertUuid(tenantId, 'tenantId');
    const input = validateOtpTarget(rawInput);
    await this.rateLimiter.consume({
      ip: metadata.ip,
      login: `${input.channel}:${input.destination}`,
      operation: 'otp_create',
      scope: 'tenant',
      tenantId,
    });
    const challengeId = uuidV7();
    const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
    const persisted = await this.database.inTenantContext(tenantId, async (transaction) => {
      await assertOtpTenantAvailable(transaction, tenantId, input.purpose);
      if (input.accountId) {
        await this.assertAccountDestination(transaction, tenantId, input);
      }
      const rows = await transaction<{ expires_at: Date }[]>`
        insert into customer_otp_challenges (
          id, tenant_id, account_id, purpose, channel,
          destination_hash, code_hash, expires_at
        ) values (
          ${challengeId}, ${tenantId}, ${input.accountId ?? null},
          ${input.purpose}, ${input.channel},
          ${this.destinationHash(input.channel, input.destination)},
          ${this.codeHash(challengeId, code)},
          statement_timestamp() + interval '10 minutes'
        )
        returning expires_at
      `;
      const row = rows[0];
      if (!row) throw new Error('OTP challenge could not be persisted');
      let deliveryRequired = false;
      if (this.delivery) {
        deliveryRequired = await this.delivery.enqueueOtp(transaction, {
          challengeId,
          challengeChannel: input.channel,
          code,
          destination: input.destination,
          expiresAt: row.expires_at,
          purpose: input.purpose,
          tenantId,
          universalCodeEnabled: this.universalCodeEnabled,
        });
      } else if (!this.universalCodeEnabled) {
        throw new ServiceUnavailableException({
          code: 'OTP_DELIVERY_UNAVAILABLE',
          message: 'Verification delivery is temporarily unavailable',
        });
      }
      return { deliveryRequired, expiresAt: row.expires_at };
    });
    return {
      challengeId,
      deliveryRequired: persisted.deliveryRequired,
      developmentCode: this.exposeDevelopmentCode ? code : undefined,
      expiresAt: persisted.expiresAt.toISOString(),
    };
  }

  async verifyChallenge(
    tenantId: string,
    rawInput: VerifyCustomerOtpInput,
    metadata: CustomerRequestMetadata,
  ): Promise<{
    verificationExpiresAt?: string;
    verificationToken?: string;
    verified: true;
  }> {
    assertUuid(tenantId, 'tenantId');
    const input = validateOtpVerification(rawInput);
    await this.rateLimiter.consume({
      ip: metadata.ip,
      login: `${input.channel}:${input.destination}:${input.challengeId}`,
      operation: 'otp_verify',
      scope: 'tenant',
      tenantId,
    });
    const outcome = await this.database.inTenantContext(
      tenantId,
      async (transaction): Promise<
        | { kind: 'expired' | 'invalid' | 'used' }
        | {
          kind: 'verified';
          verificationExpiresAt?: string;
          verificationToken?: string;
        }
      > => {
        await assertOtpTenantAvailable(transaction, tenantId, input.purpose);
        const rows = await transaction<
          Array<{
            account_id: string | null;
            attempts: number;
            code_hash: string;
            consumed_at: Date | null;
            destination_hash: string;
            expired: boolean;
            expires_at: Date;
            max_attempts: number;
          }>
        >`
          select
            account_id, attempts, max_attempts, destination_hash,
            code_hash, expires_at, consumed_at,
            expires_at <= statement_timestamp() as expired
          from customer_otp_challenges
          where id = ${input.challengeId}
            and tenant_id = ${tenantId}
            and purpose = ${input.purpose}
            and channel = ${input.channel}
          for update
        `;
        const challenge = rows[0];
        if (!challenge || challenge.consumed_at) return { kind: 'used' };
        if (
          challenge.expired || challenge.attempts >= challenge.max_attempts
        ) {
          return { kind: 'expired' };
        }
        let accountDestinationMatches = true;
        if (challenge.account_id) {
          const accountDestinations = await transaction<
            Array<{ destination: string | null }>
          >`
            select
              case when ${input.channel} = 'email' then email::text else phone end
                as destination
            from customer_accounts
            where id = ${challenge.account_id}
              and tenant_id = ${tenantId}
              and status = 'active'
          `;
          accountDestinationMatches =
            accountDestinations[0]?.destination === input.destination;
        }
        const destinationMatches = constantTimeEqualHex(
          challenge.destination_hash,
          this.destinationHash(input.channel, input.destination),
        );
        const normalCodeMatches = constantTimeEqualHex(
          challenge.code_hash,
          this.codeHash(input.challengeId, input.code),
        );
        const universalCodeMatches =
          this.universalCodeEnabled && input.code === '8888';
        if (
          !accountDestinationMatches
          || !destinationMatches
          || (!normalCodeMatches && !universalCodeMatches)
        ) {
          await transaction`
            update customer_otp_challenges
            set attempts = attempts + 1
            where id = ${input.challengeId} and consumed_at is null
          `;
          return { kind: 'invalid' };
        }

        const issueVerificationGrant = challenge.account_id === null && (
          input.purpose === 'verify_email'
          || input.purpose === 'verify_phone'
          || input.purpose === 'password_reset'
        );
        const verificationToken = issueVerificationGrant
          ? generateVerificationGrantToken(input.purpose)
          : undefined;
        const consumed = await transaction<
          Array<{ id: string; verification_grant_expires_at: Date | null }>
        >`
          update customer_otp_challenges
          set
            attempts = attempts + 1,
            consumed_at = statement_timestamp(),
            universal_code_used = ${universalCodeMatches},
            verification_grant_hash = ${verificationToken ? digestToken(verificationToken) : null},
            verification_grant_expires_at = case
              when ${Boolean(verificationToken)}
                then statement_timestamp() + interval '10 minutes'
              else null
            end
          where id = ${input.challengeId}
            and consumed_at is null
            and expires_at > statement_timestamp()
            and attempts < max_attempts
          returning id, verification_grant_expires_at
        `;
        if (!consumed[0]) return { kind: 'used' };
        if (challenge.account_id && input.purpose === 'verify_email') {
          await transaction`
            update customer_accounts
            set email_verified_at = statement_timestamp()
            where id = ${challenge.account_id} and tenant_id = ${tenantId}
          `;
        }
        if (challenge.account_id && input.purpose === 'verify_phone') {
          await transaction`
            update customer_accounts
            set phone_verified_at = statement_timestamp()
            where id = ${challenge.account_id} and tenant_id = ${tenantId}
          `;
        }
        if (universalCodeMatches) {
          await transaction`
            insert into audit_logs (
              id, scope_type, tenant_id, actor_type, actor_id, action,
              resource_type, resource_id, after_json, ip, request_id
            ) values (
              ${uuidV7()}, 'tenant', ${tenantId},
              ${challenge.account_id ? 'user' : 'system'},
              ${challenge.account_id}, 'customer.otp.universal_code_used',
              'customer_otp_challenge', ${input.challengeId},
              ${transaction.json({
                channel: input.channel,
                purpose: input.purpose,
              })},
              ${metadata.ip ?? null}, ${metadata.requestId}
            )
          `;
        }
        return {
          kind: 'verified',
          verificationExpiresAt: consumed[0].verification_grant_expires_at?.toISOString(),
          verificationToken,
        };
      },
    );
    if (outcome.kind !== 'verified') {
      throw new UnauthorizedException(
        outcome.kind === 'expired' ? 'OTP challenge expired' : 'OTP code is invalid',
      );
    }
    return outcome.verificationToken
      ? {
        verificationExpiresAt: outcome.verificationExpiresAt,
        verificationToken: outcome.verificationToken,
        verified: true,
      }
      : { verified: true };
  }

  async consumeRegistrationVerificationGrant(
    transaction: DatabaseTransaction,
    input: {
      channel: 'email' | 'phone';
      destination: string;
      tenantId: string;
      token: string;
    },
  ): Promise<void> {
    if (!VERIFICATION_GRANT_PATTERN.test(input.token)) {
      throw new BadRequestException('Contact verification token is invalid or expired');
    }
    const purpose = input.channel === 'email' ? 'verify_email' : 'verify_phone';
    const consumed = await transaction<{ id: string }[]>`
      update customer_otp_challenges
      set verification_grant_consumed_at = statement_timestamp()
      where tenant_id = ${input.tenantId}
        and account_id is null
        and purpose = ${purpose}
        and channel = ${input.channel}
        and destination_hash = ${this.destinationHash(input.channel, input.destination)}
        and verification_grant_hash = ${digestToken(input.token)}
        and verification_grant_expires_at > statement_timestamp()
        and verification_grant_consumed_at is null
      returning id
    `;
    if (!consumed[0]) {
      throw new BadRequestException('Contact verification token is invalid or expired');
    }
  }

  async consumePasswordResetGrant(
    transaction: DatabaseTransaction,
    input: {
      channel: 'email' | 'phone';
      destination: string;
      tenantId: string;
      token: string;
    },
  ): Promise<string> {
    const genericError = () => new BadRequestException(
      'Password reset request is invalid or expired',
    );
    if (!PASSWORD_RESET_GRANT_PATTERN.test(input.token)) throw genericError();
    const accounts = await transaction<{ id: string }[]>`
      select id
      from customer_accounts
      where tenant_id = ${input.tenantId}
        and status = 'active'
        and (
          (${input.channel} = 'email' and email = ${input.destination})
          or (${input.channel} = 'phone' and phone = ${input.destination})
        )
      limit 1
      for update
    `;
    const consumed = await transaction<{ id: string }[]>`
      update customer_otp_challenges
      set verification_grant_consumed_at = statement_timestamp()
      where tenant_id = ${input.tenantId}
        and account_id is null
        and purpose = 'password_reset'
        and channel = ${input.channel}
        and destination_hash = ${this.destinationHash(input.channel, input.destination)}
        and verification_grant_hash = ${digestToken(input.token)}
        and verification_grant_expires_at > statement_timestamp()
        and verification_grant_consumed_at is null
      returning id
    `;
    if (!accounts[0] || !consumed[0]) throw genericError();
    return accounts[0].id;
  }

  private async assertAccountDestination(
    transaction: DatabaseTransaction,
    tenantId: string,
    input: ReturnType<typeof validateOtpTarget>,
  ): Promise<void> {
    const accountId = input.accountId;
    if (!accountId) throw new BadRequestException('accountId is required');
    const rows = await transaction<Array<{ destination: string | null }>>`
      select
        case when ${input.channel} = 'email' then email::text else phone end
          as destination
      from customer_accounts
      where id = ${accountId}
        and tenant_id = ${tenantId}
        and status = 'active'
    `;
    if (rows[0]?.destination !== input.destination) {
      throw new BadRequestException('Account destination does not match');
    }
  }

  private destinationHash(channel: string, destination: string): string {
    return createHmac('sha256', this.hmacKey)
      .update(`destination\0${channel}\0${destination}`)
      .digest('hex');
  }

  private codeHash(challengeId: string, code: string): string {
    return createHmac('sha256', this.hmacKey)
      .update(`otp\0${challengeId}\0${code}`)
      .digest('hex');
  }
}

function validateOtpTarget(value: CreateCustomerOtpInput) {
  if (!isRecord(value)) throw new BadRequestException('Body is required');
  if (!['email', 'phone'].includes(String(value.channel))) {
    throw new BadRequestException('channel is invalid');
  }
  if (!['verify_email', 'verify_phone', 'login', 'password_reset'].includes(
    String(value.purpose),
  )) {
    throw new BadRequestException('purpose is invalid');
  }
  if (
    String(value.purpose).startsWith('verify_')
    && value.purpose !== `verify_${value.channel}`
  ) {
    throw new BadRequestException('purpose does not match channel');
  }
  if (value.accountId !== undefined) assertUuid(value.accountId, 'accountId');
  if (value.purpose === 'password_reset' && value.accountId !== undefined) {
    throw new BadRequestException('password_reset must be accountless');
  }
  return {
    accountId: value.accountId,
    channel: value.channel,
    destination: value.channel === 'email'
      ? normalizeEmail(value.destination)
      : normalizePhone(value.destination),
    purpose: value.purpose,
  };
}

function validateOtpVerification(value: VerifyCustomerOtpInput) {
  const target = validateOtpTarget(value);
  assertUuid(value.challengeId, 'challengeId');
  if (typeof value.code !== 'string' || !/^[0-9]{4,8}$/.test(value.code)) {
    throw new BadRequestException('code is invalid');
  }
  return { ...target, challengeId: value.challengeId, code: value.code };
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('email is invalid');
  const email = value.trim().toLowerCase();
  if (
    email.length < 3 || email.length > 320
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  ) {
    throw new BadRequestException('email is invalid');
  }
  return email;
}

export function normalizePhone(value: unknown): string {
  if (typeof value !== 'string') throw new BadRequestException('phone is invalid');
  const phone = value.trim();
  if (!/^\+[1-9][0-9]{7,14}$/.test(phone)) {
    throw new BadRequestException('phone is invalid');
  }
  return phone;
}

function constantTimeEqualHex(left: string, right: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(left) || !/^[0-9a-f]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function environmentFlag(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true';
}

function generateVerificationGrantToken(
  purpose: 'login' | 'password_reset' | 'verify_email' | 'verify_phone',
): string {
  const prefix = purpose === 'password_reset' ? 'prg' : 'cvg';
  return `${prefix}_${randomBytes(32).toString('base64url')}`;
}

async function assertOtpTenantAvailable(
  transaction: DatabaseTransaction,
  tenantId: string,
  purpose: 'login' | 'password_reset' | 'verify_email' | 'verify_phone',
): Promise<void> {
  if (purpose === 'password_reset') {
    await assertCustomerTenantActive(transaction, tenantId);
    return;
  }
  await assertCustomerSiteAvailable(transaction, tenantId);
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
