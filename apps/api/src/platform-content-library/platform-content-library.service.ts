import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import {
  CONTENT_LOCALES,
  type CreatePlatformDramaInput,
  type CreatePlatformEpisodeInput,
  type CreatePlatformTaxonomyInput,
  type DeletePlatformContentInput,
  type DramaTranslationInput,
  type EpisodeTranslationInput,
  type ExpectedVersionInput,
  type PlatformContentMutationMetadata,
  type PlatformDramaRecord,
  type PlatformEpisodeRecord,
  type TaxonomyTranslationInput,
  type UpdatePlatformDramaInput,
  type UpdatePlatformEpisodeInput,
  type UpdatePlatformTaxonomyInput,
} from './platform-content-library.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,127}$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;

interface DramaRow {
  category_id: string | null;
  code: string;
  cover_file_id: string | null;
  created_at: Date;
  deleted_at: Date | null;
  id: string;
  release_at: Date | null;
  restore_until: Date | null;
  status: PlatformDramaRecord['status'];
  tag_ids: string[];
  total_episodes: number;
  translations: DramaTranslationInput[];
  unpublish_at: Date | null;
  version: number;
}

interface EpisodeRow {
  drama_id: string;
  duration_seconds: number;
  episode_no: number;
  id: string;
  media_asset_id: string;
  preview_media_asset_id: string | null;
  preview_seconds: number;
  release_at: Date | null;
  status: PlatformEpisodeRecord['status'];
  translations: EpisodeTranslationInput[];
  unpublish_at: Date | null;
  version: number;
}

interface CommandRow {
  id: string;
  request_hash: string;
  response_json: unknown;
  status: string;
}

type TaxonomyType = 'category' | 'tag';

