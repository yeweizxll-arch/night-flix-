import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import type { DatabaseService, DatabaseTransaction } from '../database/database.service';
import type { S3CompatibleStorageAdapter } from '../storage/s3-compatible.adapter';
import type { StorageCredentialCipher } from '../storage/storage-credentials';
import type { CustomerPlaybackAccessService } from './customer-playback-access.service';
import { CustomerPlaybackUrlService } from './customer-playback-url.service';
import type { PlaybackUrlRateLimiterService } from './playback-url-rate-limiter.service';

const tenantId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';
const episodeId = '33333333-3333-4333-8333-333333333333';
const dramaId = '44444444-4444-4444-8444-444444444444';
const mediaAssetId = '55555555-5555-4555-8555-555555555555';
const previewMediaAssetId = '99999999-9999-4999-8999-999999999999';
const trackId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const providerId = '66666666-6666-4666-8666-666666666666';
const principal: CustomerPrincipal = {
  accountId,
  deviceId: '77777777-7777-4777-8777-777777777777',
  sessionId: '88888888-8888-4888-8888-888888888888',
  tenantId,
  username: 'viewer',
};

const fullAccess = {
  access: 'full' as const,
  dramaId,
  durationSeconds: 120,
  episodeId,
  mediaAssetId,
  previewSeconds: 15,
};
const asset = {
  bucket: 'media',
  credential_ciphertext: 'enc-v1:ciphertext',
  endpoint: 'https://s3.example.test',
  key_version: 3,
  object_key: 'opaque/playback.mp4',
  owner_tenant_id: tenantId,
  owner_type: 'tenant' as const,
  provider_id: providerId,
};
const credentials = {
  accessKeyId: 'access-key',
  region: 'us-east-1',
  secretAccessKey: 'never-return-this-secret',
};

describe('CustomerPlaybackUrlService', () => {
  it('signs only after the unified access decision and returns a minimal secret-free response', async () => {
    const fixture = serviceFixture();
    const response = await fixture.service.issue(principal, episodeId, '180', '203.0.113.10');

    expect(fixture.access.resolveInTransaction).toHaveBeenCalledWith(
      fixture.transaction,
      principal,
      episodeId,
    );
    expect(fixture.cipher.decrypt).toHaveBeenCalledWith(asset.credential_ciphertext, {
      keyVersion: 3,
      ownerTenantId: tenantId,
      ownerType: 'tenant',
      providerId,
    });
    expect(fixture.storage.presignGetObject).toHaveBeenCalledWith({
      credentials,
      expiresInSeconds: 180,
      objectKey: asset.object_key,
      target: { bucket: asset.bucket, endpoint: asset.endpoint },
    });
    expect(response).toEqual({
      access: 'full',
      expiresAt: expect.any(String),
      mediaAssetId,
      offlineSupported: false,
      url: 'https://signed.example.test/playback?X-Amz-Expires=180',
    });
    expect(JSON.stringify(response)).not.toContain(asset.object_key);
    expect(JSON.stringify(response)).not.toContain(credentials.secretAccessKey);
    expect(JSON.stringify(response)).not.toContain(asset.credential_ciphertext);
    expect(fixture.sql.join('\n')).toContain('for share of media, provider');
  });

  it('keeps the provider share lock transaction open through local presigning', async () => {
    let release!: () => void;
    const signingGate = new Promise<void>((resolve) => { release = resolve; });
    const fixture = serviceFixture({ signingGate });
    let finished = false;
    const issued = fixture.service.issue(principal, episodeId, 180, '203.0.113.10')
      .finally(() => { finished = true; });

    await vi.waitFor(() => expect(fixture.storage.presignGetObject).toHaveBeenCalledOnce());
    expect(fixture.database.inTenantContext).toHaveBeenCalledOnce();
    expect(finished).toBe(false);
    release();
    await issued;
    expect(finished).toBe(true);
  });

  it('explicitly rejects preview without querying or signing the full media object', async () => {
    const fixture = serviceFixture({
      accessResult: { ...fullAccess, access: 'preview' },
    });
    await expect(fixture.service.issue(principal, episodeId, undefined, '203.0.113.10'))
      .rejects.toMatchObject({
        response: expect.objectContaining({
          access: 'preview',
          code: 'PREVIEW_PLAYBACK_ASSET_UNAVAILABLE',
          previewSeconds: 15,
        }),
      });
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.storage.presignGetObject).not.toHaveBeenCalled();
    expect(fixture.cipher.decrypt).not.toHaveBeenCalled();
  });

  it('signs only the dedicated preview media asset when preview access is granted', async () => {
    const fixture = serviceFixture({
      accessResult: {
        ...fullAccess,
        access: 'preview',
        previewMediaAssetId,
      },
    });
    const response = await fixture.service.issue(
      principal,
      episodeId,
      180,
      '203.0.113.10',
    );

    expect(response).toMatchObject({
      access: 'preview',
      mediaAssetId: previewMediaAssetId,
      previewSeconds: 15,
    });
    expect(fixture.parameters).toContain(previewMediaAssetId);
    expect(fixture.parameters).not.toContain(mediaAssetId);
    expect(fixture.storage.presignGetObject).toHaveBeenCalledOnce();
  });

  it('does not sign external source media or a disabled/cross-scope provider', async () => {
    const fixture = serviceFixture({ assetRows: [] });
    await expect(fixture.service.issue(principal, episodeId, 180, '203.0.113.10'))
      .rejects.toBeInstanceOf(NotFoundException);
    expect(fixture.storage.presignGetObject).not.toHaveBeenCalled();
  });

  it('turns cipher and adapter failures into a fixed non-secret response', async () => {
    const adapterFailure = serviceFixture({ adapterError: new Error('secretAccessKey=leaked') });
    await expect(adapterFailure.service.issue(
      principal,
      episodeId,
      180,
      '203.0.113.10',
    )).rejects.toMatchObject({
      response: {
        code: 'PLAYBACK_SIGNING_UNAVAILABLE',
        message: 'Secure playback is temporarily unavailable',
      },
    });

    const cipherFailure = serviceFixture({ cipherError: new Error('ciphertext and master key') });
    let caught: unknown;
    try {
      await cipherFailure.service.issue(principal, episodeId, 180, '203.0.113.10');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ServiceUnavailableException);
    expect(JSON.stringify((caught as ServiceUnavailableException).getResponse()))
      .not.toMatch(/ciphertext|master key|secretAccessKey/);
  });

  it.each([119, 301, 180.5, '-1', '1e2', {}, null])(
    'rejects invalid expiry %j before consuming rate or touching the database',
    async (expiry) => {
      const fixture = serviceFixture();
      await expect(fixture.service.issue(principal, episodeId, expiry, '203.0.113.10'))
        .rejects.toBeInstanceOf(BadRequestException);
      expect(fixture.rateLimiter.consume).not.toHaveBeenCalled();
      expect(fixture.database.inTenantContext).not.toHaveBeenCalled();
    },
  );

  it('propagates locked access without touching credentials', async () => {
    const fixture = serviceFixture({ accessResult: { ...fullAccess, access: 'locked' } });
    await expect(fixture.service.issue(principal, episodeId, 180, '203.0.113.10'))
      .rejects.toBeInstanceOf(ForbiddenException);
    expect(fixture.cipher.decrypt).not.toHaveBeenCalled();
    expect(fixture.storage.presignGetObject).not.toHaveBeenCalled();
  });

  it('signs an active episode track only after full playback access', async () => {
    const fixture = serviceFixture({
      assetRows: [{ ...asset, label: 'English', locale: 'en', track_type: 'subtitle' }],
    });
    const response = await fixture.service.issueTrack(
      principal, episodeId, trackId, 180, '203.0.113.10',
    );

    expect(fixture.access.resolveInTransaction).toHaveBeenCalledWith(
      fixture.transaction, principal, episodeId,
    );
    expect(response).toMatchObject({
      id: trackId,
      label: 'English',
      locale: 'en',
      offlineSupported: false,
      type: 'subtitle',
      url: expect.stringMatching(/^https:\/\//),
    });
    expect(fixture.sql.join('\n')).toContain('track.episode_id');
    expect(fixture.sql.join('\n')).toContain('for share of track, media, provider');
  });

  it('does not expose subtitle or dubbing tracks to preview access', async () => {
    const fixture = serviceFixture({ accessResult: { ...fullAccess, access: 'preview' } });
    await expect(fixture.service.issueTrack(
      principal, episodeId, trackId, 180, '203.0.113.10',
    )).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'TRACK_ENTITLEMENT_REQUIRED' }),
    });
    expect(fixture.transaction).not.toHaveBeenCalled();
    expect(fixture.storage.presignGetObject).not.toHaveBeenCalled();
  });
});

