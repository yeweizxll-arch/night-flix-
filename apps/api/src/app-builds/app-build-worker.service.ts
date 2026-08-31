import { Inject, Injectable } from '@nestjs/common';

import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import {
  APP_BUILD_EXECUTOR,
  AppBuildExecutionError,
  type AppBuildExecutionArtifact,
  type AppBuildExecutor,
  type AppBuildFailureCode,
} from './app-build-executor';
import type { AppBuildTarget } from './app-build.types';

interface ClaimedJob {
  id: string;
  snapshot_json: Record<string, unknown>;
  target: AppBuildTarget;
  tenant_id: string;
}

@Injectable()
export class AppBuildWorkerService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(APP_BUILD_EXECUTOR)
    private readonly executor: AppBuildExecutor,
  ) {}

  async registerHeartbeat(
    capabilitiesValue: AppBuildTarget[],
    workerId = process.env.WORKER_ID ?? 'app-build-worker',
  ): Promise<void> {
    const safeWorkerId = workerIdentifier(workerId);
    const artifactProviderId = artifactProviderIdentifier(
      process.env.APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID,
    );
    const capabilities = [...new Set(capabilitiesValue)].sort() as AppBuildTarget[];
    if (capabilities.length < 1 || capabilities.length > 2
      || capabilities.some((capability) => !['android_debug', 'ios_simulator'].includes(capability))) {
      throw new TypeError('App build worker capabilities are invalid');
    }
    await this.database.inPlatformContext(async (transaction) => {
      const providers = await transaction<{ id: string }[]>`
        select id from storage_providers
        where id = ${artifactProviderId}
          and owner_type = 'platform' and owner_tenant_id is null
          and provider = 's3' and status = 'active'
        for share
      `;
      if (!providers[0]) {
        throw new Error(
          'APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID must reference an active platform S3 provider',
        );
      }
      await transaction`
        insert into app_build_worker_heartbeats (
          worker_id, artifact_storage_provider_id, capabilities, started_at, last_seen_at
        ) values (
          ${safeWorkerId}, ${artifactProviderId}, ${capabilities},
          statement_timestamp(), statement_timestamp()
        ) on conflict (worker_id) do update set
          artifact_storage_provider_id = excluded.artifact_storage_provider_id,
          capabilities = excluded.capabilities,
          last_seen_at = statement_timestamp()
      `;
    });
  }

  async unregisterHeartbeat(workerId = process.env.WORKER_ID ?? 'app-build-worker'): Promise<void> {
    const safeWorkerId = workerIdentifier(workerId);
    await this.database.inPlatformContext(async (transaction) => {
      await transaction`delete from app_build_worker_heartbeats where worker_id = ${safeWorkerId}`;
    });
  }

  async processAvailable(limit = 1, workerId = process.env.WORKER_ID ?? 'app-build-worker') {
    if (process.env.APP_BUILD_WORKER_ENABLED !== 'true') return { claimed: 0 };
    const boundedLimit = integer(limit, 1, 4, 'limit');
    const safeWorkerId = workerIdentifier(workerId);
    let claimed = 0;
    for (let index = 0; index < boundedLimit; index += 1) {
      const job = await this.claimOne(safeWorkerId);
      if (!job) break;
      claimed += 1;
      try {
        const artifact = await this.executor.execute({
          jobId: job.id,
          snapshot: job.snapshot_json,
          target: job.target,
          tenantId: job.tenant_id,
        });
        validateArtifact(job, artifact);
        await this.completeSuccess(job, safeWorkerId, artifact);
      } catch (error) {
        const code: AppBuildFailureCode = error instanceof AppBuildExecutionError
          ? error.code : 'build_failed';
        await this.completeFailure(job, safeWorkerId, code);
      }
    }
    return { claimed };
  }

  async recoverStaleLocks() {
    if (process.env.APP_BUILD_WORKER_ENABLED !== 'true') return { failed: 0, requeued: 0 };
    return this.database.inPlatformContext(async (transaction) => {
      const requeued = await transaction<{ id: string }[]>`
        update tenant_app_build_jobs set status = 'queued',
          available_at = statement_timestamp() + interval '1 minute',
          locked_at = null, locked_by = null, started_at = null,
          version = version + 1
        where status = 'processing'
          and locked_at < statement_timestamp() - interval '30 minutes'
          and attempts < max_attempts
        returning id
      `;
      const failed = await transaction<{ id: string }[]>`
        update tenant_app_build_jobs set status = 'failed',
          failure_code = 'job_timed_out', completed_at = statement_timestamp(),
          version = version + 1
        where status = 'processing'
          and locked_at < statement_timestamp() - interval '30 minutes'
          and attempts >= max_attempts
        returning id
      `;
      return { failed: failed.length, requeued: requeued.length };
    });
  }

  private claimOne(workerId: string): Promise<ClaimedJob | undefined> {
    return this.database.inPlatformContext(async (transaction) => {
      const candidates = await transaction<{ id: string }[]>`
        select job.id from tenant_app_build_jobs as job
        where job.status = 'queued' and job.available_at <= statement_timestamp()
          and exists (
            select 1 from app_build_worker_heartbeats as heartbeat
            inner join storage_providers as artifact_provider
              on artifact_provider.id = heartbeat.artifact_storage_provider_id
            where heartbeat.worker_id = ${workerId}
              and heartbeat.last_seen_at >= statement_timestamp() - interval '30 seconds'
              and job.target = any(heartbeat.capabilities)
              and artifact_provider.owner_type = 'platform'
              and artifact_provider.owner_tenant_id is null
              and artifact_provider.provider = 's3'
              and artifact_provider.status = 'active'
          )
        order by job.available_at, job.created_at, job.id
        for update skip locked limit 1
      `;
      const id = candidates[0]?.id;
      if (!id) return undefined;
      const rows = await transaction<ClaimedJob[]>`
        update tenant_app_build_jobs set status = 'processing',
          attempts = attempts + 1, locked_at = statement_timestamp(),
          locked_by = ${workerId}, started_at = statement_timestamp(),
          version = version + 1
        where id = ${id} and status = 'queued'
        returning id, tenant_id, target, snapshot_json
      `;
      return rows[0];
    });
  }

  private completeSuccess(
    job: ClaimedJob,
    workerId: string,
    artifact: AppBuildExecutionArtifact,
  ): Promise<void> {
    return this.database.inPlatformContext(async (transaction) => {
      // postgres.js accepts bigint values at runtime, but its template types reject
      // them. Serialize explicitly and cast in SQL so the full 64-bit value is
      // preserved without crossing JavaScript's safe-number boundary.
      const artifactSizeBytes = artifact.sizeBytes.toString(10);
      const rows = await transaction<{ id: string }[]>`
        update tenant_app_build_jobs set status = 'succeeded',
          artifact_storage_provider_id = ${artifact.storageProviderId},
          artifact_object_key = ${artifact.objectKey},
          artifact_filename = ${artifact.filename},
          artifact_content_type = ${artifact.contentType},
          artifact_size_bytes = ${artifactSizeBytes}::bigint,
          artifact_checksum = ${artifact.checksum},
          completed_at = statement_timestamp(), version = version + 1
        where id = ${job.id} and tenant_id = ${job.tenant_id}
          and status = 'processing' and locked_by = ${workerId}
        returning id
      `;
      if (!rows[0]) throw new Error('App build job completion lease was lost');
      await recordWorkerEvent(transaction, job, 'AppBuildSucceeded');
    });
  }

  private completeFailure(
    job: ClaimedJob,
    workerId: string,
    code: AppBuildFailureCode,
  ): Promise<void> {
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<{ id: string }[]>`
        update tenant_app_build_jobs set status = 'failed',
          failure_code = ${code}, completed_at = statement_timestamp(),
          version = version + 1
        where id = ${job.id} and tenant_id = ${job.tenant_id}
          and status = 'processing' and locked_by = ${workerId}
        returning id
      `;
      if (!rows[0]) throw new Error('App build job failure lease was lost');
      await recordWorkerEvent(transaction, job, 'AppBuildFailed', code);
    });
  }
}