@Injectable()
export class PlatformContentLibraryService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async listDramas(rawQuery: Record<string, unknown>) {
    const page = pageValue(rawQuery.page);
    const pageSize = pageSizeValue(rawQuery.pageSize);
    const includeDeleted = booleanValue(rawQuery.deleted, 'deleted', false);
    const status = optionalEnum(rawQuery.status, 'status', [
      'draft', 'approved', 'published', 'unpublished', 'rejected',
    ] as const);
    assertOnlyKeys(rawQuery, ['page', 'pageSize', 'deleted', 'status']);
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<DramaRow[]>`
        select
          drama.id, drama.code::text as code, drama.status, drama.release_at,
          drama.unpublish_at, drama.cover_file_id, drama.category_id,
          drama.total_episodes, drama.deleted_at, drama.restore_until,
          drama.version, drama.created_at,
          coalesce((
            select jsonb_agg(jsonb_build_object(
              'locale', t.locale, 'title', t.title, 'summary', t.summary,
              'searchKeywords', t.search_keywords
            ) order by t.locale)
            from drama_translations as t where t.drama_id = drama.id
          ), '[]'::jsonb) as translations,
          coalesce((
            select jsonb_agg(dt.tag_id order by dt.tag_id)
            from drama_tags as dt where dt.drama_id = drama.id
          ), '[]'::jsonb) as tag_ids
        from dramas as drama
        where drama.owner_type = 'platform'
          and drama.owner_tenant_id is null
          and (${includeDeleted} or drama.deleted_at is null)
          and (${status ?? null}::text is null or drama.status = ${status ?? null})
        order by drama.created_at desc, drama.id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      const totals = await transaction<Array<{ count: number }>>`
        select count(*)::integer as count
        from dramas as drama
        where drama.owner_type = 'platform'
          and drama.owner_tenant_id is null
          and (${includeDeleted} or drama.deleted_at is null)
          and (${status ?? null}::text is null or drama.status = ${status ?? null})
      `;
      return {
        items: rows.map(mapDrama),
        page,
        pageSize,
        total: totals[0]?.count ?? 0,
      };
    });
  }

  async getDrama(dramaId: string): Promise<PlatformDramaRecord> {
    assertUuid(dramaId, 'dramaId');
    return this.database.inPlatformContext(async (transaction) => {
      const row = await this.findDrama(transaction, dramaId, true);
      if (!row) throw new NotFoundException('Platform drama not found');
      const episodes = await this.listEpisodes(transaction, dramaId);
      return { ...mapDrama(row), episodes };
    });
  }

  async createDrama(
    rawInput: CreatePlatformDramaInput,
    metadata: PlatformContentMutationMetadata,
  ): Promise<PlatformDramaRecord> {
    const input = validateCreateDrama(rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<PlatformDramaRecord>(transaction, {
        metadata,
        request: input,
        routeKey: 'platform.content_library.drama.create',
      });
      if (command.cached) return command.cached;
      await this.assertCategory(transaction, input.categoryId);
      await this.assertCover(transaction, input.coverMediaAssetId);
      await this.assertTags(transaction, input.tagIds);
      const id = uuidV7();
      try {
        await transaction`
          insert into dramas (
            id, owner_type, owner_tenant_id, code, release_at, unpublish_at,
            cover_file_id, category_id, source_type, created_by
          ) values (
            ${id}, 'platform', null, ${input.code}, ${input.releaseAt ?? null},
            ${input.unpublishAt ?? null}, ${input.coverMediaAssetId ?? null},
            ${input.categoryId ?? null}, 'upload', ${metadata.actorId}
          )
        `;
      } catch (error) {
        translateUnique(error, 'Platform drama code already exists');
      }
      await this.replaceDramaTranslations(transaction, id, input.translations);
      await this.replaceDramaTags(transaction, id, input.tagIds, metadata.actorId);
      const row = await this.findDrama(transaction, id, false);
      if (!row) throw new Error('Platform drama could not be loaded');
      const response = mapDrama(row);
      await this.recordMutation(transaction, metadata, {
        action: 'platform.content.drama.create',
        aggregateId: id,
        aggregateType: 'drama',
        after: response,
        eventType: 'PlatformDramaCreated',
      });
      await this.completeCommand(transaction, command.id, response, 201, 'drama', id);
      return response;
    });
  }

  async updateDrama(
    dramaId: string,
    rawInput: UpdatePlatformDramaInput,
    metadata: PlatformContentMutationMetadata,
  ): Promise<PlatformDramaRecord> {
    assertUuid(dramaId, 'dramaId');
    const input = validateUpdateDrama(rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<PlatformDramaRecord>(transaction, {
        metadata,
        request: { dramaId, ...input },
        routeKey: 'platform.content_library.drama.update',
      });
      if (command.cached) return command.cached;
      const current = await this.lockEditableDrama(transaction, dramaId, input.expectedVersion);
      await this.assertCategory(transaction, input.categoryId);
      await this.assertCover(transaction, input.coverMediaAssetId);
      await this.assertTags(transaction, input.tagIds);
      const nextRelease = input.releaseAt === undefined ? current.release_at : input.releaseAt;
      const nextUnpublish = input.unpublishAt === undefined
        ? current.unpublish_at
        : input.unpublishAt;
      assertSchedule(nextRelease, nextUnpublish);
      try {
        const updated = await transaction<{ id: string }[]>`
          update dramas set
            code = coalesce(${input.code ?? null}, code),
            category_id = case when ${input.hasCategory} then ${input.categoryId ?? null} else category_id end,
            cover_file_id = case when ${input.hasCover} then ${input.coverMediaAssetId ?? null} else cover_file_id end,
            release_at = case when ${input.hasRelease} then ${input.releaseAt ?? null} else release_at end,
            unpublish_at = case when ${input.hasUnpublish} then ${input.unpublishAt ?? null} else unpublish_at end,
            version = version + 1,
            updated_by = ${metadata.actorId}
          where id = ${dramaId} and owner_type = 'platform'
            and owner_tenant_id is null and version = ${input.expectedVersion}
            and deleted_at is null and status in ('draft', 'unpublished', 'rejected')
          returning id
        `;
        if (!updated[0]) throw new ConflictException('Platform drama changed concurrently');
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        translateUnique(error, 'Platform drama code already exists');
      }
      if (input.translations) {
        await transaction`delete from drama_translations where drama_id = ${dramaId}`;
        await this.replaceDramaTranslations(transaction, dramaId, input.translations);
      }
      if (input.tagIds) {
        await transaction`delete from drama_tags where drama_id = ${dramaId}`;
        await this.replaceDramaTags(transaction, dramaId, input.tagIds, metadata.actorId);
      }
      const row = await this.findDrama(transaction, dramaId, false);
      if (!row) throw new NotFoundException('Platform drama not found');
      const response = mapDrama(row);
      await this.recordMutation(transaction, metadata, {
        action: 'platform.content.drama.update', aggregateId: dramaId,
        aggregateType: 'drama', after: response, eventType: 'PlatformDramaUpdated',
      });
      await this.completeCommand(transaction, command.id, response, 200, 'drama', dramaId);
      return response;
    });
  }

  async addEpisode(
    dramaId: string,
    rawInput: CreatePlatformEpisodeInput,
    metadata: PlatformContentMutationMetadata,
  ): Promise<PlatformEpisodeRecord & { dramaVersion: number }> {
    assertUuid(dramaId, 'dramaId');
    const input = validateCreateEpisode(rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<PlatformEpisodeRecord & { dramaVersion: number }>(
        transaction,
        { metadata, request: { dramaId, ...input }, routeKey: 'platform.content_library.episode.create' },
      );
      if (command.cached) return command.cached;
      await this.lockEditableDrama(transaction, dramaId, input.expectedDramaVersion);
      await this.assertVideo(transaction, input.mediaAssetId);
      if (input.previewMediaAssetId) {
        await this.assertVideo(transaction, input.previewMediaAssetId);
        assertSeparatePreview(input.mediaAssetId, input.previewMediaAssetId);
      }
      const id = uuidV7();
      try {
        await transaction`
          insert into episodes (
            id, drama_id, episode_no, release_at, unpublish_at,
            duration_seconds, media_asset_id, preview_media_asset_id,
            preview_seconds, created_by
          ) values (
            ${id}, ${dramaId}, ${input.episodeNo}, ${input.releaseAt ?? null},
            ${input.unpublishAt ?? null}, ${input.durationSeconds}, ${input.mediaAssetId},
            ${input.previewMediaAssetId ?? null},
            ${input.previewSeconds}, ${metadata.actorId}
          )
        `;
      } catch (error) {
        translateUnique(error, 'Episode number already exists');
      }
      await this.replaceEpisodeTranslations(transaction, id, input.translations);
      const dramaUpdated = await transaction<Array<{ version: number }>>`
        update dramas set
          total_episodes = (
            select count(*)::integer from episodes
            where drama_id = ${dramaId} and deleted_at is null
          ),
          version = version + 1,
          updated_by = ${metadata.actorId}
        where id = ${dramaId} and version = ${input.expectedDramaVersion}
        returning version
      `;
      if (!dramaUpdated[0]) throw new ConflictException('Platform drama changed concurrently');
      const row = await this.findEpisode(transaction, dramaId, id);
      if (!row) throw new Error('Platform episode could not be loaded');
      const response = { ...mapEpisode(row), dramaVersion: dramaUpdated[0].version };
      await this.recordMutation(transaction, metadata, {
        action: 'platform.content.episode.create', aggregateId: id,
        aggregateType: 'episode', after: response, eventType: 'PlatformEpisodeCreated',
      });
      await this.completeCommand(transaction, command.id, response, 201, 'episode', id);
      return response;
    });
  }

  async updateEpisode(
    dramaId: string,
    episodeId: string,
    rawInput: UpdatePlatformEpisodeInput,
    metadata: PlatformContentMutationMetadata,
  ): Promise<PlatformEpisodeRecord> {
    assertUuid(dramaId, 'dramaId');
    assertUuid(episodeId, 'episodeId');
    const input = validateUpdateEpisode(rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<PlatformEpisodeRecord>(transaction, {
        metadata,
        request: { dramaId, episodeId, ...input },
        routeKey: 'platform.content_library.episode.update',
      });
      if (command.cached) return command.cached;
      const parents = await transaction<Array<{ status: string }>>`
        select status from dramas where id = ${dramaId}
          and owner_type = 'platform' and owner_tenant_id is null
          and deleted_at is null
        for update
      `;
      if (!parents[0]) throw new NotFoundException('Platform drama not found');
      if (!['draft', 'unpublished', 'rejected'].includes(parents[0].status)) {
        throw new ConflictException('Unpublish the platform drama before editing episodes');
      }
      const current = await this.findEpisode(transaction, dramaId, episodeId, true);
      if (!current) throw new NotFoundException('Platform episode not found');
      if (current.version !== input.expectedVersion) {
        throw new ConflictException('Platform episode changed concurrently');
      }
      if (input.mediaAssetId) await this.assertVideo(transaction, input.mediaAssetId);
      if (input.previewMediaAssetId) await this.assertVideo(transaction, input.previewMediaAssetId);
      const nextMediaAssetId = input.mediaAssetId ?? current.media_asset_id;
      const nextPreviewMediaAssetId = input.hasPreviewMedia
        ? input.previewMediaAssetId
        : current.preview_media_asset_id;
      assertSeparatePreview(nextMediaAssetId, nextPreviewMediaAssetId);
      const nextRelease = input.releaseAt === undefined ? current.release_at : input.releaseAt;
      const nextUnpublish = input.unpublishAt === undefined
        ? current.unpublish_at
        : input.unpublishAt;
      assertSchedule(nextRelease, nextUnpublish);
      const nextDuration = input.durationSeconds ?? current.duration_seconds;
      const nextPreview = input.previewSeconds ?? current.preview_seconds;
      if (nextPreview > nextDuration) {
        throw new BadRequestException('previewSeconds must not exceed durationSeconds');
      }
      try {
        const updated = await transaction<{ id: string }[]>`
          update episodes set
            episode_no = coalesce(${input.episodeNo ?? null}, episode_no),
            duration_seconds = coalesce(${input.durationSeconds ?? null}, duration_seconds),
            preview_seconds = coalesce(${input.previewSeconds ?? null}, preview_seconds),
            media_asset_id = coalesce(${input.mediaAssetId ?? null}, media_asset_id),
            preview_media_asset_id = case when ${input.hasPreviewMedia}
              then ${input.previewMediaAssetId ?? null}::uuid else preview_media_asset_id end,
            release_at = case when ${input.hasRelease} then ${input.releaseAt ?? null} else release_at end,
            unpublish_at = case when ${input.hasUnpublish} then ${input.unpublishAt ?? null} else unpublish_at end,
            status = case when status = 'published' then 'unpublished' else status end,
            version = version + 1,
            updated_by = ${metadata.actorId}
          where id = ${episodeId} and drama_id = ${dramaId}
            and version = ${input.expectedVersion} and deleted_at is null
          returning id
        `;
        if (!updated[0]) throw new ConflictException('Platform episode changed concurrently');
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        translateUnique(error, 'Episode number already exists');
      }
      if (input.translations) {
        await transaction`delete from episode_translations where episode_id = ${episodeId}`;
        await this.replaceEpisodeTranslations(transaction, episodeId, input.translations);
      }
      const row = await this.findEpisode(transaction, dramaId, episodeId);
      if (!row) throw new NotFoundException('Platform episode not found');
      const response = mapEpisode(row);
      await this.recordMutation(transaction, metadata, {
        action: 'platform.content.episode.update', aggregateId: episodeId,
        aggregateType: 'episode', after: response, eventType: 'PlatformEpisodeUpdated',
      });
      await this.completeCommand(transaction, command.id, response, 200, 'episode', episodeId);
      return response;
    });
  }

  async publishDrama(
    dramaId: string,
    rawInput: ExpectedVersionInput,
    metadata: PlatformContentMutationMetadata,
  ): Promise<PlatformDramaRecord & { publication: 'published' | 'scheduled' }> {
    assertUuid(dramaId, 'dramaId');
    const input = validateExpectedVersion(rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<PlatformDramaRecord & {
        publication: 'published' | 'scheduled';
      }>(transaction, {
        metadata, request: { dramaId, ...input }, routeKey: 'platform.content_library.drama.publish',
      });
      if (command.cached) return command.cached;
      const drama = await this.lockDrama(transaction, dramaId);
      if (!drama) throw new NotFoundException('Platform drama not found');
      if (drama.deleted_at) throw new ConflictException('Deleted platform drama cannot publish');
      if (drama.version !== input.expectedVersion) {
        throw new ConflictException('Platform drama changed concurrently');
      }
      if (!['draft', 'unpublished', 'rejected', 'approved'].includes(drama.status)) {
        throw new ConflictException('Platform drama cannot be published from its current state');
      }
      await this.assertPublicationReady(transaction, dramaId, drama);
      const statusRows = await transaction<Array<{ status: 'approved' | 'published' }>>`
        update dramas set
          status = case
            when release_at is not null and release_at > statement_timestamp()
              then 'approved'
            else 'published'
          end,
          version = version + 1,
          updated_by = ${metadata.actorId}
        where id = ${dramaId} and version = ${input.expectedVersion}
        returning status
      `;
      const nextStatus = statusRows[0]?.status;
      if (!nextStatus) throw new ConflictException('Platform drama changed concurrently');
      const episodes = await transaction<Array<{
        id: string;
        release_at: Date | null;
        release_future: boolean;
        unpublish_at: Date | null;
        unpublish_future: boolean;
      }>>`
        select id, release_at, unpublish_at,
          release_at is not null and release_at > statement_timestamp() as release_future,
          unpublish_at is not null and unpublish_at > statement_timestamp() as unpublish_future
        from episodes
        where drama_id = ${dramaId} and deleted_at is null
        order by episode_no, id
        for update
      `;
      await transaction`
        update episodes set
          status = case
            when unpublish_at is not null and unpublish_at <= statement_timestamp()
              then 'unpublished'
            when ${nextStatus} = 'published'
              and (release_at is null or release_at <= statement_timestamp())
              then 'published'
            else 'approved'
          end,
          version = version + 1,
          updated_by = ${metadata.actorId}
        where drama_id = ${dramaId} and deleted_at is null
      `;
      if (nextStatus === 'approved' && drama.release_at) {
        await this.insertScheduleJob(
          transaction, 'drama', dramaId, 'publish', drama.release_at,
          metadata.actorId, metadata.requestId,
        );
      }
      if (drama.unpublish_at) {
        await this.insertScheduleJob(
          transaction, 'drama', dramaId, 'unpublish', drama.unpublish_at,
          metadata.actorId, metadata.requestId,
        );
      }
      for (const episode of episodes) {
        if (episode.release_at && episode.release_future) {
          await this.insertScheduleJob(
            transaction, 'episode', episode.id, 'publish', episode.release_at,
            metadata.actorId, metadata.requestId,
          );
        }
        if (episode.unpublish_at && episode.unpublish_future) {
          await this.insertScheduleJob(
            transaction, 'episode', episode.id, 'unpublish', episode.unpublish_at,
            metadata.actorId, metadata.requestId,
          );
        }
      }
      await this.insertContentVersion(transaction, dramaId, metadata.actorId);
      const row = await this.findDrama(transaction, dramaId, false);
      if (!row) throw new Error('Published platform drama could not be loaded');
      const response = {
        ...mapDrama(row),
        publication: nextStatus === 'published' ? 'published' as const : 'scheduled' as const,
      };
      await this.recordMutation(transaction, metadata, {
        action: 'platform.content.drama.publish', aggregateId: dramaId,
        aggregateType: 'drama', after: response,
        eventType: nextStatus === 'published' ? 'PlatformDramaPublished' : 'PlatformDramaPublicationScheduled',
      });
      await this.completeCommand(transaction, command.id, response, 200, 'drama', dramaId);
      return response;
    });
  }

  async unpublishDrama(
    dramaId: string,
    rawInput: ExpectedVersionInput,
    metadata: PlatformContentMutationMetadata,
  ): Promise<PlatformDramaRecord> {
    assertUuid(dramaId, 'dramaId');
    const input = validateExpectedVersion(rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<PlatformDramaRecord>(transaction, {
        metadata, request: { dramaId, ...input }, routeKey: 'platform.content_library.drama.unpublish',
      });
      if (command.cached) return command.cached;
      const drama = await this.lockDrama(transaction, dramaId);
      if (!drama) throw new NotFoundException('Platform drama not found');
      if (drama.deleted_at) throw new ConflictException('Deleted platform drama cannot be unpublished');
      if (drama.version !== input.expectedVersion) {
        throw new ConflictException('Platform drama changed concurrently');
      }
      if (!['approved', 'published'].includes(drama.status)) {
        throw new ConflictException('Platform drama is not published or scheduled');
      }
      const updated = await transaction<{ id: string }[]>`
        update dramas set status = 'unpublished', version = version + 1,
          updated_by = ${metadata.actorId}
        where id = ${dramaId} and version = ${input.expectedVersion}
        returning id
      `;
      if (!updated[0]) throw new ConflictException('Platform drama changed concurrently');
      await transaction`
        update episodes set status = 'unpublished', version = version + 1,
          updated_by = ${metadata.actorId}
        where drama_id = ${dramaId} and deleted_at is null
          and status in ('approved', 'published')
      `;
      await transaction`
        update content_schedule_jobs set status = 'cancelled', last_error = null,
          locked_at = null, locked_by = null, updated_by = ${metadata.actorId}
        where scope_type = 'platform' and tenant_id is null
          and (
            (target_type = 'drama' and target_id = ${dramaId})
            or (target_type = 'episode' and target_id in (
              select id from episodes where drama_id = ${dramaId}
            ))
          )
          and status in ('pending', 'retry')
      `;
      const row = await this.findDrama(transaction, dramaId, false);
      if (!row) throw new Error('Unpublished platform drama could not be loaded');
      const response = mapDrama(row);
      await this.recordMutation(transaction, metadata, {
        action: 'platform.content.drama.unpublish', aggregateId: dramaId,
        aggregateType: 'drama', after: response, eventType: 'PlatformDramaUnpublished',
      });
      await this.completeCommand(transaction, command.id, response, 200, 'drama', dramaId);
      return response;
    });
  }

  async deleteDrama(
    dramaId: string,
    rawInput: DeletePlatformContentInput,
    metadata: PlatformContentMutationMetadata,
  ): Promise<{ deletedAt: string; restoreUntil: string; version: number }> {
    assertUuid(dramaId, 'dramaId');
    const input = validateDelete(rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<{
        deletedAt: string; restoreUntil: string; version: number;
      }>(transaction, {
        metadata, request: { dramaId, ...input }, routeKey: 'platform.content_library.drama.delete',
      });
      if (command.cached) return command.cached;
      const drama = await this.lockDrama(transaction, dramaId);
      if (!drama) throw new NotFoundException('Platform drama not found');
      if (drama.deleted_at) throw new ConflictException('Platform drama is already deleted');
      if (drama.version !== input.expectedVersion) {
        throw new ConflictException('Platform drama changed concurrently');
      }
      if (['approved', 'published'].includes(drama.status)) {
        throw new ConflictException('Unpublish the platform drama before deleting it');
      }
      const licenses = await transaction<{ id: string }[]>`
        select license.id
        from content_license_items as item
        inner join content_licenses as license on license.id = item.license_id
        where item.drama_id = ${dramaId}
          and license.status in ('scheduled', 'active')
        limit 1
        for share of license
      `;
      if (licenses[0]) {
        throw new ConflictException('Active or scheduled licenses must be revoked before deletion');
      }
      const rows = await transaction<Array<{
        deleted_at: Date; restore_until: Date; version: number;
      }>>`
        update dramas set
          deleted_at = statement_timestamp(), deleted_by = ${metadata.actorId},
          delete_reason = ${input.reason},
          restore_until = statement_timestamp() + interval '30 days',
          version = version + 1, updated_by = ${metadata.actorId}
        where id = ${dramaId} and version = ${input.expectedVersion}
          and deleted_at is null
        returning deleted_at, restore_until, version
      `;
      const row = rows[0];
      if (!row) throw new ConflictException('Platform drama changed concurrently');
      const historyId = uuidV7();
      await transaction`
        insert into content_deletion_history (
          id, scope_type, tenant_id, target_type, target_id, action,
          previous_status, resulting_status, reason, restore_until,
          actor_type, actor_id
        ) values (
          ${historyId}, 'platform', null, 'drama', ${dramaId}, 'soft_delete',
          ${drama.status}, ${drama.status}, ${input.reason}, ${row.restore_until},
          'platform_staff', ${metadata.actorId}
        )
      `;
      const response = {
        deletedAt: row.deleted_at.toISOString(),
        restoreUntil: row.restore_until.toISOString(),
        version: row.version,
      };
      await this.recordMutation(transaction, metadata, {
        action: 'platform.content.drama.delete', aggregateId: dramaId,
        aggregateType: 'drama', after: response, eventType: 'PlatformDramaDeleted',
      });
      await this.completeCommand(transaction, command.id, response, 200, 'drama', dramaId);
      return response;
    });
  }

  async restoreDrama(
    dramaId: string,
    rawInput: ExpectedVersionInput,
    metadata: PlatformContentMutationMetadata,
  ): Promise<PlatformDramaRecord> {
    assertUuid(dramaId, 'dramaId');
    const input = validateExpectedVersion(rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<PlatformDramaRecord>(transaction, {
        metadata, request: { dramaId, ...input }, routeKey: 'platform.content_library.drama.restore',
      });
      if (command.cached) return command.cached;
      const drama = await this.lockDrama(transaction, dramaId);
      if (!drama) throw new NotFoundException('Platform drama not found');
      if (!drama.deleted_at || !drama.restore_until) {
        throw new ConflictException('Platform drama is not restorable');
      }
      if (drama.version !== input.expectedVersion) {
        throw new ConflictException('Platform drama changed concurrently');
      }
      const histories = await transaction<Array<{ id: string; previous_status: string }>>`
        select id, previous_status from content_deletion_history
        where scope_type = 'platform' and tenant_id is null
          and target_type = 'drama' and target_id = ${dramaId}
          and action = 'soft_delete'
        order by created_at desc, id desc limit 1
        for share
      `;
      const history = histories[0];
      if (!history) throw new ConflictException('Deletion history is unavailable');
      const rows = await transaction<{ id: string }[]>`
        update dramas set
          deleted_at = null, deleted_by = null, delete_reason = null,
          restore_until = null,
          status = case when ${history.previous_status} = 'published'
            then 'unpublished' else ${history.previous_status} end,
          version = version + 1, updated_by = ${metadata.actorId}
        where id = ${dramaId} and version = ${input.expectedVersion}
          and restore_until > statement_timestamp()
        returning id
      `;
      if (!rows[0]) throw new ConflictException('Restore window has expired');
      await transaction`
        insert into content_deletion_history (
          id, scope_type, tenant_id, target_type, target_id, action,
          restored_from_id, previous_status, resulting_status, reason,
          actor_type, actor_id
        ) values (
          ${uuidV7()}, 'platform', null, 'drama', ${dramaId}, 'restore',
          ${history.id}, ${drama.status},
          ${history.previous_status === 'published' ? 'unpublished' : history.previous_status},
          'restored within retention window', 'platform_staff', ${metadata.actorId}
        )
      `;
      const row = await this.findDrama(transaction, dramaId, false);
      if (!row) throw new Error('Restored platform drama could not be loaded');
      const response = mapDrama(row);
      await this.recordMutation(transaction, metadata, {
        action: 'platform.content.drama.restore', aggregateId: dramaId,
        aggregateType: 'drama', after: response, eventType: 'PlatformDramaRestored',
      });
      await this.completeCommand(transaction, command.id, response, 200, 'drama', dramaId);
      return response;
    });
  }

  async listTaxonomy(type: TaxonomyType, rawQuery: Record<string, unknown>) {
    const page = pageValue(rawQuery.page);
    const pageSize = pageSizeValue(rawQuery.pageSize);
    const includeDeleted = booleanValue(rawQuery.deleted, 'deleted', false);
    assertOnlyKeys(rawQuery, ['page', 'pageSize', 'deleted']);
    const table = taxonomyTable(type);
    const translationTable = taxonomyTranslationTable(type);
    const ownerColumn = taxonomyOwnerColumn(type);
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction.unsafe<Array<{
        code: string; deleted_at: Date | null; id: string; sort_order?: number;
        status: string; translations: TaxonomyTranslationInput[]; version: number;
      }>>(`
        select item.id, item.code::text as code, item.status, item.deleted_at,
          item.version${type === 'category' ? ', item.sort_order' : ''},
          coalesce((select jsonb_agg(jsonb_build_object(
            'locale', t.locale, 'name', t.name
          ) order by t.locale) from ${translationTable} as t
            where t.${ownerColumn} = item.id), '[]'::jsonb) as translations
        from ${table} as item
        where item.owner_type = 'platform' and item.owner_tenant_id is null
          and ($1 or item.deleted_at is null)
        order by ${type === 'category' ? 'item.sort_order, ' : ''}item.code, item.id
        limit $2 offset $3
      `, [includeDeleted, pageSize, (page - 1) * pageSize]);
      const totals = await transaction.unsafe<Array<{ count: number }>>(`
        select count(*)::integer as count from ${table} as item
        where item.owner_type = 'platform' and item.owner_tenant_id is null
          and ($1 or item.deleted_at is null)
      `, [includeDeleted]);
      return {
        items: rows.map((row) => ({
          code: row.code, deletedAt: iso(row.deleted_at), id: row.id,
          ...(type === 'category' ? { sortOrder: row.sort_order ?? 0 } : {}),
          status: row.status, translations: row.translations, version: row.version,
        })),
        page, pageSize, total: totals[0]?.count ?? 0,
      };
    });
  }

  async createTaxonomy(
    type: TaxonomyType,
    rawInput: CreatePlatformTaxonomyInput,
    metadata: PlatformContentMutationMetadata,
  ) {
    const input = validateCreateTaxonomy(type, rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<Record<string, unknown>>(transaction, {
        metadata, request: { type, ...input }, routeKey: `platform.content_library.${type}.create`,
      });
      if (command.cached) return command.cached;
      const id = uuidV7();
      const table = taxonomyTable(type);
      try {
        await transaction.unsafe(`
          insert into ${table} (
            id, owner_type, owner_tenant_id, code${type === 'category' ? ', sort_order' : ''},
            status, created_by
          ) values ($1, 'platform', null, $2${type === 'category' ? ', $3' : ''},
            $${type === 'category' ? 4 : 3}, $${type === 'category' ? 5 : 4})
        `, type === 'category'
          ? [id, input.code, input.sortOrder, input.status, metadata.actorId]
          : [id, input.code, input.status, metadata.actorId]);
      } catch (error) {
        translateUnique(error, `Platform ${type} code already exists`);
      }
      await this.replaceTaxonomyTranslations(transaction, type, id, input.translations);
      const response = {
        code: input.code, id,
        ...(type === 'category' ? { sortOrder: input.sortOrder } : {}),
        status: input.status, translations: input.translations, version: 0,
      };
      await this.recordMutation(transaction, metadata, {
        action: `platform.content.${type}.create`, aggregateId: id,
        aggregateType: type, after: response,
        eventType: type === 'category' ? 'PlatformCategoryCreated' : 'PlatformTagCreated',
      });
      await this.completeCommand(transaction, command.id, response, 201, type, id);
      return response;
    });
  }

  async updateTaxonomy(
    type: TaxonomyType,
    id: string,
    rawInput: UpdatePlatformTaxonomyInput,
    metadata: PlatformContentMutationMetadata,
  ) {
    assertUuid(id, `${type}Id`);
    const input = validateUpdateTaxonomy(type, rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<Record<string, unknown>>(transaction, {
        metadata, request: { id, type, ...input }, routeKey: `platform.content_library.${type}.update`,
      });
      if (command.cached) return command.cached;
      const table = taxonomyTable(type);
      const current = await transaction.unsafe<Array<{
        code: string; sort_order?: number; status: string; version: number;
      }>>(`
        select code::text as code, status, version${type === 'category' ? ', sort_order' : ''}
        from ${table} where id = $1 and owner_type = 'platform'
          and owner_tenant_id is null and deleted_at is null for update
      `, [id]);
      const row = current[0];
      if (!row) throw new NotFoundException(`Platform ${type} not found`);
      if (row.version !== input.expectedVersion) {
        throw new ConflictException(`Platform ${type} changed concurrently`);
      }
      try {
        const updated = await transaction.unsafe<{ version: number }[]>(`
          update ${table} set
            code = coalesce($1, code),
            status = coalesce($2, status),
            ${type === 'category' ? 'sort_order = coalesce($3, sort_order),' : ''}
            version = version + 1, updated_by = $${type === 'category' ? 4 : 3}
          where id = $${type === 'category' ? 5 : 4}
            and version = $${type === 'category' ? 6 : 5}
          returning version
        `, type === 'category'
          ? [input.code ?? null, input.status ?? null, input.sortOrder ?? null,
              metadata.actorId, id, input.expectedVersion]
          : [input.code ?? null, input.status ?? null,
              metadata.actorId, id, input.expectedVersion]);
        if (!updated[0]) throw new ConflictException(`Platform ${type} changed concurrently`);
        row.version = updated[0].version;
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        translateUnique(error, `Platform ${type} code already exists`);
      }
      if (input.translations) {
        const translationTable = taxonomyTranslationTable(type);
        const ownerColumn = taxonomyOwnerColumn(type);
        await transaction.unsafe(`delete from ${translationTable} where ${ownerColumn} = $1`, [id]);
        await this.replaceTaxonomyTranslations(transaction, type, id, input.translations);
      }
      const translations = input.translations ?? await this.loadTaxonomyTranslations(transaction, type, id);
      const response = {
        code: input.code ?? row.code, id,
        ...(type === 'category' ? { sortOrder: input.sortOrder ?? row.sort_order ?? 0 } : {}),
        status: input.status ?? row.status, translations, version: row.version,
      };
      await this.recordMutation(transaction, metadata, {
        action: `platform.content.${type}.update`, aggregateId: id,
        aggregateType: type, after: response,
        eventType: type === 'category' ? 'PlatformCategoryUpdated' : 'PlatformTagUpdated',
      });
      await this.completeCommand(transaction, command.id, response, 200, type, id);
      return response;
    });
  }

  async deleteTaxonomy(
    type: TaxonomyType,
    id: string,
    rawInput: DeletePlatformContentInput,
    metadata: PlatformContentMutationMetadata,
  ) {
    assertUuid(id, `${type}Id`);
    const input = validateDelete(rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<Record<string, unknown>>(transaction, {
        metadata, request: { id, type, ...input }, routeKey: `platform.content_library.${type}.delete`,
      });
      if (command.cached) return command.cached;
      const table = taxonomyTable(type);
      const current = await transaction.unsafe<Array<{ status: string; version: number }>>(`
        select status, version from ${table} where id = $1
          and owner_type = 'platform' and owner_tenant_id is null
          and deleted_at is null for update
      `, [id]);
      const row = current[0];
      if (!row) throw new NotFoundException(`Platform ${type} not found`);
      if (row.version !== input.expectedVersion) {
        throw new ConflictException(`Platform ${type} changed concurrently`);
      }
      const referenced = type === 'category'
        ? await transaction<{ id: string }[]>`
            select id from dramas where category_id = ${id} limit 1 for share
          `
        : await transaction<{ id: string }[]>`
            select drama_id as id from drama_tags where tag_id = ${id} limit 1 for share
          `;
      if (referenced[0]) throw new ConflictException(`Referenced platform ${type} cannot be deleted`);
      const updated = await transaction.unsafe<Array<{
        deleted_at: Date; restore_until: Date; version: number;
      }>>(`
        update ${table} set deleted_at = statement_timestamp(), deleted_by = $1,
          delete_reason = $2, restore_until = statement_timestamp() + interval '30 days',
          version = version + 1, updated_by = $1
        where id = $3 and version = $4
        returning deleted_at, restore_until, version
      `, [metadata.actorId, input.reason, id, input.expectedVersion]);
      const result = updated[0];
      if (!result) throw new ConflictException(`Platform ${type} changed concurrently`);
      await transaction`
        insert into content_deletion_history (
          id, scope_type, tenant_id, target_type, target_id, action,
          previous_status, resulting_status, reason, restore_until,
          actor_type, actor_id
        ) values (
          ${uuidV7()}, 'platform', null, ${type}, ${id}, 'soft_delete',
          ${row.status}, ${row.status}, ${input.reason}, ${result.restore_until},
          'platform_staff', ${metadata.actorId}
        )
      `;
      const response = {
        deletedAt: result.deleted_at.toISOString(),
        restoreUntil: result.restore_until.toISOString(), version: result.version,
      };
      await this.recordMutation(transaction, metadata, {
        action: `platform.content.${type}.delete`, aggregateId: id,
        aggregateType: type, after: response,
        eventType: type === 'category' ? 'PlatformCategoryDeleted' : 'PlatformTagDeleted',
      });
      await this.completeCommand(transaction, command.id, response, 200, type, id);
      return response;
    });
  }

  async restoreTaxonomy(
    type: TaxonomyType,
    id: string,
    rawInput: ExpectedVersionInput,
    metadata: PlatformContentMutationMetadata,
  ) {
    assertUuid(id, `${type}Id`);
    const input = validateExpectedVersion(rawInput);
    assertMetadata(metadata);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<Record<string, unknown>>(transaction, {
        metadata,
        request: { id, type, ...input },
        routeKey: `platform.content_library.${type}.restore`,
      });
      if (command.cached) return command.cached;
      const table = taxonomyTable(type);
      const current = await transaction.unsafe<Array<{
        code: string;
        restore_until: Date | null;
        status: string;
        version: number;
        sort_order?: number;
      }>>(`
        select code::text as code, status, restore_until, version
          ${type === 'category' ? ', sort_order' : ''}
        from ${table} where id = $1 and owner_type = 'platform'
          and owner_tenant_id is null and deleted_at is not null for update
      `, [id]);
      const row = current[0];
      if (!row || !row.restore_until) throw new ConflictException(`Platform ${type} is not restorable`);
      if (row.version !== input.expectedVersion) {
        throw new ConflictException(`Platform ${type} changed concurrently`);
      }
      const histories = await transaction<Array<{ id: string }>>`
        select id from content_deletion_history
        where scope_type = 'platform' and tenant_id is null
          and target_type = ${type} and target_id = ${id} and action = 'soft_delete'
        order by created_at desc, id desc limit 1 for share
      `;
      if (!histories[0]) throw new ConflictException('Deletion history is unavailable');
      const updated = await transaction.unsafe<Array<{ version: number }>>(`
        update ${table} set deleted_at = null, deleted_by = null,
          delete_reason = null, restore_until = null, version = version + 1,
          updated_by = $1
        where id = $2 and version = $3 and restore_until > statement_timestamp()
        returning version
      `, [metadata.actorId, id, input.expectedVersion]);
      if (!updated[0]) throw new ConflictException('Restore window has expired');
      await transaction`
        insert into content_deletion_history (
          id, scope_type, tenant_id, target_type, target_id, action,
          restored_from_id, previous_status, resulting_status, reason,
          actor_type, actor_id
        ) values (
          ${uuidV7()}, 'platform', null, ${type}, ${id}, 'restore',
          ${histories[0].id}, ${row.status}, ${row.status},
          'restored within retention window', 'platform_staff', ${metadata.actorId}
        )
      `;
      const translations = await this.loadTaxonomyTranslations(transaction, type, id);
      const response = {
        code: row.code, id,
        ...(type === 'category' ? { sortOrder: row.sort_order ?? 0 } : {}),
        status: row.status, translations, version: updated[0].version,
      };
      await this.recordMutation(transaction, metadata, {
        action: `platform.content.${type}.restore`, aggregateId: id,
        aggregateType: type, after: response,
        eventType: type === 'category' ? 'PlatformCategoryRestored' : 'PlatformTagRestored',
      });
      await this.completeCommand(transaction, command.id, response, 200, type, id);
      return response;
    });
  }

  private async lockEditableDrama(
    transaction: DatabaseTransaction,
    dramaId: string,
    expectedVersion: number,
  ): Promise<DramaRow> {
    const drama = await this.lockDrama(transaction, dramaId);
    if (!drama || drama.deleted_at) throw new NotFoundException('Platform drama not found');
    if (drama.version !== expectedVersion) {
      throw new ConflictException('Platform drama changed concurrently');
    }
    if (!['draft', 'unpublished', 'rejected'].includes(drama.status)) {
      throw new ConflictException('Unpublish the platform drama before editing it');
    }
    return drama;
  }

  private async lockDrama(transaction: DatabaseTransaction, dramaId: string) {
    const rows = await transaction<DramaRow[]>`
      select
        drama.id, drama.code::text as code, drama.status, drama.release_at,
        drama.unpublish_at, drama.cover_file_id, drama.category_id,
        drama.total_episodes, drama.deleted_at, drama.restore_until,
        drama.version, drama.created_at,
        coalesce((select jsonb_agg(jsonb_build_object(
          'locale', t.locale, 'title', t.title, 'summary', t.summary,
          'searchKeywords', t.search_keywords
        ) order by t.locale) from drama_translations as t
          where t.drama_id = drama.id), '[]'::jsonb) as translations,
        coalesce((select jsonb_agg(dt.tag_id order by dt.tag_id)
          from drama_tags as dt where dt.drama_id = drama.id), '[]'::jsonb) as tag_ids
      from dramas as drama where drama.id = ${dramaId}
        and drama.owner_type = 'platform' and drama.owner_tenant_id is null
      for update of drama
    `;
    return rows[0];
  }

  private async findDrama(
    transaction: DatabaseTransaction,
    dramaId: string,
    includeDeleted: boolean,
  ) {
    const rows = await transaction<DramaRow[]>`
      select
        drama.id, drama.code::text as code, drama.status, drama.release_at,
        drama.unpublish_at, drama.cover_file_id, drama.category_id,
        drama.total_episodes, drama.deleted_at, drama.restore_until,
        drama.version, drama.created_at,
        coalesce((select jsonb_agg(jsonb_build_object(
          'locale', t.locale, 'title', t.title, 'summary', t.summary,
          'searchKeywords', t.search_keywords
        ) order by t.locale) from drama_translations as t
          where t.drama_id = drama.id), '[]'::jsonb) as translations,
        coalesce((select jsonb_agg(dt.tag_id order by dt.tag_id)
          from drama_tags as dt where dt.drama_id = drama.id), '[]'::jsonb) as tag_ids
      from dramas as drama where drama.id = ${dramaId}
        and drama.owner_type = 'platform' and drama.owner_tenant_id is null
        and (${includeDeleted} or drama.deleted_at is null)
    `;
    return rows[0];
  }

  private async listEpisodes(transaction: DatabaseTransaction, dramaId: string) {
    const rows = await transaction<EpisodeRow[]>`
      select episode.id, episode.drama_id, episode.episode_no, episode.status,
        episode.release_at, episode.unpublish_at, episode.duration_seconds,
        episode.media_asset_id, episode.preview_media_asset_id,
        episode.preview_seconds, episode.version,
        coalesce((select jsonb_agg(jsonb_build_object(
          'locale', t.locale, 'title', t.title
        ) order by t.locale) from episode_translations as t
          where t.episode_id = episode.id), '[]'::jsonb) as translations
      from episodes as episode where episode.drama_id = ${dramaId}
        and episode.deleted_at is null order by episode.episode_no, episode.id
    `;
    return rows.map(mapEpisode);
  }

  private async findEpisode(
    transaction: DatabaseTransaction,
    dramaId: string,
    episodeId: string,
    forUpdate = false,
  ) {
    if (forUpdate) {
      const rows = await transaction<EpisodeRow[]>`
        select episode.id, episode.drama_id, episode.episode_no, episode.status,
          episode.release_at, episode.unpublish_at, episode.duration_seconds,
          episode.media_asset_id, episode.preview_media_asset_id,
          episode.preview_seconds, episode.version,
          coalesce((select jsonb_agg(jsonb_build_object(
            'locale', t.locale, 'title', t.title
          ) order by t.locale) from episode_translations as t
            where t.episode_id = episode.id), '[]'::jsonb) as translations
        from episodes as episode where episode.id = ${episodeId}
          and episode.drama_id = ${dramaId} and episode.deleted_at is null
        for update of episode
      `;
      return rows[0];
    }
    const rows = await transaction<EpisodeRow[]>`
      select episode.id, episode.drama_id, episode.episode_no, episode.status,
        episode.release_at, episode.unpublish_at, episode.duration_seconds,
        episode.media_asset_id, episode.preview_media_asset_id,
        episode.preview_seconds, episode.version,
        coalesce((select jsonb_agg(jsonb_build_object(
          'locale', t.locale, 'title', t.title
        ) order by t.locale) from episode_translations as t
          where t.episode_id = episode.id), '[]'::jsonb) as translations
      from episodes as episode where episode.id = ${episodeId}
        and episode.drama_id = ${dramaId} and episode.deleted_at is null
    `;
    return rows[0];
  }

  private async assertCategory(transaction: DatabaseTransaction, id: string | null | undefined) {
    if (!id) return;
    const rows = await transaction<{ id: string }[]>`
      select id from categories where id = ${id}
        and owner_type = 'platform' and owner_tenant_id is null
        and status = 'active' and deleted_at is null for share
    `;
    if (!rows[0]) throw new BadRequestException('Platform category is unavailable');
  }

  private async assertTags(transaction: DatabaseTransaction, ids: string[] | undefined) {
    if (ids === undefined || ids.length === 0) return;
    const rows = await transaction<{ count: number }[]>`
      select count(*)::integer as count from tags where id = any(${ids})
        and owner_type = 'platform' and owner_tenant_id is null
        and status = 'active' and deleted_at is null
    `;
    if (rows[0]?.count !== ids.length) {
      throw new BadRequestException('One or more platform tags are unavailable');
    }
  }

  private async assertCover(transaction: DatabaseTransaction, id: string | null | undefined) {
    if (!id) return;
    const rows = await transaction<{ id: string }[]>`
      select media.id from media_assets as media
      inner join storage_providers as provider on provider.id = media.storage_provider_id
      where media.id = ${id} and media.owner_type = 'platform'
        and media.owner_tenant_id is null and media.kind = 'image'
        and media.status = 'ready' and media.deleted_at is null
        and media.object_key is not null and media.source_url is null
        and provider.owner_type = 'platform' and provider.owner_tenant_id is null
        and provider.provider = 's3' and provider.status = 'active'
      for share of media, provider
    `;
    if (!rows[0]) throw new BadRequestException('Platform cover media is unavailable');
  }

  private async assertVideo(transaction: DatabaseTransaction, id: string) {
    const rows = await transaction<{ id: string }[]>`
      select media.id from media_assets as media
      inner join storage_providers as provider on provider.id = media.storage_provider_id
      where media.id = ${id} and media.owner_type = 'platform'
        and media.owner_tenant_id is null and media.kind = 'video'
        and media.status = 'ready' and media.transcode_status in ('ready', 'not_required')
        and media.deleted_at is null and media.object_key is not null
        and media.source_url is null and provider.owner_type = 'platform'
        and provider.owner_tenant_id is null and provider.provider = 's3'
        and provider.status = 'active'
      for share of media, provider
    `;
    if (!rows[0]) throw new BadRequestException('Platform episode media is unavailable');
  }

  private async assertPublicationReady(
    transaction: DatabaseTransaction,
    dramaId: string,
    drama: DramaRow,
  ) {
    if (!drama.cover_file_id) throw new ConflictException('A ready platform cover is required');
    if (drama.translations.length < 1) throw new ConflictException('Drama translations are required');
    await this.assertCover(transaction, drama.cover_file_id);
    if (drama.category_id) await this.assertCategory(transaction, drama.category_id);
    await this.assertTags(transaction, drama.tag_ids);
    const rows = await transaction<Array<{
      episode_count: number; invalid_count: number; invalid_preview_count: number;
      translation_count: number;
      viable_count: number;
    }>>`
      select count(*)::integer as episode_count,
        count(*) filter (where media.id is null)::integer as invalid_count,
        count(*) filter (
          where episode.preview_media_asset_id is not null
            and preview.id is null
        )::integer as invalid_preview_count,
        count(*) filter (where not exists (
          select 1 from episode_translations as t where t.episode_id = episode.id
        ))::integer as translation_count,
        count(*) filter (
          where episode.unpublish_at is null
            or episode.unpublish_at > statement_timestamp()
        )::integer as viable_count
      from episodes as episode
      left join media_assets as media on media.id = episode.media_asset_id
        and media.owner_type = 'platform' and media.owner_tenant_id is null
        and media.kind = 'video' and media.status = 'ready'
        and media.transcode_status in ('ready', 'not_required')
        and media.deleted_at is null and media.object_key is not null
        and media.source_url is null
        and exists (
          select 1 from storage_providers as provider
          where provider.id = media.storage_provider_id
            and provider.owner_type = 'platform'
            and provider.owner_tenant_id is null
            and provider.provider = 's3'
            and provider.status = 'active'
        )
      left join media_assets as preview on preview.id = episode.preview_media_asset_id
        and preview.id <> episode.media_asset_id
        and preview.owner_type = 'platform' and preview.owner_tenant_id is null
        and preview.kind = 'video' and preview.status = 'ready'
        and preview.transcode_status in ('ready', 'not_required')
        and preview.deleted_at is null and preview.object_key is not null
        and preview.source_url is null
        and exists (
          select 1 from storage_providers as preview_provider
          where preview_provider.id = preview.storage_provider_id
            and preview_provider.owner_type = 'platform'
            and preview_provider.owner_tenant_id is null
            and preview_provider.provider = 's3'
            and preview_provider.status = 'active'
        )
      where episode.drama_id = ${dramaId} and episode.deleted_at is null
    `;
    const readiness = rows[0];
    if (!readiness || readiness.episode_count < 1) {
      throw new ConflictException('At least one episode is required');
    }
    if (readiness.episode_count > 1000) throw new ConflictException('Episode limit exceeded');
    if (readiness.viable_count < 1) {
      throw new ConflictException('At least one episode must remain within its publication window');
    }
    if (readiness.invalid_count > 0) throw new ConflictException('Every episode needs ready platform video');
    if (readiness.invalid_preview_count > 0) {
      throw new ConflictException('Configured preview media must be a separate ready platform video');
    }
    if (readiness.translation_count > 0) throw new ConflictException('Every episode needs a translation');
    const elapsed = await transaction<{ elapsed: boolean }[]>`
      select ${drama.unpublish_at}::timestamptz is not null
        and ${drama.unpublish_at}::timestamptz <= statement_timestamp() as elapsed
    `;
    if (elapsed[0]?.elapsed) throw new ConflictException('Drama unpublish time has elapsed');
  }

  private async replaceDramaTranslations(
    transaction: DatabaseTransaction,
    dramaId: string,
    translations: DramaTranslationInput[],
  ) {
    for (const item of translations) {
      await transaction`
        insert into drama_translations (
          id, drama_id, locale, title, summary, search_keywords
        ) values (
          ${uuidV7()}, ${dramaId}, ${item.locale}, ${item.title},
          ${item.summary ?? ''}, ${item.searchKeywords ?? []}
        )
      `;
    }
  }

  private async replaceDramaTags(
    transaction: DatabaseTransaction,
    dramaId: string,
    tagIds: string[] | undefined,
    actorId: string,
  ) {
    for (const tagId of tagIds ?? []) {
      await transaction`
        insert into drama_tags (drama_id, tag_id, created_by)
        values (${dramaId}, ${tagId}, ${actorId})
      `;
    }
  }

  private async replaceEpisodeTranslations(
    transaction: DatabaseTransaction,
    episodeId: string,
    translations: EpisodeTranslationInput[],
  ) {
    for (const item of translations) {
      await transaction`
        insert into episode_translations (id, episode_id, locale, title)
        values (${uuidV7()}, ${episodeId}, ${item.locale}, ${item.title})
      `;
    }
  }

  private async replaceTaxonomyTranslations(
    transaction: DatabaseTransaction,
    type: TaxonomyType,
    id: string,
    translations: TaxonomyTranslationInput[],
  ) {
    const table = taxonomyTranslationTable(type);
    const column = taxonomyOwnerColumn(type);
    for (const item of translations) {
      await transaction.unsafe(
        `insert into ${table} (id, ${column}, locale, name) values ($1, $2, $3, $4)`,
        [uuidV7(), id, item.locale, item.name],
      );
    }
  }

  private async loadTaxonomyTranslations(
    transaction: DatabaseTransaction,
    type: TaxonomyType,
    id: string,
  ) {
    const table = taxonomyTranslationTable(type);
    const column = taxonomyOwnerColumn(type);
    return transaction.unsafe<TaxonomyTranslationInput[]>(
      `select locale, name from ${table} where ${column} = $1 order by locale`, [id],
    );
  }

  private async insertScheduleJob(
    transaction: DatabaseTransaction,
    targetType: 'drama' | 'episode',
    targetId: string,
    action: 'publish' | 'unpublish',
    scheduledAt: Date,
    actorId: string,
    generation: string,
  ) {
    const key = `platform:${generation}:${targetType}:${targetId}:${action}`;
    await transaction`
      insert into content_schedule_jobs (
        id, scope_type, tenant_id, target_type, target_id, action,
        scheduled_at, available_at, idempotency_key, created_by
      ) values (
        ${uuidV7()}, 'platform', null, ${targetType}, ${targetId}, ${action},
        ${scheduledAt}, ${scheduledAt}, ${key}, ${actorId}
      ) on conflict do nothing
    `;
  }

  private async insertContentVersion(
    transaction: DatabaseTransaction,
    dramaId: string,
    actorId: string,
  ) {
    const snapshots = await transaction<Array<{ snapshot: object }>>`
      select jsonb_build_object(
        'drama', to_jsonb(drama) - 'created_by' - 'updated_by',
        'translations', coalesce((select jsonb_agg(to_jsonb(t) - 'id' - 'drama_id')
          from drama_translations as t where t.drama_id = drama.id), '[]'::jsonb),
        'episodes', coalesce((select jsonb_agg(
          (
            to_jsonb(episode) - 'created_by' - 'updated_by'
            || jsonb_build_object(
              'translations', coalesce((
                select jsonb_agg(
                  to_jsonb(translation) - 'id' - 'episode_id'
                  order by translation.locale
                ) from episode_translations as translation
                where translation.episode_id = episode.id
              ), '[]'::jsonb),
              'media', (
                select jsonb_build_object(
                  'id', media.id,
                  'checksum', media.checksum,
                  'mimeType', media.mime_type,
                  'sizeBytes', media.size_bytes,
                  'status', media.status,
                  'transcodeStatus', media.transcode_status
                ) from media_assets as media where media.id = episode.media_asset_id
              ),
              'previewMedia', (
                select jsonb_build_object(
                  'id', preview.id,
                  'checksum', preview.checksum,
                  'mimeType', preview.mime_type,
                  'sizeBytes', preview.size_bytes,
                  'status', preview.status,
                  'transcodeStatus', preview.transcode_status
                ) from media_assets as preview
                where preview.id = episode.preview_media_asset_id
              )
            )
          ) order by episode.episode_no
        ) from episodes as episode where episode.drama_id = drama.id
          and episode.deleted_at is null), '[]'::jsonb),
        'tagIds', coalesce((select jsonb_agg(tag_id order by tag_id)
          from drama_tags where drama_id = drama.id), '[]'::jsonb)
      ) as snapshot
      from dramas as drama where drama.id = ${dramaId}
        and drama.owner_type = 'platform' and drama.owner_tenant_id is null
    `;
    const snapshot = snapshots[0]?.snapshot;
    if (!snapshot) throw new Error('Platform content snapshot could not be generated');
    await transaction`
      insert into content_versions (
        id, scope_type, tenant_id, aggregate_type, aggregate_id,
        version_no, snapshot_json, change_level, created_by
      ) select
        ${uuidV7()}, 'platform', null, 'drama', ${dramaId},
        coalesce(max(version_no), 0) + 1, ${transaction.json(toJson(snapshot))},
        'critical', ${actorId}
      from content_versions where scope_type = 'platform'
        and tenant_id is null and aggregate_type = 'drama'
        and aggregate_id = ${dramaId}
    `;
  }

  private async beginCommand<T>(
    transaction: DatabaseTransaction,
    input: { metadata: PlatformContentMutationMetadata; request: unknown; routeKey: string },
  ): Promise<{ cached?: T; id: string }> {
    const key = input.metadata.idempotencyKey.trim();
    if (!IDEMPOTENCY_PATTERN.test(key)) {
      throw new BadRequestException('A valid Idempotency-Key is required');
    }
    const requestHash = createHash('sha256').update(JSON.stringify(toJson(input.request))).digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, 'platform', null, 'platform_staff', ${input.metadata.actorId},
        ${input.routeKey}, ${key}, ${requestHash}, statement_timestamp() + interval '24 hours'
      ) on conflict do nothing returning id
    `;
    if (inserted[0]) return { id };
    const rows = await transaction<CommandRow[]>`
      select id, request_hash, status, response_json from command_idempotency
      where scope_type = 'platform' and tenant_id is null
        and actor_type = 'platform_staff' and actor_id = ${input.metadata.actorId}
        and route_key = ${input.routeKey} and idempotency_key = ${key}
      for update
    `;
    const existing = rows[0];
    if (!existing) throw new ConflictException('Idempotency record is unavailable');
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used for another request');
    }
    if (existing.status === 'completed' && existing.response_json !== null) {
      return { cached: existing.response_json as T, id: existing.id };
    }
    throw new ConflictException('The same command is already processing');
  }

  private async completeCommand(
    transaction: DatabaseTransaction,
    commandId: string,
    response: unknown,
    status: number,
    resourceType: string,
    resourceId: string,
  ) {
    const rows = await transaction<{ id: string }[]>`
      update command_idempotency set status = 'completed', response_status = ${status},
        response_json = ${transaction.json(toJson(response))},
        resource_type = ${resourceType}, resource_id = ${resourceId}, locked_at = null
      where id = ${commandId} and status = 'processing' returning id
    `;
    if (!rows[0]) throw new ConflictException('Idempotency command changed unexpectedly');
  }

  private async recordMutation(
    transaction: DatabaseTransaction,
    metadata: PlatformContentMutationMetadata,
    input: {
      action: string; after: object; aggregateId: string; aggregateType: string; eventType: string;
    },
  ) {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, ip, request_id
      ) values (
        ${uuidV7()}, 'platform', null, 'platform_staff', ${metadata.actorId},
        ${input.action}, ${input.aggregateType}, ${input.aggregateId},
        ${transaction.json(toJson(input.after))}, ${metadata.ip ?? null}, ${metadata.requestId}
      )
    `;
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, 'platform', null, ${`event:${eventId}`},
        ${`${metadata.requestId}:${input.eventType}`}, ${input.aggregateType},
        ${input.aggregateId}, ${input.eventType},
        ${transaction.json(toJson({ id: input.aggregateId, resourceType: input.aggregateType }))}
      )
    `;
  }
}

