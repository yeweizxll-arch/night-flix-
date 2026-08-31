import { hostname } from 'node:os';
import { Inject, Injectable } from '@nestjs/common';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';

interface ScheduleJobRow {
  action: 'publish' | 'unpublish';
  attempts: number;
  id: string;
  max_attempts: number;
  scope_type: 'platform' | 'tenant';
  target_id: string;
  target_type: 'drama' | 'episode';
  tenant_id: string | null;
}

type TenantScheduleJob = ScheduleJobRow & { tenant_id: string };

@Injectable()
export class ContentScheduleWorkerService {
  private readonly batchSize = integerEnvironment('SCHEDULE_BATCH_SIZE', 50, 1, 200);
  private readonly workerId = workerIdentity();

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  recoverStaleLocks(): Promise<number> {
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{ count: number }>>`
        with recovered as (
          update content_schedule_jobs
          set
            status = case when attempts >= max_attempts then 'failed' else 'retry' end,
            available_at = statement_timestamp(),
            locked_at = null,
            locked_by = null,
            last_error = 'worker lock expired before completion'
          where status = 'processing'
            and locked_at < statement_timestamp() - interval '5 minutes'
          returning id
        )
        select count(*)::integer as count from recovered
      `;
      return rows[0]?.count ?? 0;
    });
  }

  async processDue(): Promise<{ claimed: number; completed: number; failed: number }> {
    const jobs = await this.claimBatch();
    let completed = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        const result = await this.executeJob(job);
        if (result === 'completed') completed += 1;
        else failed += 1;
      } catch (error) {
        await this.failJob(job, safeErrorMessage(error));
        failed += 1;
      }
    }
    return { claimed: jobs.length, completed, failed };
  }

  private claimBatch(): Promise<ScheduleJobRow[]> {
    return this.database.inPlatformContext(async (transaction) => {
      return transaction<ScheduleJobRow[]>`
        with candidates as (
          select id
          from content_schedule_jobs
          where status in ('pending', 'retry')
            and scheduled_at <= statement_timestamp()
            and available_at <= statement_timestamp()
          order by available_at, scheduled_at, id
          for update skip locked
          limit ${this.batchSize}
        )
        update content_schedule_jobs as job
        set
          status = 'processing',
          attempts = job.attempts + 1,
          locked_at = statement_timestamp(),
          locked_by = ${this.workerId},
          last_error = null
        from candidates
        where job.id = candidates.id
        returning
          job.id,
          job.scope_type,
          job.tenant_id,
          job.target_type,
          job.target_id,
          job.action,
          job.attempts,
          job.max_attempts
      `;
    });
  }

  private executeJob(job: ScheduleJobRow): Promise<'completed' | 'failed'> {
    return this.database.inPlatformContext(async (transaction) => {
      if (!['drama', 'episode'].includes(job.target_type)) {
        await this.updateFailure(transaction, job, 'unsupported schedule target', false);
        return 'failed';
      }
      if (job.scope_type === 'platform' && job.tenant_id === null) {
        return job.target_type === 'drama'
          ? this.executePlatformDramaJob(transaction, job)
          : this.executePlatformEpisodeJob(transaction, job);
      }
      if (job.scope_type !== 'tenant' || !job.tenant_id) {
        await this.updateFailure(transaction, job, 'unsupported schedule scope', false);
        return 'failed';
      }
      const tenantJob = job as TenantScheduleJob;
      return tenantJob.target_type === 'drama'
        ? this.executeDramaJob(transaction, tenantJob)
        : this.executeEpisodeJob(transaction, tenantJob);
    });
  }

  private async executePlatformDramaJob(
    transaction: DatabaseTransaction,
    job: ScheduleJobRow,
  ): Promise<'completed' | 'failed'> {
    const rows = await transaction<Array<{
      content_available: boolean;
      drama_status: string;
    }>>`
      select drama.status as drama_status,
        cover.id is not null
          and exists (
            select 1 from episodes as episode
            inner join media_assets as media on media.id = episode.media_asset_id
              and media.owner_type = 'platform' and media.owner_tenant_id is null
              and media.status = 'ready'
              and media.transcode_status in ('ready', 'not_required')
              and media.deleted_at is null
              and media.object_key is not null and media.source_url is null
            inner join storage_providers as provider on provider.id = media.storage_provider_id
              and provider.owner_type = 'platform' and provider.owner_tenant_id is null
              and provider.status = 'active'
            where episode.drama_id = drama.id and episode.deleted_at is null
              and (episode.unpublish_at is null
                or episode.unpublish_at > statement_timestamp())
              and (
                episode.preview_media_asset_id is null
                or exists (
                  select 1 from media_assets as preview
                  inner join storage_providers as preview_provider
                    on preview_provider.id = preview.storage_provider_id
                    and preview_provider.owner_type = 'platform'
                    and preview_provider.owner_tenant_id is null
                    and preview_provider.provider = 's3'
                    and preview_provider.status = 'active'
                  where preview.id = episode.preview_media_asset_id
                    and preview.id <> episode.media_asset_id
                    and preview.owner_type = 'platform'
                    and preview.owner_tenant_id is null
                    and preview.kind = 'video' and preview.status = 'ready'
                    and preview.transcode_status in ('ready', 'not_required')
                    and preview.deleted_at is null
                    and preview.object_key is not null and preview.source_url is null
                )
              )
          )
          and not exists (
            select 1 from episodes as episode
            left join media_assets as media on media.id = episode.media_asset_id
              and media.owner_type = 'platform' and media.owner_tenant_id is null
              and media.status = 'ready'
              and media.transcode_status in ('ready', 'not_required')
              and media.deleted_at is null and media.object_key is not null
              and media.source_url is null
              and exists (
                select 1 from storage_providers as provider
                where provider.id = media.storage_provider_id
                  and provider.owner_type = 'platform'
                  and provider.owner_tenant_id is null
                  and provider.status = 'active'
              )
            where episode.drama_id = drama.id and episode.deleted_at is null
              and (media.id is null or (
                episode.preview_media_asset_id is not null
                and not exists (
                  select 1 from media_assets as preview
                  inner join storage_providers as preview_provider
                    on preview_provider.id = preview.storage_provider_id
                    and preview_provider.owner_type = 'platform'
                    and preview_provider.owner_tenant_id is null
                    and preview_provider.provider = 's3'
                    and preview_provider.status = 'active'
                  where preview.id = episode.preview_media_asset_id
                    and preview.id <> episode.media_asset_id
                    and preview.owner_type = 'platform'
                    and preview.owner_tenant_id is null
                    and preview.kind = 'video' and preview.status = 'ready'
                    and preview.transcode_status in ('ready', 'not_required')
                    and preview.deleted_at is null
                    and preview.object_key is not null and preview.source_url is null
                )
              ))
          ) as content_available
      from content_schedule_jobs as job
      inner join dramas as drama on drama.id = job.target_id
        and drama.owner_type = 'platform' and drama.owner_tenant_id is null
        and drama.deleted_at is null
      left join media_assets as cover on cover.id = drama.cover_file_id
        and cover.owner_type = 'platform' and cover.owner_tenant_id is null
        and cover.kind = 'image' and cover.status = 'ready'
        and cover.deleted_at is null and cover.object_key is not null
        and cover.source_url is null
        and exists (
          select 1 from storage_providers as cover_provider
          where cover_provider.id = cover.storage_provider_id
            and cover_provider.owner_type = 'platform'
            and cover_provider.owner_tenant_id is null
            and cover_provider.status = 'active'
        )
      where job.id = ${job.id} and job.scope_type = 'platform'
        and job.tenant_id is null and job.status = 'processing'
        and job.locked_by = ${this.workerId}
      for update of job, drama
    `;
    const state = rows[0];
    if (!state) {
      await this.updateFailure(transaction, job, 'schedule target is unavailable', false);
      return 'failed';
    }
    if (job.action === 'publish' && !state.content_available) {
      await this.updateFailure(
        transaction,
        job,
        'platform content media is unavailable for publication',
        true,
      );
      return 'failed';
    }
    const allowed = job.action === 'publish'
      ? ['approved', 'published']
      : ['approved', 'published', 'unpublished'];
    if (!allowed.includes(state.drama_status)) {
      await this.updateFailure(
        transaction,
        job,
        `drama state ${state.drama_status} cannot ${job.action}`,
        false,
      );
      return 'failed';
    }
    const targetStatus = job.action === 'publish' ? 'published' : 'unpublished';
    await transaction`
      update dramas set status = ${targetStatus}, version = version + 1, updated_by = null
      where id = ${job.target_id} and status <> ${targetStatus}
    `;
    if (job.action === 'publish') {
      await transaction`
        update episodes set
          status = case
            when unpublish_at is not null and unpublish_at <= statement_timestamp()
              then 'unpublished'
            when release_at is null or release_at <= statement_timestamp()
              then 'published'
            else 'approved'
          end,
          version = version + 1,
          updated_by = null
        where drama_id = ${job.target_id} and deleted_at is null
          and status in ('approved', 'published')
          and status is distinct from case
            when unpublish_at is not null and unpublish_at <= statement_timestamp()
              then 'unpublished'
            when release_at is null or release_at <= statement_timestamp()
              then 'published'
            else 'approved'
          end
      `;
    } else {
      await transaction`
        update episodes set status = 'unpublished', version = version + 1,
          updated_by = null
        where drama_id = ${job.target_id} and deleted_at is null
          and status in ('approved', 'published')
      `;
    }
    await this.completeTargetJob(transaction, job, targetStatus, job.target_id);
    return 'completed';
  }

  private async executePlatformEpisodeJob(
    transaction: DatabaseTransaction,
    job: ScheduleJobRow,
  ): Promise<'completed' | 'failed'> {
    const rows = await transaction<Array<{
      drama_id: string;
      episode_status: string;
      media_available: boolean;
      preview_available: boolean;
      parent_status: string;
      unpublish_elapsed: boolean;
    }>>`
      select drama.id as drama_id, drama.status as parent_status,
        episode.status as episode_status,
        media.id is not null as media_available,
        episode.preview_media_asset_id is null or exists (
          select 1 from media_assets as preview
          inner join storage_providers as preview_provider
            on preview_provider.id = preview.storage_provider_id
            and preview_provider.owner_type = 'platform'
            and preview_provider.owner_tenant_id is null
            and preview_provider.provider = 's3'
            and preview_provider.status = 'active'
          where preview.id = episode.preview_media_asset_id
            and preview.id <> episode.media_asset_id
            and preview.owner_type = 'platform' and preview.owner_tenant_id is null
            and preview.kind = 'video' and preview.status = 'ready'
            and preview.transcode_status in ('ready', 'not_required')
            and preview.deleted_at is null and preview.object_key is not null
            and preview.source_url is null
        ) as preview_available,
        episode.unpublish_at is not null
          and episode.unpublish_at <= statement_timestamp() as unpublish_elapsed
      from content_schedule_jobs as job
      inner join episodes as episode on episode.id = job.target_id
        and episode.deleted_at is null
      inner join dramas as drama on drama.id = episode.drama_id
        and drama.owner_type = 'platform' and drama.owner_tenant_id is null
        and drama.deleted_at is null
      left join media_assets as media on media.id = episode.media_asset_id
        and media.owner_type = 'platform' and media.owner_tenant_id is null
        and media.status = 'ready'
        and media.transcode_status in ('ready', 'not_required')
        and media.deleted_at is null
        and media.object_key is not null and media.source_url is null
        and exists (
          select 1 from storage_providers as provider
          where provider.id = media.storage_provider_id
            and provider.owner_type = 'platform'
            and provider.owner_tenant_id is null and provider.status = 'active'
        )
      where job.id = ${job.id} and job.scope_type = 'platform'
        and job.tenant_id is null and job.status = 'processing'
        and job.locked_by = ${this.workerId}
      for update of job, episode, drama
    `;
    const state = rows[0];
    if (!state) {
      await this.updateFailure(transaction, job, 'schedule target is unavailable', false);
      return 'failed';
    }
    if (job.action === 'publish' && (!state.media_available || !state.preview_available)) {
      await this.updateFailure(
        transaction,
        job,
        'platform episode or preview media is unavailable for publication',
        true,
      );
      return 'failed';
    }
    if (job.action === 'publish' && !['approved', 'published'].includes(state.parent_status)) {
      await this.updateFailure(
        transaction,
        job,
        `parent drama state ${state.parent_status} cannot publish episode`,
        false,
      );
      return 'failed';
    }
    if (job.action === 'publish' && state.unpublish_elapsed) {
      await this.updateFailure(transaction, job, 'episode unpublish time has already elapsed', false);
      return 'failed';
    }
    const allowed = job.action === 'publish'
      ? ['approved', 'published']
      : ['approved', 'published', 'unpublished'];
    if (!allowed.includes(state.episode_status)) {
      await this.updateFailure(
        transaction,
        job,
        `episode state ${state.episode_status} cannot ${job.action}`,
        false,
      );
      return 'failed';
    }
    const targetStatus = job.action === 'publish' ? 'published' : 'unpublished';
    await transaction`
      update episodes set status = ${targetStatus}, version = version + 1, updated_by = null
      where id = ${job.target_id} and status <> ${targetStatus}
    `;
    await this.completeTargetJob(transaction, job, targetStatus, state.drama_id);
    return 'completed';
  }

  private async executeDramaJob(
    transaction: DatabaseTransaction,
    job: TenantScheduleJob,
  ): Promise<'completed' | 'failed'> {
    const rows = await transaction<
      Array<{
        content_available: boolean;
        drama_status: string;
        tenant_available: boolean;
      }>
    >`
        select
          drama.status as drama_status,
          not exists (
            select 1 from episodes as episode
            where episode.drama_id = drama.id and episode.deleted_at is null
              and (
                not exists (
                  select 1 from media_assets as media
                  inner join storage_providers as provider
                    on provider.id = media.storage_provider_id
                    and provider.provider = 's3' and provider.status = 'active'
                    and (provider.owner_type = 'platform'
                      or (provider.owner_type = 'tenant'
                        and provider.owner_tenant_id = job.tenant_id))
                  where media.id = episode.media_asset_id
                    and media.owner_type = 'tenant'
                    and media.owner_tenant_id = job.tenant_id
                    and media.kind = 'video' and media.status = 'ready'
                    and media.transcode_status in ('ready', 'not_required')
                    and media.deleted_at is null and media.object_key is not null
                    and media.source_url is null
                )
                or (
                  episode.preview_media_asset_id is not null
                  and not exists (
                    select 1 from media_assets as preview
                    inner join storage_providers as preview_provider
                      on preview_provider.id = preview.storage_provider_id
                      and preview_provider.provider = 's3'
                      and preview_provider.status = 'active'
                      and (preview_provider.owner_type = 'platform'
                        or (preview_provider.owner_type = 'tenant'
                          and preview_provider.owner_tenant_id = job.tenant_id))
                    where preview.id = episode.preview_media_asset_id
                      and preview.id <> episode.media_asset_id
                      and preview.owner_type = 'tenant'
                      and preview.owner_tenant_id = job.tenant_id
                      and preview.kind = 'video' and preview.status = 'ready'
                      and preview.transcode_status in ('ready', 'not_required')
                      and preview.deleted_at is null and preview.object_key is not null
                      and preview.source_url is null
                  )
                )
              )
          ) as content_available,
          tenant.status = 'active'
            and tenant.expires_at > statement_timestamp()
            and tenant.user_site_enabled
            and tenant.platform_site_enabled as tenant_available
        from content_schedule_jobs as job
        inner join dramas as drama
          on drama.id = job.target_id
          and drama.owner_type = 'tenant'
          and drama.owner_tenant_id = job.tenant_id
          and drama.deleted_at is null
        inner join tenants as tenant on tenant.id = job.tenant_id
        where job.id = ${job.id}
          and job.status = 'processing'
          and job.locked_by = ${this.workerId}
        for update of job, drama
    `;
    const state = rows[0];
    if (!state) {
      await this.updateFailure(transaction, job, 'schedule target is unavailable', false);
      return 'failed';
    }
    if (!state.tenant_available && job.action === 'publish') {
      await this.updateFailure(transaction, job, 'tenant is not available for publication', true);
      return 'failed';
    }
    if (job.action === 'publish' && !state.content_available) {
      await this.updateFailure(
        transaction,
        job,
        'content episode or preview media is unavailable for publication',
        true,
      );
      return 'failed';
    }

    const allowed = job.action === 'publish'
      ? ['approved', 'published']
      : ['published', 'unpublished'];
    if (!allowed.includes(state.drama_status)) {
      await this.updateFailure(
        transaction,
        job,
        `drama state ${state.drama_status} cannot ${job.action}`,
        false,
      );
      return 'failed';
    }
    const targetStatus = job.action === 'publish' ? 'published' : 'unpublished';
    await transaction`
      update dramas
      set status = ${targetStatus}, version = version + 1, updated_by = null
      where id = ${job.target_id} and status <> ${targetStatus}
    `;
    if (job.action === 'publish') {
      await transaction`
        update episodes
        set
          status = case
            when unpublish_at is not null
              and unpublish_at <= statement_timestamp() then 'unpublished'
            when release_at is null or release_at <= statement_timestamp()
              then 'published'
            else 'approved'
          end,
          version = version + 1,
          updated_by = null
        where drama_id = ${job.target_id}
          and deleted_at is null
          and status in ('approved', 'published')
          and status is distinct from case
            when unpublish_at is not null
              and unpublish_at <= statement_timestamp() then 'unpublished'
            when release_at is null or release_at <= statement_timestamp()
              then 'published'
            else 'approved'
          end
      `;
    } else {
      await transaction`
        update episodes
        set status = 'unpublished', version = version + 1, updated_by = null
        where drama_id = ${job.target_id}
          and deleted_at is null
          and status = 'published'
      `;
    }
    await this.completeTargetJob(transaction, job, targetStatus, job.target_id);
    return 'completed';
  }

  private async executeEpisodeJob(
    transaction: DatabaseTransaction,
    job: TenantScheduleJob,
  ): Promise<'completed' | 'failed'> {
    const rows = await transaction<
      Array<{
        drama_id: string;
        episode_status: string;
        media_available: boolean;
        parent_status: string;
        preview_available: boolean;
        tenant_available: boolean;
        unpublish_elapsed: boolean;
      }>
    >`
      select
        drama.id as drama_id,
        drama.status as parent_status,
        episode.status as episode_status,
        media.id is not null as media_available,
        episode.preview_media_asset_id is null or preview.id is not null
          as preview_available,
        episode.unpublish_at is not null
          and episode.unpublish_at <= statement_timestamp() as unpublish_elapsed,
        tenant.status = 'active'
          and tenant.expires_at > statement_timestamp()
          and tenant.user_site_enabled
          and tenant.platform_site_enabled as tenant_available
      from content_schedule_jobs as job
      inner join episodes as episode
        on episode.id = job.target_id
        and episode.deleted_at is null
      inner join dramas as drama
        on drama.id = episode.drama_id
        and drama.owner_type = 'tenant'
        and drama.owner_tenant_id = job.tenant_id
        and drama.deleted_at is null
      inner join tenants as tenant on tenant.id = job.tenant_id
      left join media_assets as media on media.id = episode.media_asset_id
        and media.owner_type = 'tenant' and media.owner_tenant_id = job.tenant_id
        and media.kind = 'video' and media.status = 'ready'
        and media.transcode_status in ('ready', 'not_required')
        and media.deleted_at is null and media.object_key is not null
        and media.source_url is null
        and exists (
          select 1 from storage_providers as provider
          where provider.id = media.storage_provider_id
            and provider.provider = 's3' and provider.status = 'active'
            and (provider.owner_type = 'platform'
              or (provider.owner_type = 'tenant'
                and provider.owner_tenant_id = job.tenant_id))
        )
      left join media_assets as preview on preview.id = episode.preview_media_asset_id
        and preview.id <> episode.media_asset_id
        and preview.owner_type = 'tenant' and preview.owner_tenant_id = job.tenant_id
        and preview.kind = 'video' and preview.status = 'ready'
        and preview.transcode_status in ('ready', 'not_required')
        and preview.deleted_at is null and preview.object_key is not null
        and preview.source_url is null
        and exists (
          select 1 from storage_providers as preview_provider
          where preview_provider.id = preview.storage_provider_id
            and preview_provider.provider = 's3'
            and preview_provider.status = 'active'
            and (preview_provider.owner_type = 'platform'
              or (preview_provider.owner_type = 'tenant'
                and preview_provider.owner_tenant_id = job.tenant_id))
        )
      where job.id = ${job.id}
        and job.status = 'processing'
        and job.locked_by = ${this.workerId}
      for update of job, episode, drama
    `;
    const state = rows[0];
    if (!state) {
      await this.updateFailure(transaction, job, 'schedule target is unavailable', false);
      return 'failed';
    }
    if (!state.tenant_available && job.action === 'publish') {
      await this.updateFailure(
        transaction,
        job,
        'tenant is not available for publication',
        true,
      );
      return 'failed';
    }
    if (job.action === 'publish' && (!state.media_available || !state.preview_available)) {
      await this.updateFailure(
        transaction,
        job,
        'episode or preview media is unavailable for publication',
        true,
      );
      return 'failed';
    }
    if (
      job.action === 'publish'
      && !['approved', 'published'].includes(state.parent_status)
    ) {
      await this.updateFailure(
        transaction,
        job,
        `parent drama state ${state.parent_status} cannot publish episode`,
        false,
      );
      return 'failed';
    }
    if (job.action === 'publish' && state.unpublish_elapsed) {
      await this.updateFailure(
        transaction,
        job,
        'episode unpublish time has already elapsed',
        false,
      );
      return 'failed';
    }
    const allowed = job.action === 'publish'
      ? ['approved', 'published']
      : ['approved', 'published', 'unpublished'];
    if (!allowed.includes(state.episode_status)) {
      await this.updateFailure(
        transaction,
        job,
        `episode state ${state.episode_status} cannot ${job.action}`,
        false,
      );
      return 'failed';
    }
    const targetStatus = job.action === 'publish' ? 'published' : 'unpublished';
    await transaction`
      update episodes
      set status = ${targetStatus}, version = version + 1, updated_by = null
      where id = ${job.target_id} and status <> ${targetStatus}
    `;
    await this.completeTargetJob(
      transaction,
      job,
      targetStatus,
      state.drama_id,
    );
    return 'completed';
  }

  private async completeTargetJob(
    transaction: DatabaseTransaction,
    job: ScheduleJobRow,
    targetStatus: 'published' | 'unpublished',
    dramaId: string,
  ): Promise<void> {
    await transaction`
      update content_schedule_jobs
      set
        status = 'completed',
        executed_at = statement_timestamp(),
        locked_at = null,
        locked_by = null,
        last_error = null
      where id = ${job.id}
        and status = 'processing'
        and locked_by = ${this.workerId}
    `;

    const eventId = uuidV7();
    const eventType = job.target_type === 'drama'
      ? job.action === 'publish' ? 'ContentPublished' : 'ContentUnpublished'
      : job.action === 'publish' ? 'EpisodePublished' : 'EpisodeUnpublished';
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, ${job.scope_type}, ${job.tenant_id}, ${`event:${eventId}`},
        ${`schedule:${job.id}:${job.action}`}, ${job.target_type}, ${job.target_id},
        ${eventType},
        ${transaction.json({
          dramaId,
          episodeId: job.target_type === 'episode' ? job.target_id : undefined,
          scheduleJobId: job.id,
          targetType: job.target_type,
          tenantId: job.tenant_id ?? undefined,
        })}
      )
    `;
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, request_id
      ) values (
        ${uuidV7()}, ${job.scope_type}, ${job.tenant_id}, 'system', null,
        ${`content.schedule.${job.target_type}.${job.action}`},
        ${job.target_type}, ${job.target_id},
        ${transaction.json({ scheduleJobId: job.id, status: targetStatus })},
        ${`schedule:${job.id}`}
      )
    `;
  }

  private failJob(job: ScheduleJobRow, message: string): Promise<void> {
    return this.database.inPlatformContext(async (transaction) => {
      await this.updateFailure(transaction, job, message, true);
    });
  }

  private async updateFailure(
    transaction: DatabaseTransaction,
    job: ScheduleJobRow,
    message: string,
    retryable: boolean,
  ): Promise<void> {
    const canRetry = retryable && job.attempts < job.max_attempts;
    const delaySeconds = Math.min(3_600, 2 ** Math.min(job.attempts, 10));
    await transaction`
      update content_schedule_jobs
      set
        status = ${canRetry ? 'retry' : 'failed'},
        available_at = statement_timestamp() + (${delaySeconds} * interval '1 second'),
        locked_at = null,
        locked_by = null,
        last_error = ${message}
      where id = ${job.id}
        and status = 'processing'
        and locked_by = ${this.workerId}
    `;
  }
}

function integerEnvironment(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function workerIdentity(): string {
  const value = process.env.WORKER_ID?.trim() || `${hostname()}:${process.pid}`;
  if (!value || value.length > 200) throw new Error('WORKER_ID is invalid');
  return value;
}

function safeErrorMessage(error: unknown): string {
  const value = error instanceof Error ? error.message : 'Unknown schedule failure';
  return value.replace(/[\r\n\t]+/g, ' ').slice(0, 4_000) || 'Unknown schedule failure';
}
