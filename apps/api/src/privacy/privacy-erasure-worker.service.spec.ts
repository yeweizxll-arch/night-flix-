import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService } from '../database/database.service';
import { PrivacyErasureWorkerService } from './privacy-erasure-worker.service';

const FIRST_REQUEST = '018f2f45-7f5e-7e70-b17f-f6e77357ee01';
const SECOND_REQUEST = '018f2f45-7f5e-7e70-b17f-f6e77357ee02';

describe('PrivacyErasureWorkerService queue handling', () => {
  it('isolates one failed erasure request and continues processing the batch', async () => {
    const transaction = vi.fn(async () => [
      { id: FIRST_REQUEST },
      { id: SECOND_REQUEST },
    ]);
    const database = {
      inPlatformContext: vi.fn(async (callback: (value: unknown) => Promise<unknown>) =>
        callback(transaction)),
    } as unknown as DatabaseService;
    const worker = new PrivacyErasureWorkerService(database);
    const processRequest = vi.spyOn(worker, 'processRequest')
      .mockRejectedValueOnce(new Error('isolated failure'))
      .mockResolvedValueOnce({ dataErasurePerformed: true, status: 'completed' });

    await expect(worker.processDue(10, 'privacy-worker-test')).resolves.toEqual({
      completed: 1,
      failed: 1,
      inspected: 2,
    });
    expect(processRequest).toHaveBeenNthCalledWith(1, FIRST_REQUEST, 'privacy-worker-test');
    expect(processRequest).toHaveBeenNthCalledWith(2, SECOND_REQUEST, 'privacy-worker-test');
  });

  it('does not steal a fresh processing claim from another worker', async () => {
    const freshClaim = {
      account_id: '018f2f45-7f5e-7e70-b17f-f6e77357ee03',
      attempt_count: 1,
      email: null,
      id: FIRST_REQUEST,
      lock_is_stale: false,
      locked_at: new Date(),
      locked_by: 'privacy-worker-one',
      max_attempts: 10,
      phone: null,
      retention_summary_json: [],
      status: 'processing',
      tenant_id: '018f2f45-7f5e-7e70-b17f-f6e77357ee04',
    } as const;
    const transaction = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?').replace(/\s+/g, ' ').trim();
      if (sql.includes('from customer_privacy_requests as request')) return [freshClaim];
      throw new Error(`Unexpected query: ${sql}`);
    });
    const database = {
      inPlatformContext: vi.fn(async (callback: (value: unknown) => Promise<unknown>) =>
        callback(transaction)),
    } as unknown as DatabaseService;
    const worker = new PrivacyErasureWorkerService(database);

    await expect(worker.processRequest(FIRST_REQUEST, 'privacy-worker-two'))
      .resolves.toEqual({ dataErasurePerformed: false, status: 'processing' });
    expect(database.inPlatformContext).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
