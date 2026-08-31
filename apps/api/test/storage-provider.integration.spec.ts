import { PGlite, type Transaction } from '@electric-sql/pglite';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../src/database/database.service';
import { StorageCredentialCipher } from '../src/storage/storage-credentials';
import {
  StorageProviderService,
  type StorageProviderMutationMetadata,
} from '../src/storage/storage-provider.service';

let database: PGlite;
let providers: StorageProviderService;
let cipher: StorageCredentialCipher;
let publicProviderId: string;
let firstTenantProviderId: string;

const firstTenantId = '018f2f45-7f5e-7e70-b17f-f6e773575101';
const secondTenantId = '018f2f45-7f5e-7e70-b17f-f6e773575102';
const platformStaffId = '018f2f45-7f5e-7e70-b17f-f6e773575103';
const firstTenantStaffId = '018f2f45-7f5e-7e70-b17f-f6e773575104';
const secondTenantStaffId = '018f2f45-7f5e-7e70-b17f-f6e773575105';

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = async (
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown[]> => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}

function metadata(
  actorId: string,
  idempotencyKey?: string,
): StorageProviderMutationMetadata {
  return {
    actorId,
    idempotencyKey,
    ip: '127.0.0.1',
    requestId: uuidV7(),
  };
}

function createInput(label: string, bucket: string) {
  return {
    accessKeyId: `AKIA-${label}`,
    bucket,
    cdnBaseUrl: 'https://cdn.example.com',
    endpoint: 'https://objects.example.com',
    forcePathStyle: true,
    label,
    provider: 's3',
    region: 'ap-northeast-1',
    secretAccessKey: `secret-${label}-credential-value`,
    sessionToken: `session-${label}`,
  };
}

