import { SUPPORTED_APP_LOCALES } from '@drama/contracts';
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
import type {
  ContentMutationMetadata,
  CreateDramaInput,
  CreateEpisodeInput,
  DeleteTenantDramaInput,
  DramaRecord,
  DramaTranslationInput,
  EpisodeRecord,
  ExpectedTenantContentVersionInput,
  UpdateDramaInput,
  UpdateEpisodeInput,
} from './content.types';

const CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{1,127}$/;
const MAX_EPISODES_PER_DRAMA = 1_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SUPPORTED_LOCALES = new Set<string>(SUPPORTED_APP_LOCALES);

interface DramaRow {
  category_id: string | null;
  code: string;
  cover_file_id: string | null;
  created_at: Date;
  deleted_at: Date | null;
  id: string;
  release_at: Date | null;
  restore_until: Date | null;
  source_type: 'import' | 'upload' | 'url';
  status: DramaRecord['status'];
  tag_ids: string[];
  total_count?: number;
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
  status: EpisodeRecord['status'];
  translations: Array<{ locale: string; title: string }>;
  unpublish_at: Date | null;
  version: number;
}

interface CommandIdempotencyRow {
  id: string;
  request_hash: string;
  response_json: unknown;
  status: 'completed' | 'failed' | 'processing';
}

