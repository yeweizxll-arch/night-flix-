import {
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';

import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService } from '../database/database.service';
import {
  S3_COMPATIBLE_STORAGE_ADAPTER,
  type S3CompatibleStorageAdapter,
} from '../storage/s3-compatible.adapter';
import {
  StorageCredentialCipher,
  type S3StorageCredentials,
} from '../storage/storage-credentials';
import type { AppBuildDownloadMetadata } from './app-build.types';

const DOWNLOAD_EXPIRY_SECONDS = 180;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface DownloadRow {
  artifact_checksum: string;
  artifact_content_type: 'application/vnd.android.package-archive' | 'application/zip';
  artifact_filename: string;
  artifact_object_key: string;
  artifact_size_bytes: string | number | bigint;
  bucket: string;
  credential_ciphertext: string;
  endpoint: string | null;
  key_version: number;
  provider_id: string;
}

@Injectable()
export class AppBuildDownloadService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(StorageCredentialCipher) private readonly cipher: StorageCredentialCipher,
    @Inject(S3_COMPATIBLE_STORAGE_ADAPTER)
    private readonly storage: S3CompatibleStorageAdapter,
  ) {}

  async issue(tenantId: string, jobId: string, metadata: AppBuildDownloadMetadata) {
    assertUuid(tenantId, 'tenantId');
    assertUuid(jobId, 'jobId');
    assertUuid(metadata.actorId, 'actorId');
    assertUuid(metadata.requestId, 'requestId');
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<DownloadRow[]>`
        select job.artifact_object_key, job.artifact_filename,
          job.artifact_content_type, job.artifact_size_bytes, job.artifact_checksum,
          provider.id as provider_id, provider.endpoint, provider.bucket,
          provider.credential_ciphertext, provider.key_version
        from tenant_app_build_jobs as job
        inner join storage_providers as provider
          on provider.id = job.artifact_storage_provider_id
        where job.id = ${jobId} and job.tenant_id = ${tenantId}
          and job.status = 'succeeded'
          and provider.owner_type = 'platform'
          and provider.owner_tenant_id is null
          and provider.provider = 's3' and provider.status = 'active'
        for share of job, provider
      `;
      const artifact = rows[0];
      if (!artifact) throw new NotFoundException('Build artifact is unavailable');
      try {
        const credentials: S3StorageCredentials = this.cipher.decrypt(
          artifact.credential_ciphertext,
          {
            keyVersion: artifact.key_version,
            ownerTenantId: null,
            ownerType: 'platform',
            providerId: artifact.provider_id,
          },
        );
        // Presigning is local work and stays under the provider share lock so a
        // disable or credential rotation cannot race issuance.
        const signed = await this.storage.presignGetObject({
          credentials,
          expiresInSeconds: DOWNLOAD_EXPIRY_SECONDS,
          objectKey: artifact.artifact_object_key,
          target: { bucket: artifact.bucket, endpoint: artifact.endpoint },
        });
        const expiresAt = validateSignedDownload(signed);
        await transaction`
          insert into audit_logs (
            id, scope_type, tenant_id, actor_type, actor_id, action,
            resource_type, resource_id, after_json, ip, request_id
          ) values (
            ${uuidV7()}, 'platform', null, 'platform_staff', ${metadata.actorId},
            'platform.app_build.artifact.download', 'app_build_job', ${jobId},
            ${transaction.json({
              checksum: artifact.artifact_checksum,
              filename: artifact.artifact_filename,
              tenantId,
            })},
            ${metadata.ip ?? null}, ${metadata.requestId}
          )
        `;
        return {
          checksum: artifact.artifact_checksum,
          contentType: artifact.artifact_content_type,
          expiresAt: expiresAt.toISOString(),
          filename: artifact.artifact_filename,
          sizeBytes: String(artifact.artifact_size_bytes),
          url: signed.url,
        };
      } catch (error) {
        if (error instanceof NotFoundException) throw error;
        throw new ServiceUnavailableException({
          code: 'APP_BUILD_DOWNLOAD_UNAVAILABLE',
          message: 'The secure build download is temporarily unavailable',
        });
      }
    });
  }
}

function validateSignedDownload(value: { expiresAt: Date; url: string }): Date {
  if (!value || typeof value.url !== 'string' || value.url.length > 16_384) {
    throw new Error('Invalid signed download');
  }
  let parsed: URL;
  try {
    parsed = new URL(value.url);
  } catch {
    throw new Error('Invalid signed download');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) {
    throw new Error('Invalid signed download');
  }
  if (!(value.expiresAt instanceof Date) || !Number.isFinite(value.expiresAt.getTime())) {
    throw new Error('Invalid signed download expiry');
  }
  const remaining = value.expiresAt.getTime() - Date.now();
  if (remaining <= 0 || remaining > (DOWNLOAD_EXPIRY_SECONDS + 5) * 1_000) {
    throw new Error('Invalid signed download expiry');
  }
  return value.expiresAt;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new NotFoundException(`${field} is invalid`);
  }
}
