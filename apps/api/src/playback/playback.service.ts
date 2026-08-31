import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import { assertCustomerSiteAvailable } from '../customer-auth/customer-site-policy';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  FavoriteDramaRecord,
  UpsertWatchProgressInput,
  WatchProgressRecord,
} from './playback.types';
import { CustomerPlaybackAccessService } from './customer-playback-access.service';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ProgressRow {
  completed: boolean;
  drama_id: string;
  episode_id: string;
  position_seconds: number;
  total_count?: number;
  updated_at: Date;
  version: number;
}

@Injectable()
export class PlaybackService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(CustomerPlaybackAccessService)
    private readonly access: CustomerPlaybackAccessService,
  ) {}

  async upsertProgress(
    principal: CustomerPrincipal,
    rawInput: UpsertWatchProgressInput,
  ): Promise<WatchProgressRecord> {
    const input = validateProgress(rawInput);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      const target = await this.access.resolveInTransaction(
        transaction,
        principal,
        input.episodeId,
      );
      if (target.dramaId !== input.dramaId) {
        throw new NotFoundException('Published episode is unavailable');
      }
      if (target.access === 'locked') {
        throw new ForbiddenException('Playback is locked');
      }
      const maximumPosition = target.access === 'preview'
        ? target.previewSeconds
        : target.durationSeconds;
      if (input.positionSeconds > maximumPosition) {
        throw new BadRequestException('positionSeconds exceeds playback access');
      }
      if (target.access === 'preview' && input.completed) {
        throw new BadRequestException('Preview playback cannot be completed');
      }
      const rows = await transaction<ProgressRow[]>`
        insert into watch_progress (
          id, tenant_id, account_id, drama_id, episode_id,
          position_seconds, completed
        ) values (
          ${uuidV7()}, ${principal.tenantId}, ${principal.accountId},
          ${input.dramaId}, ${input.episodeId}, ${input.positionSeconds},
          ${input.completed}
        )
        on conflict (tenant_id, account_id, episode_id) do update
        set
          drama_id = excluded.drama_id,
          position_seconds = excluded.position_seconds,
          completed = excluded.completed,
          version = watch_progress.version + 1
        returning
          drama_id, episode_id, position_seconds, completed, version, updated_at
      `;
      const row = rows[0];
      if (!row) throw new Error('Watch progress could not be saved');
      return mapProgress(row);
    });
  }

  async listHistory(
    principal: CustomerPrincipal,
    pageValue: number,
    pageSizeValue: number,
  ): Promise<{
    items: WatchProgressRecord[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await assertCustomerSiteAvailable(transaction, principal.tenantId);
      const rows = await transaction<ProgressRow[]>`
        select
          drama_id, episode_id, position_seconds, completed, version, updated_at,
          count(*) over()::integer as total_count
        from watch_progress
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
        order by updated_at desc, id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map(mapProgress),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  async addFavorite(
    principal: CustomerPrincipal,
    dramaId: string,
    requestId: string,
  ): Promise<{ added: boolean }> {
    assertUuid(dramaId, 'dramaId');
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await assertCustomerSiteAvailable(transaction, principal.tenantId);
      const targets = await transaction<{ id: string }[]>`
        select id from dramas
        where id = ${dramaId}
          and status = 'published'
          and deleted_at is null
          and (
            (owner_type = 'tenant' and owner_tenant_id = ${principal.tenantId})
            or (
              owner_type = 'platform'
              and exists (
                select 1
                from content_license_items as license_item
                inner join content_licenses as license
                  on license.id = license_item.license_id
                  and license.tenant_id = license_item.tenant_id
                where license_item.tenant_id = ${principal.tenantId}
                  and license_item.drama_id = dramas.id
                  and license.status in ('scheduled', 'active')
                  and license.starts_at <= statement_timestamp()
                  and license.expires_at > statement_timestamp()
              )
            )
          )
      `;
      if (!targets[0]) throw new NotFoundException('Published drama is unavailable');
      const inserted = await transaction<{ drama_id: string }[]>`
        insert into customer_favorites (tenant_id, account_id, drama_id)
        values (${principal.tenantId}, ${principal.accountId}, ${dramaId})
        on conflict do nothing
        returning drama_id
      `;
      if (inserted[0]) {
        await this.insertOutbox(transaction, principal.tenantId, requestId, {
          accountId: principal.accountId,
          dramaId,
          eventType: 'CustomerFavoriteAdded',
        });
      }
      return { added: Boolean(inserted[0]) };
    });
  }

  async removeFavorite(
    principal: CustomerPrincipal,
    dramaId: string,
    requestId: string,
  ): Promise<{ removed: boolean }> {
    assertUuid(dramaId, 'dramaId');
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await assertCustomerSiteAvailable(transaction, principal.tenantId);
      const removed = await transaction<{ drama_id: string }[]>`
        delete from customer_favorites
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and drama_id = ${dramaId}
        returning drama_id
      `;
      if (removed[0]) {
        await this.insertOutbox(transaction, principal.tenantId, requestId, {
          accountId: principal.accountId,
          dramaId,
          eventType: 'CustomerFavoriteRemoved',
        });
      }
      return { removed: Boolean(removed[0]) };
    });
  }

  async listFavorites(
    principal: CustomerPrincipal,
    pageValue: number,
    pageSizeValue: number,
  ): Promise<{
    items: FavoriteDramaRecord[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await assertCustomerSiteAvailable(transaction, principal.tenantId);
      const rows = await transaction<
        Array<{
          code: string;
          cover_file_id: string | null;
          created_at: Date;
          drama_id: string;
          title: string | null;
          total_count: number;
        }>
      >`
        select
          favorite.drama_id,
          favorite.created_at,
          drama.code::text,
          drama.cover_file_id,
          count(*) over()::integer as total_count,
          (
            select translation.title
            from drama_translations as translation
            where translation.drama_id = drama.id
            order by
              case when translation.locale = 'en-US' then 0 else 1 end,
              translation.locale
            limit 1
          ) as title
        from customer_favorites as favorite
        inner join dramas as drama
          on drama.id = favorite.drama_id
          and drama.status = 'published'
          and drama.deleted_at is null
          and (
            (
              drama.owner_type = 'tenant'
              and drama.owner_tenant_id = ${principal.tenantId}
            )
            or (
              drama.owner_type = 'platform'
              and exists (
                select 1
                from content_license_items as license_item
                inner join content_licenses as license
                  on license.id = license_item.license_id
                  and license.tenant_id = license_item.tenant_id
                where license_item.tenant_id = ${principal.tenantId}
                  and license_item.drama_id = drama.id
                  and license.status in ('scheduled', 'active')
                  and license.starts_at <= statement_timestamp()
                  and license.expires_at > statement_timestamp()
              )
            )
          )
        where favorite.tenant_id = ${principal.tenantId}
          and favorite.account_id = ${principal.accountId}
        order by favorite.created_at desc, favorite.drama_id
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map((row) => ({
          code: row.code,
          coverFileId: row.cover_file_id ?? undefined,
          createdAt: row.created_at.toISOString(),
          dramaId: row.drama_id,
          title: row.title ?? undefined,
        })),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  private async insertOutbox(
    transaction: DatabaseTransaction,
    tenantId: string,
    requestId: string,
    input: { accountId: string; dramaId: string; eventType: string },
  ): Promise<void> {
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, 'tenant', ${tenantId}, ${`event:${eventId}`},
        ${`${requestId}:${input.eventType}`}, 'drama', ${input.dramaId},
        ${input.eventType},
        ${transaction.json(toJsonValue({
          accountId: input.accountId,
          dramaId: input.dramaId,
          tenantId,
        }))}
      )
    `;
  }
}

function validateProgress(value: UpsertWatchProgressInput) {
  if (!isRecord(value)) throw new BadRequestException('Body is required');
  assertUuid(value.dramaId, 'dramaId');
  assertUuid(value.episodeId, 'episodeId');
  if (
    typeof value.positionSeconds !== 'number'
    || !Number.isInteger(value.positionSeconds)
    || value.positionSeconds < 0
  ) {
    throw new BadRequestException('positionSeconds must be a non-negative integer');
  }
  if (value.completed !== undefined && typeof value.completed !== 'boolean') {
    throw new BadRequestException('completed must be boolean');
  }
  return {
    completed: value.completed ?? false,
    dramaId: value.dramaId,
    episodeId: value.episodeId,
    positionSeconds: value.positionSeconds,
  };
}

function mapProgress(row: ProgressRow): WatchProgressRecord {
  return {
    completed: row.completed,
    dramaId: row.drama_id,
    episodeId: row.episode_id,
    positionSeconds: row.position_seconds,
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

function boundedInteger(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