@Injectable()
export class ContentService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async listTenantDramas(
    tenantId: string,
    pageValue: number,
    pageSizeValue: number,
    deleted = false,
  ): Promise<{ items: DramaRecord[]; page: number; pageSize: number; total: number }> {
    assertUuid(tenantId, 'tenantId');
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    const offset = (page - 1) * pageSize;

    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<DramaRow[]>`
        select
          drama.id,
          drama.code::text as code,
          drama.status,
          drama.release_at,
          drama.unpublish_at,
          drama.cover_file_id,
          drama.category_id,
          drama.total_episodes,
          drama.source_type,
          drama.deleted_at,
          drama.restore_until,
          drama.version,
          drama.created_at,
          coalesce((
            select jsonb_agg(tag.tag_id order by tag.tag_id)
            from drama_tags as tag where tag.drama_id = drama.id
          ), '[]'::jsonb) as tag_ids,
          count(*) over()::integer as total_count,
          coalesce(
            jsonb_agg(
              jsonb_build_object(
                'locale', translation.locale,
                'title', translation.title,
                'summary', translation.summary,
                'searchKeywords', translation.search_keywords
              ) order by translation.locale
            ) filter (where translation.id is not null),
            '[]'::jsonb
          ) as translations
        from dramas as drama
        left join drama_translations as translation on translation.drama_id = drama.id
        where drama.owner_type = 'tenant'
          and drama.owner_tenant_id = ${tenantId}
          and (${deleted} = (drama.deleted_at is not null))
        group by drama.id
        order by drama.created_at desc, drama.id desc
        limit ${pageSize} offset ${offset}
      `;
      return {
        items: rows.map(toDramaRecord),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  async getTenantDrama(tenantId: string, dramaId: string): Promise<DramaRecord & {
    episodes: EpisodeRecord[];
  }> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const drama = await this.findTenantDrama(transaction, tenantId, dramaId);
      if (!drama) throw new NotFoundException('Drama not found');
      const episodes = await this.listTenantEpisodes(transaction, tenantId, dramaId);
      return { ...toDramaRecord(drama), episodes };
    });
  }

  async createTenantDrama(
    tenantId: string,
    rawInput: CreateDramaInput,
    metadata: ContentMutationMetadata,
  ): Promise<DramaRecord> {
    assertUuid(tenantId, 'tenantId');
    const input = validateCreateDrama(rawInput);
    const dramaId = uuidV7();

    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<DramaRecord>(transaction, {
        actorId: metadata.actorId,
        actorType: 'tenant_staff',
        idempotencyKey: metadata.idempotencyKey,
        request: input,
        routeKey: 'tenant.content.drama.create',
        scope: 'tenant',
        tenantId,
      });
      if (command.cached !== undefined) return command.cached;

      const duplicate = await transaction<{ exists: boolean }[]>`
        select exists (
          select 1 from dramas
          where owner_type = 'tenant'
            and owner_tenant_id = ${tenantId}
            and code = ${input.code}
        ) as exists
      `;
      if (duplicate[0]?.exists) {
        throw new ConflictException('Drama code already exists');
      }
      await this.assertTenantCover(transaction, tenantId, input.coverFileId);
      await this.assertTenantCategory(transaction, tenantId, input.categoryId);
      await this.assertTenantTags(transaction, tenantId, input.tagIds);

      await transaction`
        insert into dramas (
          id, owner_type, owner_tenant_id, code, release_at, unpublish_at,
          cover_file_id, category_id, source_type, created_by
        ) values (
          ${dramaId}, 'tenant', ${tenantId}, ${input.code},
          ${input.releaseAt ?? null}, ${input.unpublishAt ?? null},
          ${input.coverFileId ?? null}, ${input.categoryId ?? null},
          ${input.sourceType}, ${metadata.actorId}
        )
      `;
      await this.replaceDramaTranslations(transaction, dramaId, input.translations);
      await this.replaceDramaTags(
        transaction,
        dramaId,
        input.tagIds,
        metadata.actorId,
      );
      await this.insertContentVersion(transaction, {
        actorId: metadata.actorId,
        aggregateId: dramaId,
        aggregateType: 'drama',
        snapshot: input,
        tenantId,
      });
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'content.drama.create',
        after: input,
        resourceId: dramaId,
        resourceType: 'drama',
      });
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: dramaId,
        eventType: 'ContentDraftCreated',
        payload: { dramaId, tenantId },
      });

      const created = await this.findTenantDrama(transaction, tenantId, dramaId);
      if (!created) throw new Error('Created drama could not be loaded');
      const response = toDramaRecord(created);
      await this.completeCommand(transaction, command.id, response, 201, {
        resourceId: dramaId,
        resourceType: 'drama',
      });
      return response;
    });
  }

  async addTenantEpisode(
    tenantId: string,
    dramaId: string,
    rawInput: CreateEpisodeInput,
    metadata: ContentMutationMetadata,
  ): Promise<EpisodeRecord & { dramaVersion: number }> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    const input = validateCreateEpisode(rawInput);
    const episodeId = uuidV7();

    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<EpisodeRecord & { dramaVersion: number }>(
        transaction,
        {
          actorId: metadata.actorId,
          actorType: 'tenant_staff',
          idempotencyKey: metadata.idempotencyKey,
          request: { dramaId, ...input },
          routeKey: 'tenant.content.episode.create',
          scope: 'tenant',
          tenantId,
        },
      );
      if (command.cached !== undefined) return command.cached;
      const dramas = await transaction<
        Array<{ episode_count: number; status: DramaRecord['status']; version: number }>
      >`
        select
          drama.status, drama.version,
          (select count(*)::integer from episodes
            where drama_id = drama.id and deleted_at is null) as episode_count
        from dramas as drama
        where drama.id = ${dramaId}
          and drama.owner_type = 'tenant'
          and drama.owner_tenant_id = ${tenantId}
          and drama.deleted_at is null
        for update
      `;
      const drama = dramas[0];
      if (!drama) throw new NotFoundException('Drama not found');
      if (!['draft', 'rejected', 'unpublished'].includes(drama.status)) {
        throw new ConflictException('Episodes can only be changed in draft, rejected or unpublished state');
      }
      if (drama.version !== input.expectedDramaVersion) {
        throw new ConflictException('Drama has already changed');
      }
      if (drama.episode_count >= MAX_EPISODES_PER_DRAMA) {
        throw new ConflictException('Drama has reached the episode limit');
      }

      await this.assertTenantVideo(transaction, tenantId, input.mediaAssetId);
      if (input.previewMediaAssetId) {
        await this.assertTenantVideo(transaction, tenantId, input.previewMediaAssetId);
        assertSeparatePreview(input.mediaAssetId, input.previewMediaAssetId);
      }

      await transaction`
        insert into episodes (
          id, drama_id, episode_no, release_at, unpublish_at,
          duration_seconds, media_asset_id, preview_media_asset_id,
          preview_seconds, created_by
        ) values (
          ${episodeId}, ${dramaId}, ${input.episodeNo},
          ${input.releaseAt ?? null}, ${input.unpublishAt ?? null},
          ${input.durationSeconds}, ${input.mediaAssetId}, ${input.previewMediaAssetId ?? null},
          ${input.previewSeconds}, ${metadata.actorId}
        )
      `;
      for (const translation of input.translations) {
        await transaction`
          insert into episode_translations (id, episode_id, locale, title)
          values (${uuidV7()}, ${episodeId}, ${translation.locale}, ${translation.title})
        `;
      }
      const dramaUpdates = await transaction<Array<{ version: number }>>`
        update dramas
        set
          total_episodes = (
            select count(*)::integer from episodes
            where drama_id = ${dramaId} and deleted_at is null
          ),
          updated_by = ${metadata.actorId},
          version = version + 1
        where id = ${dramaId} and version = ${input.expectedDramaVersion}
        returning version
      `;
      const dramaVersion = dramaUpdates[0]?.version;
      if (dramaVersion === undefined) throw new ConflictException('Drama has already changed');
      await this.insertContentVersion(transaction, {
        actorId: metadata.actorId,
        aggregateId: episodeId,
        aggregateType: 'episode',
        snapshot: input,
        tenantId,
      });
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'content.episode.create',
        after: input,
        resourceId: episodeId,
        resourceType: 'episode',
      });
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: episodeId,
        eventType: 'EpisodeDraftCreated',
        payload: { dramaId, episodeId, tenantId },
      });
      const created = await this.findTenantEpisode(
        transaction,
        tenantId,
        dramaId,
        episodeId,
      );
      if (!created) throw new Error('Created episode could not be loaded');
      const response = { ...toEpisodeRecord(created), dramaVersion };
      await this.completeCommand(transaction, command.id, response, 201, {
        resourceId: episodeId,
        resourceType: 'episode',
      });
      return response;
    });
  }

  async updateTenantDrama(
    tenantId: string,
    dramaId: string,
    rawInput: UpdateDramaInput,
    metadata: ContentMutationMetadata,
  ): Promise<DramaRecord> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    const input = validateUpdateDrama(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<DramaRecord>(transaction, {
        actorId: metadata.actorId,
        actorType: 'tenant_staff',
        idempotencyKey: metadata.idempotencyKey,
        request: { dramaId, ...input },
        routeKey: 'tenant.content.drama.update',
        scope: 'tenant',
        tenantId,
      });
      if (command.cached !== undefined) return command.cached;
      const rows = await transaction<
        Array<{
          category_id: string | null;
          cover_file_id: string | null;
          release_at: Date | null;
          status: DramaRecord['status'];
          unpublish_at: Date | null;
          version: number;
        }>
      >`
        select
          status, version, release_at, unpublish_at, cover_file_id, category_id
        from dramas
        where id = ${dramaId}
          and owner_type = 'tenant'
          and owner_tenant_id = ${tenantId}
          and deleted_at is null
        for update
      `;
      const drama = rows[0];
      if (!drama) throw new NotFoundException('Drama not found');
      if (!['draft', 'rejected', 'unpublished'].includes(drama.status)) {
        throw new ConflictException('Only draft, rejected or unpublished dramas can be edited');
      }
      if (drama.version !== input.version) {
        throw new ConflictException('Drama has already changed');
      }
      const releaseAt = input.hasReleaseAt ? input.releaseAt : drama.release_at;
      const unpublishAt = input.hasUnpublishAt ? input.unpublishAt : drama.unpublish_at;
      if (unpublishAt && (!releaseAt || unpublishAt <= releaseAt)) {
        throw new BadRequestException('unpublishAt must be after releaseAt');
      }
      await this.assertTenantCover(transaction, tenantId, input.coverFileId);
      await this.assertTenantCategory(transaction, tenantId, input.categoryId);
      await this.assertTenantTags(transaction, tenantId, input.tagIds);
      if (input.code) {
        const duplicate = await transaction<{ exists: boolean }[]>`
          select exists (select 1 from dramas where owner_type = 'tenant'
            and owner_tenant_id = ${tenantId} and code = ${input.code}
            and id <> ${dramaId}) as exists
        `;
        if (duplicate[0]?.exists) throw new ConflictException('Drama code already exists');
      }

      const updated = await transaction<{ id: string }[]>`
        update dramas
        set
          code = coalesce(${input.code ?? null}, code),
          status = case when status = 'rejected' then 'draft' else status end,
          release_at = case
            when ${input.hasReleaseAt} then ${releaseAt ?? null}::timestamptz
            else release_at
          end,
          unpublish_at = case
            when ${input.hasUnpublishAt} then ${unpublishAt ?? null}::timestamptz
            else unpublish_at
          end,
          cover_file_id = case
            when ${input.hasCoverFileId} then ${input.coverFileId ?? null}::uuid
            else cover_file_id
          end,
          category_id = case
            when ${input.hasCategoryId} then ${input.categoryId ?? null}::uuid
            else category_id
          end,
          version = version + 1,
          updated_by = ${metadata.actorId}
        where id = ${dramaId} and version = ${input.version}
        returning id
      `;
      if (!updated[0]) throw new ConflictException('Drama has already changed');
      if (input.translations) {
        await transaction`delete from drama_translations where drama_id = ${dramaId}`;
        await this.replaceDramaTranslations(transaction, dramaId, input.translations);
      }
      if (input.tagIds) {
        await transaction`delete from drama_tags where drama_id = ${dramaId}`;
        await this.replaceDramaTags(
          transaction,
          dramaId,
          input.tagIds,
          metadata.actorId,
        );
      }
      const snapshot = await this.loadDramaSnapshot(transaction, tenantId, dramaId);
      await this.insertContentVersion(transaction, {
        actorId: metadata.actorId,
        aggregateId: dramaId,
        aggregateType: 'drama',
        snapshot,
        tenantId,
      });
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'content.drama.update',
        after: {
          changedFields: [
            input.code ? 'code' : null,
            input.hasCategoryId ? 'categoryId' : null,
            input.hasCoverFileId ? 'coverFileId' : null,
            input.hasReleaseAt ? 'releaseAt' : null,
            input.hasUnpublishAt ? 'unpublishAt' : null,
            input.translations ? 'translations' : null,
            input.tagIds ? 'tagIds' : null,
          ].filter(Boolean),
          version: input.version + 1,
        },
        resourceId: dramaId,
        resourceType: 'drama',
      });
      const result = await this.findTenantDrama(transaction, tenantId, dramaId);
      if (!result) throw new Error('Updated drama could not be loaded');
      const response = toDramaRecord(result);
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: dramaId,
        eventType: 'ContentDraftUpdated',
        payload: { dramaId, tenantId, version: response.version },
      });
      await this.completeCommand(transaction, command.id, response, 200, {
        resourceId: dramaId,
        resourceType: 'drama',
      });
      return response;
    });
  }

  async updateTenantEpisode(
    tenantId: string,
    dramaId: string,
    episodeId: string,
    rawInput: UpdateEpisodeInput,
    metadata: ContentMutationMetadata,
  ): Promise<EpisodeRecord & { dramaVersion: number }> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    assertUuid(episodeId, 'episodeId');
    const input = validateUpdateEpisode(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<EpisodeRecord & { dramaVersion: number }>(
        transaction,
        {
          actorId: metadata.actorId,
          actorType: 'tenant_staff',
          idempotencyKey: metadata.idempotencyKey,
          request: { dramaId, episodeId, ...input },
          routeKey: 'tenant.content.episode.update',
          scope: 'tenant',
          tenantId,
        },
      );
      if (command.cached !== undefined) return command.cached;
      const parents = await transaction<Array<{ status: DramaRecord['status'] }>>`
        select status from dramas where id = ${dramaId}
          and owner_type = 'tenant' and owner_tenant_id = ${tenantId}
          and deleted_at is null for update
      `;
      const parent = parents[0];
      if (!parent) throw new NotFoundException('Drama not found');
      if (!['draft', 'rejected', 'unpublished'].includes(parent.status)) {
        throw new ConflictException('Episodes can only be changed in draft, rejected or unpublished state');
      }
      const current = await this.findTenantEpisode(
        transaction,
        tenantId,
        dramaId,
        episodeId,
        true,
      );
      if (!current) throw new NotFoundException('Episode not found');
      if (current.version !== input.expectedVersion) {
        throw new ConflictException('Episode has already changed');
      }
      if (input.mediaAssetId) {
        await this.assertTenantVideo(transaction, tenantId, input.mediaAssetId);
      }
      if (input.previewMediaAssetId) {
        await this.assertTenantVideo(transaction, tenantId, input.previewMediaAssetId);
      }
      const nextMediaAssetId = input.mediaAssetId ?? current.media_asset_id;
      const nextPreviewMediaAssetId = input.hasPreviewMedia
        ? input.previewMediaAssetId
        : current.preview_media_asset_id;
      assertSeparatePreview(nextMediaAssetId, nextPreviewMediaAssetId);
      const nextRelease = input.hasReleaseAt ? input.releaseAt : current.release_at;
      const nextUnpublish = input.hasUnpublishAt
        ? input.unpublishAt
        : current.unpublish_at;
      if (nextUnpublish && (!nextRelease || nextUnpublish <= nextRelease)) {
        throw new BadRequestException('unpublishAt must be after releaseAt');
      }
      const duration = input.durationSeconds ?? current.duration_seconds;
      const preview = input.previewSeconds ?? current.preview_seconds;
      if (preview > duration) {
        throw new BadRequestException('previewSeconds must not exceed durationSeconds');
      }
      const updated = await transaction<{ id: string }[]>`
        update episodes set
          episode_no = coalesce(${input.episodeNo ?? null}, episode_no),
          duration_seconds = coalesce(${input.durationSeconds ?? null}, duration_seconds),
          preview_seconds = coalesce(${input.previewSeconds ?? null}, preview_seconds),
          media_asset_id = coalesce(${input.mediaAssetId ?? null}, media_asset_id),
          preview_media_asset_id = case when ${input.hasPreviewMedia}
            then ${input.previewMediaAssetId ?? null}::uuid else preview_media_asset_id end,
          release_at = case when ${input.hasReleaseAt}
            then ${input.releaseAt ?? null}::timestamptz else release_at end,
          unpublish_at = case when ${input.hasUnpublishAt}
            then ${input.unpublishAt ?? null}::timestamptz else unpublish_at end,
          status = 'draft', version = version + 1, updated_by = ${metadata.actorId}
        where id = ${episodeId} and drama_id = ${dramaId}
          and version = ${input.expectedVersion} and deleted_at is null
        returning id
      `;
      if (!updated[0]) throw new ConflictException('Episode has already changed');
      if (input.translations) {
        await transaction`delete from episode_translations where episode_id = ${episodeId}`;
        for (const translation of input.translations) {
          await transaction`
            insert into episode_translations (id, episode_id, locale, title)
            values (${uuidV7()}, ${episodeId}, ${translation.locale}, ${translation.title})
          `;
        }
      }
      const dramaRows = await transaction<Array<{ version: number }>>`
        update dramas set status = case when status = 'rejected' then 'draft' else status end,
          version = version + 1, updated_by = ${metadata.actorId}
        where id = ${dramaId} returning version
      `;
      const refreshed = await this.findTenantEpisode(
        transaction,
        tenantId,
        dramaId,
        episodeId,
      );
      if (!refreshed || !dramaRows[0]) throw new Error('Updated episode could not be loaded');
      const response = { ...toEpisodeRecord(refreshed), dramaVersion: dramaRows[0].version };
      await this.insertContentVersion(transaction, {
        actorId: metadata.actorId,
        aggregateId: episodeId,
        aggregateType: 'episode',
        snapshot: response,
        tenantId,
      });
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'content.episode.update',
        after: { dramaId, version: response.version },
        resourceId: episodeId,
        resourceType: 'episode',
      });
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: episodeId,
        eventType: 'EpisodeDraftUpdated',
        payload: { dramaId, episodeId, tenantId, version: response.version },
      });
      await this.completeCommand(transaction, command.id, response, 200, {
        resourceId: episodeId,
        resourceType: 'episode',
      });
      return response;
    });
  }

  async setTenantDramaPublication(
    tenantId: string,
    dramaId: string,
    action: 'publish' | 'unpublish',
    rawInput: ExpectedTenantContentVersionInput,
    metadata: ContentMutationMetadata,
  ): Promise<{ status: DramaRecord['status']; version: number }> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    const input = validateExpectedVersion(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<{ status: DramaRecord['status']; version: number }>(
        transaction, {
          actorId: metadata.actorId,
          actorType: 'tenant_staff',
          idempotencyKey: metadata.idempotencyKey,
          request: { dramaId, action, input },
          routeKey: `tenant.content.drama.${action}`,
          scope: 'tenant',
          tenantId,
        },
      );
      if (command.cached !== undefined) return command.cached;
      const rows = await transaction<Array<{
        cover_file_id: string | null; status: DramaRecord['status']; version: number;
        release_at: Date | null; unpublish_at: Date | null; expired: boolean;
      }>>`
        select cover_file_id, status, version, release_at, unpublish_at,
          unpublish_at is not null and unpublish_at <= statement_timestamp() as expired
        from dramas
        where id = ${dramaId} and owner_type = 'tenant'
          and owner_tenant_id = ${tenantId} and deleted_at is null
        for update
      `;
      const drama = rows[0];
      if (!drama) throw new NotFoundException('Drama not found');
      if (drama.version !== input.expectedVersion) {
        throw new ConflictException('Drama has already changed');
      }
      const allowed = action === 'publish'
        ? ['draft', 'rejected', 'unpublished']
        : ['approved', 'published'];
      if (!allowed.includes(drama.status)) {
        throw new ConflictException('Drama is not in a valid publication state');
      }
      if (action === 'publish') {
        if (drama.expired) throw new BadRequestException('Update the expired unpublish time before publishing');
        if (!drama.cover_file_id) {
          throw new BadRequestException('A separately uploaded cover is required');
        }

        const readiness = await transaction<
          { cover_ready: boolean; episode_count: number; invalid_episodes: number; translation_count: number }[]
        >`
          select
            exists (
              select 1 from media_assets as cover
              inner join storage_providers as provider
                on provider.id = cover.storage_provider_id
              where cover.id = ${drama.cover_file_id}
                and cover.owner_type = 'tenant'
                and cover.owner_tenant_id = ${tenantId}
                and cover.kind = 'image' and cover.status = 'ready'
                and cover.deleted_at is null and cover.object_key is not null
                and cover.source_url is null and provider.provider = 's3'
                and provider.status = 'active'
                and (provider.owner_type = 'platform'
                  or (provider.owner_type = 'tenant'
                    and provider.owner_tenant_id = ${tenantId}))
            ) as cover_ready,
            (select count(*)::integer from episodes
              where drama_id = ${dramaId} and deleted_at is null) as episode_count,
            (select count(*)::integer
              from episodes as episode
              left join media_assets as asset on asset.id = episode.media_asset_id
              left join media_assets as preview on preview.id = episode.preview_media_asset_id
              where episode.drama_id = ${dramaId}
                and episode.deleted_at is null
                and (
                  asset.id is null
                  or asset.owner_type <> 'tenant'
                  or asset.owner_tenant_id <> ${tenantId}
                  or asset.kind <> 'video'
                  or asset.status <> 'ready'
                  or asset.transcode_status not in ('not_required', 'ready')
                  or asset.deleted_at is not null
                  or asset.object_key is null
                  or asset.source_url is not null
                  or not exists (
                    select 1 from storage_providers as provider
                    where provider.id = asset.storage_provider_id
                      and provider.provider = 's3'
                      and provider.status = 'active'
                      and (provider.owner_type = 'platform'
                        or (provider.owner_type = 'tenant'
                          and provider.owner_tenant_id = ${tenantId}))
                  )
                  or (
                    episode.preview_media_asset_id is not null
                    and (
                      preview.id is null
                      or preview.id = episode.media_asset_id
                      or preview.owner_type <> 'tenant'
                      or preview.owner_tenant_id <> ${tenantId}
                      or preview.kind <> 'video'
                      or preview.status <> 'ready'
                      or preview.transcode_status not in ('not_required', 'ready')
                      or preview.deleted_at is not null
                      or preview.object_key is null
                      or preview.source_url is not null
                      or not exists (
                        select 1 from storage_providers as provider
                        where provider.id = preview.storage_provider_id
                          and provider.provider = 's3'
                          and provider.status = 'active'
                          and (provider.owner_type = 'platform'
                            or (provider.owner_type = 'tenant'
                              and provider.owner_tenant_id = ${tenantId}))
                      )
                    )
                  )
                )) as invalid_episodes,
            (select count(*)::integer from drama_translations
              where drama_id = ${dramaId}) as translation_count
        `;
        const state = readiness[0];
        if (!state?.cover_ready) throw new BadRequestException('Cover is not ready');
        if (!state.episode_count) throw new BadRequestException('At least one episode is required');
        if (state.episode_count > MAX_EPISODES_PER_DRAMA) {
          throw new BadRequestException('Drama has too many episodes');
        }
        if (state.invalid_episodes > 0) {
          throw new BadRequestException('All episode media must be ready');
        }
        if (!state.translation_count) throw new BadRequestException('A translation is required');

      }
      // Cancel the previous generation before scheduling this publication.
      await transaction`
        update content_schedule_jobs
        set status = 'cancelled', locked_by = null, locked_at = null
        where scope_type = 'tenant' and tenant_id = ${tenantId}
          and status in ('pending', 'retry', 'processing')
          and ((target_type = 'drama' and target_id = ${dramaId})
            or (target_type = 'episode' and target_id in (
              select id from episodes where drama_id = ${dramaId}
            )))
      `;
      const updated = await transaction<Array<{ status: DramaRecord['status']; version: number }>>`
        update dramas set status = case
          when ${action} = 'unpublish' then 'unpublished'
          when release_at > statement_timestamp() then 'approved'
          else 'published' end,
          version = version + 1, updated_by = ${metadata.actorId}
        where id = ${dramaId} and owner_type = 'tenant'
          and owner_tenant_id = ${tenantId} and version = ${input.expectedVersion}
        returning status, version
      `;
      const response = updated[0];
      if (!response) throw new ConflictException('Drama has already changed');
      await transaction`
        update episodes set status = case
          when ${action} = 'unpublish' then 'unpublished'
          when unpublish_at <= statement_timestamp() then 'unpublished'
          when ${response.status} = 'published'
            and (release_at is null or release_at <= statement_timestamp()) then 'published'
          else 'approved' end,
          version = version + 1, updated_by = ${metadata.actorId}
        where drama_id = ${dramaId} and deleted_at is null
      `;
      if (action === 'publish') {
        if (response.status === 'approved' && drama.release_at) {
          await this.insertScheduleJob(transaction, tenantId, 'drama', dramaId,
            'publish', drama.release_at, metadata, response.version);
        }
        if (drama.unpublish_at) {
          await this.insertScheduleJob(transaction, tenantId, 'drama', dramaId,
            'unpublish', drama.unpublish_at, metadata, response.version);
        }
        const episodes = await transaction<Array<{
          id: string; release_at: Date | null; unpublish_at: Date | null;
          schedule_publish: boolean; schedule_unpublish: boolean;
        }>>`
          select id, release_at, unpublish_at,
            release_at > statement_timestamp() as schedule_publish,
            unpublish_at > statement_timestamp() as schedule_unpublish
          from episodes where drama_id = ${dramaId} and deleted_at is null
        `;
        for (const episode of episodes) {
          if (episode.schedule_publish && episode.release_at) {
            await this.insertScheduleJob(transaction, tenantId, 'episode', episode.id,
              'publish', episode.release_at, metadata, response.version);
          }
          if (episode.schedule_unpublish && episode.unpublish_at) {
            await this.insertScheduleJob(transaction, tenantId, 'episode', episode.id,
              'unpublish', episode.unpublish_at, metadata, response.version);
          }
        }
      }
      await this.insertContentVersion(transaction, {
        actorId: metadata.actorId, aggregateId: dramaId, aggregateType: 'drama',
        snapshot: await this.loadDramaSnapshot(transaction, tenantId, dramaId), tenantId,
      });
      await this.insertAudit(transaction, tenantId, metadata, {
        action: `content.drama.${action}`, after: response,
        resourceId: dramaId, resourceType: 'drama',
      });
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: dramaId,
        eventType: action === 'publish' ? 'TenantContentPublished' : 'TenantContentUnpublished',
        payload: { dramaId, tenantId, ...response },
      });
      await this.completeCommand(transaction, command.id, response, 200, {
        resourceId: dramaId, resourceType: 'drama',
      });
      return response;
    });
  }

  async withdrawTenantReview(
    tenantId: string,
    dramaId: string,
    metadata: ContentMutationMetadata,
  ): Promise<{ status: 'draft'; withdrawn: true }> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<Array<{ id: string; version: number }>>`
        select request.id, request.version
        from review_requests as request
        inner join dramas as drama
          on drama.id = request.target_id
          and drama.owner_type = 'tenant'
          and drama.owner_tenant_id = request.tenant_id
        where request.tenant_id = ${tenantId}
          and request.target_type = 'drama'
          and request.target_id = ${dramaId}
          and request.status = 'submitted'
          and drama.status = 'pending_review'
          and drama.deleted_at is null
        order by request.submitted_at desc
        limit 1
        for update of request, drama
      `;
      const review = rows[0];
      if (!review) throw new ConflictException('No pending review can be withdrawn');
      await transaction`
        update review_requests
        set status = 'withdrawn', version = version + 1
        where id = ${review.id} and version = ${review.version} and status = 'submitted'
      `;
      await transaction`
        update dramas
        set status = 'draft', version = version + 1, updated_by = ${metadata.actorId}
        where id = ${dramaId} and status = 'pending_review'
      `;
      await transaction`
        insert into review_request_actions (
          id, tenant_id, review_request_id, action, actor_type, actor_id
        ) values (
          ${uuidV7()}, ${tenantId}, ${review.id},
          'withdraw', 'tenant_staff', ${metadata.actorId}
        )
      `;
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'content.drama.withdraw_review',
        after: { reviewRequestId: review.id, status: 'draft' },
        resourceId: dramaId,
        resourceType: 'drama',
      });
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: dramaId,
        eventType: 'ContentReviewWithdrawn',
        payload: { dramaId, reviewRequestId: review.id, tenantId },
      });
      return { status: 'draft', withdrawn: true };
    });
  }

  async softDeleteTenantDrama(
    tenantId: string,
    dramaId: string,
    rawInput: DeleteTenantDramaInput,
    metadata: ContentMutationMetadata,
  ): Promise<{ restoreUntil: string; version: number }> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    const input = validateDeleteDrama(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<{ restoreUntil: string; version: number }>(
        transaction,
        { actorId: metadata.actorId, actorType: 'tenant_staff',
          idempotencyKey: metadata.idempotencyKey, request: { dramaId, ...input },
          routeKey: 'tenant.content.drama.delete', scope: 'tenant', tenantId },
      );
      if (command.cached) return command.cached;
      const rows = await transaction<
        Array<{ restore_until: Date; status: DramaRecord['status']; version: number }>
      >`
        update dramas
        set
          deleted_at = statement_timestamp(),
          deleted_by = ${metadata.actorId},
          delete_reason = ${input.reason},
          restore_until = statement_timestamp() + interval '30 days',
          updated_by = ${metadata.actorId},
          version = version + 1
        where id = ${dramaId}
          and owner_type = 'tenant'
          and owner_tenant_id = ${tenantId}
          and deleted_at is null
          and version = ${input.expectedVersion}
          and status in ('draft', 'rejected', 'unpublished')
        returning status, restore_until, version
      `;
      const drama = rows[0];
      if (!drama) {
        throw new ConflictException('Only draft, rejected, or unpublished dramas can be deleted');
      }
      await transaction`
        insert into content_deletion_history (
          id, scope_type, tenant_id, target_type, target_id, action,
          previous_status, resulting_status, reason, restore_until,
          actor_type, actor_id
        ) values (
          ${uuidV7()}, 'tenant', ${tenantId}, 'drama', ${dramaId}, 'soft_delete',
          ${drama.status}, 'deleted', ${input.reason}, ${drama.restore_until},
          'tenant_staff', ${metadata.actorId}
        )
      `;
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'content.drama.soft_delete',
        after: { reason: input.reason, restoreUntil: drama.restore_until.toISOString(),
          version: drama.version },
        resourceId: dramaId,
        resourceType: 'drama',
      });
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: dramaId, eventType: 'ContentDraftDeleted',
        payload: { dramaId, tenantId, version: drama.version },
      });
      const response = { restoreUntil: drama.restore_until.toISOString(), version: drama.version };
      await this.completeCommand(transaction, command.id, response, 200,
        { resourceId: dramaId, resourceType: 'drama' });
      return response;
    });
  }

  async restoreTenantDrama(
    tenantId: string,
    dramaId: string,
    rawInput: ExpectedTenantContentVersionInput,
    metadata: ContentMutationMetadata,
  ): Promise<{ restored: true; version: number }> {
    assertUuid(tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    const input = validateExpectedVersion(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<{ restored: true; version: number }>(transaction,
        { actorId: metadata.actorId, actorType: 'tenant_staff',
          idempotencyKey: metadata.idempotencyKey, request: { dramaId, ...input },
          routeKey: 'tenant.content.drama.restore', scope: 'tenant', tenantId });
      if (command.cached) return command.cached;
      const rows = await transaction<Array<{
        delete_event_id: string; status: string; version: number;
      }>>`
        select drama.status, drama.version, history.id as delete_event_id
        from dramas as drama
        inner join content_deletion_history as history
          on history.target_id = drama.id
          and history.tenant_id = drama.owner_tenant_id
          and history.target_type = 'drama'
          and history.action = 'soft_delete'
        where drama.id = ${dramaId}
          and drama.owner_type = 'tenant'
          and drama.owner_tenant_id = ${tenantId}
          and drama.deleted_at is not null
          and drama.version = ${input.expectedVersion}
          and drama.restore_until > statement_timestamp()
          and not exists (
            select 1 from content_deletion_history as restoration
            where restoration.restored_from_id = history.id
          )
        order by history.created_at desc
        limit 1
        for update of drama
      `;
      const deleted = rows[0];
      if (!deleted) throw new NotFoundException('Restorable drama not found');
      const changed = await transaction<{ version: number }[]>`
        update dramas
        set
          deleted_at = null,
          deleted_by = null,
          delete_reason = null,
          restore_until = null,
          updated_by = ${metadata.actorId},
          version = version + 1
        where id = ${dramaId} and version = ${input.expectedVersion}
        returning version
      `;
      if (!changed[0]) throw new ConflictException('Drama has already changed');
      await transaction`
        insert into content_deletion_history (
          id, scope_type, tenant_id, target_type, target_id, action,
          restored_from_id, previous_status, resulting_status, reason,
          actor_type, actor_id
        ) values (
          ${uuidV7()}, 'tenant', ${tenantId}, 'drama', ${dramaId}, 'restore',
          ${deleted.delete_event_id}, 'deleted', ${deleted.status}, 'manual restore',
          'tenant_staff', ${metadata.actorId}
        )
      `;
      await this.insertAudit(transaction, tenantId, metadata, {
        action: 'content.drama.restore',
        after: { restored: true, version: changed[0].version },
        resourceId: dramaId,
        resourceType: 'drama',
      });
      await this.insertOutbox(transaction, tenantId, metadata.requestId, {
        aggregateId: dramaId, eventType: 'ContentDraftRestored',
        payload: { dramaId, tenantId, version: changed[0].version },
      });
      const response = { restored: true as const, version: changed[0].version };
      await this.completeCommand(transaction, command.id, response, 200,
        { resourceId: dramaId, resourceType: 'drama' });
      return response;
    });
  }

  private async findTenantDrama(
    transaction: DatabaseTransaction,
    tenantId: string,
    dramaId: string,
  ): Promise<DramaRow | undefined> {
    const rows = await transaction<DramaRow[]>`
      select
        drama.id, drama.code::text as code, drama.status, drama.release_at,
        drama.unpublish_at, drama.cover_file_id, drama.category_id,
        drama.total_episodes, drama.source_type, drama.deleted_at,
        drama.restore_until, drama.version, drama.created_at,
        coalesce((
          select jsonb_agg(tag.tag_id order by tag.tag_id)
          from drama_tags as tag where tag.drama_id = drama.id
        ), '[]'::jsonb) as tag_ids,
        coalesce(
          jsonb_agg(
            jsonb_build_object(
              'locale', translation.locale, 'title', translation.title,
              'summary', translation.summary,
              'searchKeywords', translation.search_keywords
            ) order by translation.locale
          ) filter (where translation.id is not null),
          '[]'::jsonb
        ) as translations
      from dramas as drama
      left join drama_translations as translation on translation.drama_id = drama.id
      where drama.id = ${dramaId}
        and drama.owner_type = 'tenant'
        and drama.owner_tenant_id = ${tenantId}
      group by drama.id
    `;
    return rows[0];
  }

  private async listTenantEpisodes(
    transaction: DatabaseTransaction,
    tenantId: string,
    dramaId: string,
  ): Promise<EpisodeRecord[]> {
    const rows = await transaction<EpisodeRow[]>`
      select episode.id, episode.drama_id, episode.episode_no, episode.status,
        episode.release_at, episode.unpublish_at, episode.duration_seconds,
        episode.media_asset_id, episode.preview_media_asset_id,
        episode.preview_seconds, episode.version,
        coalesce((select jsonb_agg(jsonb_build_object(
          'locale', translation.locale, 'title', translation.title
        ) order by translation.locale) from episode_translations as translation
          where translation.episode_id = episode.id), '[]'::jsonb) as translations
      from episodes as episode
      inner join dramas as drama on drama.id = episode.drama_id
        and drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId}
      where episode.drama_id = ${dramaId} and episode.deleted_at is null
      order by episode.episode_no, episode.id
    `;
    return rows.map(toEpisodeRecord);
  }

  private async findTenantEpisode(
    transaction: DatabaseTransaction,
    tenantId: string,
    dramaId: string,
    episodeId: string,
    forUpdate = false,
  ): Promise<EpisodeRow | undefined> {
    if (forUpdate) {
      const rows = await transaction<EpisodeRow[]>`
        select episode.id, episode.drama_id, episode.episode_no, episode.status,
          episode.release_at, episode.unpublish_at, episode.duration_seconds,
          episode.media_asset_id, episode.preview_media_asset_id,
          episode.preview_seconds, episode.version,
          coalesce((select jsonb_agg(jsonb_build_object(
            'locale', translation.locale, 'title', translation.title
          ) order by translation.locale) from episode_translations as translation
            where translation.episode_id = episode.id), '[]'::jsonb) as translations
        from episodes as episode
        inner join dramas as drama on drama.id = episode.drama_id
          and drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId}
        where episode.id = ${episodeId} and episode.drama_id = ${dramaId}
          and episode.deleted_at is null for update of episode
      `;
      return rows[0];
    }
    const rows = await transaction<EpisodeRow[]>`
      select episode.id, episode.drama_id, episode.episode_no, episode.status,
        episode.release_at, episode.unpublish_at, episode.duration_seconds,
        episode.media_asset_id, episode.preview_media_asset_id,
        episode.preview_seconds, episode.version,
        coalesce((select jsonb_agg(jsonb_build_object(
          'locale', translation.locale, 'title', translation.title
        ) order by translation.locale) from episode_translations as translation
          where translation.episode_id = episode.id), '[]'::jsonb) as translations
      from episodes as episode
      inner join dramas as drama on drama.id = episode.drama_id
        and drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId}
      where episode.id = ${episodeId} and episode.drama_id = ${dramaId}
        and episode.deleted_at is null
    `;
    return rows[0];
  }

  private async assertTenantCover(
    transaction: DatabaseTransaction,
    tenantId: string,
    mediaId: string | null | undefined,
  ): Promise<void> {
    if (!mediaId) return;
    const rows = await transaction<{ id: string }[]>`
      select media.id from media_assets as media
      inner join storage_providers as provider on provider.id = media.storage_provider_id
      where media.id = ${mediaId} and media.owner_type = 'tenant'
        and media.owner_tenant_id = ${tenantId} and media.kind = 'image'
        and media.status = 'ready' and media.deleted_at is null
        and media.object_key is not null and media.source_url is null
        and provider.provider = 's3' and provider.status = 'active'
        and (provider.owner_type = 'platform'
          or (provider.owner_type = 'tenant' and provider.owner_tenant_id = ${tenantId}))
      for share of media, provider
    `;
    if (!rows[0]) throw new BadRequestException('Cover must be a ready tenant S3 image');
  }

  private async assertTenantVideo(
    transaction: DatabaseTransaction,
    tenantId: string,
    mediaId: string,
  ): Promise<void> {
    const rows = await transaction<{ id: string }[]>`
      select media.id from media_assets as media
      inner join storage_providers as provider on provider.id = media.storage_provider_id
      where media.id = ${mediaId} and media.owner_type = 'tenant'
        and media.owner_tenant_id = ${tenantId} and media.kind = 'video'
        and media.status = 'ready'
        and media.transcode_status in ('not_required', 'ready')
        and media.deleted_at is null and media.object_key is not null
        and media.source_url is null and provider.provider = 's3'
        and provider.status = 'active'
        and (provider.owner_type = 'platform'
          or (provider.owner_type = 'tenant' and provider.owner_tenant_id = ${tenantId}))
      for share of media, provider
    `;
    if (!rows[0]) throw new BadRequestException('Episode media must be a ready tenant S3 video');
  }

  private async assertTenantCategory(
    transaction: DatabaseTransaction,
    tenantId: string,
    categoryId: string | null | undefined,
  ): Promise<void> {
    if (!categoryId) return;
    const rows = await transaction<{ id: string }[]>`
      select id from categories where id = ${categoryId} and status = 'active'
        and deleted_at is null and (
          (owner_type = 'tenant' and owner_tenant_id = ${tenantId})
          or (owner_type = 'platform' and owner_tenant_id is null)
        ) for share
    `;
    if (!rows[0]) throw new BadRequestException('Category is unavailable');
  }

  private async assertTenantTags(
    transaction: DatabaseTransaction,
    tenantId: string,
    tagIds: string[] | undefined,
  ): Promise<void> {
    if (!tagIds?.length) return;
    const rows = await transaction<{ count: number }[]>`
      select count(*)::integer as count from tags where id = any(${tagIds})
        and status = 'active' and deleted_at is null and (
          (owner_type = 'tenant' and owner_tenant_id = ${tenantId})
          or (owner_type = 'platform' and owner_tenant_id is null)
        )
    `;
    if (rows[0]?.count !== tagIds.length) {
      throw new BadRequestException('One or more tags are unavailable');
    }
  }

  private async replaceDramaTags(
    transaction: DatabaseTransaction,
    dramaId: string,
    tagIds: string[] | undefined,
    actorId: string,
  ): Promise<void> {
    for (const tagId of tagIds ?? []) {
      await transaction`
        insert into drama_tags (drama_id, tag_id, created_by)
        values (${dramaId}, ${tagId}, ${actorId})
      `;
    }
  }

  private async replaceDramaTranslations(
    transaction: DatabaseTransaction,
    dramaId: string,
    translations: DramaTranslationInput[],
  ): Promise<void> {
    for (const translation of translations) {
      await transaction`
        insert into drama_translations (
          id, drama_id, locale, title, summary, search_keywords
        ) values (
          ${uuidV7()}, ${dramaId}, ${translation.locale}, ${translation.title},
          ${translation.summary ?? ''}, ${translation.searchKeywords ?? []}
        )
      `;
    }
  }

  private async insertContentVersion(
    transaction: DatabaseTransaction,
    input: {
      actorId: string;
      aggregateId: string;
      aggregateType: 'drama' | 'episode';
      snapshot: object;
      tenantId: string;
    },
  ): Promise<string> {
    const id = uuidV7();
    await transaction`
      insert into content_versions (
        id, scope_type, tenant_id, aggregate_type, aggregate_id,
        version_no, snapshot_json, change_level, created_by
      )
      select
        ${id}, 'tenant', ${input.tenantId}, ${input.aggregateType},
        ${input.aggregateId}, coalesce(max(version_no), 0) + 1,
        ${transaction.json(toJsonValue(input.snapshot))}, 'critical', ${input.actorId}
      from content_versions
      where scope_type = 'tenant'
        and tenant_id = ${input.tenantId}
        and aggregate_type = ${input.aggregateType}
        and aggregate_id = ${input.aggregateId}
    `;
    return id;
  }

  private async loadDramaSnapshot(
    transaction: DatabaseTransaction,
    tenantId: string,
    dramaId: string,
  ): Promise<object> {
    const rows = await transaction<Array<{ snapshot: object }>>`
      select jsonb_build_object(
        'drama', to_jsonb(drama) - 'created_by' - 'updated_by',
        'cover', (
          select jsonb_build_object(
            'id', cover.id,
            'kind', cover.kind,
            'mimeType', cover.mime_type,
            'sizeBytes', cover.size_bytes,
            'checksum', cover.checksum,
            'storageProviderId', cover.storage_provider_id,
            'objectKey', cover.object_key,
            'sourceUrl', cover.source_url,
            'status', cover.status,
            'metadata', cover.metadata_json
          )
          from media_assets as cover
          where cover.id = drama.cover_file_id
        ),
        'translations', coalesce((
          select jsonb_agg(to_jsonb(translation) - 'id' - 'drama_id')
          from drama_translations as translation
          where translation.drama_id = drama.id
        ), '[]'::jsonb),
        'episodes', coalesce((
          select jsonb_agg(
            (
              to_jsonb(episode) - 'created_by' - 'updated_by'
              || jsonb_build_object(
                'media', (
                  select jsonb_build_object(
                    'id', media.id,
                    'kind', media.kind,
                    'mimeType', media.mime_type,
                    'sizeBytes', media.size_bytes,
                    'checksum', media.checksum,
                    'durationSeconds', media.duration_seconds,
                    'storageProviderId', media.storage_provider_id,
                    'objectKey', media.object_key,
                    'sourceUrl', media.source_url,
                    'status', media.status,
                    'transcodeStatus', media.transcode_status,
                    'metadata', media.metadata_json
                  )
                  from media_assets as media
                  where media.id = episode.media_asset_id
                ),
                'previewMedia', (
                  select jsonb_build_object(
                    'id', preview.id,
                    'kind', preview.kind,
                    'mimeType', preview.mime_type,
                    'sizeBytes', preview.size_bytes,
                    'checksum', preview.checksum,
                    'durationSeconds', preview.duration_seconds,
                    'storageProviderId', preview.storage_provider_id,
                    'objectKey', preview.object_key,
                    'sourceUrl', preview.source_url,
                    'status', preview.status,
                    'transcodeStatus', preview.transcode_status,
                    'metadata', preview.metadata_json
                  )
                  from media_assets as preview
                  where preview.id = episode.preview_media_asset_id
                ),
                'translations', coalesce((
                  select jsonb_agg(
                    to_jsonb(episode_translation) - 'id' - 'episode_id'
                    order by episode_translation.locale
                  )
                  from episode_translations as episode_translation
                  where episode_translation.episode_id = episode.id
                ), '[]'::jsonb)
              )
            )
            order by episode.episode_no
          )
          from episodes as episode
          where episode.drama_id = drama.id and episode.deleted_at is null
        ), '[]'::jsonb)
      ) as snapshot
      from dramas as drama
      where drama.id = ${dramaId}
        and drama.owner_type = 'tenant'
        and drama.owner_tenant_id = ${tenantId}
        and drama.deleted_at is null
    `;
    if (!rows[0]) throw new NotFoundException('Drama not found');
    return rows[0].snapshot;
  }

  private async insertScheduleJob(
    transaction: DatabaseTransaction,
    tenantId: string,
    targetType: 'drama' | 'episode',
    targetId: string,
    action: 'publish' | 'unpublish',
    scheduledAt: Date,
    metadata: ContentMutationMetadata,
    publicationVersion: number,
  ): Promise<void> {
    await transaction`
      insert into content_schedule_jobs (
        id, scope_type, tenant_id, target_type, target_id, action,
        scheduled_at, idempotency_key, created_by
      ) values (
        ${uuidV7()}, 'tenant', ${tenantId}, ${targetType}, ${targetId}, ${action},
        ${scheduledAt},
        ${`tenant-publish:${targetType}:${targetId}:v${publicationVersion}:${action}:${scheduledAt.toISOString()}`},
        ${metadata.actorId}
      )
      on conflict do nothing
    `;
  }

  private async insertOutbox(
    transaction: DatabaseTransaction,
    tenantId: string,
    idempotencyKey: string,
    input: { aggregateId: string; eventType: string; payload: object },
  ): Promise<void> {
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, 'tenant', ${tenantId}, ${`event:${eventId}`},
        ${idempotencyKey}, 'drama', ${input.aggregateId}, ${input.eventType},
        ${transaction.json(toJsonValue(input.payload))}
      )
    `;
  }

  private async insertAudit(
    transaction: DatabaseTransaction,
    tenantId: string,
    metadata: ContentMutationMetadata,
    input: {
      action: string;
      after: object;
      resourceId: string;
      resourceType: string;
      scope?: 'platform' | 'tenant';
    },
  ): Promise<void> {
    const scope = input.scope ?? 'tenant';
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, ip, request_id
      ) values (
        ${uuidV7()}, ${scope}, ${scope === 'platform' ? null : tenantId},
        ${scope === 'platform' ? 'platform_staff' : 'tenant_staff'},
        ${metadata.actorId}, ${input.action}, ${input.resourceType},
        ${input.resourceId}, ${transaction.json(toJsonValue(input.after))},
        ${metadata.ip ?? null}, ${metadata.requestId}
      )
    `;
  }

  private async beginCommand<T>(
    transaction: DatabaseTransaction,
    input: {
      actorId: string;
      actorType: 'platform_staff' | 'tenant_staff';
      idempotencyKey?: string;
      request: unknown;
      routeKey: string;
      scope: 'platform' | 'tenant';
      tenantId?: string;
    },
  ): Promise<{ cached?: T; id?: string }> {
    if (!input.idempotencyKey) return {};
    const key = input.idempotencyKey.trim();
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw new BadRequestException('Idempotency-Key is invalid');
    }
    const requestHash = createHash('sha256')
      .update(JSON.stringify(toJsonValue(input.request)))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, ${input.scope}, ${input.tenantId ?? null}, ${input.actorType},
        ${input.actorId}, ${input.routeKey}, ${key}, ${requestHash},
        statement_timestamp() + interval '24 hours'
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) return { id };

    const rows = await transaction<CommandIdempotencyRow[]>`
      select id, request_hash, status, response_json
      from command_idempotency
      where scope_type = ${input.scope}
        and tenant_id is not distinct from ${input.tenantId ?? null}
        and actor_type = ${input.actorType}
        and actor_id = ${input.actorId}
        and route_key = ${input.routeKey}
        and idempotency_key = ${key}
      for update
    `;
    const existing = rows[0];
    if (!existing) {
      throw new ConflictException('Idempotency record is unavailable');
    }
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was already used for another request');
    }
    if (existing.status === 'completed' && existing.response_json !== null) {
      return { cached: existing.response_json as T };
    }
    throw new ConflictException('The same command is already processing');
  }

  private async completeCommand(
    transaction: DatabaseTransaction,
    commandId: string | undefined,
    response: unknown,
    responseStatus: number,
    resource?: { resourceId: string; resourceType: string },
  ): Promise<void> {
    if (!commandId) return;
    await transaction`
      update command_idempotency
      set
        status = 'completed',
        response_status = ${responseStatus},
        response_json = ${transaction.json(toJsonValue(response))},
        resource_type = ${resource?.resourceType ?? null},
        resource_id = ${resource?.resourceId ?? null},
        locked_at = null
      where id = ${commandId} and status = 'processing'
    `;
  }
}

