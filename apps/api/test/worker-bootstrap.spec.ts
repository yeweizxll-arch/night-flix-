import { Test, type TestingModule } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { PrivacyErasureWorkerService } from '../src/privacy/privacy-erasure-worker.service';
import { WorkerModule } from '../src/workers/worker.module';

describe('worker dependency graph', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    await moduleRef?.close();
  });

  it('loads the privacy erasure worker in the production worker module', async () => {
    moduleRef = await Test.createTestingModule({ imports: [WorkerModule] }).compile();

    expect(moduleRef.get(PrivacyErasureWorkerService, { strict: false }))
      .toBeInstanceOf(PrivacyErasureWorkerService);
  });
});
