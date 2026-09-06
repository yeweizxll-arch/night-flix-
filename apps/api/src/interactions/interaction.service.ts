import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { SUPPORTED_APP_LOCALES } from '@drama/contracts';

import { uuidV7 } from '../common/uuid-v7';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import type { PlaybackViewer } from '../playback/playback.types';
import { assertCustomerSiteAvailable } from '../customer-auth/customer-site-policy';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  CreateBulletCommentInput,
  CreateCommentInput,
  CreateInteractionReportInput,
  CreateSensitiveWordInput,
  DramaInteractionSummaryResponse,
  InteractionCommandMetadata,
  InteractionItemResponse,
  InteractionReportResponse,
  InteractionStatus,
  InteractionTargetType,
  ModerateInteractionInput,
  SensitiveWordResponse,
} from './interaction.types';
import { InteractionRateLimiterService } from './interaction-rate-limiter.service';
import { lockPublicDistribution } from '../public-drama-pool/public-distribution';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,200}$/;
const MAX_SENSITIVE_WORDS = 1_000;
const MAX_MATCHES = 20;

interface CommandRow {
  id: string;
  request_hash: string;
  response_json: unknown;
  status: 'completed' | 'failed' | 'processing';
}

interface InteractionRow {
  account_id: string;
  body: string;
  created_at: Date | string;
  drama_id: string;
  episode_id: string | null;
  id: string;
  parent_id: string | null;
  position_ms?: number;
  status: InteractionStatus;
  username?: string;
}

interface ReportRow {
  created_at: Date | string;
  id: string;
  reason_category: string;
  status: 'open' | 'rejected' | 'resolved' | 'reviewing';
  target_id: string;
  target_type: InteractionTargetType;
}

interface SensitiveWordRow {
  created_at: Date | string;
  id: string;
  normalized_term: string;
  scope_type: 'platform' | 'tenant';
  status: 'active' | 'disabled';
  tenant_id: string | null;
  term: string;
}