async function recordWorkerEvent(
  transaction: DatabaseTransaction,
  job: ClaimedJob,
  eventType: 'AppBuildFailed' | 'AppBuildSucceeded',
  failureCode?: AppBuildFailureCode,
) {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, request_id
    ) values (
      ${uuidV7()}, 'platform', null, 'system', null,
      ${eventType === 'AppBuildSucceeded'
        ? 'platform.app_build.job.succeed' : 'platform.app_build.job.fail'},
      'app_build_job', ${job.id},
      ${transaction.json({ failureCode: failureCode ?? null, status: eventType })},
      ${`app-build-worker:${job.id}`}
    )
  `;
  const eventId = uuidV7();
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key,
      aggregate_type, aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, 'platform', null, ${`event:${eventId}`},
      ${`app-build:${job.id}:${eventType}`}, 'app_build_job', ${job.id},
      ${eventType},
      ${transaction.json({ failureCode: failureCode ?? null, id: job.id, tenantId: job.tenant_id })}
    )
  `;
}

function validateArtifact(job: ClaimedJob, artifact: AppBuildExecutionArtifact) {
  if (!artifact || typeof artifact !== 'object'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(artifact.storageProviderId)
    || !/^sha256:[0-9a-f]{64}$/.test(artifact.checksum)
    || artifact.sizeBytes < 1n || artifact.sizeBytes > 4_294_967_296n
    || !artifact.objectKey.startsWith(`app-builds/${job.tenant_id}/${job.id}/`)
    || /[\\\u0000-\u001f\u007f]/.test(artifact.objectKey)
    || !/^[A-Za-z0-9._-]{3,200}$/.test(artifact.filename)) {
    throw new AppBuildExecutionError('artifact_upload_failed');
  }
  if (job.target === 'android_debug'
    && (artifact.contentType !== 'application/vnd.android.package-archive'
      || !artifact.filename.endsWith('.apk'))) {
    throw new AppBuildExecutionError('artifact_upload_failed');
  }
  if (job.target === 'ios_simulator'
    && (artifact.contentType !== 'application/zip' || !artifact.filename.endsWith('.zip'))) {
    throw new AppBuildExecutionError('artifact_upload_failed');
  }
}

function integer(value: number, minimum: number, maximum: number, field: string) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${field} is invalid`);
  }
  return value;
}

function workerIdentifier(value: string) {
  const result = value.trim();
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(result)) throw new Error('WORKER_ID is invalid');
  return result;
}

function artifactProviderIdentifier(value: string | undefined) {
  const result = value?.trim() ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(result)) {
    throw new Error('APP_BUILD_ARTIFACT_STORAGE_PROVIDER_ID is invalid');
  }
  return result;
}