function serviceFixture(options: {
  accessResult?: typeof fullAccess | { access: 'preview' | 'locked'; dramaId: string;
    durationSeconds: number; episodeId: string; mediaAssetId: string;
    previewMediaAssetId?: string; previewSeconds: number };
  adapterError?: Error;
  assetRows?: Array<typeof asset & { label?: string; locale?: string; track_type?: 'dubbing' | 'subtitle' }>;
  cipherError?: Error;
  signingGate?: Promise<void>;
} = {}) {
  const sql: string[] = [];
  const parameters: unknown[] = [];
  const transaction = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sql.push(strings.join(' ').replace(/\s+/g, ' ').trim());
    parameters.push(...values);
    return options.assetRows ?? [asset];
  }) as unknown as DatabaseTransaction;
  Object.assign(transaction, { json: (value: unknown) => value });
  const database = {
    inTenantContext: vi.fn(async (_tenantId: string, callback: (
      transaction: DatabaseTransaction,
    ) => Promise<unknown>) => callback(transaction)),
  };
  const access = {
    resolveInTransaction: vi.fn(async () => options.accessResult ?? fullAccess),
  };
  const cipher = {
    decrypt: options.cipherError
      ? vi.fn(() => { throw options.cipherError; })
      : vi.fn(() => credentials),
  };
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
          url: 'https://signed.example.test/playback?X-Amz-Expires=180',
        };
      }),
  };
  const rateLimiter = { consume: vi.fn(async () => undefined) };
  return {
    access,
    cipher,
    database,
    parameters,
    rateLimiter,
    service: new CustomerPlaybackUrlService(
      database as unknown as DatabaseService,
      access as unknown as CustomerPlaybackAccessService,
      cipher as unknown as StorageCredentialCipher,
      storage as unknown as S3CompatibleStorageAdapter,
      rateLimiter as unknown as PlaybackUrlRateLimiterService,
    ),
    sql,
    storage,
    transaction,
  };
}