function validateCreateDrama(value: CreateDramaInput) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  assertOnlyInputKeys(value, [
    'categoryId', 'code', 'coverFileId', 'releaseAt', 'sourceType',
    'tagIds', 'translations', 'unpublishAt',
  ]);
  const code = requiredString(value.code, 'code', 2, 128).toLowerCase();
  if (!CODE_PATTERN.test(code)) throw new BadRequestException('Invalid drama code');
  const translations = validateDramaTranslations(value.translations);
  const releaseAt = optionalDate(value.releaseAt, 'releaseAt');
  const unpublishAt = optionalDate(value.unpublishAt, 'unpublishAt');
  if (unpublishAt && (!releaseAt || unpublishAt <= releaseAt)) {
    throw new BadRequestException('unpublishAt must be after releaseAt');
  }
  const sourceType = value.sourceType ?? 'upload';
  if (sourceType !== 'upload') {
    throw new BadRequestException('Only direct S3 upload content is supported');
  }
  if (value.coverFileId !== undefined) assertUuid(value.coverFileId, 'coverFileId');
  if (value.categoryId !== undefined) assertUuid(value.categoryId, 'categoryId');
  const tagIds = validateUuidArray(value.tagIds, 'tagIds', 50, []);
  return {
    categoryId: value.categoryId,
    code,
    coverFileId: value.coverFileId,
    releaseAt,
    sourceType,
    tagIds,
    translations,
    unpublishAt,
  };
}