@Injectable()
export class InteractionService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(InteractionRateLimiterService)
    private readonly rateLimiter: InteractionRateLimiterService,
  ) {}

  async sendFeedback(principal: CustomerPrincipal, raw: Record<string, unknown>, metadata: InteractionCommandMetadata) {
    this.assertPrincipal(principal);
    const body = optionalText(raw?.body, 'body', 1, 2000);
    const locale = raw?.locale;
    if (!body || typeof locale !== 'string' || !SUPPORTED_APP_LOCALES.includes(locale as typeof SUPPORTED_APP_LOCALES[number])) {
      throw new BadRequestException('Feedback body and supported locale are required');
    }
    await this.rateLimiter.consume({ accountId: principal.accountId, tenantId: principal.tenantId, ip: metadata.ip, operation: 'report' });
    return this.database.inTenantContext(principal.tenantId, async sql => {
      await this.requireCustomerSite(sql, principal);
      const command = await this.beginCommand<{ id: string }>(sql, {
        ...metadata, request: { body, locale }, routeKey: 'customer.feedback.create', tenantId: principal.tenantId,
      });
      if (command.cached) return command.cached;
      const id = uuidV7();
      await sql`insert into customer_feedback (id, tenant_id, account_id, locale, body)
        values (${id}, ${principal.tenantId}, ${principal.accountId}, ${locale}, ${body})`;
      const result = { id };
      await this.completeCommand(sql, command.id, result, 201, { resourceId: id, resourceType: 'customer_feedback' });
      return result;
    });
  }

  async feedback(tenantId: string, accountId: string | undefined, pageValue: unknown) {
    assertUuid(tenantId, 'tenantId');
    if (accountId !== undefined) assertUuid(accountId, 'accountId');
    const page = integer(pageValue, 'page', 1, 1, 10000);
    return this.database.inTenantContext(tenantId, async sql => {
      if (accountId) await this.requireReadSite(sql, { tenantId, accountId });
      const items = await sql<Array<{ id: string; body: string; reply: string | null; created_at: Date; replied_at: Date | null }>>`
        select id, body, reply, created_at, replied_at from customer_feedback
        where tenant_id = ${tenantId} and (${accountId ?? null}::uuid is null or account_id = ${accountId ?? null}::uuid)
        order by created_at desc, id desc limit 30 offset ${(page - 1) * 30}
      `;
      return { items: items.map(row => ({ id: row.id, body: row.body, reply: row.reply,
        createdAt: iso(row.created_at), repliedAt: row.replied_at ? iso(row.replied_at) : null })), page, pageSize: 30 };
    });
  }

  async replyFeedback(tenantId: string, id: string, raw: Record<string, unknown>, metadata: InteractionCommandMetadata) {
    assertUuid(id, 'feedbackId');
    const reply = optionalText(raw?.reply, 'reply', 1, 2000);
    if (!reply) throw new BadRequestException('Reply is required');
    return this.database.inTenantContext(tenantId, async sql => {
      const rows = await sql<Array<{ account_id: string; locale: string; reply: string | null }>>`
        select account_id, locale, reply from customer_feedback where tenant_id = ${tenantId} and id = ${id} for update
      `;
      const row = rows[0];
      if (!row) throw new NotFoundException('Feedback is unavailable');
      if (row.reply !== null) {
        if (row.reply !== reply) throw new ConflictException('Feedback already replied');
        return { id, replied: true };
      }
      await sql`update customer_feedback set reply = ${reply}, replied_at = statement_timestamp()
        where tenant_id = ${tenantId} and id = ${id}`;
      await sql`insert into customer_inbox_messages (id, tenant_id, account_id, category, source_type, locale, title, body)
        values (${id}, ${tenantId}, ${row.account_id}, 'transactional', 'system', ${row.locale},
          ${row.locale.startsWith('zh') ? '客服回复' : 'Support reply'}, ${reply})`;
      await sql`insert into audit_logs (id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, request_id) values (${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff',
        ${metadata.actorId}, 'customer.feedback.reply', 'customer_feedback', ${id}, ${metadata.requestId})`;
      return { id, replied: true };
    });
  }

  async dramaSummary(
    principal: PlaybackViewer,
    dramaId: string,
  ): Promise<DramaInteractionSummaryResponse> {
    assertUuid(principal.tenantId, 'tenantId');
    assertUuid(dramaId, 'dramaId');
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.requireReadSite(transaction, principal);
      await this.requirePublishedContent(transaction, principal.tenantId, dramaId, undefined);
      const rows = await transaction<Array<{
        comment_count: number;
        favorite_count: number;
        is_favorite: boolean;
        is_liked: boolean;
        like_count: number;
      }>>`
        select
          (select count(*)::integer from interaction_comments
            where tenant_id = ${principal.tenantId} and drama_id = ${dramaId}
              and status = 'visible') as comment_count,
          (select count(*)::integer from customer_favorites
            where tenant_id = ${principal.tenantId} and drama_id = ${dramaId})
            as favorite_count,
          exists (select 1 from customer_favorites
            where tenant_id = ${principal.tenantId}
              and account_id = ${principal.accountId ?? null}::uuid and drama_id = ${dramaId})
            as is_favorite,
          exists (select 1 from customer_drama_likes
            where tenant_id = ${principal.tenantId}
              and account_id = ${principal.accountId ?? null}::uuid and drama_id = ${dramaId})
            as is_liked,
          (select count(*)::integer from customer_drama_likes
            where tenant_id = ${principal.tenantId} and drama_id = ${dramaId})
            as like_count
      `;
      const row = requiredRow(rows[0], 'Interaction summary is unavailable');
      return mapDramaSummary(row);
    });
  }

  async setDramaLike(
    principal: CustomerPrincipal,
    dramaId: string,
    liked: boolean,
    requestId: string,
  ): Promise<DramaInteractionSummaryResponse> {
    this.assertPrincipal(principal);
    assertUuid(dramaId, 'dramaId');
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.requireCustomerSite(transaction, principal);
      await this.requirePublishedContent(transaction, principal.tenantId, dramaId, undefined);
      const changed = liked
        ? await transaction<{ drama_id: string }[]>`
            insert into customer_drama_likes (tenant_id, account_id, drama_id)
            values (${principal.tenantId}, ${principal.accountId}, ${dramaId})
            on conflict do nothing returning drama_id
          `
        : await transaction<{ drama_id: string }[]>`
            delete from customer_drama_likes
            where tenant_id = ${principal.tenantId}
              and account_id = ${principal.accountId} and drama_id = ${dramaId}
            returning drama_id
          `;
      if (changed[0]) {
        const eventId = uuidV7();
        await transaction`
          insert into outbox_events (
            id, scope_type, tenant_id, event_key, idempotency_key,
            aggregate_type, aggregate_id, event_type, payload_json
          ) values (
            ${eventId}, 'tenant', ${principal.tenantId}, ${`event:${eventId}`},
            ${`${requestId}:${liked ? 'liked' : 'unliked'}`}, 'drama', ${dramaId},
            ${liked ? 'CustomerDramaLiked' : 'CustomerDramaUnliked'},
            ${transaction.json(toJsonValue({
              accountId: principal.accountId, dramaId, tenantId: principal.tenantId,
            }))}
          )
        `;
      }
      const rows = await transaction<Array<{
        comment_count: number; favorite_count: number; is_favorite: boolean;
        is_liked: boolean; like_count: number;
      }>>`
        select
          (select count(*)::integer from interaction_comments
            where tenant_id = ${principal.tenantId} and drama_id = ${dramaId}
              and status = 'visible') as comment_count,
          (select count(*)::integer from customer_favorites
            where tenant_id = ${principal.tenantId} and drama_id = ${dramaId})
            as favorite_count,
          exists (select 1 from customer_favorites
            where tenant_id = ${principal.tenantId}
              and account_id = ${principal.accountId} and drama_id = ${dramaId})
            as is_favorite,
          ${liked}::boolean as is_liked,
          (select count(*)::integer from customer_drama_likes
            where tenant_id = ${principal.tenantId} and drama_id = ${dramaId})
            as like_count
      `;
      return mapDramaSummary(requiredRow(rows[0], 'Interaction summary is unavailable'));
    });
  }

  async listComments(
    principal: PlaybackViewer,
    rawQuery: Record<string, unknown>,
  ): Promise<{ items: InteractionItemResponse[]; page: number; pageSize: number }> {
    const query = contentQuery(rawQuery, true);
    assertUuid(principal.tenantId, 'tenantId');
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.requireReadSite(transaction, principal);
      await this.requirePublishedContent(
        transaction,
        principal.tenantId,
        query.dramaId,
        query.episodeId,
      );
      const rows = await transaction<InteractionRow[]>`
        select
          comment.id, comment.drama_id, comment.episode_id, comment.account_id,
          comment.parent_id, comment.body, comment.status, comment.created_at,
          account.username::text
        from interaction_comments as comment
        inner join customer_accounts as account
          on account.tenant_id = comment.tenant_id
          and account.id = comment.account_id
        where comment.tenant_id = ${principal.tenantId}
          and comment.drama_id = ${query.dramaId}
          and comment.episode_id is not distinct from ${query.episodeId ?? null}
          and comment.status = 'visible'
          and (
            comment.parent_id is null
            or exists (
              select 1 from interaction_comments as parent
              where parent.id = comment.parent_id
                and parent.tenant_id = comment.tenant_id
                and parent.status = 'visible'
            )
          )
        order by
          coalesce(comment.parent_id, comment.id),
          case when comment.parent_id is null then 0 else 1 end,
          comment.created_at,
          comment.id
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
      `;
      return { items: rows.map(row => ({ ...mapInteraction(row),
        isOwn: row.account_id === principal.accountId })), page: query.page, pageSize: query.pageSize };
    });
  }

  async createComment(
    principal: CustomerPrincipal,
    rawInput: CreateCommentInput,
    metadata: InteractionCommandMetadata,
  ): Promise<InteractionItemResponse> {
    this.assertPrincipal(principal);
    const input = commentInput(rawInput);
    const safeMetadata = customerMetadata(principal, metadata);
    await this.rateLimiter.consume({
      accountId: principal.accountId,
      ip: safeMetadata.ip,
      operation: 'comment',
      tenantId: principal.tenantId,
    });
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.requireCustomerSite(transaction, principal);
      const command = await this.beginCommand<InteractionItemResponse>(transaction, {
        ...safeMetadata,
        request: input,
        routeKey: 'customer.interactions.comments.create',
        tenantId: principal.tenantId,
      });
      if (command.cached) return command.cached;
      await this.requirePublishedContent(
        transaction,
        principal.tenantId,
        input.dramaId,
        input.episodeId,
      );
      if (input.parentId) {
        const parents = await transaction<{ id: string }[]>`
          select id from interaction_comments
          where tenant_id = ${principal.tenantId}
            and id = ${input.parentId}
            and drama_id = ${input.dramaId}
            and episode_id is not distinct from ${input.episodeId ?? null}
            and parent_id is null
            and status = 'visible'
          for share
        `;
        if (!parents[0]) throw new NotFoundException('Reply parent is unavailable');
      }
      const matchIds = await this.matchSensitiveWords(
        transaction,
        principal.tenantId,
        input.body,
      );
      const id = uuidV7();
      const rows = await transaction<InteractionRow[]>`
        insert into interaction_comments (
          id, tenant_id, drama_id, episode_id, account_id, parent_id,
          body, status, sensitive_match_ids
        ) values (
          ${id}, ${principal.tenantId}, ${input.dramaId}, ${input.episodeId ?? null},
          ${principal.accountId}, ${input.parentId ?? null}, ${input.body},
          ${matchIds.length ? 'pending' : 'visible'}, ${matchIds}
        )
        returning id, drama_id, episode_id, account_id, parent_id, body,
          status, created_at
      `;
      const response = { ...mapInteraction(requiredRow(rows[0], 'Comment was not created')), isOwn: true };
      await this.recordCustomerMutation(transaction, safeMetadata, {
        eventType: 'InteractionCommentCreated',
        matchCount: matchIds.length,
        resourceId: id,
        resourceType: 'interaction_comment',
        response,
        routeKey: 'customer.interactions.comments.create',
        tenantId: principal.tenantId,
      });
      await this.completeCommand(transaction, command.id, response, 201, {
        resourceId: id,
        resourceType: 'interaction_comment',
      });
      return response;
    });
  }

  async listBulletComments(
    principal: CustomerPrincipal,
    rawQuery: Record<string, unknown>,
  ): Promise<{ items: InteractionItemResponse[]; page: number; pageSize: number }> {
    const query = contentQuery(rawQuery, false);
    if (!query.episodeId) throw new BadRequestException('episodeId is required');
    const episodeId = query.episodeId;
    this.assertPrincipal(principal);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.requireCustomerSite(transaction, principal);
      await this.requirePublishedContent(
        transaction,
        principal.tenantId,
        query.dramaId,
        episodeId,
      );
      const rows = await transaction<InteractionRow[]>`
        select
          bullet.id, bullet.drama_id, bullet.episode_id, bullet.account_id,
          bullet.body, bullet.status, bullet.position_ms, bullet.created_at,
          account.username::text
        from interaction_bullet_comments as bullet
        inner join customer_accounts as account
          on account.tenant_id = bullet.tenant_id
          and account.id = bullet.account_id
        where bullet.tenant_id = ${principal.tenantId}
          and bullet.drama_id = ${query.dramaId}
          and bullet.episode_id = ${episodeId}
          and bullet.status = 'visible'
        order by bullet.position_ms, bullet.id
        limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
      `;
      return { items: rows.map(mapInteraction), page: query.page, pageSize: query.pageSize };
    });
  }

  async createBulletComment(
    principal: CustomerPrincipal,
    rawInput: CreateBulletCommentInput,
    metadata: InteractionCommandMetadata,
  ): Promise<InteractionItemResponse> {
    this.assertPrincipal(principal);
    const input = bulletInput(rawInput);
    const safeMetadata = customerMetadata(principal, metadata);
    await this.rateLimiter.consume({
      accountId: principal.accountId,
      ip: safeMetadata.ip,
      operation: 'bullet_comment',
      tenantId: principal.tenantId,
    });
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.requireCustomerSite(transaction, principal);
      const command = await this.beginCommand<InteractionItemResponse>(transaction, {
        ...safeMetadata,
        request: input,
        routeKey: 'customer.interactions.bullet_comments.create',
        tenantId: principal.tenantId,
      });
      if (command.cached) return command.cached;
      const durationSeconds = await this.requirePublishedContent(
        transaction,
        principal.tenantId,
        input.dramaId,
        input.episodeId,
      );
      if (durationSeconds === undefined || input.positionMs > durationSeconds * 1_000) {
        throw new BadRequestException('positionMs exceeds the episode duration');
      }
      const matchIds = await this.matchSensitiveWords(
        transaction,
        principal.tenantId,
        input.body,
      );
      const id = uuidV7();
      const rows = await transaction<InteractionRow[]>`
        insert into interaction_bullet_comments (
          id, tenant_id, drama_id, episode_id, account_id, position_ms,
          body, status, sensitive_match_ids
        ) values (
          ${id}, ${principal.tenantId}, ${input.dramaId}, ${input.episodeId},
          ${principal.accountId}, ${input.positionMs}, ${input.body},
          ${matchIds.length ? 'pending' : 'visible'}, ${matchIds}
        )
        returning id, drama_id, episode_id, account_id, body, status,
          position_ms, created_at
      `;
      const response = mapInteraction(requiredRow(rows[0], 'Bullet comment was not created'));
      await this.recordCustomerMutation(transaction, safeMetadata, {
        eventType: 'InteractionBulletCommentCreated',
        matchCount: matchIds.length,
        resourceId: id,
        resourceType: 'interaction_bullet_comment',
        response,
        routeKey: 'customer.interactions.bullet_comments.create',
        tenantId: principal.tenantId,
      });
      await this.completeCommand(transaction, command.id, response, 201, {
        resourceId: id,
        resourceType: 'interaction_bullet_comment',
      });
      return response;
    });
  }

  async deleteOwnInteraction(
    principal: CustomerPrincipal,
    targetType: InteractionTargetType,
    targetId: string,
    metadata: InteractionCommandMetadata,
  ): Promise<InteractionItemResponse> {
    this.assertPrincipal(principal);
    if (targetType !== 'comment' && targetType !== 'bullet_comment') {
      throw new BadRequestException('targetType is invalid');
    }
    assertUuid(targetId, 'targetId');
    const safeMetadata = customerMetadata(principal, metadata);
    await this.rateLimiter.consume({
      accountId: principal.accountId,
      ip: safeMetadata.ip,
      operation: targetType,
      tenantId: principal.tenantId,
    });
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.requireCustomerSite(transaction, principal);
      const routeKey = `customer.interactions.${targetType}.delete`;
      const command = await this.beginCommand<InteractionItemResponse>(transaction, {
        ...safeMetadata,
        request: { targetId, targetType },
        routeKey,
        tenantId: principal.tenantId,
      });
      if (command.cached) return command.cached;
      const rows = targetType === 'comment'
        ? await transaction<InteractionRow[]>`
            select id, drama_id, episode_id, account_id, parent_id, body,
              status, created_at
            from interaction_comments
            where tenant_id = ${principal.tenantId}
              and id = ${targetId}
              and account_id = ${principal.accountId}
              and status in ('visible', 'pending', 'hidden')
            for update
          `
        : await transaction<InteractionRow[]>`
            select id, drama_id, episode_id, account_id, body, status,
              position_ms, created_at
            from interaction_bullet_comments
            where tenant_id = ${principal.tenantId}
              and id = ${targetId}
              and account_id = ${principal.accountId}
              and status in ('visible', 'pending', 'hidden')
            for update
          `;
      const before = rows[0];
      if (!before) throw new NotFoundException('Owned interaction not found');
      await this.requirePublishedContent(
        transaction,
        principal.tenantId,
        before.drama_id,
        before.episode_id ?? undefined,
      );
      const deleted = targetType === 'comment'
        ? await transaction<InteractionRow[]>`
            update interaction_comments
            set status = 'deleted', deleted_at = statement_timestamp(),
              deleted_by = ${principal.accountId}, deleted_by_type = 'user',
              delete_reason = 'deleted by author',
              restore_until = statement_timestamp() + interval '30 days',
              version = version + 1
            where tenant_id = ${principal.tenantId} and id = ${targetId}
            returning id, drama_id, episode_id, account_id, parent_id,
              body, status, created_at
          `
        : await transaction<InteractionRow[]>`
            update interaction_bullet_comments
            set status = 'deleted', deleted_at = statement_timestamp(),
              deleted_by = ${principal.accountId}, deleted_by_type = 'user',
              delete_reason = 'deleted by author',
              restore_until = statement_timestamp() + interval '30 days',
              version = version + 1
            where tenant_id = ${principal.tenantId} and id = ${targetId}
            returning id, drama_id, episode_id, account_id, position_ms,
              body, status, created_at
          `;
      const response = mapInteraction(requiredRow(deleted[0], 'Interaction was not deleted'));
      await this.recordCustomerMutation(transaction, safeMetadata, {
        eventType: 'InteractionDeletedByAuthor',
        matchCount: 0,
        resourceId: targetId,
        resourceType: `interaction_${targetType}`,
        response,
        routeKey,
        tenantId: principal.tenantId,
      });
      await this.completeCommand(transaction, command.id, response, 200, {
        resourceId: targetId,
        resourceType: `interaction_${targetType}`,
      });
      return response;
    });
  }

  async createReport(
    principal: CustomerPrincipal,
    rawInput: CreateInteractionReportInput,
    metadata: InteractionCommandMetadata,
  ): Promise<InteractionReportResponse> {
    this.assertPrincipal(principal);
    const input = reportInput(rawInput);
    const safeMetadata = customerMetadata(principal, metadata);
    await this.rateLimiter.consume({
      accountId: principal.accountId,
      ip: safeMetadata.ip,
      operation: 'report',
      tenantId: principal.tenantId,
    });
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await this.requireCustomerSite(transaction, principal);
      const command = await this.beginCommand<InteractionReportResponse>(transaction, {
        ...safeMetadata,
        request: input,
        routeKey: 'customer.interactions.reports.create',
        tenantId: principal.tenantId,
      });
      if (command.cached) return command.cached;
      const targets = input.targetType === 'comment'
        ? await transaction<Array<{
            drama_id: string;
            episode_id: string | null;
            id: string;
          }>>`
            select id, drama_id, episode_id from interaction_comments
            where tenant_id = ${principal.tenantId}
              and id = ${input.targetId}
              and status = 'visible'
            for share
          `
        : await transaction<Array<{
            drama_id: string;
            episode_id: string | null;
            id: string;
          }>>`
            select id, drama_id, episode_id from interaction_bullet_comments
            where tenant_id = ${principal.tenantId}
              and id = ${input.targetId}
              and status = 'visible'
            for share
          `;
      const target = targets[0];
      if (!target) throw new NotFoundException('Report target is unavailable');
      await this.requirePublishedContent(
        transaction,
        principal.tenantId,
        target.drama_id,
        target.episode_id ?? undefined,
      );
      const id = uuidV7();
      let rows: ReportRow[];
      try {
        rows = await transaction<ReportRow[]>`
          insert into interaction_reports (
            id, tenant_id, reporter_account_id, target_type, target_id,
            reason_category, details
          ) values (
            ${id}, ${principal.tenantId}, ${principal.accountId},
            ${input.targetType}, ${input.targetId}, ${input.reasonCategory},
            ${input.details ?? null}
          )
          returning id, target_type, target_id, reason_category, status, created_at
        `;
      } catch (error: unknown) {
        if (isDatabaseError(error, '23505')) {
          throw new ConflictException('This interaction was already reported');
        }
        throw error;
      }
      const response = mapReport(requiredRow(rows[0], 'Report was not created'));
      await this.recordCustomerMutation(transaction, safeMetadata, {
        eventType: 'InteractionReported',
        matchCount: 0,
        resourceId: id,
        resourceType: 'interaction_report',
        response,
        routeKey: 'customer.interactions.reports.create',
        tenantId: principal.tenantId,
      });
      await this.completeCommand(transaction, command.id, response, 201, {
        resourceId: id,
        resourceType: 'interaction_report',
      });
      return response;
    });
  }

  async listSensitiveWords(
    scope: 'platform' | 'tenant',
    tenantId: string | undefined,
    rawQuery: Record<string, unknown>,
  ): Promise<{ items: SensitiveWordResponse[]; page: number; pageSize: number }> {
    const page = integer(rawQuery.page, 'page', 1, 1, 10_000);
    const pageSize = integer(rawQuery.pageSize, 'pageSize', 20, 1, 100);
    if (scope === 'tenant') assertUuid(tenantId, 'tenantId');
    return this.withScope(scope, tenantId, async (transaction) => {
      const rows = await transaction<SensitiveWordRow[]>`
        select id, scope_type, tenant_id, term, normalized_term, status, created_at
        from interaction_sensitive_words
        where scope_type = ${scope}
          and tenant_id is not distinct from ${tenantId ?? null}
        order by created_at desc, id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return { items: rows.map(mapSensitiveWord), page, pageSize };
    });
  }

  async createSensitiveWord(
    scope: 'platform' | 'tenant',
    tenantId: string | undefined,
    rawInput: CreateSensitiveWordInput,
    metadata: InteractionCommandMetadata,
  ): Promise<SensitiveWordResponse> {
    if (scope === 'tenant') assertUuid(tenantId, 'tenantId');
    const term = requiredCanonicalText(rawInput?.term, 'term', 2, 64);
    const normalizedTerm = normalizeText(term);
    const safeMetadata = staffMetadata(scope, tenantId, metadata);
    return this.withScope(scope, tenantId, async (transaction) => {
      const command = await this.beginCommand<SensitiveWordResponse>(transaction, {
        ...safeMetadata,
        request: { term },
        routeKey: `${scope}.interactions.sensitive_words.create`,
        tenantId,
      });
      if (command.cached) return command.cached;
      const existing = await transaction<SensitiveWordRow[]>`
        select id, scope_type, tenant_id, term, normalized_term, status, created_at
        from interaction_sensitive_words
        where scope_type = ${scope}
          and tenant_id is not distinct from ${tenantId ?? null}
          and normalized_term = ${normalizedTerm}
        for update
      `;
      let row = existing[0];
      if (row) {
        if (row.status === 'active') {
          throw new ConflictException('Sensitive word already exists');
        }
        const reactivated = await transaction<SensitiveWordRow[]>`
          update interaction_sensitive_words
          set status = 'active', term = ${term}, updated_by = ${safeMetadata.actorId}
          where id = ${row.id}
          returning id, scope_type, tenant_id, term, normalized_term, status, created_at
        `;
        row = reactivated[0];
      } else {
        const inserted = await transaction<SensitiveWordRow[]>`
          insert into interaction_sensitive_words (
            id, scope_type, tenant_id, term, normalized_term, created_by
          ) values (
            ${uuidV7()}, ${scope}, ${tenantId ?? null}, ${term},
            ${normalizedTerm}, ${safeMetadata.actorId}
          )
          returning id, scope_type, tenant_id, term, normalized_term, status, created_at
        `;
        row = inserted[0];
      }
      const response = mapSensitiveWord(requiredRow(row, 'Sensitive word was not created'));
      await this.recordStaffMutation(transaction, safeMetadata, {
        action: 'interaction.sensitive_word.create',
        eventType: 'InteractionSensitiveWordChanged',
        resourceId: response.id,
        resourceType: 'interaction_sensitive_word',
        response,
        routeKey: `${scope}.interactions.sensitive_words.create`,
        tenantId,
      });
      await this.completeCommand(transaction, command.id, response, 201, {
        resourceId: response.id,
        resourceType: 'interaction_sensitive_word',
      });
      return response;
    });
  }

  async disableSensitiveWord(
    scope: 'platform' | 'tenant',
    tenantId: string | undefined,
    wordId: string,
    metadata: InteractionCommandMetadata,
  ): Promise<SensitiveWordResponse> {
    assertUuid(wordId, 'wordId');
    if (scope === 'tenant') assertUuid(tenantId, 'tenantId');
    const safeMetadata = staffMetadata(scope, tenantId, metadata);
    return this.withScope(scope, tenantId, async (transaction) => {
      const command = await this.beginCommand<SensitiveWordResponse>(transaction, {
        ...safeMetadata,
        request: { wordId },
        routeKey: `${scope}.interactions.sensitive_words.disable`,
        tenantId,
      });
      if (command.cached) return command.cached;
      const rows = await transaction<SensitiveWordRow[]>`
        update interaction_sensitive_words
        set status = 'disabled', updated_by = ${safeMetadata.actorId}
        where id = ${wordId}
          and scope_type = ${scope}
          and tenant_id is not distinct from ${tenantId ?? null}
          and status = 'active'
        returning id, scope_type, tenant_id, term, normalized_term, status, created_at
      `;
      const response = mapSensitiveWord(requiredRow(rows[0], 'Active sensitive word not found'));
      await this.recordStaffMutation(transaction, safeMetadata, {
        action: 'interaction.sensitive_word.disable',
        eventType: 'InteractionSensitiveWordChanged',
        resourceId: response.id,
        resourceType: 'interaction_sensitive_word',
        response,
        routeKey: `${scope}.interactions.sensitive_words.disable`,
        tenantId,
      });
      await this.completeCommand(transaction, command.id, response, 200, {
        resourceId: response.id,
        resourceType: 'interaction_sensitive_word',
      });
      return response;
    });
  }

  async listModerationQueue(
    scope: 'platform' | 'tenant',
    tenantId: string | undefined,
    rawQuery: Record<string, unknown>,
  ): Promise<{ items: Array<Record<string, unknown>>; page: number; pageSize: number }> {
    const query = moderationQuery(rawQuery, scope);
    const effectiveTenantId = scope === 'tenant' ? tenantId : query.tenantId;
    if (scope === 'tenant') assertUuid(effectiveTenantId, 'tenantId');
    return this.withScope(scope, effectiveTenantId, async (transaction) => {
      const tenantFilter = scope === 'tenant' ? effectiveTenantId : query.tenantId;
      if (query.targetType === 'report') {
        const rows = await transaction<Array<{
          created_at: Date | string;
          details: string | null;
          id: string;
          reason_category: string;
          reporter_account_id: string;
          status: string;
          target_id: string;
          target_type: string;
          tenant_id: string;
        }>>`
          select id, tenant_id, reporter_account_id, target_type, target_id,
            reason_category, details, status, created_at
          from interaction_reports
          where (${tenantFilter ?? null}::uuid is null or tenant_id = ${tenantFilter ?? null})
            and (${query.status ?? null}::text is null or status = ${query.status ?? null})
          order by created_at desc, id desc
          limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
        `;
        return {
          items: rows.map((row) => ({
            createdAt: iso(row.created_at),
            details: row.details ?? undefined,
            id: row.id,
            reasonCategory: row.reason_category,
            reporterAccountId: row.reporter_account_id,
            status: row.status,
            targetId: row.target_id,
            targetType: row.target_type,
            tenantId: row.tenant_id,
          })),
          page: query.page,
          pageSize: query.pageSize,
        };
      }
      const rows = query.targetType === 'comment'
        ? await transaction<Array<InteractionRow & {
            sensitive_match_count: number;
            tenant_id: string;
          }>>`
            select id, tenant_id, drama_id, episode_id, account_id, parent_id,
              body, status,
              cardinality(sensitive_match_ids)::integer as sensitive_match_count,
              created_at
            from interaction_comments
            where (${tenantFilter ?? null}::uuid is null or tenant_id = ${tenantFilter ?? null})
              and (${query.status ?? null}::text is null or status = ${query.status ?? null})
            order by created_at desc, id desc
            limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
          `
        : await transaction<Array<InteractionRow & {
            sensitive_match_count: number;
            tenant_id: string;
          }>>`
            select id, tenant_id, drama_id, episode_id, account_id, position_ms,
              body, status,
              cardinality(sensitive_match_ids)::integer as sensitive_match_count,
              created_at
            from interaction_bullet_comments
            where (${tenantFilter ?? null}::uuid is null or tenant_id = ${tenantFilter ?? null})
              and (${query.status ?? null}::text is null or status = ${query.status ?? null})
            order by created_at desc, id desc
            limit ${query.pageSize} offset ${(query.page - 1) * query.pageSize}
          `;
      return {
        items: rows.map((row) => ({
          ...mapInteraction(row),
          accountId: row.account_id,
          sensitiveMatchCount: row.sensitive_match_count,
          tenantId: row.tenant_id,
        })),
        page: query.page,
        pageSize: query.pageSize,
      };
    });
  }

  async moderate(
    scope: 'platform' | 'tenant',
    tenantId: string | undefined,
    targetTypeValue: unknown,
    targetId: string,
    rawInput: ModerateInteractionInput,
    metadata: InteractionCommandMetadata,
  ): Promise<Record<string, unknown>> {
    const targetType = moderationTargetType(targetTypeValue);
    assertUuid(targetId, 'targetId');
    const input = moderationInput(rawInput, targetType, scope);
    const effectiveTenantId = scope === 'platform' ? input.tenantId : tenantId;
    assertUuid(effectiveTenantId, 'tenantId');
    const safeMetadata = staffMetadata(scope, effectiveTenantId, metadata);
    return this.withScope(scope, effectiveTenantId, async (transaction) => {
      const command = await this.beginCommand<Record<string, unknown>>(transaction, {
        ...safeMetadata,
        request: { action: input.action, reason: input.reason, targetId, targetType },
        routeKey: `${scope}.interactions.moderation.${targetType}.${input.action}`,
        tenantId: scope === 'tenant' ? effectiveTenantId : undefined,
      });
      if (command.cached) return command.cached;
      const before = await this.lockModerationTarget(
        transaction,
        effectiveTenantId,
        targetType,
        targetId,
      );
      const afterStatus = moderationTransition(targetType, before.status, input.action);
      if (targetType === 'report') {
        await transaction`
          update interaction_reports
          set status = ${afterStatus}, reviewed_at = statement_timestamp(),
            reviewed_by = ${safeMetadata.actorId},
            reviewed_by_type = ${safeMetadata.actorType},
            resolution = ${input.reason}, version = version + 1
          where tenant_id = ${effectiveTenantId} and id = ${targetId}
        `;
      } else {
        const table = targetType === 'comment'
          ? 'interaction_comments'
          : 'interaction_bullet_comments';
        if (input.action === 'delete') {
          await transaction`
            update ${transaction(table)}
            set status = 'deleted', moderated_at = statement_timestamp(),
              moderated_by = ${safeMetadata.actorId},
              moderated_by_type = ${safeMetadata.actorType},
              moderation_reason = ${input.reason},
              deleted_at = statement_timestamp(), deleted_by = ${safeMetadata.actorId},
              deleted_by_type = ${safeMetadata.actorType}, delete_reason = ${input.reason},
              restore_until = statement_timestamp() + interval '30 days',
              version = version + 1
            where tenant_id = ${effectiveTenantId} and id = ${targetId}
          `;
        } else {
          await transaction`
            update ${transaction(table)}
            set status = ${afterStatus}, moderated_at = statement_timestamp(),
              moderated_by = ${safeMetadata.actorId},
              moderated_by_type = ${safeMetadata.actorType},
              moderation_reason = ${input.reason}, version = version + 1
            where tenant_id = ${effectiveTenantId} and id = ${targetId}
          `;
        }
      }
      const actionId = uuidV7();
      await transaction`
        insert into interaction_moderation_actions (
          id, tenant_id, target_type, target_id, action, actor_type, actor_id,
          reason, before_status, after_status, request_id
        ) values (
          ${actionId}, ${effectiveTenantId}, ${targetType}, ${targetId},
          ${input.action}, ${safeMetadata.actorType}, ${safeMetadata.actorId},
          ${input.reason}, ${before.status}, ${afterStatus}, ${safeMetadata.requestId}
        )
      `;
      const response = {
        action: input.action,
        id: targetId,
        status: afterStatus,
        targetType,
        tenantId: effectiveTenantId,
      };
      await this.recordStaffMutation(transaction, safeMetadata, {
        action: `interaction.moderation.${input.action}`,
        eventType: 'InteractionModerated',
        resourceId: targetId,
        resourceType: `interaction_${targetType}`,
        response,
        routeKey: `${scope}.interactions.moderation.${targetType}.${input.action}`,
        tenantId: effectiveTenantId,
      });
      await this.completeCommand(transaction, command.id, response, 200, {
        resourceId: targetId,
        resourceType: `interaction_${targetType}`,
      });
      return response;
    });
  }

  private async withScope<T>(
    scope: 'platform' | 'tenant',
    tenantId: string | undefined,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    if (scope !== 'tenant') throw new ForbiddenException('Content moderation belongs to the tenant');
    return this.database.inTenantContext(requiredString(tenantId, 'tenantId'), callback);
  }

  private async requireReadSite(transaction: DatabaseTransaction, principal: PlaybackViewer) {
    if (principal.accountId !== undefined) {
      assertUuid(principal.accountId, 'accountId');
      await this.requireCustomerSite(transaction, principal as CustomerPrincipal);
    } else {
      await assertCustomerSiteAvailable(transaction, principal.tenantId);
    }
  }

  private assertPrincipal(principal: CustomerPrincipal): void {
    if (!principal || typeof principal !== 'object') {
      throw new ForbiddenException('Customer principal is required');
    }
    assertUuid(principal.tenantId, 'tenantId');
    assertUuid(principal.accountId, 'accountId');
  }

  private async requireCustomerSite(
    transaction: DatabaseTransaction,
    principal: CustomerPrincipal,
  ): Promise<void> {
    const rows = await transaction<{ id: string }[]>`
      select account.id
      from tenants as tenant
      inner join customer_accounts as account
        on account.tenant_id = tenant.id
        and account.id = ${principal.accountId}
        and account.status = 'active'
      where tenant.id = ${principal.tenantId}
        and tenant.status = 'active'
        and tenant.expires_at > statement_timestamp()
        and tenant.user_site_enabled
        and tenant.platform_site_enabled
      for share of tenant, account
    `;
    if (!rows[0]) throw new ForbiddenException('Customer site is unavailable');
  }

  private async requirePublishedContent(
    transaction: DatabaseTransaction,
    tenantId: string,
    dramaId: string,
    episodeId: string | undefined,
  ): Promise<number | undefined> {
    const dramas = await transaction<{ owner_type: 'platform' | 'tenant' }[]>`
      select drama.owner_type
      from dramas as drama
      where drama.id = ${dramaId}
        and drama.status = 'published'
        and drama.deleted_at is null
        and drama.emergency_takedown_at is null
        and app.customer_region_allowed(${tenantId}, drama.id)
        and (drama.release_at is null or drama.release_at <= statement_timestamp())
        and (drama.unpublish_at is null or drama.unpublish_at > statement_timestamp())
        and (
          (drama.owner_type = 'tenant' and drama.owner_tenant_id = ${tenantId})
          or (
            drama.owner_type = 'platform'
            and (
              exists (
                select 1 from tenant_public_drama_publications as publication
                where publication.tenant_id = ${tenantId}
                  and publication.drama_id = drama.id
                  and publication.status = 'published'
              )
              or exists (
                select 1
                from content_license_items as item
                inner join content_licenses as license
                  on license.id = item.license_id and license.tenant_id = item.tenant_id
                where item.tenant_id = ${tenantId}
                  and item.drama_id = drama.id
                  and license.status in ('scheduled', 'active')
                  and license.starts_at <= statement_timestamp()
                  and license.expires_at > statement_timestamp()
              )
            )
          )
        )
        and app.lock_customer_row('dramas', drama.id, to_jsonb(drama.*))
    `;
    const drama = dramas[0];
    if (!drama) throw new NotFoundException('Published content is unavailable');
    if (drama.owner_type === 'platform') {
      await lockPublicDistribution(transaction, tenantId, dramaId);
    }
    if (!episodeId) return undefined;
    const episodes = await transaction<{ duration_seconds: number }[]>`
      select duration_seconds from episodes
      where id = ${episodeId} and drama_id = ${dramaId}
        and status = 'published' and deleted_at is null
        and (release_at is null or release_at <= statement_timestamp())
        and (unpublish_at is null or unpublish_at > statement_timestamp())
        and app.lock_customer_row('episodes', episodes.id, to_jsonb(episodes.*))
    `;
    const episode = episodes[0];
    if (!episode) throw new NotFoundException('Published episode is unavailable');
    return episode.duration_seconds;
  }

  private async matchSensitiveWords(
    transaction: DatabaseTransaction,
    tenantId: string,
    body: string,
  ): Promise<string[]> {
    const words = await transaction<SensitiveWordRow[]>`
      select id, scope_type, tenant_id, term, normalized_term, status, created_at
      from interaction_sensitive_words
      where status = 'active'
        and (scope_type = 'tenant' and tenant_id = ${tenantId})
      order by char_length(normalized_term) desc, id
      limit ${MAX_SENSITIVE_WORDS + 1}
    `;
    if (words.length > MAX_SENSITIVE_WORDS) {
      throw new ServiceUnavailableException('Sensitive-word configuration exceeds the safe limit');
    }
    const normalizedBody = normalizeText(body);
    const matches: string[] = [];
    for (const word of words) {
      if (normalizedBody.includes(word.normalized_term)) matches.push(word.id);
      if (matches.length === MAX_MATCHES) break;
    }
    return matches;
  }

  private async lockModerationTarget(
    transaction: DatabaseTransaction,
    tenantId: string,
    targetType: 'bullet_comment' | 'comment' | 'report',
    targetId: string,
  ): Promise<{ status: string }> {
    const table = targetType === 'comment'
      ? 'interaction_comments'
      : targetType === 'bullet_comment'
        ? 'interaction_bullet_comments'
        : 'interaction_reports';
    const rows = await transaction<{ status: string }[]>`
      select status from ${transaction(table)}
      where tenant_id = ${tenantId} and id = ${targetId}
      for update
    `;
    if (!rows[0]) throw new NotFoundException('Moderation target not found');
    return rows[0];
  }

  private async beginCommand<T>(
    transaction: DatabaseTransaction,
    input: InteractionCommandMetadata & {
      request: unknown;
      routeKey: string;
      tenantId?: string;
    },
  ): Promise<{ cached?: T; id?: string }> {
    const key = requireIdempotencyKey(input.idempotencyKey);
    const requestHash = createHash('sha256')
      .update(JSON.stringify(toJsonValue(input.request)))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, ${input.scope}, ${input.scope === 'tenant' ? input.tenantId ?? null : null},
        ${input.actorType}, ${input.actorId}, ${input.routeKey}, ${key},
        ${requestHash}, statement_timestamp() + interval '24 hours'
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) return { id };
    const rows = await transaction<CommandRow[]>`
      select id, request_hash, response_json, status
      from command_idempotency
      where scope_type = ${input.scope}
        and tenant_id is not distinct from ${input.scope === 'tenant' ? input.tenantId ?? null : null}
        and actor_type = ${input.actorType}
        and actor_id = ${input.actorId}
        and route_key = ${input.routeKey}
        and idempotency_key = ${key}
      for update
    `;
    const existing = rows[0];
    if (!existing) throw new ConflictException('Idempotency record is unavailable');
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was used for another request');
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
    resource: { resourceId: string; resourceType: string },
  ): Promise<void> {
    if (!commandId) return;
    await transaction`
      update command_idempotency
      set status = 'completed', response_status = ${responseStatus},
        response_json = ${transaction.json(toJsonValue(response))},
        resource_type = ${resource.resourceType}, resource_id = ${resource.resourceId},
        locked_at = null
      where id = ${commandId} and status = 'processing'
    `;
  }

  private async recordCustomerMutation(
    transaction: DatabaseTransaction,
    metadata: InteractionCommandMetadata,
    input: {
      eventType: string;
      matchCount: number;
      resourceId: string;
      resourceType: string;
      response: object;
      routeKey: string;
      tenantId: string;
    },
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, ip, request_id
      ) values (
        ${uuidV7()}, 'tenant', ${input.tenantId}, 'user', ${metadata.actorId},
        ${input.routeKey}, ${input.resourceType}, ${input.resourceId},
        ${transaction.json(toJsonValue({
          bodyLength: 'body' in input.response
            ? String(input.response.body).length
            : undefined,
          matchCount: input.matchCount,
          status: 'status' in input.response ? input.response.status : undefined,
        }))}, ${metadata.ip ?? null}, ${metadata.requestId}
      )
    `;
    await this.insertOutbox(transaction, metadata, {
      eventType: input.eventType,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      routeKey: input.routeKey,
      tenantId: input.tenantId,
    });
  }

  private async recordStaffMutation(
    transaction: DatabaseTransaction,
    metadata: InteractionCommandMetadata,
    input: {
      action: string;
      eventType: string;
      resourceId: string;
      resourceType: string;
      response: object;
      routeKey: string;
      tenantId?: string;
    },
  ): Promise<void> {
    const platform = metadata.scope === 'platform';
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, ip, request_id
      ) values (
        ${uuidV7()}, ${metadata.scope}, ${platform ? null : input.tenantId ?? null},
        ${metadata.actorType}, ${metadata.actorId}, ${input.action},
        ${input.resourceType}, ${input.resourceId},
        ${transaction.json(toJsonValue(input.response))}, ${metadata.ip ?? null},
        ${metadata.requestId}
      )
    `;
    await this.insertOutbox(transaction, metadata, {
      eventType: input.eventType,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
      routeKey: input.routeKey,
      tenantId: input.tenantId,
    });
  }

  private async insertOutbox(
    transaction: DatabaseTransaction,
    metadata: InteractionCommandMetadata,
    input: {
      eventType: string;
      resourceId: string;
      resourceType: string;
      routeKey: string;
      tenantId?: string;
    },
  ): Promise<void> {
    const key = requireIdempotencyKey(metadata.idempotencyKey);
    const digest = createHash('sha256')
      .update(`${metadata.scope}|${input.tenantId ?? ''}|${metadata.actorId}|${input.routeKey}|${key}`)
      .digest('hex');
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, ${metadata.scope},
        ${metadata.scope === 'tenant' ? input.tenantId ?? null : null},
        ${`event:${eventId}`}, ${`interaction:${digest}`},
        ${input.resourceType}, ${input.resourceId}, ${input.eventType},
        ${transaction.json(toJsonValue({
          resourceId: input.resourceId,
          tenantId: input.tenantId,
        }))}
      )
    `;
  }
}