function validateCreateDrama(value: CreatePlatformDramaInput) {
  const record = inputRecord(value);
  assertOnlyKeys(record, [
    'code', 'categoryId', 'coverMediaAssetId', 'releaseAt', 'tagIds',
    'translations', 'unpublishAt',
  ]);
  const code = codeValue(record.code, 'code');
  const translations = dramaTranslations(record.translations);
  const releaseAt = optionalDate(record.releaseAt, 'releaseAt');
  const unpublishAt = optionalDate(record.unpublishAt, 'unpublishAt');
  assertSchedule(releaseAt, unpublishAt);
  const categoryId = optionalUuid(record.categoryId, 'categoryId');
  const coverMediaAssetId = optionalUuid(record.coverMediaAssetId, 'coverMediaAssetId');
  const tagIds = uuidArray(record.tagIds, 'tagIds', 50, []);
  return { categoryId, code, coverMediaAssetId, releaseAt, tagIds, translations, unpublishAt };
}

function validateUpdateDrama(value: UpdatePlatformDramaInput) {
  const record = inputRecord(value);
  assertOnlyKeys(record, [
    'code', 'categoryId', 'coverMediaAssetId', 'expectedVersion', 'releaseAt',
    'tagIds', 'translations', 'unpublishAt',
  ]);
  const expectedVersion = versionValue(record.expectedVersion);
  const hasCategory = Object.hasOwn(record, 'categoryId');
  const hasCover = Object.hasOwn(record, 'coverMediaAssetId');
  const hasRelease = Object.hasOwn(record, 'releaseAt');
  const hasUnpublish = Object.hasOwn(record, 'unpublishAt');
  const categoryId = record.categoryId === null ? null : optionalUuid(record.categoryId, 'categoryId');
  const coverMediaAssetId = record.coverMediaAssetId === null
    ? null : optionalUuid(record.coverMediaAssetId, 'coverMediaAssetId');
  const releaseAt = record.releaseAt === null ? null : optionalDate(record.releaseAt, 'releaseAt');
  const unpublishAt = record.unpublishAt === null
    ? null : optionalDate(record.unpublishAt, 'unpublishAt');
  const code = record.code === undefined ? undefined : codeValue(record.code, 'code');
  const tagIds = record.tagIds === undefined ? undefined : uuidArray(record.tagIds, 'tagIds', 50);
  const translations = record.translations === undefined
    ? undefined : dramaTranslations(record.translations);
  if (![code, hasCategory, hasCover, hasRelease, hasUnpublish, tagIds, translations].some(Boolean)) {
    throw new BadRequestException('At least one drama field must be changed');
  }
  return {
    categoryId, code, coverMediaAssetId, expectedVersion, hasCategory, hasCover,
    hasRelease, hasUnpublish, releaseAt, tagIds, translations, unpublishAt,
  };
}