function validateDramaTranslations(value: unknown): DramaTranslationInput[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 6) {
    throw new BadRequestException('translations must contain 1 to 6 locales');
  }
  const locales = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new BadRequestException('Invalid translation');
    const raw = item as Record<string, unknown>;
    assertOnlyInputKeys(raw, ['locale', 'searchKeywords', 'summary', 'title']);
    const locale = requiredString(raw.locale, 'locale', 2, 20);
    if (!SUPPORTED_LOCALES.has(locale) || locales.has(locale)) {
      throw new BadRequestException('Unsupported or duplicate locale');
    }
    locales.add(locale);
    const keywords = raw.searchKeywords ?? [];
    if (!Array.isArray(keywords) || keywords.length > 50 || keywords.some((entry) => typeof entry !== 'string' || entry.length > 100)) {
      throw new BadRequestException('Invalid searchKeywords');
    }
    return {
      locale,
      searchKeywords: keywords,
      summary: optionalString(raw.summary, 'summary', 20_000) ?? '',
      title: requiredString(raw.title, 'title', 1, 300),
    };
  });
}

function validateCreateEpisode(value: CreateEpisodeInput) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  assertOnlyInputKeys(value, [
    'durationSeconds', 'episodeNo', 'expectedDramaVersion', 'mediaAssetId',
    'previewMediaAssetId', 'previewSeconds', 'releaseAt', 'translations', 'unpublishAt',
  ]);
  const episodeNo = boundedInteger(
    value.episodeNo,
    Number.NaN,
    1,
    MAX_EPISODES_PER_DRAMA,
  );
  const durationSeconds = boundedInteger(value.durationSeconds, Number.NaN, 1, 86_400);
  const expectedDramaVersion = boundedInteger(
    value.expectedDramaVersion,
    Number.NaN,
    0,
    1_000_000_000,
  );
  const previewSeconds = boundedInteger(
    value.previewSeconds ?? 0,
    Number.NaN,
    0,
    durationSeconds,
  );
  assertUuid(value.mediaAssetId, 'mediaAssetId');
  if (value.previewMediaAssetId !== undefined) {
    assertUuid(value.previewMediaAssetId, 'previewMediaAssetId');
    assertSeparatePreview(value.mediaAssetId, value.previewMediaAssetId);
  }
  const releaseAt = optionalDate(value.releaseAt, 'releaseAt');
  const unpublishAt = optionalDate(value.unpublishAt, 'unpublishAt');
  if (unpublishAt && (!releaseAt || unpublishAt <= releaseAt)) {
    throw new BadRequestException('unpublishAt must be after releaseAt');
  }
  if (!Array.isArray(value.translations) || value.translations.length < 1 || value.translations.length > 6) {
    throw new BadRequestException('translations must contain 1 to 6 locales');
  }
  const locales = new Set<string>();
  const translations = value.translations.map((item) => {
    if (!item || typeof item !== 'object') throw new BadRequestException('Invalid translation');
    assertOnlyInputKeys(item, ['locale', 'title']);
    const locale = requiredString(item?.locale, 'locale', 2, 20);
    if (!SUPPORTED_LOCALES.has(locale) || locales.has(locale)) {
      throw new BadRequestException('Unsupported or duplicate locale');
    }
    locales.add(locale);
    return { locale, title: requiredString(item?.title, 'title', 1, 300) };
  });
  return {
    durationSeconds,
    episodeNo,
    expectedDramaVersion,
    mediaAssetId: value.mediaAssetId,
    previewMediaAssetId: value.previewMediaAssetId,
    previewSeconds,
    releaseAt,
    translations,
    unpublishAt,
  };
}