function contentQuery(value: Record<string, unknown>, episodeOptional: boolean) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Query is invalid');
  }
  return {
    dramaId: uuid(value.dramaId, 'dramaId'),
    episodeId: episodeOptional
      ? optionalUuid(value.episodeId, 'episodeId')
      : uuid(value.episodeId, 'episodeId'),
    page: integer(value.page, 'page', 1, 1, 10_000),
    pageSize: integer(value.pageSize, 'pageSize', 20, 1, 50),
  };
}

function commentInput(value: CreateCommentInput) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  return {
    body: requiredCanonicalText(value.body, 'body', 1, 2_000),
    dramaId: uuid(value.dramaId, 'dramaId'),
    episodeId: optionalUuid(value.episodeId, 'episodeId'),
    parentId: optionalUuid(value.parentId, 'parentId'),
  };
}

function bulletInput(value: CreateBulletCommentInput) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  return {
    body: requiredCanonicalText(value.body, 'body', 1, 200),
    dramaId: uuid(value.dramaId, 'dramaId'),
    episodeId: uuid(value.episodeId, 'episodeId'),
    positionMs: integer(value.positionMs, 'positionMs', -1, 0, 86_400_000),
  };
}

function reportInput(value: CreateInteractionReportInput) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  const targetType = value.targetType;
  if (targetType !== 'comment' && targetType !== 'bullet_comment') {
    throw new BadRequestException('targetType is invalid');
  }
  const categories = ['abuse', 'copyright', 'harassment', 'illegal', 'spam', 'other'];
  if (typeof value.reasonCategory !== 'string' || !categories.includes(value.reasonCategory)) {
    throw new BadRequestException('reasonCategory is invalid');
  }
  return {
    details: optionalText(value.details, 'details', 1, 1_000),
    reasonCategory: value.reasonCategory,
    targetId: uuid(value.targetId, 'targetId'),
    targetType,
  } as const;
}

