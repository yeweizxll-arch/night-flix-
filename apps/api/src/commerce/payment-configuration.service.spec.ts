import { describe, expect, it, vi } from 'vitest';

import type {
  DatabaseService,
  DatabaseTransaction,
} from '../database/database.service';
import { PaymentConfigurationService } from './payment-configuration.service';

const TENANT_ID = '018f2f45-7f5e-7e70-b17f-f6e77357d001';
const CONFIG_ID = '018f2f45-7f5e-7e70-b17f-f6e77357d002';
const ACTOR_ID = '018f2f45-7f5e-7e70-b17f-f6e77357d003';

describe('PaymentConfigurationService listings', () => {
  it('returns only the public platform config projection and never secret storage fields', async () => {
    const calls: QueryCall[] = [];
    const transaction = createTransaction(calls, () => [{
      adapter_code: 'fake',
      credential_ciphertext: 'encrypted-private-value',
      id: CONFIG_ID,
      label: 'Local test',
      owner_tenant_id: TENANT_ID,
      owner_type: 'platform',
      provider: 'fake',
      public_metadata_json: {
        clientSecret: 'must-not-leak',
        localOnly: true,
      },
      status: 'active',
      version: 3,
    }]);
    const { service } = createService(transaction);

    const result = await service.listPlatformPaymentConfigs();

    expect(result).toEqual([{
      id: CONFIG_ID,
      label: 'Local test',
      provider: 'fake',
      publicMetadata: {
        clientSecret: '[REDACTED]',
        localOnly: true,
      },
      status: 'active',
      version: 3,
    }]);
    expect(Object.keys(result[0] ?? {}).sort()).toEqual([
      'id',
      'label',
      'provider',
      'publicMetadata',
      'status',
      'version',
    ]);
    expect(JSON.stringify(result)).not.toMatch(
      /encrypted-private-value|must-not-leak|credential_ciphertext|owner_tenant_id/,
    );
    expect(calls[0]?.sql).toContain("where config.owner_type = 'platform'");
    expect(calls[0]?.sql).not.toMatch(/payment_config_secrets|credential_ciphertext/);
  });

  it('lists only through the verified tenant transaction and returns routing', async () => {
    const calls: QueryCall[] = [];
    const transaction = createTransaction(calls, (sql) => {
      if (sql.includes('from payment_configs as config')) {
        return [{
          id: CONFIG_ID,
          label: 'Platform collect',
          owner_type: 'platform',
          provider: 'fake',
          public_metadata_json: { localOnly: true },
          status: 'active',
          version: 0,
        }];
      }
      if (sql.includes('from tenant_payment_routing')) {
        return [{
          collection_mode: 'platform_collect',
          payment_config_id: CONFIG_ID,
          version: 2,
        }];
      }
      return [];
    });
    const { database, service } = createService(transaction);

    await expect(service.listTenantPaymentConfigs(TENANT_ID)).resolves.toEqual({
      configs: [{
        id: CONFIG_ID,
        label: 'Platform collect',
        ownerType: 'platform',
        provider: 'fake',
        publicMetadata: { localOnly: true },
        status: 'active',
        version: 0,
      }],
      routing: {
        collectionMode: 'platform_collect',
        paymentConfigId: CONFIG_ID,
        version: 2,
      },
    });
    expect(database.inTenantContext).toHaveBeenCalledWith(
      TENANT_ID,
      expect.any(Function),
    );
    expect(database.inPlatformContext).not.toHaveBeenCalled();
    expect(calls[0]?.sql).toContain("config.owner_type = 'platform' and config.status = 'active'");
    expect(calls[0]?.sql).toContain("config.owner_tenant_id = ?");
    expect(calls[0]?.sql).toContain("config.status in ('active', 'disabled')");
  });

  it('returns a completed routing command for the same idempotency key without mutating again', async () => {
    const calls: QueryCall[] = [];
    let requestHash = '';
    const cached = {
      collectionMode: 'platform_collect' as const,
      paymentConfigId: CONFIG_ID,
      version: 4,
    };
    const transaction = createTransaction(calls, (sql, values) => {
      if (sql.includes('insert into command_idempotency')) {
        requestHash = String(values[7]);
        return [];
      }
      if (sql.includes('from command_idempotency')) {
        return [{
          request_hash: requestHash,
          response_json: cached,
          status: 'completed',
        }];
      }
      throw new Error(`Unexpected mutation after cached command: ${sql}`);
    });
    const { service } = createService(transaction);

    await expect(service.setTenantRouting(
      TENANT_ID,
      CONFIG_ID,
      'platform_collect',
      ACTOR_ID,
      '018f2f45-7f5e-7e70-b17f-f6e77357d004',
      'tenant-routing-command-1',
    )).resolves.toEqual(cached);
    expect(calls).toHaveLength(2);
    expect(calls.some((call) => call.sql.includes('tenant_payment_routing'))).toBe(false);
  });
});

interface QueryCall {
  sql: string;
  values: unknown[];
}

function createService(transaction: DatabaseTransaction) {
  const database = {
    inPlatformContext: vi.fn(
      async (callback: (value: DatabaseTransaction) => Promise<unknown>) =>
        callback(transaction),
    ),
    inTenantContext: vi.fn(
      async (
        _tenantId: string,
        callback: (value: DatabaseTransaction) => Promise<unknown>,
      ) => callback(transaction),
    ),
  };
  return {
    database,
    service: new PaymentConfigurationService(
      database as unknown as DatabaseService,
    ),
  };
}

function createTransaction(
  calls: QueryCall[],
  resolve: (sql: string, values: unknown[]) => unknown,
): DatabaseTransaction {
  const transaction = (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown> => {
    const sql = strings.join('?').replace(/\s+/g, ' ').trim();
    calls.push({ sql, values });
    return Promise.resolve(resolve(sql, values));
  };
  Object.assign(transaction, {
    json: (value: unknown) => value,
  });
  return transaction as unknown as DatabaseTransaction;
}