function validateUpdateDrama(value: UpdateDramaInput) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  assertOnlyInputKeys(value, [
    'categoryId', 'code', 'coverFileId', 'expectedVersion', 'releaseAt',
    'tagIds', 'translations', 'unpublishAt', 'version',
  ]);
  if (
    value.expectedVersion !== undefined
    && value.version !== undefined
    && value.expectedVersion !== value.version
  ) throw new BadRequestException('version and expectedVersion conflict');
  const version = boundedInteger(
    value.expectedVersion ?? value.version,
    Number.NaN,
    0,
    1_000_000_000,
  );
  const hasCode = Object.hasOwn(value, 'code');
  const hasCoverFileId = Object.hasOwn(value, 'coverFileId');
  const hasCategoryId = Object.hasOwn(value, 'categoryId');
  const hasReleaseAt = Object.hasOwn(value, 'releaseAt');
  const hasUnpublishAt = Object.hasOwn(value, 'unpublishAt');
  const hasTranslations = Object.hasOwn(value, 'translations');
  const hasTagIds = Object.hasOwn(value, 'tagIds');
  if (!hasCode && !hasCoverFileId && !hasCategoryId && !hasReleaseAt
    && !hasUnpublishAt && !hasTranslations && !hasTagIds) {
    throw new BadRequestException('At least one drama field must be changed');
  }
  if (hasCoverFileId && value.coverFileId !== null) assertUuid(value.coverFileId, 'coverFileId');
  if (hasCategoryId && value.categoryId !== null) assertUuid(value.categoryId, 'categoryId');
  const code = hasCode ? requiredString(value.code, 'code', 2, 128).toLowerCase() : undefined;
  if (code && !CODE_PATTERN.test(code)) throw new BadRequestException('Invalid drama code');
  return {
    categoryId: value.categoryId,
    code,
    coverFileId: value.coverFileId,
    hasCategoryId,
    hasCoverFileId,
    hasReleaseAt,
    hasUnpublishAt,
    releaseAt: hasReleaseAt ? optionalNullableDate(value.releaseAt, 'releaseAt') : undefined,
    translations: hasTranslations ? validateDramaTranslations(value.translations) : undefined,
    tagIds: hasTagIds ? validateUuidArray(value.tagIds, 'tagIds', 50) : undefined,
    unpublishAt: hasUnpublishAt
      ? optionalNullableDate(value.unpublishAt, 'unpublishAt')
      : undefined,
    version,
  };
}