function validateCreateEpisode(value: CreatePlatformEpisodeInput) {
  const record = inputRecord(value);
  assertOnlyKeys(record, [
    'durationSeconds', 'episodeNo', 'expectedDramaVersion', 'mediaAssetId',
    'previewMediaAssetId', 'previewSeconds', 'releaseAt', 'translations', 'unpublishAt',
  ]);
  const durationSeconds = integerValue(record.durationSeconds, 'durationSeconds', 1, 86_400);
  const episodeNo = integerValue(record.episodeNo, 'episodeNo', 1, 1000);
  const expectedDramaVersion = versionValue(record.expectedDramaVersion);
  const mediaAssetId = requiredUuid(record.mediaAssetId, 'mediaAssetId');
  const previewMediaAssetId = optionalUuid(record.previewMediaAssetId, 'previewMediaAssetId');
  assertSeparatePreview(mediaAssetId, previewMediaAssetId);
  const previewSeconds = record.previewSeconds === undefined
    ? 0 : integerValue(record.previewSeconds, 'previewSeconds', 0, durationSeconds);
  const releaseAt = optionalDate(record.releaseAt, 'releaseAt');
  const unpublishAt = optionalDate(record.unpublishAt, 'unpublishAt');
  assertSchedule(releaseAt, unpublishAt);
  const translations = episodeTranslations(record.translations);
  return {
    durationSeconds, episodeNo, expectedDramaVersion, mediaAssetId, previewMediaAssetId,
    previewSeconds, releaseAt, translations, unpublishAt,
  };
}

