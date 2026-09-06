import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService, DatabaseTransaction } from '../database/database.service';
import type { S3CompatibleStorageAdapter } from '../storage/s3-compatible.adapter';
import type { StorageCredentialCipher } from '../storage/storage-credentials';
import type { CustomerAssetRateLimiterService } from './customer-asset-rate-limiter.service';
import { CustomerAssetService } from './customer-asset.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const mediaId = '22222222-2222-4222-8222-222222222222';
const providerId = '33333333-3333-4333-8333-333333333333';
const secureAsset = {
  bucket: 'customer-media',
  credential_ciphertext: 'encrypted-placeholder',
  endpoint: 'https://s3.example.test',
  key_version: 4,
  object_key: 'tenant/customer/logo.png',
  owner_tenant_id: tenantId,
  owner_type: 'tenant' as const,
  provider_id: providerId,
};
const credentials = {
  accessKeyId: 'access-key',
  region: 'us-east-1',
  secretAccessKey: 'secret-key-never-return',
};

describe('CustomerAssetService', () => {
  it('signs an authorized branding image under share locks and returns no storage metadata', async () => {
    const fixture = serviceFixture();
    const result = await fixture.service.issue(tenantId, mediaId, {}, '203.0.113.8');
    expect(fixture.cipher.decrypt).toHaveBeenCalledWith(
      secureAsset.credential_ciphertext,
      {
        keyVersion: 4,
        ownerTenantId: tenantId,
        ownerType: 'tenant',
        providerId,
      },
    );
    expect(fixture.storage.presignGetObject).toHaveBeenCalledWith({
      credentials,
      expiresInSeconds: 180,
      objectKey: secureAsset.object_key,
      target: { bucket: secureAsset.bucket, endpoint: secureAsset.endpoint },
    });
    expect(result).toEqual({
      expiresAt: expect.any(String),
      mediaAssetId: mediaId,
      url: 'https://signed.example.test/image?X-Amz-Expires=180',
    });
    expect(JSON.stringify(result)).not.toMatch(/object_key|credential|provider|secret-key/);
    expect(fixture.sql.join('\n')).toContain('for share');
    expect(fixture.sql.join('\n')).toContain("app.lock_customer_row('media_assets', media.id");
    expect(fixture.sql.join('\n')).toContain("app.lock_customer_row('storage_providers', provider.id");
  });

  it('keeps the transaction open while local signing blocks provider disable or rotation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = serviceFixture({ signingGate: gate });
    let finished = false;
    const issuing = fixture.service.issue(tenantId, mediaId, {}, '203.0.113.8')
      .finally(() => { finished = true; });
    await vi.waitFor(() => expect(fixture.storage.presignGetObject).toHaveBeenCalledOnce());
    expect(finished).toBe(false);
    release();
    await issuing;
    expect(finished).toBe(true);
  });

  it('does not decrypt or sign an arbitrary non-branding and non-cover image', async () => {
    const fixture = serviceFixture({ branding: false, coverRows: [] });
    await expect(fixture.service.issue(tenantId, mediaId, {}, '203.0.113.8'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(fixture.cipher.decrypt).not.toHaveBeenCalled();
    expect(fixture.storage.presignGetObject).not.toHaveBeenCalled();
  });

  it('turns cipher and adapter details into a fixed secret-free failure', async () => {
    const fixture = serviceFixture({ adapterError: new Error('token=secret&bucket=private') });
    const error = await fixture.service.issue(tenantId, mediaId, {}, '203.0.113.8')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as ServiceUnavailableException).getResponse()).toEqual({
      code: 'CUSTOMER_ASSET_SIGNING_UNAVAILABLE',
      message: 'Customer image access is temporarily unavailable',
    });
    expect(JSON.stringify((error as ServiceUnavailableException).getResponse()))
      .not.toMatch(/token|bucket|private|secret/);
  });

  it.each([
    ['bad-id', mediaId, {}, '203.0.113.8'],
    [tenantId, 'bad-id', {}, '203.0.113.8'],
    [tenantId, mediaId, { expiresInSeconds: '900' }, '203.0.113.8'],
    [tenantId, mediaId, {}, 'bad ip'],
  ])('rejects invalid public input before rate or database work', async (
    invalidTenant,
    invalidMedia,
    query,
    ip,
  ) => {
    const fixture = serviceFixture();
    await expect(fixture.service.issue(invalidTenant, invalidMedia, query, ip))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(fixture.rateLimiter.consume).not.toHaveBeenCalled();
    expect(fixture.database.inTenantContext).not.toHaveBeenCalled();
  });
});

function serviceFixture(options: {
  adapterError?: Error;
  assetRows?: typeof secureAsset[];
  branding?: boolean;
  coverRows?: Array<{ id: string; owner_type: 'platform' | 'tenant' }>;
  signingGate?: Promise<void>;
} = {}) {
  const sql: string[] = [];
  const transaction = vi.fn(async (strings: TemplateStringsArray) => {
    const statement = strings.join(' ').replace(/\s+/g, ' ').trim();
    sql.push(statement);
    if (statement.includes('select logo_media_asset_id')) {
      return [{
        icon_media_asset_id: null,
        logo_media_asset_id: options.branding === false ? null : mediaId,
      }];
    }
    if (statement.includes('select drama.id')) return options.coverRows ?? [];
    if (statement.includes('select provider.id')) return options.assetRows ?? [secureAsset];
    return [];
  }) as unknown as DatabaseTransaction;
  Object.assign(transaction, { json: (value: unknown) => value });
  const database = {
    inTenantContext: vi.fn(async (_tenant: string, callback: (
      transaction: DatabaseTransaction,
    ) => Promise<unknown>) => callback(transaction)),
  };
  const cipher = { decrypt: vi.fn(() => credentials) };
  const storage = {
    headObject: vi.fn(),
    presignConditionalPut: vi.fn(),
    presignGetObject: options.adapterError
      ? vi.fn(async () => { throw options.adapterError; })
      : vi.fn(async () => {
          if (options.signingGate) await options.signingGate;
          return {
            cacheControl: 'private, no-store, max-age=0' as const,
            contentDisposition: 'inline' as const,
            expiresAt: new Date(Date.now() + 180_000),
            url: 'https://signed.example.test/image?X-Amz-Expires=180',
          };
        }),
  };
  const rateLimiter = { consume: vi.fn(async () => undefined) };
  return {
    cipher,
    database,
    rateLimiter,
    service: new CustomerAssetService(
      database as unknown as DatabaseService,
      cipher as unknown as StorageCredentialCipher,
      storage as unknown as S3CompatibleStorageAdapter,
      rateLimiter as unknown as CustomerAssetRateLimiterService,
    ),
    sql,
    storage,
  };
}