function validateUpdateEpisode(value: UpdateEpisodeInput) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  assertOnlyInputKeys(value, [
    'durationSeconds', 'episodeNo', 'expectedVersion', 'mediaAssetId',
    'previewMediaAssetId', 'previewSeconds', 'releaseAt', 'translations', 'unpublishAt',
  ]);
  const expectedVersion = boundedInteger(
    value.expectedVersion,
    Number.NaN,
    0,
    1_000_000_000,
  );
  const hasEpisodeNo = Object.hasOwn(value, 'episodeNo');
  const hasDuration = Object.hasOwn(value, 'durationSeconds');
  const hasPreview = Object.hasOwn(value, 'previewSeconds');
  const hasMedia = Object.hasOwn(value, 'mediaAssetId');
  const hasPreviewMedia = Object.hasOwn(value, 'previewMediaAssetId');
  const hasReleaseAt = Object.hasOwn(value, 'releaseAt');
  const hasUnpublishAt = Object.hasOwn(value, 'unpublishAt');
  const hasTranslations = Object.hasOwn(value, 'translations');
  if (!hasEpisodeNo && !hasDuration && !hasPreview && !hasMedia && !hasPreviewMedia
    && !hasReleaseAt && !hasUnpublishAt && !hasTranslations) {
    throw new BadRequestException('At least one episode field must be changed');
  }
  const episodeNo = hasEpisodeNo
    ? boundedInteger(value.episodeNo, Number.NaN, 1, MAX_EPISODES_PER_DRAMA)
    : undefined;
  const durationSeconds = hasDuration
    ? boundedInteger(value.durationSeconds, Number.NaN, 1, 86_400)
    : undefined;
  const previewSeconds = hasPreview
    ? boundedInteger(value.previewSeconds, Number.NaN, 0, 86_400)
    : undefined;
  if (hasMedia) assertUuid(value.mediaAssetId, 'mediaAssetId');
  if (hasPreviewMedia && value.previewMediaAssetId !== null) {
    assertUuid(value.previewMediaAssetId, 'previewMediaAssetId');
  }
  let translations: Array<{ locale: string; title: string }> | undefined;
  if (hasTranslations) {
    if (!Array.isArray(value.translations) || value.translations.length < 1
      || value.translations.length > 6) {
      throw new BadRequestException('translations must contain 1 to 6 locales');
    }
    const locales = new Set<string>();
    translations = value.translations.map((item) => {
      if (!item || typeof item !== 'object') throw new BadRequestException('Invalid translation');
      assertOnlyInputKeys(item, ['locale', 'title']);
      const locale = requiredString(item?.locale, 'locale', 2, 20);
      if (!SUPPORTED_LOCALES.has(locale) || locales.has(locale)) {
        throw new BadRequestException('Unsupported or duplicate locale');
      }
      locales.add(locale);
      return { locale, title: requiredString(item?.title, 'title', 1, 300) };
    });
  }
  return {
    durationSeconds,
    episodeNo,
    expectedVersion,
    hasReleaseAt,
    hasPreviewMedia,
    hasUnpublishAt,
    mediaAssetId: value.mediaAssetId,
    previewMediaAssetId: value.previewMediaAssetId,
    previewSeconds,
    releaseAt: hasReleaseAt ? optionalNullableDate(value.releaseAt, 'releaseAt') : undefined,
    translations,
    unpublishAt: hasUnpublishAt
      ? optionalNullableDate(value.unpublishAt, 'unpublishAt')
      : undefined,
  };
}