function moderationQuery(value: Record<string, unknown>, scope: 'platform' | 'tenant') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Query is invalid');
  }
  const targetType = moderationTargetType(value.targetType ?? 'comment');
  const allowedStatuses = targetType === 'report'
    ? ['open', 'reviewing', 'resolved', 'rejected']
    : ['visible', 'pending', 'hidden', 'deleted'];
  const status = optionalText(value.status, 'status', 3, 32);
  if (status && !allowedStatuses.includes(status)) {
    throw new BadRequestException('status is invalid');
  }
  return {
    page: integer(value.page, 'page', 1, 1, 10_000),
    pageSize: integer(value.pageSize, 'pageSize', 20, 1, 100),
    status,
    targetType,
    tenantId: scope === 'platform' ? optionalUuid(value.tenantId, 'tenantId') : undefined,
  };
}

function moderationInput(
  value: ModerateInteractionInput,
  targetType: 'bullet_comment' | 'comment' | 'report',
  scope: 'platform' | 'tenant',
) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  const actions = targetType === 'report'
    ? ['resolve', 'reject']
    : ['approve', 'hide', 'delete', 'restore'];
  if (typeof value.action !== 'string' || !actions.includes(value.action)) {
    throw new BadRequestException('action is invalid');
  }
  return {
    action: value.action as 'approve' | 'delete' | 'hide' | 'reject' | 'resolve' | 'restore',
    reason: requiredText(value.reason, 'reason', 1, 1_000),
    tenantId: scope === 'platform' ? uuid(value.tenantId, 'tenantId') : undefined,
  };
}

