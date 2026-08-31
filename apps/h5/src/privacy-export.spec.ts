import { describe, expect, it, vi } from 'vitest';

import type { CustomerRequestInit } from './api/client';
import type { PrivacyExportPage } from './api/types';
import { collectPrivacyExport } from './privacy-export';

describe('privacy export collection', () => {
  it('follows the opaque cursor with no-store and re-verifies the password on every page', async () => {
    const calls: CustomerRequestInit[] = [];
    const pages: PrivacyExportPage[] = [
      { exportedAt: '2030-01-01T00:00:00Z', items: [{ id: 1 }], nextCursor: 'cursor-two', notice: 'safe', section: 'orders' },
      { exportedAt: '2030-01-01T00:00:01Z', items: [{ id: 2 }], notice: 'safe', section: 'orders' },
    ];
    const request = vi.fn(async (_path: string, init?: CustomerRequestInit) => {
      calls.push(init ?? {});
      return pages.shift()!;
    });
    await expect(collectPrivacyExport({ request: request as never }, 'orders', 'current password'))
      .resolves.toMatchObject({ items: [{ id: 1 }, { id: 2 }], section: 'orders' });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.cache === 'no-store')).toBe(true);
    expect(calls.map((call) => call.json)).toEqual([
      { currentPassword: 'current password', pageSize: 100, section: 'orders' },
      { currentPassword: 'current password', cursor: 'cursor-two', pageSize: 100, section: 'orders' },
    ]);
  });

  it('rejects a repeated cursor instead of looping forever', async () => {
    const request = vi.fn(async () => ({
      exportedAt: '2030-01-01T00:00:00Z', items: [], nextCursor: 'same', notice: 'safe', section: 'profile',
    }));
    await expect(collectPrivacyExport({ request: request as never }, 'profile', 'password'))
      .rejects.toThrow('cursor repeated');
  });
});