function validateUpdateEpisode(value: UpdatePlatformEpisodeInput) {
  const record = inputRecord(value);
  assertOnlyKeys(record, [
    'durationSeconds', 'episodeNo', 'expectedVersion', 'mediaAssetId',
    'previewMediaAssetId', 'previewSeconds', 'releaseAt', 'translations', 'unpublishAt',
  ]);
  const expectedVersion = versionValue(record.expectedVersion);
  const hasRelease = Object.hasOwn(record, 'releaseAt');
  const hasUnpublish = Object.hasOwn(record, 'unpublishAt');
  const durationSeconds = record.durationSeconds === undefined
    ? undefined : integerValue(record.durationSeconds, 'durationSeconds', 1, 86_400);
  const episodeNo = record.episodeNo === undefined
    ? undefined : integerValue(record.episodeNo, 'episodeNo', 1, 1000);
  const mediaAssetId = record.mediaAssetId === undefined
    ? undefined : requiredUuid(record.mediaAssetId, 'mediaAssetId');
  const hasPreviewMedia = Object.hasOwn(record, 'previewMediaAssetId');
  const previewMediaAssetId = record.previewMediaAssetId === null
    ? null : optionalUuid(record.previewMediaAssetId, 'previewMediaAssetId');
  const previewSeconds = record.previewSeconds === undefined
    ? undefined : integerValue(record.previewSeconds, 'previewSeconds', 0, 86_400);
  const releaseAt = record.releaseAt === null ? null : optionalDate(record.releaseAt, 'releaseAt');
  const unpublishAt = record.unpublishAt === null
    ? null : optionalDate(record.unpublishAt, 'unpublishAt');
  const translations = record.translations === undefined
    ? undefined : episodeTranslations(record.translations);
  if (![durationSeconds, episodeNo, mediaAssetId, hasPreviewMedia, previewSeconds, hasRelease,
    hasUnpublish, translations].some((item) => item !== undefined && item !== false)) {
    throw new BadRequestException('At least one episode field must be changed');
  }
  return {
    durationSeconds, episodeNo, expectedVersion, hasRelease, hasUnpublish,
    hasPreviewMedia, mediaAssetId, previewMediaAssetId, previewSeconds,
    releaseAt, translations, unpublishAt,
  };
}

