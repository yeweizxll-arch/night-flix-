import { GoneException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../database/database.service';
import { MediaService } from './media.service';

const TENANT_ID = '018f2f48-6a9d-7b23-8c4d-1234567890ab';
const metadata = {
  actorId: '018f2f48-6a9d-7b23-8c4d-1234567890ae',
  requestId: '018f2f48-6a9d-7b23-8c4d-1234567890af',
};

function service() {
  const database = { inTenantContext: vi.fn() } as unknown as DatabaseService;
  return { database, media: new MediaService(database) };
}

describe('MediaService external URL retirement boundary', () => {
  it.each([
    'http://cdn.example.com/video.mp4',
    'https://localhost/video.mp4',
    'https://127.0.0.1/video.mp4',
    'https://100.64.0.1/video.mp4',
    'https://192.168.1.10/video.mp4',
    'https://[::1]/video.mp4',
    'https://[::ffff:127.0.0.1]/video.mp4',
    'https://[fec0::1]/video.mp4',
    'https://[ff02::1]/video.mp4',
  ])('returns a stable gone response for retired URL %s', async (sourceUrl) => {
    const { database, media } = service();
    await expect(media.registerExternal(TENANT_ID, {
      kind: 'video',
      sourceUrl,
    }, metadata)).rejects.toBeInstanceOf(GoneException);
    expect(database.inTenantContext).not.toHaveBeenCalled();
  });

  it('does not create pending rows for otherwise valid URLs', async () => {
    const { media } = service();
    await expect(media.registerExternal(TENANT_ID, {
      kind: 'image',
      mimeType: 'video/mp4',
      sourceUrl: 'https://cdn.example.com/cover.jpg',
    }, metadata)).rejects.toMatchObject({
      response: { code: 'EXTERNAL_MEDIA_INGESTION_UNAVAILABLE' },
    });
  });
});