function moderationTargetType(value: unknown): 'bullet_comment' | 'comment' | 'report' {
  if (value !== 'comment' && value !== 'bullet_comment' && value !== 'report') {
    throw new BadRequestException('targetType is invalid');
  }
  return value;
}

function moderationTransition(
  targetType: 'bullet_comment' | 'comment' | 'report',
  current: string,
  action: string,
): string {
  if (targetType === 'report') {
    if (!['open', 'reviewing'].includes(current)) {
      throw new ConflictException('Report review is already final');
    }
    return action === 'resolve' ? 'resolved' : 'rejected';
  }
  if (action === 'delete') {
    if (current === 'deleted') throw new ConflictException('Interaction is already deleted');
    return 'deleted';
  }
  if (action === 'restore') {
    if (current !== 'deleted') throw new ConflictException('Only deleted interactions can be restored');
    return 'hidden';
  }
  if (current === 'deleted') {
    throw new ConflictException('Deleted interaction must be restored first');
  }
  const next = action === 'approve' ? 'visible' : 'hidden';
  if (current === next) throw new ConflictException('Interaction is already in that state');
  return next;
}

function customerMetadata(
  principal: CustomerPrincipal,
  metadata: InteractionCommandMetadata,
): InteractionCommandMetadata {
  if (metadata.actorId !== principal.accountId || metadata.actorType !== 'user') {
    throw new ForbiddenException('Customer command actor is invalid');
  }
  return { ...metadata, actorId: principal.accountId, actorType: 'user', scope: 'tenant' };
}

