import { BadRequestException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../database/database.service';
import { MerchantService } from './merchant.service';

const metadata = {
  actorId: '018f2f45-7f5e-7e70-b17f-f6e77357c004',
  requestId: '018f2f45-7f5e-7e70-b17f-f6e77357c005',
};

describe('MerchantService input boundary', () => {
  it('rejects malformed or oversized merchant searches without querying storage', async () => {
    const database = { inPlatformContext: vi.fn() };
    const service = new MerchantService(database as unknown as DatabaseService);
    for (const query of [[], {}, 12, 'a'.repeat(101)]) {
      await expect(service.list(1, 30, query)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(database.inPlatformContext).not.toHaveBeenCalled();
  });
  it('binds search text as parameters in both merchant rows and total queries', async () => {
    const transaction = vi.fn(async () => []);
    const service = new MerchantService({ inPlatformContext: (run: (value: unknown) => unknown) => run(transaction) } as unknown as DatabaseService);
    const query = "' OR 1=1 --";
    await service.list(1, 30, query);
    expect(transaction).toHaveBeenCalledTimes(2);
    for (const [strings, ...values] of transaction.mock.calls as unknown as [TemplateStringsArray, ...unknown[]][]) {
      expect(strings.join('')).not.toContain(query);
      expect(values).toContain(query);
    }
  });
  it('rejects a missing owner object before touching storage', async () => {
    const database = { inPlatformContext: vi.fn() };
    const service = new MerchantService(database as unknown as DatabaseService);

    await expect(
      service.create(
        {
          code: 'merchant-a',
          defaultCurrency: 'USD',
          defaultLocale: 'en-US',
          expiresAt: '2030-01-01T00:00:00.000Z',
          name: 'Merchant A',
          owner: undefined,
          timezone: 'Asia/Tokyo',
        } as never,
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.inPlatformContext).not.toHaveBeenCalled();
  });

  it('rejects unsafe runtime types and weak owner passwords', async () => {
    const database = { inPlatformContext: vi.fn() };
    const service = new MerchantService(database as unknown as DatabaseService);
    const baseInput = {
      code: 'merchant-a',
      defaultCurrency: 'USD',
      defaultLocale: 'en-US',
      expiresAt: '2030-01-01T00:00:00.000Z',
      name: 'Merchant A',
      owner: { password: 'short', username: 'owner' },
      timezone: 'Asia/Tokyo',
    };

    await expect(service.create(baseInput, metadata)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      service.create({ ...baseInput, code: 123 } as never, metadata),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.inPlatformContext).not.toHaveBeenCalled();
  });

  it('rejects malformed IDs and update bodies before storage', async () => {
    const database = { inPlatformContext: vi.fn() };
    const service = new MerchantService(database as unknown as DatabaseService);

    await expect(
      service.update('not-an-id', { reason: 'test', version: 0 }, metadata),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.update(
        '018f2f45-7f5e-7e70-b17f-f6e77357c004',
        { name: 'Changed', reason: 123, version: 0 } as never,
        metadata,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(database.inPlatformContext).not.toHaveBeenCalled();
  });
});
