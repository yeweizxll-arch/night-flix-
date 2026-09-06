import { SUPPORTED_APP_LOCALES } from '@drama/contracts';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import type postgres from 'postgres';

import { AuthenticationRateLimiterService } from '../auth/authentication-rate-limiter.service';
import { CryptoWorkLimiterService } from '../auth/crypto-work-limiter.service';
import { hashPassword, verifyPassword } from '../auth/password';
import {
  createSessionExpiryWindow,
  renewSessionExpiryWindow,
} from '../auth/session-expiry';
import {
  digestToken,
  generateAccessToken,
  generateRefreshToken,
} from '../auth/token';
import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  CustomerDevicePlatform,
  ChangeCustomerPasswordInput,
  CustomerLoginInput,
  CustomerPrincipal,
  CustomerRequestMetadata,
  CustomerSessionResponse,
  RegisterCustomerInput,
  ResetCustomerPasswordInput,
} from './customer-auth.types';
import { normalizeEmail, normalizePhone } from './customer-otp.service';
import { CustomerOtpService } from './customer-otp.service';
import { OidcVerifier, type IdentityProvider } from './oidc-verifier';
import { nativeIntegrationConfig } from '../runtime/native-integration-config';
import {
  assertCustomerSiteAvailable,
  assertCustomerTenantActive,
  assertCustomerTenantAvailable,
} from './customer-site-policy';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
const DEVICE_TOKEN_PATTERN = /^dev_[A-Za-z0-9_-]{43}$/;
const MAX_ACTIVE_DEVICES = 3;

interface CustomerCredentialRow {
  id: string;
  password_hash: string;
  status: 'active' | 'disabled';
  username: string;
}

interface LockedCustomerCredentialRow extends CustomerCredentialRow {
  database_now: Date;
}

interface CustomerSessionRow {
  absolute_expires_at: Date;
  account_id: string;
  access_expires_at: Date;
  database_now: Date;
  device_id: string;
  id: string;
  issued_at: Date;
  refresh_expires_at: Date;
  refresh_token_hash: string;
  session_family_id: string;
  username: string;
}

