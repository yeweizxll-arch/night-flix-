import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import { AuthenticationRateLimiterService } from '../src/auth/authentication-rate-limiter.service';
import { CryptoWorkLimiterService } from '../src/auth/crypto-work-limiter.service';
import type {
  CustomerPrincipal,
  CustomerSessionResponse,
} from '../src/customer-auth/customer-auth.types';
import { CustomerAuthenticationService } from '../src/customer-auth/customer-authentication.service';
import { CustomerOtpService } from '../src/customer-auth/customer-otp.service';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';
import { CustomerPlaybackAccessService } from '../src/playback/customer-playback-access.service';
import { CustomerPlaybackUrlService } from '../src/playback/customer-playback-url.service';
import type { PlaybackUrlRateLimiterService } from '../src/playback/playback-url-rate-limiter.service';
import { PlaybackService } from '../src/playback/playback.service';
import type { RedisService } from '../src/redis/redis.service';
import type { S3CompatibleStorageAdapter } from '../src/storage/s3-compatible.adapter';
import type { StorageCredentialCipher } from '../src/storage/storage-credentials';

let database: PGlite;
let authentication: CustomerAuthenticationService;
let otp: CustomerOtpService;
let playback: PlaybackService;
let playbackAccess: CustomerPlaybackAccessService;
let playbackUrl: CustomerPlaybackUrlService;
let playbackUrlPresigner: ReturnType<typeof vi.fn>;
let presignGate: Promise<void> | undefined;
let accountId: string;
let activeSession: CustomerSessionResponse;
let platformLicenseId: string;

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773573101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773573102';
const platformStaffId = '018f2f45-7f5e-7e70-b17f-f6e773573103';
const tenantVideoId = '018f2f45-7f5e-7e70-b17f-f6e773573104';
const platformVideoId = '018f2f45-7f5e-7e70-b17f-f6e773573105';
const tenantDramaId = '018f2f45-7f5e-7e70-b17f-f6e773573106';
const tenantEpisodeId = '018f2f45-7f5e-7e70-b17f-f6e773573107';
const licensedDramaId = '018f2f45-7f5e-7e70-b17f-f6e773573108';
const licensedEpisodeId = '018f2f45-7f5e-7e70-b17f-f6e773573109';
const unlicensedDramaId = '018f2f45-7f5e-7e70-b17f-f6e77357310a';
const unlicensedEpisodeId = '018f2f45-7f5e-7e70-b17f-f6e77357310b';
const tenantBDramaId = '018f2f45-7f5e-7e70-b17f-f6e77357310c';
const accountB = '018f2f45-7f5e-7e70-b17f-f6e77357310d';
const accountASecond = '018f2f45-7f5e-7e70-b17f-f6e77357310e';
const paymentProviderId = '018f2f45-7f5e-7e70-b17f-f6e77357310f';
const paymentConfigId = '018f2f45-7f5e-7e70-b17f-f6e773573110';
const tenantStorageProviderId = '018f2f45-7f5e-7e70-b17f-f6e773573111';
const platformStorageProviderId = '018f2f45-7f5e-7e70-b17f-f6e773573112';
const tenantSecureVideoId = '018f2f45-7f5e-7e70-b17f-f6e773573113';
const platformSecureVideoId = '018f2f45-7f5e-7e70-b17f-f6e773573114';
const tenantSecureDramaId = '018f2f45-7f5e-7e70-b17f-f6e773573115';
const tenantSecureEpisodeId = '018f2f45-7f5e-7e70-b17f-f6e773573116';
const platformSecureDramaId = '018f2f45-7f5e-7e70-b17f-f6e773573117';
const platformSecureEpisodeId = '018f2f45-7f5e-7e70-b17f-f6e773573118';
const crossAccountDeviceId = '018f2f45-7f5e-7e70-b17f-f6e773573119';
const tenantSecurePreviewVideoId = '018f2f45-7f5e-7e70-b17f-f6e77357311a';
const platformSecurePreviewVideoId = '018f2f45-7f5e-7e70-b17f-f6e77357311b';
const privacyDocumentA = '018f2f45-7f5e-7e70-b17f-f6e773573201';
const termsDocumentA = '018f2f45-7f5e-7e70-b17f-f6e773573202';
const privacyDocumentB = '018f2f45-7f5e-7e70-b17f-f6e773573203';
const termsDocumentB = '018f2f45-7f5e-7e70-b17f-f6e773573204';

const originalEnvironment = {
  expose: process.env.CUSTOMER_OTP_EXPOSE_CODE,
  nodeEnv: process.env.NODE_ENV,
  secret: process.env.CUSTOMER_OTP_HMAC_SECRET,
  universal: process.env.CUSTOMER_UNIVERSAL_OTP_ENABLED,
};

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}

function metadata() {
  return { ip: '127.0.0.1', requestId: uuidV7() };
}