function validateExpectedVersion(value: ExpectedVersionInput) {
  const record = inputRecord(value);
  assertOnlyKeys(record, ['expectedVersion']);
  return { expectedVersion: versionValue(record.expectedVersion) };
}

function validateDelete(value: DeletePlatformContentInput) {
  const record = inputRecord(value);
  assertOnlyKeys(record, ['expectedVersion', 'reason']);
  return {
    expectedVersion: versionValue(record.expectedVersion),
    reason: stringValue(record.reason, 'reason', 1, 2000),
  };
}

function validateCreateTaxonomy(type: TaxonomyType, value: CreatePlatformTaxonomyInput) {
  const record = inputRecord(value);
  assertOnlyKeys(record, ['code', 'sortOrder', 'status', 'translations']);
  if (type === 'tag' && record.sortOrder !== undefined) {
    throw new BadRequestException('sortOrder is only supported for categories');
  }
  return {
    code: codeValue(record.code, 'code', 64),
    sortOrder: type === 'category'
      ? integerValue(record.sortOrder ?? 0, 'sortOrder', -1_000_000, 1_000_000) : 0,
    status: optionalEnum(record.status, 'status', ['active', 'disabled'] as const) ?? 'active',
    translations: taxonomyTranslations(record.translations),
  };
}