function validateDeleteDrama(value: DeleteTenantDramaInput) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  const extra = Object.keys(value).find((key) => !['expectedVersion', 'reason'].includes(key));
  if (extra) throw new BadRequestException(`Unknown field: ${extra}`);
  return {
    expectedVersion: boundedInteger(value.expectedVersion, Number.NaN, 0, 1_000_000_000),
    reason: requiredString(value.reason, 'reason', 1, 2_000),
  };
}

function validateExpectedVersion(value: ExpectedTenantContentVersionInput) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  const extra = Object.keys(value).find((key) => key !== 'expectedVersion');
  if (extra) throw new BadRequestException(`Unknown field: ${extra}`);
  return { expectedVersion: boundedInteger(
    value.expectedVersion, Number.NaN, 0, 1_000_000_000,
  ) };
}

function toDramaRecord(row: DramaRow): DramaRecord {
  return {
    categoryId: row.category_id ?? undefined,
    code: row.code,
    coverFileId: row.cover_file_id ?? undefined,
    createdAt: row.created_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString(),
    id: row.id,
    releaseAt: row.release_at?.toISOString(),
    restoreUntil: row.restore_until?.toISOString(),
    sourceType: row.source_type,
    status: row.status,
    tagIds: row.tag_ids,
    totalEpisodes: row.total_episodes,
    translations: row.translations,
    unpublishAt: row.unpublish_at?.toISOString(),
    version: row.version,
  };
}