function staffMetadata(
  scope: 'platform' | 'tenant',
  tenantId: string | undefined,
  metadata: InteractionCommandMetadata,
): InteractionCommandMetadata {
  const expectedActorType = scope === 'platform' ? 'platform_staff' : 'tenant_staff';
  if (metadata.scope !== scope || metadata.actorType !== expectedActorType) {
    throw new ForbiddenException('Moderation command actor is invalid');
  }
  assertUuid(metadata.actorId, 'actorId');
  if (scope === 'tenant') assertUuid(tenantId, 'tenantId');
  return metadata;
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new BadRequestException('A valid Idempotency-Key header is required');
  }
  return value;
}

function requiredText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is invalid`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return normalized;
}

function optionalText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : requiredText(value, field, minimum, maximum);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new BadRequestException(`${field} is required`);
  return value;
}

function integer(
  value: unknown,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined && fallback >= minimum) return fallback;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new BadRequestException(`${field} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return parsed;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return uuid(value, field);
}

function uuid(value: unknown, field: string): string {
  assertUuid(value, field);
  return value;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function normalizeText(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und').trim();
}

function mapInteraction(row: InteractionRow): InteractionItemResponse {
  return {
    body: row.body,
    createdAt: iso(row.created_at),
    dramaId: row.drama_id,
    episodeId: row.episode_id ?? undefined,
    id: row.id,
    parentId: row.parent_id ?? undefined,
    positionMs: row.position_ms,
    status: row.status,
    username: row.username,
  };
}

function mapDramaSummary(row: {
  comment_count: number;
  favorite_count: number;
  is_favorite: boolean;
  is_liked: boolean;
  like_count: number;
}): DramaInteractionSummaryResponse {
  return {
    commentCount: row.comment_count,
    favoriteCount: row.favorite_count,
    isFavorite: row.is_favorite,
    isLiked: row.is_liked,
    likeCount: row.like_count,
  };
}

function requiredCanonicalText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is invalid`);
  if (value.length > maximum * 4) throw new BadRequestException(`${field} is invalid`);
  return requiredText(value.normalize('NFKC'), field, minimum, maximum);
}

function mapReport(row: ReportRow): InteractionReportResponse {
  return {
    createdAt: iso(row.created_at),
    id: row.id,
    reasonCategory: row.reason_category,
    status: row.status,
    targetId: row.target_id,
    targetType: row.target_type,
  };
}

function mapSensitiveWord(row: SensitiveWordRow): SensitiveWordResponse {
  return {
    createdAt: iso(row.created_at),
    id: row.id,
    scope: row.scope_type,
    status: row.status,
    tenantId: row.tenant_id ?? undefined,
    term: row.term,
  };
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function requiredRow<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function isDatabaseError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