@Injectable()
export class CustomerAuthenticationService {
  private readonly dummyPasswordHash = hashPassword(
    `invalid-customer-${uuidV7()}`,
  );

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(AuthenticationRateLimiterService)
    private readonly rateLimiter: AuthenticationRateLimiterService,
    @Inject(CryptoWorkLimiterService)
    private readonly cryptoWorkLimiter: CryptoWorkLimiterService,
    @Inject(CustomerOtpService)
    private readonly otp: CustomerOtpService,
    @Optional() @Inject(OidcVerifier) private readonly oidc?: OidcVerifier,
  ) {}

  async identityChallenge(tenantId: string, provider: IdentityProvider, metadata: CustomerRequestMetadata) {
    assertUuid(tenantId, 'tenantId');
    const config = nativeIntegrationConfig(tenantId);
    if (!['apple', 'google'].includes(provider)
      || !(provider === 'apple' ? config.appleClientId : config.googleClientId)) {
      throw new BadRequestException('Identity provider is unavailable');
    }
    await this.rateLimiter.consume({ ip: metadata.ip, login: provider, operation: 'login', scope: 'tenant', tenantId });
    const nonce = randomBytes(32).toString('base64url');
    const challengeId = uuidV7();
    await this.database.inPlatformContext(async (transaction) => {
      await assertCustomerSiteAvailable(transaction, tenantId);
      await transaction`insert into customer_identity_challenges(id, tenant_id, provider, nonce_hash, expires_at)
        values (${challengeId}, ${tenantId}, ${provider}, ${createHash('sha256').update(nonce).digest('hex')}, statement_timestamp() + interval '5 minutes')`;
    });
    return { challengeId, nonce };
  }

  async identityLogin(tenantId: string, raw: {
    provider: IdentityProvider; challengeId: string; identityToken: string;
    devicePlatform: CustomerDevicePlatform; deviceToken?: string; deviceLabel?: string;
    legalLocale?: unknown; legalConsents?: unknown;
  }, metadata: CustomerRequestMetadata): Promise<CustomerSessionResponse> {
    assertUuid(tenantId, 'tenantId');
    if (!raw || !['apple', 'google'].includes(raw.provider)) throw new BadRequestException('Invalid identity provider');
    assertUuid(raw.challengeId, 'challengeId');
    const device = validateLogin({ ...raw, identifier: 'oidc-customer', password: 'Not-a-login-password-1' });
    await this.rateLimiter.consume({ ip: metadata.ip, login: raw.provider, operation: 'login', scope: 'tenant', tenantId });
    const challenge = await this.database.inPlatformContext(async (transaction) => {
      await assertCustomerSiteAvailable(transaction, tenantId);
      const rows = await transaction<{ nonce_hash: string }[]>`select nonce_hash from customer_identity_challenges
        where id = ${raw.challengeId} and tenant_id = ${tenantId} and provider = ${raw.provider}
          and consumed_at is null and expires_at > statement_timestamp()`;
      if (!rows[0]) throw new UnauthorizedException('Identity challenge expired');
      return rows[0];
    });
    if (!this.oidc) throw new ServiceUnavailableException('Identity verification is unavailable');
    const identity = await this.oidc.verify(tenantId, raw.provider, raw.identityToken, challenge.nonce_hash);
    const accountId = await this.database.inPlatformContext(async (transaction) => {
      await assertCustomerSiteAvailable(transaction, tenantId);
      const consumed = await transaction<{ id: string }[]>`update customer_identity_challenges
        set consumed_at = statement_timestamp() where id = ${raw.challengeId} and tenant_id = ${tenantId}
          and provider = ${raw.provider} and consumed_at is null and expires_at > statement_timestamp() returning id`;
      if (!consumed[0]) throw new UnauthorizedException('Identity challenge was already consumed');
      const existing = await transaction<{ account_id: string }[]>`select account_id from customer_external_identities
        where tenant_id = ${tenantId} and provider = ${raw.provider} and subject = ${identity.subject}`;
      if (existing[0]) return existing[0].account_id;
      const locale = validateLegalLocale(raw.legalLocale);
      const consents = validateLegalConsentInput(raw.legalConsents);
      const documents = await requiredRegistrationDocuments(transaction, tenantId, locale);
      validateRegistrationConsents(consents, documents);
      const id = uuidV7();
      // No automatic email-based account linking. Provider subject is the identity.
      const passwordHash = await this.cryptoWorkLimiter.run(() => hashPassword(randomBytes(48).toString('base64url')));
      await transaction`insert into customer_accounts(id, tenant_id, username, password_hash)
        values (${id}, ${tenantId}, ${'user_' + id.replaceAll('-', '')}, ${passwordHash})`;
      await transaction`insert into customer_external_identities(tenant_id, account_id, provider, subject)
        values (${tenantId}, ${id}, ${raw.provider}, ${identity.subject})`;
      for (const document of documents) {
        await transaction`insert into customer_legal_consents(id, tenant_id, account_id, document_id,
          document_version_no, document_type, locale, consent_source) values
          (${uuidV7()}, ${tenantId}, ${id}, ${document.id}, ${document.version_no}, ${document.document_type}, ${document.locale}, 'registration')`;
      }
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: id, eventType: 'CustomerRegistered', payload: { accountId: id, tenantId },
      });
      return id;
    });
    return this.issueCustomerSession(tenantId, accountId, device, metadata);
  }

  async register(
    tenantId: string,
    rawInput: RegisterCustomerInput,
    metadata: CustomerRequestMetadata,
  ): Promise<{ accountId: string; username: string }> {
    assertUuid(tenantId, 'tenantId');
    const input = validateRegistration(rawInput);
    await this.rateLimiter.consume({
      ip: metadata.ip,
      login: input.username,
      operation: 'register',
      scope: 'tenant',
      tenantId,
    });
    await this.database.inTenantContext(tenantId, (transaction) =>
      assertCustomerSiteAvailable(transaction, tenantId));
    const accountId = uuidV7();
    const passwordHash = await this.cryptoWorkLimiter.run(
      () => hashPassword(input.password),
    );
    return this.database.inPlatformContext(async (transaction) => {
      await assertCustomerSiteAvailable(transaction, tenantId);
      const legalDocuments = await requiredRegistrationDocuments(
        transaction,
        tenantId,
        input.legalLocale,
      );
      validateRegistrationConsents(input.legalConsents, legalDocuments);
      if (input.email) {
        await this.otp.consumeRegistrationVerificationGrant(transaction, {
          channel: 'email',
          destination: input.email,
          tenantId,
          token: input.emailVerificationToken,
        });
      }
      if (input.phone) {
        await this.otp.consumeRegistrationVerificationGrant(transaction, {
          channel: 'phone',
          destination: input.phone,
          tenantId,
          token: input.phoneVerificationToken,
        });
      }
      try {
        await transaction`
          insert into customer_accounts (
            id, tenant_id, username, email, phone, password_hash,
            email_verified_at, phone_verified_at
          ) values (
            ${accountId}, ${tenantId}, ${input.username},
            ${input.email ?? null}, ${input.phone ?? null}, ${passwordHash},
            case when ${Boolean(input.email)} then statement_timestamp() else null end,
            case when ${Boolean(input.phone)} then statement_timestamp() else null end
          )
        `;
      } catch (error) {
        if (isDatabaseError(error, '23505')) {
          throw new ConflictException('Customer identifier already exists');
        }
        throw error;
      }
      for (const consent of input.legalConsents) {
        const document = legalDocuments.find(
          (candidate) => candidate.id === consent.documentId
            && candidate.version_no === consent.version,
        );
        if (!document) {
          throw new BadRequestException('Legal consent is not a current document version');
        }
        await transaction`
          insert into customer_legal_consents (
            id, tenant_id, account_id, document_id, document_version_no,
            document_type, locale, consent_source
          ) values (
            ${uuidV7()}, ${tenantId}, ${accountId}, ${document.id},
            ${document.version_no}, ${document.document_type}, ${document.locale},
            'registration'
          )
        `;
      }
      await transaction`
        insert into audit_logs (
          id, scope_type, tenant_id, actor_type, actor_id, action,
          resource_type, resource_id, after_json, ip, request_id
        ) values (
          ${uuidV7()}, 'tenant', ${tenantId}, 'user', ${accountId},
          'customer.account.register', 'customer_account', ${accountId},
          ${transaction.json({
            emailProvided: Boolean(input.email),
            legalConsentCount: input.legalConsents.length,
            legalLocale: input.legalLocale,
            phoneProvided: Boolean(input.phone),
          })}, ${metadata.ip ?? null}, ${metadata.requestId}
        )
      `;
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: accountId,
        eventType: 'CustomerRegistered',
        payload: { accountId, tenantId },
      });
      return { accountId, username: input.username };
    });
  }

  async login(
    tenantId: string,
    rawInput: CustomerLoginInput,
    metadata: CustomerRequestMetadata,
  ): Promise<CustomerSessionResponse> {
    assertUuid(tenantId, 'tenantId');
    const input = validateLogin(rawInput);
    await this.rateLimiter.consume({
      ip: metadata.ip,
      login: input.identifier,
      operation: 'login',
      scope: 'tenant',
      tenantId,
    });
    const credential = await this.database.inTenantContext(
      tenantId,
      async (transaction) => {
        await assertCustomerSiteAvailable(transaction, tenantId);
        const rows = await transaction<CustomerCredentialRow[]>`
          select id, username::text, password_hash, status
          from customer_accounts
          where tenant_id = ${tenantId}
            and (
              username = ${input.identifier}
              or (email = ${input.identifier} and email_verified_at is not null)
              or (phone = ${input.identifier} and phone_verified_at is not null)
            )
          limit 1
        `;
        return rows[0];
      },
    );
    const passwordHash = credential?.password_hash ?? (await this.dummyPasswordHash);
    const passwordMatches = await this.cryptoWorkLimiter.run(
      () => verifyPassword(input.password, passwordHash),
    );
    if (!credential || !passwordMatches || credential.status !== 'active') {
      throw new UnauthorizedException('Invalid customer account or password');
    }
    return this.issueCustomerSession(tenantId, credential.id, input, metadata, passwordHash);
  }

  private async issueCustomerSession(tenantId: string, accountId: string,
    input: Pick<CustomerLoginInput, 'deviceToken' | 'devicePlatform' | 'deviceLabel'>,
    metadata: CustomerRequestMetadata, expectedPasswordHash?: string): Promise<CustomerSessionResponse> {
    const access = generateAccessToken();
    const refresh = generateRefreshToken();
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await assertCustomerSiteAvailable(transaction, tenantId);
      const lockedAccounts = await transaction<LockedCustomerCredentialRow[]>`
        select
          id, username::text, password_hash, status,
          statement_timestamp() as database_now
        from customer_accounts
        where id = ${accountId} and tenant_id = ${tenantId}
        for update
      `;
      const account = lockedAccounts[0];
      if (!account || account.status !== 'active'
        || (expectedPasswordHash !== undefined && account.password_hash !== expectedPasswordHash)) {
        throw new UnauthorizedException('Customer account is disabled');
      }
      const nowMs = account.database_now.getTime();
      const expiry = createSessionExpiryWindow(nowMs);

      const suppliedDeviceHash = input.deviceToken
        ? digestToken(input.deviceToken)
        : undefined;
      const existingDevices = suppliedDeviceHash
        ? await transaction<{ id: string }[]>`
            select id from customer_devices
            where tenant_id = ${tenantId}
              and account_id = ${account.id}
              and device_token_hash = ${suppliedDeviceHash}
              and status = 'active'
            for update
          `
        : [];
      let deviceId = existingDevices[0]?.id;
      let deviceToken = input.deviceToken;
      if (!deviceId) {
        const activeDevices = await transaction<Array<{ id: string }>>`
          select device.id
          from customer_devices as device
          where device.tenant_id = ${tenantId}
            and device.account_id = ${account.id}
            and device.status = 'active'
          order by device.last_seen_at, device.id
        `;
        const devicesToEvict = activeDevices.slice(
          0,
          Math.max(0, activeDevices.length - MAX_ACTIVE_DEVICES + 1),
        );
        for (const deviceToEvict of devicesToEvict) {
          const evictedDeviceId = deviceToEvict.id;
          await transaction`
            update customer_devices
            set
              status = 'revoked', revoked_at = statement_timestamp(),
              revoke_reason = 'device_limit_eviction'
            where id = ${evictedDeviceId} and status = 'active'
          `;
          await transaction`
            update customer_sessions
            set
              revoked_at = statement_timestamp(),
              revoked_reason = 'device_limit_eviction'
            where tenant_id = ${tenantId}
              and account_id = ${account.id}
              and device_id = ${evictedDeviceId}
              and revoked_at is null
          `;
          await transaction`
            insert into audit_logs (
              id, scope_type, tenant_id, actor_type, actor_id, action,
              resource_type, resource_id, after_json, ip, request_id
            ) values (
              ${uuidV7()}, 'tenant', ${tenantId}, 'user', ${account.id},
              'customer.device.limit_eviction', 'customer_device',
              ${evictedDeviceId}, ${transaction.json({ maxDevices: 3 })},
              ${metadata.ip ?? null}, ${metadata.requestId}
            )
          `;
        }
        deviceId = uuidV7(nowMs);
        deviceToken = generateDeviceToken();
        await transaction`
          insert into customer_devices (
            id, tenant_id, account_id, device_token_hash, platform, label
          ) values (
            ${deviceId}, ${tenantId}, ${account.id}, ${digestToken(deviceToken)},
            ${input.devicePlatform}, ${input.deviceLabel ?? null}
          )
        `;
      } else {
        await transaction`
          update customer_devices
          set
            last_seen_at = statement_timestamp(),
            platform = ${input.devicePlatform},
            label = ${input.deviceLabel ?? null}
          where id = ${deviceId}
        `;
      }
      await transaction`
        update customer_sessions
        set revoked_at = statement_timestamp(), revoked_reason = 'new_device_login'
        where tenant_id = ${tenantId}
          and account_id = ${account.id}
          and device_id = ${deviceId}
          and revoked_at is null
      `;

      const sessionId = uuidV7(nowMs);
      await transaction`
        insert into customer_sessions (
          id, session_family_id, tenant_id, account_id, device_id,
          access_token_hash, refresh_token_hash, issued_at,
          access_expires_at, refresh_expires_at, absolute_expires_at,
          last_ip, user_agent_hash
        ) values (
          ${sessionId}, ${sessionId}, ${tenantId}, ${account.id}, ${deviceId},
          ${access.digest}, ${refresh.digest}, ${new Date(nowMs)},
          ${new Date(expiry.accessTokenExpiresAtMs)},
          ${new Date(expiry.refreshTokenExpiresAtMs)},
          ${new Date(expiry.absoluteExpiresAtMs)},
          ${metadata.ip ?? null}, ${metadata.userAgentHash ?? null}
        )
      `;
      return {
        accessExpiresAt: new Date(expiry.accessTokenExpiresAtMs).toISOString(),
        accessToken: access.token,
        deviceToken,
        principal: {
          accountId: account.id,
          deviceId,
          sessionId,
          tenantId,
          username: account.username,
        },
        refreshExpiresAt: new Date(expiry.refreshTokenExpiresAtMs).toISOString(),
        refreshToken: refresh.token,
      };
    });
  }

  async authenticateAccess(
    tenantId: string,
    accessToken: string,
  ): Promise<CustomerPrincipal> {
    return this.authenticateAccessInternal(tenantId, accessToken, true);
  }

  /** Narrow exception used only to let an authenticated customer close an account. */
  async authenticateAccessForAccountClosure(
    tenantId: string,
    accessToken: string,
  ): Promise<CustomerPrincipal> {
    return this.authenticateAccessInternal(tenantId, accessToken, false);
  }

  private async authenticateAccessInternal(
    tenantId: string,
    accessToken: string,
    requireAvailableSite: boolean,
  ): Promise<CustomerPrincipal> {
    assertUuid(tenantId, 'tenantId');
    if (!/^atk_[A-Za-z0-9_-]{43}$/.test(accessToken)) {
      throw new UnauthorizedException('Customer access token is invalid');
    }
    const principal = await this.database.inTenantContext(
      tenantId,
      async (transaction) => {
        if (requireAvailableSite) {
          await assertCustomerTenantAvailable(transaction, tenantId, true);
        } else {
          await assertCustomerTenantActive(transaction, tenantId);
        }
        const rows = await transaction<
          Array<{
            account_id: string;
            device_id: string;
            id: string;
            username: string;
          }>
        >`
          select
            session.id, session.account_id, session.device_id,
            account.username::text
          from customer_sessions as session
          inner join customer_accounts as account
            on account.id = session.account_id
            and account.tenant_id = session.tenant_id
            and account.status = 'active'
          inner join customer_devices as device
            on device.id = session.device_id
            and device.tenant_id = session.tenant_id
            and device.account_id = session.account_id
            and device.status = 'active'
          where session.tenant_id = ${tenantId}
            and session.access_token_hash = ${digestToken(accessToken)}
            and session.revoked_at is null
            and session.access_expires_at > statement_timestamp()
            and session.absolute_expires_at > statement_timestamp()
          limit 1
        `;
        const row = rows[0];
        if (!row) return undefined;
        await transaction`
          update customer_sessions
          set last_seen_at = statement_timestamp()
          where id = ${row.id}
        `;
        await transaction`
          update customer_devices
          set last_seen_at = statement_timestamp()
          where id = ${row.device_id}
        `;
        return {
          accountId: row.account_id,
          deviceId: row.device_id,
          sessionId: row.id,
          tenantId,
          username: row.username,
        };
      },
    );
    if (!principal) throw new UnauthorizedException('Customer session is invalid');
    return principal;
  }

  async refresh(
    tenantId: string,
    refreshToken: string,
    metadata: CustomerRequestMetadata,
  ): Promise<CustomerSessionResponse> {
    assertUuid(tenantId, 'tenantId');
    if (!/^rtk_[A-Za-z0-9_-]{43}$/.test(refreshToken)) {
      throw new UnauthorizedException('Customer refresh token is invalid');
    }
    const oldDigest = digestToken(refreshToken);
    const newAccess = generateAccessToken();
    const newRefresh = generateRefreshToken();
    const outcome = await this.database.inTenantContext(
      tenantId,
      async (transaction): Promise<
        | { kind: 'invalid' | 'replay' }
        | { kind: 'rotated'; response: CustomerSessionResponse }
      > => {
        await assertCustomerSiteAvailable(transaction, tenantId);
        const rows = await transaction<CustomerSessionRow[]>`
          select
            session.id, session.session_family_id, session.account_id,
            session.device_id, session.refresh_token_hash, session.issued_at,
            session.access_expires_at, session.refresh_expires_at,
            session.absolute_expires_at, account.username::text,
            statement_timestamp() as database_now
          from customer_sessions as session
          inner join customer_accounts as account
            on account.id = session.account_id
            and account.tenant_id = session.tenant_id
            and account.status = 'active'
          inner join customer_devices as device
            on device.id = session.device_id
            and device.tenant_id = session.tenant_id
            and device.account_id = session.account_id
            and device.status = 'active'
          where session.tenant_id = ${tenantId}
            and session.refresh_token_hash = ${oldDigest}
          for update of session
        `;
        const session = rows[0];
        if (!session) {
          const reused = await transaction<
            Array<{ account_id: string; session_family_id: string }>
          >`
            select account_id, session_family_id
            from customer_refresh_token_history
            where tenant_id = ${tenantId}
              and token_hash = ${oldDigest}
              and expires_at > statement_timestamp()
            limit 1
          `;
          const replay = reused[0];
          const familyId = replay?.session_family_id;
          if (familyId) {
            await transaction`
              update customer_sessions
              set
                revoked_at = coalesce(revoked_at, statement_timestamp()),
                revoked_reason = coalesce(revoked_reason, 'refresh_token_replay')
              where tenant_id = ${tenantId}
                and session_family_id = ${familyId}
            `;
            await transaction`
              insert into audit_logs (
                id, scope_type, tenant_id, actor_type, actor_id, action,
                resource_type, resource_id, after_json, ip, request_id
              ) values (
                ${uuidV7()}, 'tenant', ${tenantId}, 'user', ${replay.account_id},
                'customer.auth.refresh_replay', 'customer_session_family',
                ${familyId}, ${transaction.json(toJsonValue({ sessionFamilyId: familyId }))},
                ${metadata.ip ?? null}, ${metadata.requestId}
              )
            `;
            return { kind: 'replay' };
          }
          return { kind: 'invalid' };
        }
        const nowMs = session.database_now.getTime();
        if (
          session.refresh_expires_at.getTime() <= nowMs
          || session.absolute_expires_at.getTime() <= nowMs
        ) {
          return { kind: 'invalid' };
        }
        let renewed;
        try {
          renewed = renewSessionExpiryWindow(
            {
              absoluteExpiresAtMs: session.absolute_expires_at.getTime(),
              accessTokenExpiresAtMs: session.access_expires_at.getTime(),
              createdAtMs: session.issued_at.getTime(),
              refreshTokenExpiresAtMs: session.refresh_expires_at.getTime(),
            },
            nowMs,
          );
        } catch {
          return { kind: 'invalid' };
        }
        await transaction`
          insert into customer_refresh_token_history (
            id, tenant_id, account_id, session_id, session_family_id,
            token_hash, expires_at
          ) values (
            ${uuidV7()}, ${tenantId}, ${session.account_id}, ${session.id},
            ${session.session_family_id}, ${oldDigest}, ${session.absolute_expires_at}
          )
        `;
        const updated = await transaction<{ id: string }[]>`
          update customer_sessions
          set
            access_token_hash = ${newAccess.digest},
            refresh_token_hash = ${newRefresh.digest},
            access_expires_at = ${new Date(renewed.accessTokenExpiresAtMs)},
            refresh_expires_at = ${new Date(renewed.refreshTokenExpiresAtMs)},
            last_seen_at = statement_timestamp(),
            last_ip = ${metadata.ip ?? null},
            user_agent_hash = ${metadata.userAgentHash ?? null},
            rotation_count = rotation_count + 1
          where id = ${session.id}
            and refresh_token_hash = ${oldDigest}
            and device_id = ${session.device_id}
            and revoked_at is null
            and refresh_expires_at > statement_timestamp()
            and absolute_expires_at > statement_timestamp()
          returning id
        `;
        if (!updated[0]) {
          // Throw so the transaction also rolls back the refresh-history insert.
          throw new UnauthorizedException('Customer refresh session is invalid');
        }
        return {
          kind: 'rotated',
          response: {
            accessExpiresAt: new Date(renewed.accessTokenExpiresAtMs).toISOString(),
            accessToken: newAccess.token,
            principal: {
              accountId: session.account_id,
              deviceId: session.device_id,
              sessionId: session.id,
              tenantId,
              username: session.username,
            },
            refreshExpiresAt: new Date(renewed.refreshTokenExpiresAtMs).toISOString(),
            refreshToken: newRefresh.token,
          },
        };
      },
    );
    if (outcome.kind !== 'rotated') {
      throw new UnauthorizedException(
        outcome.kind === 'replay'
          ? 'Refresh token replay detected'
          : 'Customer refresh session is invalid',
      );
    }
    return outcome.response;
  }

  async logout(tenantId: string, refreshToken: string | undefined): Promise<void> {
    assertUuid(tenantId, 'tenantId');
    if (!refreshToken || !/^rtk_[A-Za-z0-9_-]{43}$/.test(refreshToken)) return;
    await this.database.inTenantContext(tenantId, async (transaction) => {
      await transaction`update customer_push_tokens as token set status = 'revoked', revoked_at = statement_timestamp(), revoke_reason = 'customer_logout'
        where token.tenant_id = ${tenantId} and token.status = 'active' and exists (
          select 1 from customer_sessions as session where session.tenant_id = token.tenant_id
            and session.account_id = token.account_id and session.device_id = token.device_id
            and session.refresh_token_hash = ${digestToken(refreshToken)} and session.revoked_at is null)`;
      await transaction`
        update customer_sessions
        set revoked_at = statement_timestamp(), revoked_reason = 'logout'
        where tenant_id = ${tenantId}
          and refresh_token_hash = ${digestToken(refreshToken)}
          and revoked_at is null
      `;
    });
  }

  async listDevices(principal: CustomerPrincipal): Promise<{
    items: Array<{
      current: boolean;
      id: string;
      label: string | null;
      lastSeenAt: string;
      platform: CustomerDevicePlatform;
      status: 'active';
    }>;
  }> {
    assertPrincipal(principal);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await assertCustomerSiteAvailable(transaction, principal.tenantId);
      const rows = await transaction<Array<{
        id: string;
        label: string | null;
        last_seen_at: Date | string;
        platform: CustomerDevicePlatform;
        status: 'active';
      }>>`
        select id, label, platform, last_seen_at, status
        from customer_devices
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and status = 'active'
        order by (id = ${principal.deviceId}) desc, last_seen_at desc, id
        limit ${MAX_ACTIVE_DEVICES}
      `;
      return {
        items: rows.map((row) => ({
          current: row.id === principal.deviceId,
          id: row.id,
          label: row.label,
          lastSeenAt: dateIso(row.last_seen_at),
          platform: row.platform,
          status: row.status,
        })),
      };
    });
  }

  async revokeDevice(
    principal: CustomerPrincipal,
    deviceIdValue: unknown,
    metadata: CustomerRequestMetadata,
  ): Promise<{
    deviceId: string;
    requiresReauthentication: boolean;
    revoked: true;
  }> {
    assertPrincipal(principal);
    const deviceId = uuid(deviceIdValue, 'deviceId');
    await this.rateLimiter.consume({
      ip: metadata.ip,
      login: principal.accountId,
      operation: 'device_revoke',
      scope: 'tenant',
      tenantId: principal.tenantId,
    });
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await assertCustomerSiteAvailable(transaction, principal.tenantId);
      const command = await this.beginCustomerCommand<{
        deviceId: string; requiresReauthentication: boolean; revoked: true;
      }>(transaction, principal, metadata, 'customer.account.device.revoke', { deviceId });
      if (command.cached) return command.cached;
      const accounts = await transaction<{ id: string }[]>`
        select id from customer_accounts
        where tenant_id = ${principal.tenantId}
          and id = ${principal.accountId}
          and status = 'active'
        for share
      `;
      if (!accounts[0]) throw new UnauthorizedException('Customer account is unavailable');
      const devices = await transaction<Array<{ id: string; status: 'active' | 'revoked' }>>`
        select id, status
        from customer_devices
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and id = ${deviceId}
        for update
      `;
      const device = devices[0];
      if (!device) throw new NotFoundException('Customer device was not found');
      if (device.status === 'active') {
        await transaction`
          update customer_devices
          set status = 'revoked', revoked_at = statement_timestamp(),
            revoke_reason = 'customer_self_revoke'
          where tenant_id = ${principal.tenantId}
            and account_id = ${principal.accountId}
            and id = ${deviceId}
            and status = 'active'
        `;
        await transaction`
          update customer_sessions
          set revoked_at = statement_timestamp(), revoked_reason = 'device_revoked'
          where tenant_id = ${principal.tenantId}
            and account_id = ${principal.accountId}
            and device_id = ${deviceId}
            and revoked_at is null
        `;
        await this.insertAudit(transaction, principal, metadata,
          'customer.device.revoke', 'customer_device', deviceId,
          { currentDevice: deviceId === principal.deviceId });
        await this.insertOutbox(transaction, principal.tenantId, metadata.requestId, {
          aggregateId: principal.accountId,
          eventType: 'CustomerDeviceRevoked',
          payload: { accountId: principal.accountId, deviceId, tenantId: principal.tenantId },
        });
      }
      const response = {
        deviceId,
        requiresReauthentication: deviceId === principal.deviceId,
        revoked: true as const,
      };
      await this.completeCustomerCommand(
        transaction,
        command.id,
        response,
        'customer_device',
        deviceId,
      );
      return response;
    });
  }

  async changePassword(
    principal: CustomerPrincipal,
    rawInput: ChangeCustomerPasswordInput,
    metadata: CustomerRequestMetadata,
  ): Promise<{ changed: true; otherSessionsRevoked: true }> {
    assertPrincipal(principal);
    const input = validatePasswordChange(rawInput);
    await this.rateLimiter.consume({
      ip: metadata.ip,
      login: principal.accountId,
      operation: 'password_change',
      scope: 'tenant',
      tenantId: principal.tenantId,
    });
    const credential = await this.database.inTenantContext(
      principal.tenantId,
      async (transaction) => {
        await assertCustomerSiteAvailable(transaction, principal.tenantId);
        const rows = await transaction<CustomerCredentialRow[]>`
          select id, username::text, password_hash, status
          from customer_accounts
          where tenant_id = ${principal.tenantId}
            and id = ${principal.accountId}
            and status = 'active'
          limit 1
        `;
        return rows[0];
      },
    );
    const currentHash = credential?.password_hash ?? (await this.dummyPasswordHash);
    const matches = await this.cryptoWorkLimiter.run(
      () => verifyPassword(input.currentPassword, currentHash),
    );
    if (!credential || !matches) {
      throw new UnauthorizedException('Current password is invalid');
    }
    const newHash = await this.cryptoWorkLimiter.run(() => hashPassword(input.newPassword));
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await assertCustomerSiteAvailable(transaction, principal.tenantId);
      const locked = await transaction<Array<{ id: string; password_hash: string }>>`
        select id, password_hash
        from customer_accounts
        where tenant_id = ${principal.tenantId}
          and id = ${principal.accountId}
          and status = 'active'
        for update
      `;
      if (!locked[0] || locked[0].password_hash !== credential.password_hash) {
        throw new UnauthorizedException('Current password is invalid');
      }
      const sessions = await transaction<{ id: string }[]>`
        select session.id
        from customer_sessions as session
        inner join customer_devices as device
          on device.id = session.device_id
          and device.tenant_id = session.tenant_id
          and device.account_id = session.account_id
          and device.status = 'active'
        where session.tenant_id = ${principal.tenantId}
          and session.account_id = ${principal.accountId}
          and session.id = ${principal.sessionId}
          and session.device_id = ${principal.deviceId}
          and session.revoked_at is null
          and session.access_expires_at > statement_timestamp()
          and session.absolute_expires_at > statement_timestamp()
        for update of session
      `;
      if (!sessions[0]) throw new UnauthorizedException('Customer session is invalid');
      await transaction`
        update customer_accounts
        set password_hash = ${newHash}, version = version + 1
        where tenant_id = ${principal.tenantId}
          and id = ${principal.accountId}
          and status = 'active'
      `;
      await transaction`
        update customer_sessions
        set revoked_at = statement_timestamp(), revoked_reason = 'password_changed'
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and id <> ${principal.sessionId}
          and revoked_at is null
      `;
      const response = { changed: true as const, otherSessionsRevoked: true as const };
      await this.insertAudit(transaction, principal, metadata,
        'customer.account.password_change', 'customer_account', principal.accountId,
        { otherSessionsRevoked: true });
      await this.insertOutbox(transaction, principal.tenantId, metadata.requestId, {
        aggregateId: principal.accountId,
        eventType: 'CustomerPasswordChanged',
        payload: { accountId: principal.accountId, tenantId: principal.tenantId },
      });
      return response;
    });
  }

  async resetPassword(
    tenantId: string,
    rawInput: ResetCustomerPasswordInput,
    metadata: CustomerRequestMetadata,
  ): Promise<{ requiresReauthentication: true; reset: true }> {
    assertUuid(tenantId, 'tenantId');
    const input = validatePasswordReset(rawInput);
    await this.rateLimiter.consume({
      ip: metadata.ip,
      login: `${input.channel}:${input.destination}`,
      operation: 'password_reset',
      scope: 'tenant',
      tenantId,
    });
    // Hash before resolving the grant/account so invalid and unknown destinations
    // still consume the same bounded expensive work as a valid reset.
    const newHash = await this.cryptoWorkLimiter.run(() => hashPassword(input.newPassword));
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await assertCustomerTenantActive(transaction, tenantId);
      const accountId = await this.otp.consumePasswordResetGrant(transaction, {
        channel: input.channel,
        destination: input.destination,
        tenantId,
        token: input.verificationToken,
      });
      const updated = await transaction<{ id: string }[]>`
        update customer_accounts
        set password_hash = ${newHash}, version = version + 1
        where tenant_id = ${tenantId}
          and id = ${accountId}
          and status = 'active'
        returning id
      `;
      if (!updated[0]) {
        throw new BadRequestException('Password reset request is invalid or expired');
      }
      await transaction`
        update customer_sessions
        set revoked_at = statement_timestamp(), revoked_reason = 'password_reset'
        where tenant_id = ${tenantId}
          and account_id = ${accountId}
          and revoked_at is null
      `;
      await transaction`
        update customer_devices
        set status = 'revoked', revoked_at = statement_timestamp(),
          revoke_reason = 'password_reset'
        where tenant_id = ${tenantId}
          and account_id = ${accountId}
          and status = 'active'
      `;
      await this.insertAudit(transaction, { accountId, tenantId }, metadata,
        'customer.account.password_reset', 'customer_account', accountId,
        { devicesRevoked: true, sessionsRevoked: true });
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: accountId,
        eventType: 'CustomerPasswordReset',
        payload: { accountId, tenantId },
      });
      return { requiresReauthentication: true as const, reset: true as const };
    });
  }

  async disableOwnAccount(
    principal: CustomerPrincipal,
    reasonValue: unknown,
    metadata: CustomerRequestMetadata,
  ): Promise<{ disabled: true }> {
    assertPrincipal(principal);
    const reason = requiredString(reasonValue, 'reason', 1, 1000);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await assertCustomerTenantActive(transaction, principal.tenantId);
      const updated = await transaction<{ id: string }[]>`
        update customer_accounts
        set
          status = 'disabled', disabled_at = statement_timestamp(),
          disabled_by = ${principal.accountId}, disable_reason = ${reason},
          version = version + 1
        where id = ${principal.accountId}
          and tenant_id = ${principal.tenantId}
          and status = 'active'
        returning id
      `;
      if (!updated[0]) throw new ConflictException('Customer account is already disabled');
      await transaction`
        update customer_sessions
        set revoked_at = statement_timestamp(), revoked_reason = 'account_disabled'
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and revoked_at is null
      `;
      await transaction`
        update customer_devices
        set status = 'revoked', revoked_at = statement_timestamp(),
          revoke_reason = 'account_disabled'
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and status = 'active'
      `;
      await this.insertAudit(transaction, principal, metadata,
        'customer.account.disable', 'customer_account', principal.accountId,
        { disabled: true, dataErasurePerformed: false });
      await this.insertOutbox(transaction, principal.tenantId, metadata.requestId, {
        aggregateId: principal.accountId,
        eventType: 'CustomerAccountDisabled',
        payload: { accountId: principal.accountId, tenantId: principal.tenantId },
      });
      return { disabled: true };
    });
  }

  private async insertAudit(
    transaction: DatabaseTransaction,
    principal: Pick<CustomerPrincipal, 'accountId' | 'tenantId'>,
    metadata: CustomerRequestMetadata,
    action: string,
    resourceType: string,
    resourceId: string,
    after: object,
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, ip, request_id
      ) values (
        ${uuidV7()}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
        ${action}, ${resourceType}, ${resourceId},
        ${transaction.json(toJsonValue(after))}, ${metadata.ip ?? null}, ${metadata.requestId}
      )
    `;
  }

  private async beginCustomerCommand<T>(
    transaction: DatabaseTransaction,
    principal: CustomerPrincipal,
    metadata: CustomerRequestMetadata,
    routeKey: string,
    request: object,
  ): Promise<{ cached?: T; id?: string }> {
    const key = typeof metadata.idempotencyKey === 'string'
      ? metadata.idempotencyKey.trim()
      : '';
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw new BadRequestException('A valid Idempotency-Key header is required');
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
        ${routeKey}, ${key}, ${requestHash}, statement_timestamp() + interval '24 hours'
      ) on conflict do nothing returning id
    `;
    if (inserted[0]) return { id };
    const rows = await transaction<Array<{
      id: string; request_hash: string; response_json: unknown; status: string;
    }>>`
      select id, request_hash, response_json, status
      from command_idempotency
      where scope_type = 'tenant'
        and tenant_id = ${principal.tenantId}
        and actor_type = 'user'
        and actor_id = ${principal.accountId}
        and route_key = ${routeKey}
        and idempotency_key = ${key}
      for update
    `;
    const existing = rows[0];
    if (!existing) throw new ConflictException('Idempotency record is unavailable');
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was used for another request');
    }
    if (existing.status === 'completed' && existing.response_json !== null) {
      return { cached: existing.response_json as T };
    }
    throw new ConflictException('The same command is already processing');
  }

  private async completeCustomerCommand(
    transaction: DatabaseTransaction,
    commandId: string | undefined,
    response: object,
    resourceType: string,
    resourceId: string,
  ): Promise<void> {
    if (!commandId) return;
    await transaction`
      update command_idempotency
      set status = 'completed', response_status = 200,
        response_json = ${transaction.json(toJsonValue(response))},
        resource_type = ${resourceType}, resource_id = ${resourceId}, locked_at = null
      where id = ${commandId} and status = 'processing'
    `;
  }

  private async insertOutbox(
    transaction: DatabaseTransaction,
    tenantId: string,
    requestId: string,
    input: { aggregateId: string; eventType: string; payload: object },
  ): Promise<void> {
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, 'tenant', ${tenantId}, ${`event:${eventId}`},
        ${`${requestId}:${input.eventType}`}, 'customer_account',
        ${input.aggregateId}, ${input.eventType},
        ${transaction.json(toJsonValue(input.payload))}
      )
    `;
  }
}

function validateRegistration(value: RegisterCustomerInput) {
  if (!isRecord(value)) throw new BadRequestException('Body is required');
  const username = requiredString(value.username, 'username', 3, 64).toLowerCase();
  if (!USERNAME_PATTERN.test(username)) {
    throw new BadRequestException('username is invalid');
  }
  const password = validatePassword(value.password);
  const email = value.email === undefined ? undefined : normalizeEmail(value.email);
  const phone = value.phone === undefined ? undefined : normalizePhone(value.phone);
  const emailVerificationToken = optionalVerificationToken(
    value.emailVerificationToken,
    'emailVerificationToken',
  );
  const phoneVerificationToken = optionalVerificationToken(
    value.phoneVerificationToken,
    'phoneVerificationToken',
  );
  if (Boolean(email) !== Boolean(emailVerificationToken)) {
    throw new BadRequestException('email and emailVerificationToken must be provided together');
  }
  if (Boolean(phone) !== Boolean(phoneVerificationToken)) {
    throw new BadRequestException('phone and phoneVerificationToken must be provided together');
  }
  const legalLocale = validateLegalLocale(value.legalLocale);
  const legalConsents = validateLegalConsentInput(value.legalConsents);
  return {
    email,
    emailVerificationToken: emailVerificationToken as string,
    legalConsents,
    legalLocale,
    password,
    phone,
    phoneVerificationToken: phoneVerificationToken as string,
    username,
  };
}

interface RegistrationLegalDocument {
  document_type: 'community' | 'privacy' | 'refund' | 'terms';
  id: string;
  locale: string;
  required_for_registration: boolean;
  version_no: number;
}

async function requiredRegistrationDocuments(
  transaction: DatabaseTransaction,
  tenantId: string,
  locale: string,
): Promise<RegistrationLegalDocument[]> {
  const rows = await transaction<RegistrationLegalDocument[]>`
    with tenant_settings as (
      select default_locale from tenants where id = ${tenantId}
    ), ranked as (
      select document.id, document.document_type, document.locale,
        document.version_no, document.required_for_registration,
        row_number() over (
          partition by document.document_type
          order by
            case document.locale
              when ${locale} then 0
              when (select default_locale from tenant_settings) then 1
              when 'en-US' then 2
              else 3
            end,
            document.effective_at desc,
            document.version_no desc
        ) as locale_rank
      from tenant_legal_document_versions as document
      where document.tenant_id = ${tenantId}
        and document.status = 'published'
        and document.effective_at <= transaction_timestamp()
    )
    select id, document_type, locale, version_no, required_for_registration
    from ranked where locale_rank = 1
    order by document_type
  `;
  if (!rows.some((row) => row.document_type === 'privacy')
    || !rows.some((row) => row.document_type === 'terms')) {
    throw new ServiceUnavailableException({
      code: 'LEGAL_DOCUMENTS_UNAVAILABLE',
      message: 'Current privacy and terms documents are required for registration',
    });
  }
  return rows;
}

function validateRegistrationConsents(
  consents: Array<{ documentId: string; version: number }>,
  documents: RegistrationLegalDocument[],
): void {
  const current = new Map(
    documents.map((document) => [
      `${document.id}:${document.version_no}`,
      document,
    ]),
  );
  for (const consent of consents) {
    if (!current.has(`${consent.documentId}:${consent.version}`)) {
      throw new BadRequestException('Legal consent is not a current document version');
    }
  }
  const required = documents.filter(
    (document) => document.document_type === 'privacy'
      || document.document_type === 'terms'
      || document.required_for_registration,
  );
  const supplied = new Set(
    consents.map((consent) => `${consent.documentId}:${consent.version}`),
  );
  if (required.some(
    (document) => !supplied.has(`${document.id}:${document.version_no}`),
  )) {
    throw new BadRequestException('All current required legal documents must be accepted');
  }
}

function validateLegalLocale(value: unknown): string {
  if (typeof value !== 'string'
    || !SUPPORTED_APP_LOCALES.some(locale => locale === value)) {
    throw new BadRequestException('legalLocale is required and must be supported');
  }
  return value;
}

function validateLegalConsentInput(
  value: unknown,
): Array<{ documentId: string; version: number }> {
  if (!Array.isArray(value) || value.length < 2 || value.length > 4) {
    throw new BadRequestException('legalConsents must contain the current document versions');
  }
  const seen = new Set<string>();
  return value.map((item) => {
    if (!isRecord(item)
      || Object.keys(item).some((key) => !['documentId', 'version'].includes(key))
      || typeof item.documentId !== 'string'
      || !UUID_PATTERN.test(item.documentId)
      || !Number.isInteger(item.version)
      || Number(item.version) < 1) {
      throw new BadRequestException('legalConsents contains an invalid document version');
    }
    const key = `${item.documentId}:${item.version}`;
    if (seen.has(key)) throw new BadRequestException('legalConsents contains a duplicate');
    seen.add(key);
    return { documentId: item.documentId, version: Number(item.version) };
  });
}

function validateLogin(value: CustomerLoginInput) {
  if (!isRecord(value)) throw new BadRequestException('Body is required');
  const rawIdentifier = requiredString(value.identifier, 'identifier', 3, 320);
  const identifier = rawIdentifier.startsWith('+')
    ? normalizePhone(rawIdentifier)
    : rawIdentifier.includes('@')
      ? normalizeEmail(rawIdentifier)
      : rawIdentifier.toLowerCase();
  const allowedPlatforms = new Set<CustomerDevicePlatform>([
    'android', 'h5', 'ios', 'web',
  ]);
  if (!allowedPlatforms.has(value.devicePlatform)) {
    throw new BadRequestException('devicePlatform is invalid');
  }
  if (
    value.deviceToken !== undefined
    && (typeof value.deviceToken !== 'string' || !DEVICE_TOKEN_PATTERN.test(value.deviceToken))
  ) {
    throw new BadRequestException('deviceToken is invalid');
  }
  const deviceLabel = value.deviceLabel === undefined
    ? undefined
    : requiredString(value.deviceLabel, 'deviceLabel', 1, 100);
  return {
    deviceLabel,
    devicePlatform: value.devicePlatform,
    deviceToken: value.deviceToken,
    identifier,
    password: validatePassword(value.password),
  };
}

function validatePasswordChange(value: ChangeCustomerPasswordInput): {
  currentPassword: string;
  newPassword: string;
} {
  if (!isRecord(value)) throw new BadRequestException('Body is required');
  rejectUnknown(value, ['currentPassword', 'newPassword']);
  return {
    currentPassword: validatePassword(value.currentPassword),
    newPassword: validatePassword(value.newPassword),
  };
}

function validatePasswordReset(value: ResetCustomerPasswordInput): {
  channel: 'email' | 'phone';
  destination: string;
  newPassword: string;
  verificationToken: string;
} {
  if (!isRecord(value)) throw new BadRequestException('Body is required');
  rejectUnknown(value, ['channel', 'destination', 'newPassword', 'verificationToken']);
  if (value.channel !== 'email' && value.channel !== 'phone') {
    throw new BadRequestException('channel is invalid');
  }
  if (typeof value.verificationToken !== 'string'
    || !/^prg_[A-Za-z0-9_-]{43}$/.test(value.verificationToken)) {
    throw new BadRequestException('Password reset request is invalid or expired');
  }
  return {
    channel: value.channel,
    destination: value.channel === 'email'
      ? normalizeEmail(value.destination)
      : normalizePhone(value.destination),
    newPassword: validatePassword(value.newPassword),
    verificationToken: value.verificationToken,
  };
}

function validatePassword(value: unknown): string {
  if (
    typeof value !== 'string'
    || Buffer.byteLength(value, 'utf8') < 8
    || Buffer.byteLength(value, 'utf8') > 4096
  ) {
    throw new BadRequestException('password must contain 8 to 4096 UTF-8 bytes');
  }
  return value;
}

function generateDeviceToken(): string {
  return `dev_${randomBytes(32).toString('base64url')}`;
}

function optionalVerificationToken(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^cvg_[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

function requiredString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) {
    throw new BadRequestException(`${field} length is invalid`);
  }
  return result;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function uuid(value: unknown, field: string): string {
  assertUuid(value, field);
  return value;
}

function assertPrincipal(principal: CustomerPrincipal): void {
  if (!principal || typeof principal !== 'object') {
    throw new UnauthorizedException('Customer principal is invalid');
  }
  assertUuid(principal.tenantId, 'tenantId');
  assertUuid(principal.accountId, 'accountId');
  assertUuid(principal.deviceId, 'deviceId');
  assertUuid(principal.sessionId, 'sessionId');
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed);
  if (Object.keys(value).some((key) => !accepted.has(key))) {
    throw new BadRequestException('Body contains unknown fields');
  }
}

function dateIso(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error('Database returned an invalid date');
  return parsed.toISOString();
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function isDatabaseError(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
