import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import type { DatabaseService } from '../database/database.service';
import { CustomerNotificationService } from './customer-notification.service';
import { NotificationSecretCipher } from './notification-secret-cipher';

describe('CustomerNotificationService', () => {
  it('maps a concurrent active token unique race to a stable conflict response', async () => {
    const database = {
      inTenantContext: async () => Promise.reject({
        code: '23505',
        constraint_name: 'customer_push_tokens_sha256_unique_idx',
      }),
    } as unknown as DatabaseService;
    const cipher = new NotificationSecretCipher({
      activeVersion: 1,
      keys: new Map([[1, Buffer.alloc(32, 3)]]),
    });
    const service = new CustomerNotificationService(database, cipher);
    await expect(service.registerPushToken(
      {
        accountId: '01910000-0000-7000-8000-000000000001',
        deviceId: '01910000-0000-7000-8000-000000000002',
        sessionId: '01910000-0000-7000-8000-000000000003',
        tenantId: '01910000-0000-7000-8000-000000000004',
        username: 'viewer',
      },
      {
        deviceId: '01910000-0000-7000-8000-000000000002',
        platform: 'ios',
        token: 'concurrent-device-token-value',
      },
      {
        actorId: '01910000-0000-7000-8000-000000000001',
        actorType: 'user',
        requestId: 'notification-concurrent-test',
      },
    )).rejects.toBeInstanceOf(ConflictException);
  });
});