describe('customer authentication, OTP, devices, and playback domain', () => {
  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.CUSTOMER_OTP_HMAC_SECRET = 'test-only-customer-otp-hmac-secret-123456789';
    process.env.CUSTOMER_OTP_EXPOSE_CODE = 'true';
    process.env.CUSTOMER_UNIVERSAL_OTP_ENABLED = 'true';

    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of filenames) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(
        source
          .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
          .replace(/\bcitext\b/g, 'text'),
      );
    }
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantA}', 'customer-a', 'Customer A', statement_timestamp() + interval '1 year'),
        ('${tenantB}', 'customer-b', 'Customer B', statement_timestamp() + interval '1 year');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaffId}', 'customer-license-operator', '${'p'.repeat(64)}');
      insert into tenant_legal_document_versions (
        id, tenant_id, document_type, locale, version_no, title,
        body_markdown, required_for_registration, created_by
      ) values
        ('${privacyDocumentA}', '${tenantA}', 'privacy', 'en-US', 1,
          'Privacy', 'Privacy text', true, '${platformStaffId}'),
        ('${termsDocumentA}', '${tenantA}', 'terms', 'en-US', 1,
          'Terms', 'Terms text', true, '${platformStaffId}'),
        ('${privacyDocumentB}', '${tenantB}', 'privacy', 'en-US', 1,
          'Privacy', 'Privacy text', true, '${platformStaffId}'),
        ('${termsDocumentB}', '${tenantB}', 'terms', 'en-US', 1,
          'Terms', 'Terms text', true, '${platformStaffId}');
      update tenant_legal_document_versions
      set status = 'published', effective_at = transaction_timestamp(),
        published_by = '${platformStaffId}', published_at = transaction_timestamp(),
        row_version = row_version + 1;
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, source_url, checksum,
        status, transcode_status, duration_seconds, metadata_json
      ) values (
        '${tenantVideoId}', 'tenant', '${tenantA}', 'video',
        'https://media.example.com/customer-tenant.mp4', '${'a'.repeat(64)}',
        'ready', 'ready', 120, '{"immutable":true}'::jsonb
      ), (
        '${platformVideoId}', 'platform', null, 'video',
        'https://media.example.com/customer-platform.mp4', '${'b'.repeat(64)}',
        'ready', 'ready', 100, '{"immutable":true}'::jsonb
      );
      insert into dramas (
        id, owner_type, owner_tenant_id, code, status, total_episodes
      ) values
        ('${tenantDramaId}', 'tenant', '${tenantA}', 'customer-own-drama', 'published', 1),
        ('${licensedDramaId}', 'platform', null, 'customer-licensed-drama', 'published', 1),
        ('${unlicensedDramaId}', 'platform', null, 'customer-unlicensed-drama', 'published', 1),
        ('${tenantBDramaId}', 'tenant', '${tenantB}', 'customer-other-drama', 'published', 0);
      insert into episodes (
        id, drama_id, episode_no, status, duration_seconds, media_asset_id
      ) values
        ('${tenantEpisodeId}', '${tenantDramaId}', 1, 'published', 120, '${tenantVideoId}'),
        ('${licensedEpisodeId}', '${licensedDramaId}', 1, 'published', 100, '${platformVideoId}'),
        ('${unlicensedEpisodeId}', '${unlicensedDramaId}', 1, 'published', 100, '${platformVideoId}');
      insert into customer_accounts (
        id, tenant_id, username, email, password_hash, email_verified_at
      ) values (
        '${accountB}', '${tenantB}', 'other_customer', 'other@example.com',
        '${'x'.repeat(64)}', statement_timestamp()
      ), (
        '${accountASecond}', '${tenantA}', 'viewer_two', 'viewer-two@example.com',
        '${'y'.repeat(64)}', statement_timestamp()
      );
      insert into payment_providers (id, code, adapter_code)
      values ('${paymentProviderId}', 'playback-test-provider', 'fake');
      insert into payment_configs (id, owner_type, provider_id, label)
      values (
        '${paymentConfigId}', 'platform', '${paymentProviderId}',
        'Playback entitlement test config'
      );
      insert into storage_providers (
        id, owner_type, owner_tenant_id, provider, account_label, endpoint,
        bucket, credential_ciphertext, key_version
      ) values (
        '${tenantStorageProviderId}', 'tenant', '${tenantA}', 's3',
        'secure-playback-tenant', 'https://s3.tenant.example', 'tenant-media',
        'test-ciphertext-tenant-credential', 1
      ), (
        '${platformStorageProviderId}', 'platform', null, 's3',
        'secure-playback-platform', 'https://s3.platform.example', 'platform-media',
        'test-ciphertext-platform-credential', 1
      );
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, storage_provider_id, object_key,
        mime_type, size_bytes, checksum, status, transcode_status, duration_seconds
      ) values (
        '${tenantSecureVideoId}', 'tenant', '${tenantA}', 'video',
        '${tenantStorageProviderId}', 'opaque/tenant-secure-video.mp4',
        'video/mp4', 1024, '${'d'.repeat(64)}', 'ready', 'not_required', 90
      ), (
        '${tenantSecurePreviewVideoId}', 'tenant', '${tenantA}', 'video',
        '${tenantStorageProviderId}', 'opaque/tenant-secure-preview.mp4',
        'video/mp4', 512, '${'f'.repeat(64)}', 'ready', 'not_required', 20
      ), (
        '${platformSecureVideoId}', 'platform', null, 'video',
        '${platformStorageProviderId}', 'opaque/platform-secure-video.mp4',
        'video/mp4', 2048, '${'e'.repeat(64)}', 'ready', 'not_required', 80
      ), (
        '${platformSecurePreviewVideoId}', 'platform', null, 'video',
        '${platformStorageProviderId}', 'opaque/platform-secure-preview.mp4',
        'video/mp4', 512, '${'1'.repeat(64)}', 'ready', 'not_required', 15
      );
      insert into dramas (
        id, owner_type, owner_tenant_id, code, status, total_episodes
      ) values (
        '${tenantSecureDramaId}', 'tenant', '${tenantA}',
        'customer-secure-tenant-drama', 'published', 1
      ), (
        '${platformSecureDramaId}', 'platform', null,
        'customer-secure-platform-drama', 'published', 1
      );
      insert into episodes (
        id, drama_id, episode_no, status, duration_seconds, preview_seconds,
        media_asset_id, preview_media_asset_id
      ) values (
        '${tenantSecureEpisodeId}', '${tenantSecureDramaId}', 1, 'published',
        90, 20, '${tenantSecureVideoId}', '${tenantSecurePreviewVideoId}'
      ), (
        '${platformSecureEpisodeId}', '${platformSecureDramaId}', 1, 'published',
        80, 15, '${platformSecureVideoId}', '${platformSecurePreviewVideoId}'
      );
    `);

    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction(async (transaction) => {
          const tagged = transactionTag(transaction);
          await tagged`
            select
              set_config('app.access_scope', 'tenant', true),
              set_config('app.tenant_id', ${tenantId}, true)
          `;
          return callback(tagged);
        }),
    } as unknown as DatabaseService;
    const rateLimiter = new AuthenticationRateLimiterService({
      configured: false,
    } as RedisService);
    const cryptoWorkLimiter = new CryptoWorkLimiterService();
    otp = new CustomerOtpService(databaseService, rateLimiter);
    authentication = new CustomerAuthenticationService(
      databaseService,
      rateLimiter,
      cryptoWorkLimiter,
      otp,
    );
    playbackAccess = new CustomerPlaybackAccessService(databaseService);
    playback = new PlaybackService(databaseService, playbackAccess);
    playbackUrlPresigner = vi.fn(async (input: { expiresInSeconds: number }) => {
      if (presignGate) await presignGate;
      return {
        cacheControl: 'private, no-store, max-age=0' as const,
        contentDisposition: 'inline' as const,
        expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000),
        url: `https://signed.example.test/playback?X-Amz-Expires=${input.expiresInSeconds}`,
      };
    });
    playbackUrl = new CustomerPlaybackUrlService(
      databaseService,
      playbackAccess,
      {
        decrypt: vi.fn(() => ({
          accessKeyId: 'integration-access-key',
          region: 'us-east-1',
          secretAccessKey: 'integration-secret-never-returned',
        })),
      } as unknown as StorageCredentialCipher,
      {
        headObject: vi.fn(),
        presignConditionalPut: vi.fn(),
        presignGetObject: playbackUrlPresigner,
      } as unknown as S3CompatibleStorageAdapter,
      { consume: vi.fn(async () => undefined) } as unknown as PlaybackUrlRateLimiterService,
    );
  }, 30_000);

  afterAll(async () => {
    await database?.close();
    restoreEnvironment('NODE_ENV', originalEnvironment.nodeEnv);
    restoreEnvironment('CUSTOMER_OTP_HMAC_SECRET', originalEnvironment.secret);
    restoreEnvironment('CUSTOMER_OTP_EXPOSE_CODE', originalEnvironment.expose);
    restoreEnvironment('CUSTOMER_UNIVERSAL_OTP_ENABLED', originalEnvironment.universal);
  });

  it('stores only OTP HMACs, commits failed attempts, consumes atomically, and audits 8888', async () => {
    await expect(database.exec(`
      insert into customer_accounts (
        id, tenant_id, username, email, password_hash
      ) values (
        '${uuidV7()}', '${tenantA}', 'raw_unverified_contact',
        'raw-unverified@example.com', '${'z'.repeat(64)}'
      )
    `)).rejects.toThrow(/email_must_be_verified/);

    const emailRegistrationChallenge = await otp.createChallenge(tenantA, {
      channel: 'email',
      destination: 'viewer@example.com',
      purpose: 'verify_email',
    }, metadata());
    const emailGrant = await otp.verifyChallenge(tenantA, {
      challengeId: emailRegistrationChallenge.challengeId,
      channel: 'email',
      code: emailRegistrationChallenge.developmentCode ?? '',
      destination: 'viewer@example.com',
      purpose: 'verify_email',
    }, metadata());
    const phoneRegistrationChallenge = await otp.createChallenge(tenantA, {
      channel: 'phone',
      destination: '+819012345678',
      purpose: 'verify_phone',
    }, metadata());
    const phoneGrant = await otp.verifyChallenge(tenantA, {
      challengeId: phoneRegistrationChallenge.challengeId,
      channel: 'phone',
      code: phoneRegistrationChallenge.developmentCode ?? '',
      destination: '+819012345678',
      purpose: 'verify_phone',
    }, metadata());
    expect(emailGrant.verificationToken).toMatch(/^cvg_/);
    expect(phoneGrant.verificationToken).toMatch(/^cvg_/);
    const storedGrant = await database.query<{
      verification_grant_consumed_at: Date | null;
      verification_grant_hash: string;
    }>(`
      select verification_grant_hash, verification_grant_consumed_at
      from customer_otp_challenges
      where id = '${emailRegistrationChallenge.challengeId}'
    `);
    expect(storedGrant.rows[0]?.verification_grant_hash).toMatch(
      /^sha256\$[A-Za-z0-9_-]{43}$/,
    );
    expect(storedGrant.rows[0]?.verification_grant_hash).not.toContain(
      emailGrant.verificationToken,
    );
    expect(storedGrant.rows[0]?.verification_grant_consumed_at).toBeNull();

    await expect(authentication.register(tenantA, {
      email: 'unverified@example.com',
      password: 'correct horse battery staple',
      username: 'unverified_contact',
    }, metadata())).rejects.toThrow(/VerificationToken/);
    await expect(authentication.register(tenantB, {
      email: 'viewer@example.com',
      emailVerificationToken: emailGrant.verificationToken,
      password: 'correct horse battery staple',
      ...legalRegistration(tenantB),
      username: 'cross_tenant_grant',
    }, metadata())).rejects.toThrow(/verification token/i);

    const registered = await authentication.register(
      tenantA,
      {
        email: 'Viewer@Example.COM',
        emailVerificationToken: emailGrant.verificationToken,
        password: 'correct horse battery staple',
        ...legalRegistration(tenantA),
        phone: '+819012345678',
        phoneVerificationToken: phoneGrant.verificationToken,
        username: 'viewer_one',
      },
      metadata(),
    );
    accountId = registered.accountId;
    const registrationFacts = await database.query<{
      email_verified: boolean;
      grant_consumed: boolean;
      phone_verified: boolean;
    }>(`
      select
        account.email_verified_at is not null as email_verified,
        account.phone_verified_at is not null as phone_verified,
        challenge.verification_grant_consumed_at is not null as grant_consumed
      from customer_accounts as account
      cross join customer_otp_challenges as challenge
      where account.id = '${accountId}'
        and challenge.id = '${emailRegistrationChallenge.challengeId}'
    `);
    expect(registrationFacts.rows[0]).toEqual({
      email_verified: true,
      grant_consumed: true,
      phone_verified: true,
    });
    await expect(authentication.register(tenantA, {
      email: 'viewer@example.com',
      emailVerificationToken: emailGrant.verificationToken,
      password: 'correct horse battery staple',
      ...legalRegistration(tenantA),
      username: 'reused_grant',
    }, metadata())).rejects.toThrow(/verification token/i);

    const challenge = await otp.createChallenge(tenantA, {
      accountId,
      channel: 'email',
      destination: 'viewer@example.com',
      purpose: 'verify_email',
    }, metadata());
    expect(challenge.developmentCode).toMatch(/^[0-9]{6}$/);
    const stored = await database.query<{
      code_hash: string;
      destination_hash: string;
    }>(`
      select code_hash, destination_hash
      from customer_otp_challenges where id = '${challenge.challengeId}'
    `);
    expect(stored.rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored.rows[0]?.destination_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.rows[0])).not.toContain('viewer@example.com');
    expect(JSON.stringify(stored.rows[0])).not.toContain(challenge.developmentCode);

    await expect(otp.verifyChallenge(
      tenantA,
      {
        accountId,
        challengeId: challenge.challengeId,
        channel: 'email',
        code: '000000',
        destination: 'viewer@example.com',
        purpose: 'verify_email',
      },
      metadata(),
    )).rejects.toBeInstanceOf(UnauthorizedException);
    const failedAttempt = await database.query<{ attempts: number }>(`
      select attempts from customer_otp_challenges where id = '${challenge.challengeId}'
    `);
    expect(failedAttempt.rows[0]?.attempts).toBe(1);

    await expect(otp.verifyChallenge(
      tenantA,
      {
        accountId,
        challengeId: challenge.challengeId,
        channel: 'email',
        code: challenge.developmentCode ?? '',
        destination: 'viewer@example.com',
        purpose: 'verify_email',
      },
      metadata(),
    )).resolves.toEqual({ verified: true });
    await expect(otp.verifyChallenge(
      tenantA,
      {
        accountId,
        challengeId: challenge.challengeId,
        channel: 'email',
        code: challenge.developmentCode ?? '',
        destination: 'viewer@example.com',
        purpose: 'verify_email',
      },
      metadata(),
    )).rejects.toBeInstanceOf(UnauthorizedException);

    const phoneChallenge = await otp.createChallenge(tenantA, {
      accountId,
      channel: 'phone',
      destination: '+819012345678',
      purpose: 'verify_phone',
    }, metadata());
    await otp.verifyChallenge(
      tenantA,
      {
        accountId,
        challengeId: phoneChallenge.challengeId,
        channel: 'phone',
        code: '8888',
        destination: '+819012345678',
        purpose: 'verify_phone',
      },
      metadata(),
    );
    const verified = await database.query<{
      audits: string;
      email_verified: boolean;
      phone_verified: boolean;
      universal_used: boolean;
    }>(`
      select
        (select email_verified_at is not null from customer_accounts
          where id = '${accountId}') as email_verified,
        (select phone_verified_at is not null from customer_accounts
          where id = '${accountId}') as phone_verified,
        (select universal_code_used from customer_otp_challenges
          where id = '${phoneChallenge.challengeId}') as universal_used,
        (select count(*)::text from audit_logs
          where resource_id = '${phoneChallenge.challengeId}'
            and action = 'customer.otp.universal_code_used') as audits
    `);
    expect(verified.rows[0]).toEqual({
      audits: '1',
      email_verified: true,
      phone_verified: true,
      universal_used: true,
    });
  });

  it('requires an explicit second production switch for universal OTP', () => {
    const previous = {
      allow: process.env.ALLOW_INSECURE_OTP,
      nodeEnv: process.env.NODE_ENV,
    };
    process.env.NODE_ENV = 'production';
    delete process.env.ALLOW_INSECURE_OTP;
    expect(() => new CustomerOtpService(
      {} as DatabaseService,
      {} as AuthenticationRateLimiterService,
    )).toThrow(
      /ALLOW_INSECURE_OTP=true/,
    );
    restoreEnvironment('ALLOW_INSECURE_OTP', previous.allow);
    restoreEnvironment('NODE_ENV', previous.nodeEnv);
  });

  it('keeps at most three active devices and detects rotated refresh replay', async () => {
    const sessions: CustomerSessionResponse[] = [];
    for (const devicePlatform of ['web', 'h5', 'android', 'ios'] as const) {
      sessions.push(await authentication.login(
        tenantA,
        {
          deviceLabel: `Device ${devicePlatform}`,
          devicePlatform,
          identifier: 'VIEWER_ONE',
          password: 'correct horse battery staple',
        },
        metadata(),
      ));
    }
    activeSession = sessions[2] as CustomerSessionResponse;
    await expect(authentication.authenticateAccess(
      tenantA,
      sessions[0]?.accessToken ?? '',
    )).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(authentication.authenticateAccess(
      tenantA,
      activeSession.accessToken,
    )).resolves.toMatchObject({ accountId, tenantId: tenantA });
    const deviceFacts = await database.query<{
      active_devices: string;
      evicted_devices: string;
    }>(`
      select
        count(*) filter (where status = 'active')::text as active_devices,
        count(*) filter (
          where status = 'revoked' and revoke_reason = 'device_limit_eviction'
        )::text as evicted_devices
      from customer_devices where tenant_id = '${tenantA}' and account_id = '${accountId}'
    `);
    expect(deviceFacts.rows[0]).toEqual({
      active_devices: '3',
      evicted_devices: '1',
    });

    const rotating = sessions[1] as CustomerSessionResponse;
    const rotated = await authentication.refresh(
      tenantA,
      rotating.refreshToken,
      metadata(),
    );
    await expect(authentication.authenticateAccess(
      tenantA,
      rotated.accessToken,
    )).resolves.toMatchObject({ accountId });
    await expect(authentication.refresh(
      tenantA,
      rotating.refreshToken,
      metadata(),
    )).rejects.toThrow(/replay/i);
    await expect(authentication.authenticateAccess(
      tenantA,
      rotated.accessToken,
    )).rejects.toBeInstanceOf(UnauthorizedException);

    const concurrentSession = await authentication.login(
      tenantA,
      {
        deviceLabel: 'Concurrent refresh',
        devicePlatform: 'web',
        identifier: 'viewer_one',
        password: 'correct horse battery staple',
      },
      metadata(),
    );
    const concurrent = await Promise.allSettled([
      authentication.refresh(tenantA, concurrentSession.refreshToken, metadata()),
      authentication.refresh(tenantA, concurrentSession.refreshToken, metadata()),
    ]);
    expect(concurrent.map((result) => result.status).sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    const concurrentSuccess = concurrent.find(
      (result): result is PromiseFulfilledResult<CustomerSessionResponse> =>
        result.status === 'fulfilled',
    );
    expect(concurrentSuccess).toBeDefined();
    await expect(authentication.authenticateAccess(
      tenantA,
      concurrentSuccess?.value.accessToken ?? '',
    )).rejects.toBeInstanceOf(UnauthorizedException);
    const replayAudits = await database.query<{ count: string }>(`
      select count(*)::text as count
      from audit_logs
      where tenant_id = '${tenantA}'
        and action = 'customer.auth.refresh_replay'
    `);
    expect(Number(replayAudits.rows[0]?.count)).toBeGreaterThanOrEqual(2);
  });

  it('upserts authorized online progress, enforces duration, favorites, and history', async () => {
    const principal = await authentication.authenticateAccess(
      tenantA,
      activeSession.accessToken,
    );
    const first = await playback.upsertProgress(principal, {
      dramaId: tenantDramaId,
      episodeId: tenantEpisodeId,
      positionSeconds: 30,
    });
    expect(first).toMatchObject({ positionSeconds: 30, version: 0 });
    const second = await playback.upsertProgress(principal, {
      completed: true,
      dramaId: tenantDramaId,
      episodeId: tenantEpisodeId,
      positionSeconds: 120,
    });
    expect(second).toMatchObject({ completed: true, version: 1 });
    await expect(playback.upsertProgress(principal, {
      dramaId: tenantDramaId,
      episodeId: tenantEpisodeId,
      positionSeconds: 121,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(playback.upsertProgress(principal, {
      dramaId: unlicensedDramaId,
      episodeId: unlicensedEpisodeId,
      positionSeconds: 10,
    })).rejects.toBeInstanceOf(NotFoundException);

    platformLicenseId = uuidV7();
    await database.exec(`
      insert into content_licenses (
        id, tenant_id, license_type, drama_id, starts_at, expires_at,
        status, granted_by
      ) values (
        '${platformLicenseId}', '${tenantA}', 'drama', '${licensedDramaId}',
        statement_timestamp() - interval '1 hour',
        statement_timestamp() + interval '1 day', 'active', '${platformStaffId}'
      );
      insert into content_license_items (id, tenant_id, license_id, drama_id)
      values (
        '${uuidV7()}', '${tenantA}', '${platformLicenseId}', '${licensedDramaId}'
      );
    `);
    await expect(playback.upsertProgress(principal, {
      dramaId: licensedDramaId,
      episodeId: licensedEpisodeId,
      positionSeconds: 50,
    })).resolves.toMatchObject({ positionSeconds: 50 });

    await expect(playback.addFavorite(
      principal,
      tenantDramaId,
      uuidV7(),
    )).resolves.toEqual({ added: true });
    await expect(playback.addFavorite(
      principal,
      tenantDramaId,
      uuidV7(),
    )).resolves.toEqual({ added: false });
    const favorites = await playback.listFavorites(principal, 1, 20);
    expect(favorites.items.map((favorite) => favorite.dramaId)).toEqual([
      tenantDramaId,
    ]);
    const history = await playback.listHistory(principal, 1, 20);
    expect(history.total).toBe(2);
    expect(history.items.map((entry) => entry.episodeId)).toEqual(
      expect.arrayContaining([tenantEpisodeId, licensedEpisodeId]),
    );
    await expect(playback.removeFavorite(
      principal,
      tenantDramaId,
      uuidV7(),
    )).resolves.toEqual({ removed: true });
  });

  it('resolves free, membership, drama, and episode playback access per account', async () => {
    const principal = await authentication.authenticateAccess(
      tenantA,
      activeSession.accessToken,
    );
    const secondPrincipal = {
      accountId: accountASecond,
      deviceId: uuidV7(),
      sessionId: uuidV7(),
      tenantId: tenantA,
      username: 'viewer_two',
    };

    await expect(playbackAccess.getAccess(principal, tenantEpisodeId)).resolves.toEqual({
      access: 'full',
      dramaId: tenantDramaId,
      durationSeconds: 120,
      episodeId: tenantEpisodeId,
      mediaAssetId: tenantVideoId,
      previewSeconds: 0,
    });

    await database.exec(`
      update episodes set preview_seconds = 15 where id = '${tenantEpisodeId}';
      insert into content_prices (
        id, tenant_id, target_type, target_id, currency, amount_minor
      ) values (
        '${uuidV7()}', '${tenantA}', 'drama', '${tenantDramaId}', 'USD', 199
      )
    `);
    await grantEntitlement(accountId, 'membership', uuidV7(), '-30 days', '-1 day');
    await expect(playbackAccess.getAccess(principal, tenantEpisodeId))
      .resolves.toMatchObject({ access: 'preview', previewSeconds: 15 });
    await expect(playbackAccess.getAccess(secondPrincipal, tenantEpisodeId))
      .resolves.toMatchObject({ access: 'preview' });

    const activeMembership = await grantEntitlement(
      accountId,
      'membership',
      uuidV7(),
      '-1 hour',
      '+30 days',
    );
    await expect(playbackAccess.getAccess(principal, tenantEpisodeId))
      .resolves.toMatchObject({ access: 'full' });
    await revokeEntitlement(activeMembership);

    const dramaEntitlement = await grantEntitlement(
      accountId,
      'drama',
      tenantDramaId,
      '-1 hour',
      '+30 days',
    );
    await expect(playbackAccess.getAccess(principal, tenantEpisodeId))
      .resolves.toMatchObject({ access: 'full' });
    await revokeEntitlement(dramaEntitlement);

    await database.exec(`
      insert into content_prices (
        id, tenant_id, target_type, target_id, currency, amount_minor
      ) values (
        '${uuidV7()}', '${tenantA}', 'episode', '${tenantEpisodeId}', 'JPY', 200
      )
    `);
    await grantEntitlement(
      accountId,
      'episode',
      tenantEpisodeId,
      '-1 hour',
      '+30 days',
    );
    await expect(playbackAccess.getAccess(principal, tenantEpisodeId))
      .resolves.toMatchObject({ access: 'full' });
    await expect(playbackAccess.getAccess(secondPrincipal, tenantEpisodeId))
      .resolves.toMatchObject({ access: 'preview' });
  });

  it('blocks locked progress, caps preview progress, and rechecks platform licenses', async () => {
    const secondPrincipal = {
      accountId: accountASecond,
      deviceId: uuidV7(),
      sessionId: uuidV7(),
      tenantId: tenantA,
      username: 'viewer_two',
    };
    await expect(playback.upsertProgress(secondPrincipal, {
      dramaId: tenantDramaId,
      episodeId: tenantEpisodeId,
      positionSeconds: 16,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(playback.upsertProgress(secondPrincipal, {
      completed: true,
      dramaId: tenantDramaId,
      episodeId: tenantEpisodeId,
      positionSeconds: 15,
    })).rejects.toBeInstanceOf(BadRequestException);
    await expect(playback.upsertProgress(secondPrincipal, {
      dramaId: tenantDramaId,
      episodeId: tenantEpisodeId,
      positionSeconds: 15,
    })).resolves.toMatchObject({ completed: false, positionSeconds: 15 });

    await database.exec(`
      update episodes set preview_seconds = 0 where id = '${tenantEpisodeId}'
    `);
    await expect(playbackAccess.getAccess(secondPrincipal, tenantEpisodeId))
      .resolves.toMatchObject({ access: 'locked', previewSeconds: 0 });
    await expect(playback.upsertProgress(secondPrincipal, {
      dramaId: tenantDramaId,
      episodeId: tenantEpisodeId,
      positionSeconds: 0,
    })).rejects.toBeInstanceOf(ForbiddenException);

    await expect(playbackAccess.getAccess(secondPrincipal, licensedEpisodeId))
      .resolves.toMatchObject({ access: 'full' });
    await database.exec(`
      update content_licenses
      set status = 'revoked', revoked_at = statement_timestamp(),
          revoked_by = '${platformStaffId}', revoke_reason = 'playback access test'
      where id = '${platformLicenseId}'
    `);
    await expect(playbackAccess.getAccess(secondPrincipal, licensedEpisodeId))
      .rejects.toBeInstanceOf(NotFoundException);
  });

  it('issues only real-time authorized internal URLs and linearizes provider disable', async () => {
    const principal = await authentication.authenticateAccess(
      tenantA,
      activeSession.accessToken,
    );
    const secondPrincipal: CustomerPrincipal = {
      accountId: accountASecond,
      deviceId: uuidV7(),
      sessionId: uuidV7(),
      tenantId: tenantA,
      username: 'viewer_two',
    };
    const crossTenantPrincipal: CustomerPrincipal = {
      accountId: accountB,
      deviceId: uuidV7(),
      sessionId: uuidV7(),
      tenantId: tenantB,
      username: 'other_customer',
    };
    await database.exec(`
      insert into content_prices (
        id, tenant_id, target_type, target_id, currency, amount_minor
      ) values (
        '${uuidV7()}', '${tenantA}', 'drama', '${tenantSecureDramaId}', 'USD', 299
      )
    `);
    await grantEntitlement(
      accountId,
      'drama',
      tenantSecureDramaId,
      '-1 hour',
      '+30 days',
    );

    const beforeFacts = await playbackUrlSideEffectFacts();
    const signed = await playbackUrl.issue(
      principal,
      tenantSecureEpisodeId,
      180,
      '203.0.113.10',
    );
    expect(signed).toEqual({
      access: 'full',
      expiresAt: expect.any(String),
      mediaAssetId: tenantSecureVideoId,
      offlineSupported: false,
      url: 'https://signed.example.test/playback?X-Amz-Expires=180',
    });
    expect(JSON.stringify(signed)).not.toMatch(
      /opaque\/tenant-secure|integration-secret|credential_ciphertext|objectKey/,
    );
    expect(await playbackUrlSideEffectFacts()).toEqual(beforeFacts);

    const callsAfterSuccess = playbackUrlPresigner.mock.calls.length;
    await expect(playbackUrl.issue(
      secondPrincipal,
      tenantSecureEpisodeId,
      180,
      '203.0.113.11',
    )).resolves.toMatchObject({
      access: 'preview',
      mediaAssetId: tenantSecurePreviewVideoId,
      previewSeconds: 20,
    });
    expect(playbackUrlPresigner).toHaveBeenCalledTimes(callsAfterSuccess + 1);
    await database.exec(`update episodes set preview_seconds = 15,
      preview_media_asset_id = null where id = '${tenantEpisodeId}'`);
    await expect(playbackUrl.issue(
      secondPrincipal,
      tenantEpisodeId,
      180,
      '203.0.113.17',
    )).rejects.toMatchObject({
      response: expect.objectContaining({
        access: 'preview',
        code: 'PREVIEW_PLAYBACK_ASSET_UNAVAILABLE',
      }),
    });
    await expect(playbackUrl.issue(
      crossTenantPrincipal,
      tenantSecureEpisodeId,
      180,
      '203.0.113.12',
    )).rejects.toBeInstanceOf(NotFoundException);

    // This account is entitled to the original episode, but it is an external
    // source URL and therefore must never be forwarded as secure playback.
    await expect(playbackUrl.issue(
      principal,
      tenantEpisodeId,
      180,
      '203.0.113.13',
    )).rejects.toBeInstanceOf(NotFoundException);

    const securePlatformLicenseId = uuidV7();
    await database.exec(`
      insert into content_licenses (
        id, tenant_id, license_type, drama_id, starts_at, expires_at,
        status, granted_by
      ) values (
        '${securePlatformLicenseId}', '${tenantA}', 'drama',
        '${platformSecureDramaId}', statement_timestamp() - interval '1 hour',
        statement_timestamp() + interval '1 day', 'active', '${platformStaffId}'
      );
      insert into content_license_items (id, tenant_id, license_id, drama_id)
      values (
        '${uuidV7()}', '${tenantA}', '${securePlatformLicenseId}',
        '${platformSecureDramaId}'
      );
      insert into content_prices (
        id, tenant_id, target_type, target_id, currency, amount_minor
      ) values (
        '${uuidV7()}', '${tenantA}', 'drama', '${platformSecureDramaId}', 'USD', 399
      )
    `);
    await expect(playbackUrl.issue(
      secondPrincipal,
      platformSecureEpisodeId,
      240,
      '203.0.113.14',
    )).resolves.toMatchObject({
      access: 'preview',
      mediaAssetId: platformSecurePreviewVideoId,
      previewSeconds: 15,
    });
    await database.exec(`
      update content_licenses
      set status = 'revoked', revoked_at = statement_timestamp(),
          revoked_by = '${platformStaffId}', revoke_reason = 'secure URL revocation test'
      where id = '${securePlatformLicenseId}'
    `);
    await expect(playbackUrl.issue(
      secondPrincipal,
      platformSecureEpisodeId,
      240,
      '203.0.113.15',
    )).rejects.toBeInstanceOf(NotFoundException);

    let releaseGate!: () => void;
    presignGate = new Promise<void>((resolveGate) => { releaseGate = resolveGate; });
    const presignCallCount = playbackUrlPresigner.mock.calls.length;
    const inFlight = playbackUrl.issue(
      principal,
      tenantSecureEpisodeId,
      180,
      '203.0.113.16',
    );
    await vi.waitFor(() => {
      expect(playbackUrlPresigner).toHaveBeenCalledTimes(presignCallCount + 1);
    });
    let disableSettled = false;
    const disable = database.exec(`
      update storage_providers
      set status = 'disabled', version = version + 1
      where id = '${tenantStorageProviderId}'
    `).then(() => { disableSettled = true; });
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    expect(disableSettled).toBe(false);
    releaseGate();
    await expect(inFlight).resolves.toMatchObject({ access: 'full' });
    await disable;
    presignGate = undefined;
    await expect(playbackUrl.issue(
      principal,
      tenantSecureEpisodeId,
      180,
      '203.0.113.17',
    )).rejects.toBeInstanceOf(NotFoundException);
    await database.exec(`
      update storage_providers
      set status = 'active', version = version + 1
      where id = '${tenantStorageProviderId}'
    `);
  });

  it('manages only the current account devices and changes password without leaking secrets', async () => {
    const principal = await authentication.authenticateAccess(
      tenantA,
      activeSession.accessToken,
    );
    const listed = await authentication.listDevices(principal);
    expect(listed.items).toHaveLength(3);
    expect(listed.items.filter((device) => device.current)).toEqual([
      expect.objectContaining({ id: principal.deviceId, status: 'active' }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/token|hash|last_ip|userAgent/i);

    await database.exec(`
      insert into customer_devices (
        id, tenant_id, account_id, device_token_hash, platform, label
      ) values (
        '${crossAccountDeviceId}', '${tenantA}', '${accountASecond}',
        '${'f'.repeat(64)}', 'web', 'Other account device'
      )
    `);
    await expect(authentication.revokeDevice(
      principal,
      crossAccountDeviceId,
      { ...metadata(), idempotencyKey: 'cross-account-device-revoke' },
    )).rejects.toBeInstanceOf(NotFoundException);

    const otherDevice = listed.items.find((device) => !device.current);
    expect(otherDevice).toBeDefined();
    const revokeMetadata = { ...metadata(), idempotencyKey: 'own-device-revoke-command' };
    const revoked = await authentication.revokeDevice(
      principal,
      otherDevice?.id,
      revokeMetadata,
    );
    expect(revoked).toEqual({
      deviceId: otherDevice?.id,
      requiresReauthentication: false,
      revoked: true,
    });
    await expect(authentication.revokeDevice(
      principal,
      otherDevice?.id,
      revokeMetadata,
    )).resolves.toEqual(revoked);
    const revokeEvents = await database.query<{ count: string }>(`
      select count(*)::text as count from outbox_events
      where event_type = 'CustomerDeviceRevoked'
        and payload_json->>'deviceId' = '${otherDevice?.id}'
    `);
    expect(revokeEvents.rows[0]?.count).toBe('1');

    const otherSession = await authentication.login(tenantA, {
      deviceLabel: 'Password change secondary',
      devicePlatform: 'h5',
      identifier: 'viewer_one',
      password: 'correct horse battery staple',
    }, metadata());
    await expect(authentication.changePassword(principal, {
      currentPassword: 'wrong current password',
      newPassword: 'new secure customer password',
    }, metadata())).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(authentication.authenticateAccess(
      tenantA,
      otherSession.accessToken,
    )).resolves.toMatchObject({ accountId });

    await expect(authentication.changePassword(principal, {
      currentPassword: 'correct horse battery staple',
      newPassword: 'new secure customer password',
    }, metadata())).resolves.toEqual({ changed: true, otherSessionsRevoked: true });
    await expect(authentication.authenticateAccess(
      tenantA,
      otherSession.accessToken,
    )).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(authentication.authenticateAccess(
      tenantA,
      activeSession.accessToken,
    )).resolves.toMatchObject({ accountId });

    const currentRevoked = await authentication.revokeDevice(
      principal,
      principal.deviceId,
      { ...metadata(), idempotencyKey: 'current-device-revoke-command' },
    );
    expect(currentRevoked.requiresReauthentication).toBe(true);
    await expect(authentication.authenticateAccess(
      tenantA,
      activeSession.accessToken,
    )).rejects.toBeInstanceOf(UnauthorizedException);

    const safeFacts = await database.query<{ after_json: unknown; payload_json: unknown }>(`
      select audit.after_json, event.payload_json
      from audit_logs as audit
      inner join outbox_events as event
        on event.aggregate_id = audit.resource_id
      where audit.action = 'customer.account.password_change'
        and audit.resource_id = '${accountId}'
        and event.event_type = 'CustomerPasswordChanged'
      limit 1
    `);
    expect(JSON.stringify(safeFacts.rows[0])).not.toMatch(
      /correct horse|new secure|password_hash|viewer@example|\+8190/,
    );
  });

  it('resets passwords with a purpose-bound one-use grant without account enumeration', async () => {
    const unknownChallenge = await otp.createChallenge(tenantA, {
      channel: 'email',
      destination: 'unknown-reset@example.com',
      purpose: 'password_reset',
    }, metadata());
    const unknownGrant = await otp.verifyChallenge(tenantA, {
      challengeId: unknownChallenge.challengeId,
      channel: 'email',
      code: unknownChallenge.developmentCode ?? '',
      destination: 'unknown-reset@example.com',
      purpose: 'password_reset',
    }, metadata());
    expect(unknownGrant.verificationToken).toMatch(/^prg_/);
    await expect(authentication.resetPassword(tenantA, {
      channel: 'email',
      destination: 'unknown-reset@example.com',
      newPassword: 'unknown account new password',
      verificationToken: unknownGrant.verificationToken,
    }, metadata())).rejects.toThrow(/invalid or expired/);

    const registrationChallenge = await otp.createChallenge(tenantA, {
      channel: 'email',
      destination: 'cross-purpose@example.com',
      purpose: 'verify_email',
    }, metadata());
    const registrationGrant = await otp.verifyChallenge(tenantA, {
      challengeId: registrationChallenge.challengeId,
      channel: 'email',
      code: registrationChallenge.developmentCode ?? '',
      destination: 'cross-purpose@example.com',
      purpose: 'verify_email',
    }, metadata());
    expect(registrationGrant.verificationToken).toMatch(/^cvg_/);
    await expect(authentication.resetPassword(tenantA, {
      channel: 'email',
      destination: 'viewer@example.com',
      newPassword: 'cross purpose reset password',
      verificationToken: registrationGrant.verificationToken,
    }, metadata())).rejects.toThrow(/invalid or expired/);

    const expiredChallenge = await otp.createChallenge(tenantA, {
      channel: 'email',
      destination: 'viewer@example.com',
      purpose: 'password_reset',
    }, metadata());
    const expiredGrant = await otp.verifyChallenge(tenantA, {
      challengeId: expiredChallenge.challengeId,
      channel: 'email',
      code: expiredChallenge.developmentCode ?? '',
      destination: 'viewer@example.com',
      purpose: 'password_reset',
    }, metadata());
    await database.exec(`
      update customer_otp_challenges
      set verification_grant_expires_at = consumed_at + interval '1 millisecond'
      where id = '${expiredChallenge.challengeId}'
    `);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    await expect(authentication.resetPassword(tenantA, {
      channel: 'email',
      destination: 'viewer@example.com',
      newPassword: 'expired grant reset password',
      verificationToken: expiredGrant.verificationToken,
    }, metadata())).rejects.toThrow(/invalid or expired/);

    const realChallenge = await otp.createChallenge(tenantA, {
      channel: 'email',
      destination: 'viewer@example.com',
      purpose: 'password_reset',
    }, metadata());
    const realGrant = await otp.verifyChallenge(tenantA, {
      challengeId: realChallenge.challengeId,
      channel: 'email',
      code: realChallenge.developmentCode ?? '',
      destination: 'viewer@example.com',
      purpose: 'password_reset',
    }, metadata());
    expect(Object.keys(realGrant).sort()).toEqual(Object.keys(unknownGrant).sort());
    await expect(authentication.resetPassword(tenantB, {
      channel: 'email',
      destination: 'viewer@example.com',
      newPassword: 'cross tenant reset password',
      verificationToken: realGrant.verificationToken,
    }, metadata())).rejects.toThrow(/invalid or expired/);

    const resets = await Promise.allSettled([
      authentication.resetPassword(tenantA, {
        channel: 'email',
        destination: 'viewer@example.com',
        newPassword: 'final reset customer password',
        verificationToken: realGrant.verificationToken,
      }, metadata()),
      authentication.resetPassword(tenantA, {
        channel: 'email',
        destination: 'viewer@example.com',
        newPassword: 'second concurrent reset password',
        verificationToken: realGrant.verificationToken,
      }, metadata()),
    ]);
    expect(resets.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(resets.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(authentication.login(tenantA, {
      devicePlatform: 'web',
      identifier: 'viewer_one',
      password: 'new secure customer password',
    }, metadata())).rejects.toBeInstanceOf(UnauthorizedException);
    const winningPassword = resets[0]?.status === 'fulfilled'
      ? 'final reset customer password'
      : 'second concurrent reset password';
    await expect(authentication.login(tenantA, {
      devicePlatform: 'web',
      identifier: 'viewer_one',
      password: winningPassword,
    }, metadata())).resolves.toMatchObject({ principal: { accountId } });

    const resetFacts = await database.query<{
      audit_after: unknown; consumed: boolean; event_payload: unknown;
    }>(`
      select
        challenge.verification_grant_consumed_at is not null as consumed,
        audit.after_json as audit_after,
        event.payload_json as event_payload
      from customer_otp_challenges as challenge
      inner join audit_logs as audit
        on audit.action = 'customer.account.password_reset'
        and audit.resource_id = '${accountId}'
      inner join outbox_events as event
        on event.event_type = 'CustomerPasswordReset'
        and event.aggregate_id = '${accountId}'
      where challenge.id = '${realChallenge.challengeId}'
      limit 1
    `);
    expect(resetFacts.rows[0]?.consumed).toBe(true);
    expect(JSON.stringify(resetFacts.rows[0])).not.toMatch(
      /viewer@example|final reset|second concurrent|password_hash|prg_/,
    );
  });

  it('enforces user_site_enabled in every customer DB path while allowing safe exit', async () => {
    const closureAccount = await authentication.register(tenantA, {
      password: 'correct horse battery staple',
      ...legalRegistration(tenantA),
      username: 'closure_account',
    }, metadata());
    const closureSession = await authentication.login(tenantA, {
      devicePlatform: 'ios',
      identifier: 'closure_account',
      password: 'correct horse battery staple',
    }, metadata());
    const closurePrincipal = await authentication.authenticateAccess(
      tenantA,
      closureSession.accessToken,
    );
    expect(closurePrincipal.accountId).toBe(closureAccount.accountId);
    const closurePushTokenId = uuidV7();
    await database.exec(`
      insert into customer_push_tokens (
        id, tenant_id, account_id, device_id, platform, token_ciphertext,
        token_digest, token_sha256, key_version
      ) values (
        '${closurePushTokenId}', '${tenantA}', '${closureAccount.accountId}',
        '${closurePrincipal.deviceId}', 'ios', '${'x'.repeat(64)}',
        'hmac-sha256.1.${'g'.repeat(43)}', '${'1'.repeat(64)}', 1
      )
    `);

    const pendingChallenge = await otp.createChallenge(tenantA, {
      channel: 'email',
      destination: 'closed-site@example.com',
      purpose: 'verify_email',
    }, metadata());
    await database.exec(`
      update tenants set user_site_enabled = false where id = '${tenantA}'
    `);
    try {
      await expect(authentication.register(tenantA, {
        password: 'correct horse battery staple',
        ...legalRegistration(tenantA),
        username: 'closed_registration',
      }, metadata())).rejects.toBeInstanceOf(ForbiddenException);
      await expect(authentication.login(tenantA, {
        devicePlatform: 'web',
        identifier: 'closure_account',
        password: 'correct horse battery staple',
      }, metadata())).rejects.toBeInstanceOf(ForbiddenException);
      await expect(authentication.refresh(
        tenantA,
        closureSession.refreshToken,
        metadata(),
      )).rejects.toBeInstanceOf(ForbiddenException);
      await expect(authentication.authenticateAccess(
        tenantA,
        closureSession.accessToken,
      )).rejects.toBeInstanceOf(ForbiddenException);
      await expect(otp.createChallenge(tenantA, {
        channel: 'phone',
        destination: '+819012345679',
        purpose: 'verify_phone',
      }, metadata())).rejects.toBeInstanceOf(ForbiddenException);
      await expect(otp.verifyChallenge(tenantA, {
        challengeId: pendingChallenge.challengeId,
        channel: 'email',
        code: pendingChallenge.developmentCode ?? '',
        destination: 'closed-site@example.com',
        purpose: 'verify_email',
      }, metadata())).rejects.toBeInstanceOf(ForbiddenException);

      const securityChallenge = await otp.createChallenge(tenantA, {
        channel: 'email',
        destination: 'closed-site-reset@example.com',
        purpose: 'password_reset',
      }, metadata());
      const securityGrant = await otp.verifyChallenge(tenantA, {
        challengeId: securityChallenge.challengeId,
        channel: 'email',
        code: securityChallenge.developmentCode ?? '',
        destination: 'closed-site-reset@example.com',
        purpose: 'password_reset',
      }, metadata());
      await expect(authentication.resetPassword(tenantA, {
        channel: 'email',
        destination: 'closed-site-reset@example.com',
        newPassword: 'closed site security reset',
        verificationToken: securityGrant.verificationToken,
      }, metadata())).rejects.toBeInstanceOf(BadRequestException);

      for (const operation of [
        () => playback.upsertProgress(closurePrincipal, {
          dramaId: tenantDramaId,
          episodeId: tenantEpisodeId,
          positionSeconds: 1,
        }),
        () => playback.listHistory(closurePrincipal, 1, 20),
        () => playback.listFavorites(closurePrincipal, 1, 20),
        () => playback.addFavorite(closurePrincipal, tenantDramaId, uuidV7()),
        () => playback.removeFavorite(closurePrincipal, tenantDramaId, uuidV7()),
      ]) {
        await expect(operation()).rejects.toBeInstanceOf(ForbiddenException);
      }

      await expect(authentication.authenticateAccessForAccountClosure(
        tenantA,
        closureSession.accessToken,
      )).resolves.toMatchObject({ accountId: closureAccount.accountId });
      await expect(authentication.disableOwnAccount(
        closurePrincipal,
        'closed site account removal',
        metadata(),
      )).resolves.toEqual({ disabled: true });
      const disabledFacts = await database.query<{
        account_status: string;
        audit_after: unknown;
        device_status: string;
        event_payload: unknown;
        push_status: string;
        username: string;
      }>(`
        select
          account.status as account_status,
          account.username::text as username,
          device.status as device_status,
          push.status as push_status,
          audit.after_json as audit_after,
          event.payload_json as event_payload
        from customer_accounts as account
        inner join customer_devices as device
          on device.account_id = account.id and device.tenant_id = account.tenant_id
        inner join customer_push_tokens as push
          on push.device_id = device.id and push.tenant_id = device.tenant_id
        inner join audit_logs as audit
          on audit.resource_id = account.id and audit.action = 'customer.account.disable'
        inner join outbox_events as event
          on event.aggregate_id = account.id and event.event_type = 'CustomerAccountDisabled'
        where account.id = '${closureAccount.accountId}'
          and device.id = '${closurePrincipal.deviceId}'
          and push.id = '${closurePushTokenId}'
        limit 1
      `);
      expect(disabledFacts.rows[0]).toMatchObject({
        account_status: 'disabled',
        device_status: 'revoked',
        push_status: 'revoked',
        username: 'closure_account',
      });
      expect(disabledFacts.rows[0]?.audit_after).toMatchObject({
        dataErasurePerformed: false,
        disabled: true,
      });
      expect(JSON.stringify(disabledFacts.rows[0])).not.toMatch(
        /correct horse|password_hash|token_ciphertext/,
      );
      await expect(authentication.logout(
        tenantA,
        closureSession.refreshToken,
      )).resolves.toBeUndefined();
    } finally {
      await database.exec(`
        update tenants set user_site_enabled = true where id = '${tenantA}'
      `);
    }
  });

  it('forces tenant RLS for every customer table under a non-owner role', async () => {
    const customerTables = [
      'customer_accounts',
      'customer_devices',
      'customer_favorites',
      'customer_otp_challenges',
      'customer_refresh_token_history',
      'customer_sessions',
      'watch_progress',
    ];
    const list = customerTables.map((table) => `'${table}'`).join(',');
    const rls = await database.query<{
      forced: boolean;
      row_security: boolean;
      table_name: string;
    }>(`
      select
        relation.relname as table_name,
        relation.relrowsecurity as row_security,
        relation.relforcerowsecurity as forced
      from pg_class as relation
      inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
      where namespace.nspname = 'public'
        and relation.relname = any(array[${list}])
      order by relation.relname
    `);
    expect(rls.rows).toHaveLength(customerTables.length);
    expect(rls.rows.every((table) => table.row_security && table.forced)).toBe(true);

    await database.exec(`
      create role customer_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to customer_tenant_probe;
      grant select, insert on customer_accounts to customer_tenant_probe;
      set role customer_tenant_probe;
      begin;
      set local app.tenant_id = '${tenantA}'
    `);
    const visible = await database.query<{ username: string }>(`
      select username::text from customer_accounts order by username
    `);
    expect(visible.rows).toEqual([
      { username: 'closure_account' },
      { username: 'viewer_one' },
      { username: 'viewer_two' },
    ]);
    await expect(database.exec(`
      insert into customer_accounts (
        id, tenant_id, username, password_hash
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e7735731ff', '${tenantB}',
        'cross_tenant_user', '${'y'.repeat(64)}'
      )
    `)).rejects.toThrow();
    await database.exec('rollback; reset role');
  });
});

async function grantEntitlement(
  grantAccountId: string,
  entitlementType: 'drama' | 'episode' | 'membership',
  productId: string,
  startsOffset: string,
  expiresOffset: string,
): Promise<string> {
  const orderId = uuidV7();
  const itemId = uuidV7();
  const attemptId = uuidV7();
  const entitlementId = uuidV7();
  const transactionId = uuidV7();
  const orderNo = `ORD${orderId.replaceAll('-', '').slice(0, 26).toUpperCase()}`;
  await database.exec(`
    insert into orders (
      id, tenant_id, account_id, order_no, order_type, currency,
      subtotal_minor, total_minor, locale, customer_snapshot_json, expires_at
    ) values (
      '${orderId}', '${tenantA}', '${grantAccountId}', '${orderNo}',
      '${entitlementType}', 'USD', 199, 199, 'en-US', '{}'::jsonb,
      statement_timestamp() + interval '1 day'
    );
    insert into order_items (
      id, tenant_id, order_id, line_no, item_type, product_id, currency,
      unit_amount_minor, total_amount_minor, product_snapshot_json
    ) values (
      '${itemId}', '${tenantA}', '${orderId}', 1, '${entitlementType}',
      '${productId}', 'USD', 199, 199, '{}'::jsonb
    );
    insert into payment_attempts (
      id, tenant_id, account_id, order_id, provider_id, payment_config_id,
      adapter_code_snapshot, collection_mode, status, currency, amount_minor,
      idempotency_key
    ) values (
      '${attemptId}', '${tenantA}', '${grantAccountId}', '${orderId}',
      '${paymentProviderId}', '${paymentConfigId}', 'fake', 'platform_collect',
      'pending', 'USD', 199, 'playback-${attemptId}'
    );
    insert into payment_transactions (
      id, tenant_id, attempt_id, order_id, provider_id, transaction_type,
      status, external_transaction_id, currency, amount_minor, payload_hash,
      occurred_at
    ) values (
      '${transactionId}', '${tenantA}', '${attemptId}', '${orderId}',
      '${paymentProviderId}', 'charge', 'succeeded', 'charge-${transactionId}',
      'USD', 199, '${'c'.repeat(64)}', statement_timestamp()
    );
    update payment_attempts
    set status = 'succeeded', succeeded_at = statement_timestamp(), version = version + 1
    where id = '${attemptId}';
    update orders
    set status = 'paid', paid_at = statement_timestamp(), version = version + 1
    where id = '${orderId}';
    insert into entitlements (
      id, tenant_id, account_id, entitlement_type, product_id,
      source_order_id, source_order_item_id, starts_at, expires_at
    ) values (
      '${entitlementId}', '${tenantA}', '${grantAccountId}', '${entitlementType}',
      '${productId}', '${orderId}', '${itemId}',
      statement_timestamp() + interval '${startsOffset}',
      statement_timestamp() + interval '${expiresOffset}'
    )
  `);
  return entitlementId;
}

async function revokeEntitlement(entitlementId: string): Promise<void> {
  await database.exec(`
    update entitlements
    set revoked_at = statement_timestamp(), revoked_reason = 'playback access test'
    where id = '${entitlementId}'
  `);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function legalRegistration(tenantId: string) {
  const documents = tenantId === tenantA
    ? [privacyDocumentA, termsDocumentA]
    : [privacyDocumentB, termsDocumentB];
  return {
    legalConsents: documents.map((documentId) => ({ documentId, version: 1 })),
    legalLocale: 'en-US',
  };
}

async function playbackUrlSideEffectFacts(): Promise<{ audits: string; outbox: string }> {
  const result = await database.query<{ audits: string; outbox: string }>(`
    select
      (select count(*)::text from audit_logs) as audits,
      (select count(*)::text from outbox_events) as outbox
  `);
  return result.rows[0] as { audits: string; outbox: string };
}