function toEpisodeRecord(row: EpisodeRow): EpisodeRecord {
  return {
    dramaId: row.drama_id,
    durationSeconds: row.duration_seconds,
    episodeNo: row.episode_no,
    id: row.id,
    mediaAssetId: row.media_asset_id,
    previewMediaAssetId: row.preview_media_asset_id ?? undefined,
    previewSeconds: row.preview_seconds,
    releaseAt: row.release_at?.toISOString(),
    status: row.status,
    translations: row.translations,
    unpublishAt: row.unpublish_at?.toISOString(),
    version: row.version,
  };
}

function validateUuidArray(
  value: unknown,
  field: string,
  maximum: number,
  fallback?: string[],
): string[] {
  if (value === undefined && fallback) return fallback;
  if (!Array.isArray(value) || value.length > maximum) {
    throw new BadRequestException(`${field} must contain at most ${maximum} UUIDs`);
  }
  const result = value.map((item) => {
    assertUuid(item, field);
    return item;
  });
  if (new Set(result).size !== result.length) {
    throw new BadRequestException(`${field} contains duplicates`);
  }
  return result;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function assertSeparatePreview(
  mediaAssetId: string,
  previewMediaAssetId: string | null | undefined,
): void {
  if (previewMediaAssetId && previewMediaAssetId === mediaAssetId) {
    throw new BadRequestException('previewMediaAssetId must differ from mediaAssetId');
  }
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    if (Number.isNaN(fallback)) throw new BadRequestException('Invalid integer value');
    return fallback;
  }
  return parsed;
}

function requiredString(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) {
    throw new BadRequestException(`${field} length is invalid`);
  }
  return result;
}

function optionalString(value: unknown, field: string, maximum: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

function optionalDate(value: unknown, field: string): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${field} is invalid`);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new BadRequestException(`${field} is invalid`);
  return date;
}

function optionalNullableDate(value: unknown, field: string): Date | null {
  if (value === null || value === '') return null;
  const date = optionalDate(value, field);
  if (!date) throw new BadRequestException(`${field} is invalid`);
  return date;
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function assertOnlyInputKeys(value: object, allowed: readonly string[]): void {
  const extra = Object.keys(value).find((key) => !allowed.includes(key));
  if (extra) throw new BadRequestException(`Unknown field: ${extra}`);
}