function validateUpdateTaxonomy(type: TaxonomyType, value: UpdatePlatformTaxonomyInput) {
  const record = inputRecord(value);
  assertOnlyKeys(record, ['code', 'expectedVersion', 'sortOrder', 'status', 'translations']);
  if (type === 'tag' && record.sortOrder !== undefined) {
    throw new BadRequestException('sortOrder is only supported for categories');
  }
  const code = record.code === undefined ? undefined : codeValue(record.code, 'code', 64);
  const status = optionalEnum(record.status, 'status', ['active', 'disabled'] as const);
  const sortOrder = record.sortOrder === undefined ? undefined
    : integerValue(record.sortOrder, 'sortOrder', -1_000_000, 1_000_000);
  const translations = record.translations === undefined
    ? undefined : taxonomyTranslations(record.translations);
  if (code === undefined && status === undefined && sortOrder === undefined && !translations) {
    throw new BadRequestException(`At least one ${type} field must be changed`);
  }
  return { code, expectedVersion: versionValue(record.expectedVersion), sortOrder, status, translations };
}

function dramaTranslations(value: unknown): DramaTranslationInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CONTENT_LOCALES.length) {
    throw new BadRequestException('translations must contain 1 to 6 locales');
  }
  const locales = new Set<string>();
  return value.map((raw) => {
    const record = inputRecord(raw);
    assertOnlyKeys(record, ['locale', 'searchKeywords', 'summary', 'title']);
    const locale = localeValue(record.locale);
    if (locales.has(locale)) throw new BadRequestException('translations contains duplicate locales');
    locales.add(locale);
    let searchKeywords: string[] | undefined;
    if (record.searchKeywords !== undefined) {
      if (!Array.isArray(record.searchKeywords) || record.searchKeywords.length > 50) {
        throw new BadRequestException('searchKeywords must contain at most 50 values');
      }
      searchKeywords = record.searchKeywords.map((item) => stringValue(item, 'searchKeyword', 1, 100));
    }
    return {
      locale, searchKeywords,
      summary: record.summary === undefined ? '' : stringValue(record.summary, 'summary', 0, 20_000),
      title: stringValue(record.title, 'title', 1, 300),
    };
  });
}

