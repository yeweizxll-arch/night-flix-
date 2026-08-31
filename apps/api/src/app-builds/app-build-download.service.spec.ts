import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService, DatabaseTransaction } from '../database/database.service';
import type { S3CompatibleStorageAdapter } from '../storage/s3-compatible.adapter';
import type { StorageCredentialCipher } from '../storage/storage-credentials';
import { AppBuildDownloadService } from './app-build-download.service';

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e7735c0101';
const jobId = '018f2f45-7f5e-7e70-b17f-f6e7735c0102';
const actorId = '018f2f45-7f5e-7e70-b17f-f6e7735c0103';
const providerId = '018f2f45-7f5e-7e70-b17f-f6e7735c0104';

describe('AppBuildDownloadService', () => {
  it('share-locks the tenant job and platform provider, audits no URL, and returns a short link', async () => {
    const statements: string[] = [];
    const values: unknown[][] = [];
    const fixture = createFixture(async (sql, parameters) => {
      statements.push(sql);
      values.push(parameters);
      if (sql.includes('from tenant_app_build_jobs as job')) return [artifactRow()];
      return [];
    });
    const result = await fixture.service.issue(tenantId, jobId, {
      actorId,
      ip: '203.0.113.93',
      requestId: '018f2f45-7f5e-7e70-b17f-f6e7735c0105',
    });
    expect(fixture.cipher.decrypt).toHaveBeenCalledWith('ciphertext', {
      keyVersion: 7,
      ownerTenantId: null,
      ownerType: 'platform',
      providerId,
    });
    expect(fixture.storage.presignGetObject).toHaveBeenCalledWith(expect.objectContaining({
      expiresInSeconds: 180,
      objectKey: `app-builds/${tenantId}/${jobId}/app.apk`,
      target: { bucket: 'artifacts', endpoint: null },
    }));
    expect(result).toMatchObject({
      checksum: `sha256:${'a'.repeat(64)}`,
      filename: 'app.apk',
      sizeBytes: '2048',
      url: 'https://objects.example.test/signed-download?X-Amz-Expires=180',
    });
    expect(statements[0]).toContain('job.tenant_id =');
    expect(statements[0]).toContain('for share of job, provider');
    expect(values[0]).toEqual([jobId, tenantId]);
    const serializedAudit = JSON.stringify(values.slice(1));
    expect(serializedAudit).not.toContain('signed-download');
    expect(serializedAudit).not.toContain('ciphertext');
    expect(serializedAudit).not.toContain('secret-access-key');
  });

  it('maps credential and adapter failures to one fixed safe error', async () => {
    const fixture = createFixture(async (sql) => (
      sql.includes('from tenant_app_build_jobs as job') ? [artifactRow()] : []
    ));
    fixture.cipher.decrypt.mockImplementation(() => { throw new Error('raw secret failure'); });
    await expect(fixture.service.issue(tenantId, jobId, {
      actorId,
      requestId: '018f2f45-7f5e-7e70-b17f-f6e7735c0105',
    })).rejects.toMatchObject({
      response: {
        code: 'APP_BUILD_DOWNLOAD_UNAVAILABLE',
        message: 'The secure build download is temporarily unavailable',
      },
    });
    expect(fixture.storage.presignGetObject).not.toHaveBeenCalled();
  });
});

function createFixture(
  query: (sql: string, values: unknown[]) => Promise<unknown[]>,
) {
  const transaction = (async (strings: TemplateStringsArray, ...parameters: unknown[]) => {
    const sql = strings.join('$');
    return query(sql, parameters);
  }) as unknown as DatabaseTransaction;
  Object.assign(transaction, { json: (value: unknown) => JSON.stringify(value) });
  const database = {
    inPlatformContext: <T>(callback: (value: DatabaseTransaction) => Promise<T>) =>
      callback(transaction),
  } as unknown as DatabaseService;
  const cipher = {
    decrypt: vi.fn(() => ({
      accessKeyId: 'access-key',
      region: 'us-east-1',
      secretAccessKey: 'secret-access-key',
    })),
  };
  const storage = {
    presignGetObject: vi.fn(async () => ({
      cacheControl: 'private, no-store, max-age=0' as const,
      contentDisposition: 'inline' as const,
      expiresAt: new Date(Date.now() + 180_000),
      url: 'https://objects.example.test/signed-download?X-Amz-Expires=180',
    })),
  };
  return {
    cipher,
    service: new AppBuildDownloadService(
      database,
      cipher as unknown as StorageCredentialCipher,
      storage as unknown as S3CompatibleStorageAdapter,
    ),
    storage,
  };
}

function artifactRow() {
  return {
    artifact_checksum: `sha256:${'a'.repeat(64)}`,
    artifact_content_type: 'application/vnd.android.package-archive',
    artifact_filename: 'app.apk',
    artifact_object_key: `app-builds/${tenantId}/${jobId}/app.apk`,
    artifact_size_bytes: '2048',
    bucket: 'artifacts',
    credential_ciphertext: 'ciphertext',
    endpoint: null,
    key_version: 7,
    provider_id: providerId,
  };
}
