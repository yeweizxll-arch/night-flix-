import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../database/database.service';
import { ContentService } from './content.service';

const TENANT_ID = '018f2f48-6a9d-7b23-8c4d-1234567890ab';
const DRAMA_ID = '018f2f48-6a9d-7b23-8c4d-1234567890ac';
const MEDIA_ID = '018f2f48-6a9d-7b23-8c4d-1234567890ad';
const metadata = {
  actorId: '018f2f48-6a9d-7b23-8c4d-1234567890ae',
  requestId: '018f2f48-6a9d-7b23-8c4d-1234567890af',
};

function service() {
  const database = {
    inPlatformContext: vi.fn(),
    inTenantContext: vi.fn(),
  } as unknown as DatabaseService;
  return { content: new ContentService(database), database };
}

describe('ContentService input boundary', () => {
  it('rejects a drama without a supported unique translation', async () => {
    const { content, database } = service();

    await expect(content.createTenantDrama(TENANT_ID, {
      code: 'my-drama',
      translations: [],
    }, metadata)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.inTenantContext).not.toHaveBeenCalled();
  });

  it('rejects an invalid publication interval before opening a transaction', async () => {
    const { content, database } = service();

    await expect(content.createTenantDrama(TENANT_ID, {
      code: 'my-drama',
      releaseAt: '2026-08-22T00:00:00.000Z',
      translations: [{ locale: 'en-US', title: 'Drama' }],
      unpublishAt: '2026-08-21T00:00:00.000Z',
    }, metadata)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.inTenantContext).not.toHaveBeenCalled();
  });

  it('rejects preview time longer than the episode', async () => {
    const { content, database } = service();

    await expect(content.addTenantEpisode(TENANT_ID, DRAMA_ID, {
      durationSeconds: 60,
      episodeNo: 1,
      expectedDramaVersion: 0,
      mediaAssetId: MEDIA_ID,
      previewSeconds: 61,
      translations: [{ locale: 'en-US', title: 'Episode 1' }],
    }, metadata)).rejects.toBeInstanceOf(BadRequestException);
    expect(database.inTenantContext).not.toHaveBeenCalled();
  });

  it('requires a reason when a platform reviewer rejects content', async () => {
    const { content, database } = service();

    await expect(content.decidePlatformReview(
      DRAMA_ID,
      'reject',
      { version: 0 },
      metadata,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.inPlatformContext).not.toHaveBeenCalled();
  });

  it('rejects an empty soft-delete reason', async () => {
    const { content, database } = service();

    await expect(content.softDeleteTenantDrama(
      TENANT_ID,
      DRAMA_ID,
      { expectedVersion: 0, reason: ' ' },
      metadata,
    )).rejects.toBeInstanceOf(BadRequestException);
    expect(database.inTenantContext).not.toHaveBeenCalled();
  });
});