function episodeTranslations(value: unknown): EpisodeTranslationInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CONTENT_LOCALES.length) {
    throw new BadRequestException('translations must contain 1 to 6 locales');
  }
  const locales = new Set<string>();
  return value.map((raw) => {
    const record = inputRecord(raw);
    assertOnlyKeys(record, ['locale', 'title']);
    const locale = localeValue(record.locale);
    if (locales.has(locale)) throw new BadRequestException('translations contains duplicate locales');
    locales.add(locale);
    return { locale, title: stringValue(record.title, 'title', 1, 300) };
  });
}

function taxonomyTranslations(value: unknown): TaxonomyTranslationInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > CONTENT_LOCALES.length) {
    throw new BadRequestException('translations must contain 1 to 6 locales');
  }
  const locales = new Set<string>();
  return value.map((raw) => {
    const record = inputRecord(raw);
    assertOnlyKeys(record, ['locale', 'name']);
    const locale = localeValue(record.locale);
    if (locales.has(locale)) throw new BadRequestException('translations contains duplicate locales');
    locales.add(locale);
    return { locale, name: stringValue(record.name, 'name', 1, 200) };
  });
}

function mapDrama(row: DramaRow): PlatformDramaRecord {
  return compact({
    categoryId: row.category_id ?? undefined,
    code: row.code,
    coverMediaAssetId: row.cover_file_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    deletedAt: iso(row.deleted_at),
    id: row.id,
    releaseAt: iso(row.release_at),
    restoreUntil: iso(row.restore_until),
    status: row.status,
    tagIds: row.tag_ids,
    totalEpisodes: row.total_episodes,
    translations: row.translations,
    unpublishAt: iso(row.unpublish_at),
    version: row.version,
  }) as PlatformDramaRecord;
}

function mapEpisode(row: EpisodeRow): PlatformEpisodeRecord {
  return compact({
    dramaId: row.drama_id, durationSeconds: row.duration_seconds,
    episodeNo: row.episode_no, id: row.id, mediaAssetId: row.media_asset_id,
    previewMediaAssetId: row.preview_media_asset_id ?? undefined,
    previewSeconds: row.preview_seconds, releaseAt: iso(row.release_at),
    status: row.status, translations: row.translations,
    unpublishAt: iso(row.unpublish_at), version: row.version,
  }) as PlatformEpisodeRecord;
}

function assertSchedule(releaseAt: Date | null | undefined, unpublishAt: Date | null | undefined) {
  if (unpublishAt && (!releaseAt || unpublishAt <= releaseAt)) {
    throw new BadRequestException('unpublishAt must be after releaseAt');
  }
}

function assertSeparatePreview(
  mediaAssetId: string,
  previewMediaAssetId: string | null | undefined,
) {
  if (previewMediaAssetId && previewMediaAssetId === mediaAssetId) {
    throw new BadRequestException('previewMediaAssetId must differ from mediaAssetId');
  }
}

function assertMetadata(value: PlatformContentMutationMetadata) {
  if (!value || typeof value !== 'object') throw new TypeError('Mutation metadata is required');
  assertUuid(value.actorId, 'actorId');
  if (!IDEMPOTENCY_PATTERN.test(value.idempotencyKey?.trim() ?? '')) {
    throw new BadRequestException('A valid Idempotency-Key is required');
  }
  if (typeof value.requestId !== 'string' || value.requestId.length < 8 || value.requestId.length > 128) {
    throw new TypeError('requestId is invalid');
  }
}

function inputRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Body is required');
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(record: Record<string, unknown>, keys: readonly string[]) {
  const allowed = new Set(keys);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) throw new BadRequestException(`Unknown field: ${unknown}`);
}

function stringValue(value: unknown, field: string, min: number, max: number): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be a string`);
  const normalized = value.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new BadRequestException(`${field} length is invalid`);
  }
  return normalized;
}

function codeValue(value: unknown, field: string, max = 128) {
  const code = stringValue(value, field, 2, max).toLowerCase();
  if (!CODE_PATTERN.test(code)) throw new BadRequestException(`${field} is invalid`);
  return code;
}

function integerValue(value: unknown, field: string, min: number, max: number) {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) {
    throw new BadRequestException(`${field} must be an integer between ${min} and ${max}`);
  }
  return value as number;
}

function versionValue(value: unknown) {
  return integerValue(value, 'expectedVersion', 0, Number.MAX_SAFE_INTEGER);
}

function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be ISO date-time`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new BadRequestException(`${field} must be canonical ISO date-time`);
  }
  return parsed;
}

function requiredUuid(value: unknown, field: string): string {
  assertUuid(value, field);
  return value;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredUuid(value, field);
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function uuidArray(value: unknown, field: string, max: number, fallback?: string[]): string[] {
  if (value === undefined && fallback) return fallback;
  if (!Array.isArray(value) || value.length > max) {
    throw new BadRequestException(`${field} must contain at most ${max} UUIDs`);
  }
  const result = value.map((item) => requiredUuid(item, field));
  if (new Set(result).size !== result.length) throw new BadRequestException(`${field} contains duplicates`);
  return result;
}

function localeValue(value: unknown) {
  if (typeof value !== 'string' || !(CONTENT_LOCALES as readonly string[]).includes(value)) {
    throw new BadRequestException('locale is not supported');
  }
  return value as (typeof CONTENT_LOCALES)[number];
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  values: readonly T[],
): T | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !values.includes(value as T)) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value as T;
}

function pageValue(value: unknown) {
  if (value === undefined) return 1;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return integerValue(parsed, 'page', 1, 10_000);
}

function pageSizeValue(value: unknown) {
  if (value === undefined) return 20;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  return integerValue(parsed, 'pageSize', 1, 100);
}

function booleanValue(value: unknown, field: string, fallback: boolean) {
  if (value === undefined) return fallback;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new BadRequestException(`${field} must be true or false`);
}

function taxonomyTable(type: TaxonomyType) {
  return type === 'category' ? 'categories' : 'tags';
}

function taxonomyTranslationTable(type: TaxonomyType) {
  return type === 'category' ? 'category_translations' : 'tag_translations';
}

function taxonomyOwnerColumn(type: TaxonomyType) {
  return type === 'category' ? 'category_id' : 'tag_id';
}

function iso(value: Date | null | undefined) {
  return value?.toISOString();
}

function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function toJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function translateUnique(error: unknown, message: string): never {
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') {
    throw new ConflictException(message);
  }
  throw error;
}