describe('storage provider management PostgreSQL workflow', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    const filenames = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
    for (const filename of filenames) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(
        source
          .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
          .replace(/\bcitext\b/g, 'text'),
      );
    }
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${firstTenantId}', 'storage-one', 'Storage One', statement_timestamp() + interval '1 year'),
        ('${secondTenantId}', 'storage-two', 'Storage Two', statement_timestamp() + interval '1 year');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaffId}', 'storage-platform', '${'p'.repeat(64)}');
      insert into tenant_staff (id, tenant_id, username, password_hash) values
        ('${firstTenantStaffId}', '${firstTenantId}', 'storage-owner-one', '${'p'.repeat(64)}'),
        ('${secondTenantStaffId}', '${secondTenantId}', 'storage-owner-two', '${'p'.repeat(64)}');
    `);

    const databaseService = {
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> =>
        database.transaction((transaction) => callback(transactionTag(transaction))),
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        await transaction.query(
          "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
          [tenantId],
        );
        return callback(transactionTag(transaction));
      }),
    } as unknown as DatabaseService;
    cipher = new StorageCredentialCipher({
      activeVersion: 7,
      keys: new Map([[7, Buffer.alloc(32, 41)]]),
    });
    providers = new StorageProviderService(databaseService, cipher);
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('creates platform and tenant providers idempotently without exposing credentials', async () => {
    const publicInput = createInput('Public Japan', 'public-japan-bucket');
    const createdPublic = await providers.createPlatform(
      publicInput,
      metadata(platformStaffId, 'create-public-storage-1'),
    );
    const repeatedPublic = await providers.createPlatform(
      publicInput,
      metadata(platformStaffId, 'create-public-storage-1'),
    );
    expect(repeatedPublic).toEqual(createdPublic);
    publicProviderId = createdPublic.id;

    const firstInput = createInput('Merchant Private', 'merchant-one-bucket');
    const createdTenant = await providers.createTenant(
      firstTenantId,
      firstInput,
      metadata(firstTenantStaffId, 'create-tenant-storage-1'),
    );
    firstTenantProviderId = createdTenant.id;
    await providers.createTenant(
      secondTenantId,
      createInput('Other Merchant', 'merchant-two-bucket'),
      metadata(secondTenantStaffId, 'create-tenant-storage-2'),
    );

    for (const response of [createdPublic, createdTenant]) {
      expect(response).toMatchObject({
        credentialConfigured: true,
        provider: 's3',
        region: 'ap-northeast-1',
      });
      expect(JSON.stringify(response)).not.toContain('secret-');
      expect(JSON.stringify(response)).not.toContain('AKIA-');
      expect(JSON.stringify(response)).not.toContain('session-');
      expect(JSON.stringify(response)).not.toContain('ciphertext');
    }

    const stored = await database.query<{
      credential_ciphertext: string;
      key_version: number;
      owner_tenant_id: string | null;
      owner_type: 'platform' | 'tenant';
    }>(`
      select credential_ciphertext, key_version, owner_type, owner_tenant_id
      from storage_providers where id = '${firstTenantProviderId}'
    `);
    const row = stored.rows[0]!;
    expect(row.credential_ciphertext).not.toContain(firstInput.secretAccessKey);
    expect(cipher.decrypt(row.credential_ciphertext, {
      keyVersion: row.key_version,
      ownerTenantId: row.owner_tenant_id,
      ownerType: row.owner_type,
      providerId: firstTenantProviderId,
    })).toMatchObject({
      accessKeyId: firstInput.accessKeyId,
      secretAccessKey: firstInput.secretAccessKey,
      sessionToken: firstInput.sessionToken,
    });

    const audits = await database.query<{ after_json: unknown; before_json: unknown }>(`
      select before_json, after_json from audit_logs
      where resource_id in ('${publicProviderId}', '${firstTenantProviderId}')
    `);
    const auditJson = JSON.stringify(audits.rows);
    expect(auditJson).not.toContain('secret-');
    expect(auditJson).not.toContain('AKIA-');
    expect(auditJson).not.toContain('session-');
    expect(auditJson).not.toContain('credential_ciphertext');
  });

  it('shows own providers and active public providers without crossing tenants', async () => {
    const firstList = await providers.listTenant(firstTenantId, 1, 20);
    expect(firstList.items.map((provider) => provider.label).sort()).toEqual([
      'Merchant Private',
      'Public Japan',
    ]);
    expect(firstList.items.find((provider) => provider.id === publicProviderId)).toMatchObject({
      ownerType: 'platform',
      readOnly: true,
    });
    expect(firstList.items.some((provider) => provider.label === 'Other Merchant')).toBe(false);
    const firstListJson = JSON.stringify(firstList);
    expect(firstListJson).not.toContain('AKIA-');
    expect(firstListJson).not.toContain('secret-');
    expect(firstListJson).not.toContain('session-');
    expect(firstListJson).not.toContain('credential_ciphertext');

    await providers.setPlatformStatus(
      publicProviderId,
      { status: 'disabled', version: 0 },
      metadata(platformStaffId),
    );
    const withoutDisabledPublic = await providers.listTenant(firstTenantId, 1, 20);
    expect(withoutDisabledPublic.items.map((provider) => provider.label)).toEqual([
      'Merchant Private',
    ]);
    await providers.setPlatformStatus(
      publicProviderId,
      { status: 'active', version: 1 },
      metadata(platformStaffId),
    );
  });

  it('rejects tenantId bodies and prevents tenant writes across ownership boundaries', async () => {
    expect(() => providers.createTenant(
      firstTenantId,
      { ...createInput('Injected Tenant', 'injected-tenant-bucket'), tenantId: secondTenantId },
      metadata(firstTenantStaffId, 'create-injected-tenant'),
    )).toThrow(BadRequestException);

    await expect(providers.updateTenant(
      firstTenantId,
      publicProviderId,
      { label: 'Hijacked Public', version: 2 },
      metadata(firstTenantStaffId),
    )).rejects.toBeInstanceOf(NotFoundException);

    const secondList = await providers.listTenant(secondTenantId, 1, 20);
    const secondOwned = secondList.items.find((provider) => provider.ownerType === 'tenant')!;
    await expect(providers.setTenantStatus(
      firstTenantId,
      secondOwned.id,
      { status: 'disabled', version: secondOwned.version },
      metadata(firstTenantStaffId),
    )).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updates metadata without requiring secret re-entry and supports credential replacement', async () => {
    const current = (await providers.listTenant(firstTenantId, 1, 20)).items
      .find((provider) => provider.id === firstTenantProviderId)!;
    const metadataOnly = await providers.updateTenant(
      firstTenantId,
      firstTenantProviderId,
      {
        bucket: 'merchant-one-updated',
        forcePathStyle: false,
        label: 'Merchant Updated',
        region: 'us-east-1',
        version: current.version,
      },
      metadata(firstTenantStaffId),
    );
    expect(metadataOnly).toMatchObject({
      bucket: 'merchant-one-updated',
      credentialConfigured: true,
      forcePathStyle: false,
      label: 'Merchant Updated',
      region: 'us-east-1',
      version: current.version + 1,
    });

    const replaced = await providers.updateTenant(
      firstTenantId,
      firstTenantProviderId,
      {
        accessKeyId: 'AKIA-ROTATED',
        secretAccessKey: 'rotated-secret-value-123456',
        sessionToken: '',
        version: metadataOnly.version,
      },
      metadata(firstTenantStaffId),
    );
    expect(replaced.version).toBe(metadataOnly.version + 1);

    const stored = await database.query<{
      credential_ciphertext: string;
      key_version: number;
      owner_tenant_id: string | null;
      owner_type: 'platform' | 'tenant';
    }>(`
      select credential_ciphertext, key_version, owner_type, owner_tenant_id
      from storage_providers where id = '${firstTenantProviderId}'
    `);
    const row = stored.rows[0]!;
    expect(cipher.decrypt(row.credential_ciphertext, {
      keyVersion: row.key_version,
      ownerTenantId: row.owner_tenant_id,
      ownerType: row.owner_type,
      providerId: firstTenantProviderId,
    })).toEqual({
      accessKeyId: 'AKIA-ROTATED',
      forcePathStyle: false,
      region: 'us-east-1',
      secretAccessKey: 'rotated-secret-value-123456',
    });
  });

  it('supports owned deletion and retains explicit RLS policies for platform and tenants', async () => {
    const temporary = await providers.createTenant(
      firstTenantId,
      createInput('Temporary Storage', 'temporary-storage-bucket'),
      metadata(firstTenantStaffId, 'create-temporary-storage'),
    );
    await expect(providers.deleteTenant(
      firstTenantId,
      publicProviderId,
      { version: 2 },
      metadata(firstTenantStaffId),
    )).rejects.toBeInstanceOf(NotFoundException);
    expect(() => providers.deleteTenant(
      firstTenantId,
      temporary.id,
      { tenantId: secondTenantId, version: temporary.version },
      metadata(firstTenantStaffId),
    )).toThrow(BadRequestException);
    expect(await providers.deleteTenant(
      firstTenantId,
      temporary.id,
      { version: temporary.version },
      metadata(firstTenantStaffId),
    )).toEqual({ deleted: true, id: temporary.id });

    const policies = await database.query<{ policyname: string }>(`
      select policyname from pg_policies
      where schemaname = 'public' and tablename = 'storage_providers'
      order by policyname
    `);
    expect(policies.rows.map((row) => row.policyname)).toEqual(expect.arrayContaining([
      'storage_providers_platform_access',
      'storage_providers_tenant_insert',
      'storage_providers_tenant_select',
      'storage_providers_tenant_update',
    ]));
    const relation = await database.query<{
      forcerowsecurity: boolean;
      rowsecurity: boolean;
    }>(`
      select relrowsecurity as rowsecurity, relforcerowsecurity as forcerowsecurity
      from pg_class where oid = 'storage_providers'::regclass
    `);
    expect(relation.rows[0]).toEqual({ forcerowsecurity: true, rowsecurity: true });
  });
});
