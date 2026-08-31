import { PGlite, type Transaction } from '@electric-sql/pglite';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { uuidV7 } from '../src/common/uuid-v7';
import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import type { InteractionRateLimiterService } from '../src/interactions/interaction-rate-limiter.service';
import { InteractionService } from '../src/interactions/interaction.service';
import type { InteractionCommandMetadata } from '../src/interactions/interaction.types';

const tenantA = '018f2f45-7f5e-7e70-b17f-f6e773577101';
const tenantB = '018f2f45-7f5e-7e70-b17f-f6e773577102';
const accountA = '018f2f45-7f5e-7e70-b17f-f6e773577103';
const accountA2 = '018f2f45-7f5e-7e70-b17f-f6e773577104';
const accountB = '018f2f45-7f5e-7e70-b17f-f6e773577105';
const platformStaff = '018f2f45-7f5e-7e70-b17f-f6e773577106';
const tenantStaff = '018f2f45-7f5e-7e70-b17f-f6e773577107';
const videoA = '018f2f45-7f5e-7e70-b17f-f6e773577108';
const videoB = '018f2f45-7f5e-7e70-b17f-f6e773577109';
const platformVideo = '018f2f45-7f5e-7e70-b17f-f6e773577110';
const dramaA = '018f2f45-7f5e-7e70-b17f-f6e77357710a';
const dramaB = '018f2f45-7f5e-7e70-b17f-f6e77357710b';
const platformDrama = '018f2f45-7f5e-7e70-b17f-f6e77357710c';
const episodeA = '018f2f45-7f5e-7e70-b17f-f6e77357710d';
const episodeB = '018f2f45-7f5e-7e70-b17f-f6e77357710e';
const platformEpisode = '018f2f45-7f5e-7e70-b17f-f6e77357710f';

const principalA = {
  accountId: accountA,
  deviceId: uuidV7(),
  sessionId: uuidV7(),
  tenantId: tenantA,
  username: 'viewer_a',
};
const principalA2 = { ...principalA, accountId: accountA2, username: 'viewer_a2' };

let database: PGlite;
let interactions: InteractionService;
const consume = vi.fn(async () => undefined);

function transactionTag(transaction: Transaction): DatabaseTransaction {
  const tag = (
    strings: TemplateStringsArray | string,
    ...values: unknown[]
  ): Promise<unknown[]> | { identifier: string } => {
    if (typeof strings === 'string') return { identifier: strings };
    let sql = strings[0] ?? '';
    const parameters: unknown[] = [];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      if (
        typeof value === 'object' && value !== null
        && 'identifier' in value && typeof value.identifier === 'string'
      ) {
        if (!/^[a-z_][a-z0-9_]*$/.test(value.identifier)) {
          throw new Error('Unsafe SQL identifier in test adapter');
        }
        sql += `"${value.identifier}"${strings[index + 1] ?? ''}`;
        continue;
      }
      parameters.push(value);
      sql += `$${parameters.length}${strings[index + 1] ?? ''}`;
    }
    return transaction.query(sql, parameters).then((result) => result.rows);
  };
  Object.assign(tag, { json: (value: unknown) => JSON.stringify(value) });
  return tag as unknown as DatabaseTransaction;
}

describe('customer interactions and moderation security', () => {
  beforeAll(async () => {
    database = new PGlite();
    const directory = resolve(process.cwd(), '../../database/migrations');
    for (const filename of (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort()) {
      const source = await readFile(resolve(directory, filename), 'utf8');
      await database.exec(source
        .replace(/^CREATE EXTENSION IF NOT EXISTS (?:citext|pgcrypto);$/gm, '')
        .replace(/\bcitext\b/g, 'text'));
    }
    await database.exec(`
      insert into tenants (id, code, name, expires_at) values
        ('${tenantA}', 'interaction-a', 'Interaction A', statement_timestamp() + interval '1 year'),
        ('${tenantB}', 'interaction-b', 'Interaction B', statement_timestamp() + interval '1 year');
      insert into platform_staff (id, username, password_hash)
      values ('${platformStaff}', 'interaction_admin', '${'p'.repeat(64)}');
      insert into tenant_staff (id, tenant_id, username, password_hash)
      values ('${tenantStaff}', '${tenantA}', 'interaction_moderator', '${'p'.repeat(64)}');
      insert into customer_accounts (id, tenant_id, username, password_hash) values
        ('${accountA}', '${tenantA}', 'viewer_a', '${'p'.repeat(64)}'),
        ('${accountA2}', '${tenantA}', 'viewer_a2', '${'p'.repeat(64)}'),
        ('${accountB}', '${tenantB}', 'viewer_b', '${'p'.repeat(64)}');
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, source_url, mime_type,
        checksum, status, transcode_status, duration_seconds, metadata_json
      ) values
        ('${videoA}', 'tenant', '${tenantA}', 'video', 'https://example.com/a.mp4',
          'video/mp4', '${'a'.repeat(64)}', 'ready', 'ready', 120, '{"immutable":true}'),
        ('${videoB}', 'tenant', '${tenantB}', 'video', 'https://example.com/b.mp4',
          'video/mp4', '${'b'.repeat(64)}', 'ready', 'ready', 90, '{"immutable":true}');
      insert into media_assets (
        id, owner_type, owner_tenant_id, kind, source_url, mime_type,
        checksum, status, transcode_status, duration_seconds, metadata_json
      ) values
        ('${platformVideo}', 'platform', null, 'video', 'https://example.com/p.mp4',
          'video/mp4', '${'c'.repeat(64)}', 'ready', 'ready', 90, '{"immutable":true}');
      insert into dramas (
        id, owner_type, owner_tenant_id, code, status, release_at, total_episodes
      ) values
        ('${dramaA}', 'tenant', '${tenantA}', 'interaction-a', 'published',
          statement_timestamp() - interval '1 day', 1),
        ('${dramaB}', 'tenant', '${tenantB}', 'interaction-b', 'published',
          statement_timestamp() - interval '1 day', 1),
        ('${platformDrama}', 'platform', null, 'interaction-platform', 'published',
          statement_timestamp() - interval '1 day', 1);
      insert into episodes (
        id, drama_id, episode_no, status, release_at, duration_seconds,
        media_asset_id, preview_seconds
      ) values
        ('${episodeA}', '${dramaA}', 1, 'published',
          statement_timestamp() - interval '1 day', 120, '${videoA}', 10),
        ('${episodeB}', '${dramaB}', 1, 'published',
          statement_timestamp() - interval '1 day', 90, '${videoB}', 10),
        ('${platformEpisode}', '${platformDrama}', 1, 'published',
          statement_timestamp() - interval '1 day', 90, '${platformVideo}', 10);
    `);
    const expiredLicense = uuidV7();
    await database.exec(`
      insert into content_licenses (
        id, tenant_id, license_type, drama_id, starts_at, expires_at,
        status, granted_by
      ) values (
        '${expiredLicense}', '${tenantA}', 'drama', '${platformDrama}',
        statement_timestamp() - interval '2 days',
        statement_timestamp() - interval '1 day', 'expired', '${platformStaff}'
      );
      insert into content_license_items (id, tenant_id, license_id, drama_id)
      values ('${uuidV7()}', '${tenantA}', '${expiredLicense}', '${platformDrama}');
    `);

    const databaseService = {
      inTenantContext: <T>(
        tenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction(async (transaction) => {
        const tagged = transactionTag(transaction);
        await tagged`
          select set_config('app.access_scope', 'tenant', true),
            set_config('app.tenant_id', ${tenantId}, true)
        `;
        return callback(tagged);
      }),
      inPlatformContext: <T>(
        callback: (transaction: DatabaseTransaction) => Promise<T>,
      ): Promise<T> => database.transaction((transaction) => callback(transactionTag(transaction))),
    } as unknown as DatabaseService;
    interactions = new InteractionService(
      databaseService,
      { consume } as unknown as InteractionRateLimiterService,
    );
  }, 30_000);

  afterAll(async () => {
    await database?.close();
  });

  it('normalizes NFKC words and sends matched text to bounded pending review', async () => {
    const word = await interactions.createSensitiveWord(
      'platform',
      undefined,
      { term: 'ＡＢＣ' },
      staffCommand('platform', platformStaff, 'platform-word-0001'),
    );
    expect(word).toMatchObject({ scope: 'platform', status: 'active', term: 'ABC' });
    const pending = await interactions.createComment(
      principalA,
      { body: 'contains ａｂｃ text', dramaId: dramaA, episodeId: episodeA },
      customerCommand('comment-pending-0001'),
    );
    expect(pending).toMatchObject({ body: 'contains abc text', status: 'pending' });
    expect(pending).not.toHaveProperty('accountId');
    await expect(interactions.createComment(
      principalA,
      { body: 'different body', dramaId: dramaA, episodeId: episodeA },
      customerCommand('comment-pending-0001'),
    )).rejects.toBeInstanceOf(ConflictException);
    const cached = await interactions.createComment(
      principalA,
      { body: 'contains ａｂｃ text', dramaId: dramaA, episodeId: episodeA },
      customerCommand('comment-pending-0001'),
    );
    expect(cached).toEqual(pending);
    const visible = await interactions.createComment(
      principalA,
      { body: 'safe root', dramaId: dramaA, episodeId: episodeA },
      customerCommand('comment-visible-0001'),
    );
    expect(visible.status).toBe('visible');
    const listed = await interactions.listComments(principalA, {
      dramaId: dramaA,
      episodeId: episodeA,
      pageSize: 50,
    });
    expect(listed.items.map((item) => item.id)).toContain(visible.id);
    expect(listed.items.map((item) => item.id)).not.toContain(pending.id);
    expect(JSON.stringify(listed)).not.toContain(accountA);
    await expect(database.exec(`
      delete from interaction_sensitive_words where id = '${word.id}'
    `)).rejects.toThrow();
  });

  it('supports exactly one reply level and freezes the thread structure', async () => {
    const root = await interactions.createComment(
      principalA,
      { body: 'thread root', dramaId: dramaA, episodeId: episodeA },
      customerCommand('thread-root-0001'),
    );
    const reply = await interactions.createComment(
      principalA2,
      { body: 'first level reply', dramaId: dramaA, episodeId: episodeA, parentId: root.id },
      customerCommand('thread-reply-0001', accountA2),
    );
    await expect(interactions.createComment(
      principalA,
      { body: 'forbidden second level', dramaId: dramaA, episodeId: episodeA, parentId: reply.id },
      customerCommand('thread-reply-0002'),
    )).rejects.toBeInstanceOf(NotFoundException);
    await expect(database.exec(`
      update interaction_comments set parent_id = '${reply.id}' where id = '${root.id}'
    `)).rejects.toThrow();
    await expect(database.exec(`
      update interaction_comments set body = 'rewritten' where id = '${root.id}'
    `)).rejects.toThrow();
  });

  it('enforces author-only idempotent soft deletion and one staff restore within 30 days', async () => {
    const comment = await interactions.createComment(
      principalA,
      { body: 'delete my comment', dramaId: dramaA, episodeId: episodeA },
      customerCommand('delete-create-0001'),
    );
    await expect(interactions.deleteOwnInteraction(
      principalA2,
      'comment',
      comment.id,
      customerCommand('delete-other-0001', accountA2),
    )).rejects.toBeInstanceOf(NotFoundException);
    const deleted = await interactions.deleteOwnInteraction(
      principalA,
      'comment',
      comment.id,
      customerCommand('delete-own-0001'),
    );
    expect(deleted.status).toBe('deleted');
    const cached = await interactions.deleteOwnInteraction(
      principalA,
      'comment',
      comment.id,
      customerCommand('delete-own-0001'),
    );
    expect(cached).toEqual(deleted);
    await database.exec(`
      update interaction_comments
      set status = 'hidden', moderated_at = statement_timestamp(),
        moderated_by = '${tenantStaff}', moderated_by_type = 'tenant_staff',
        moderation_reason = 'approved restore'
      where id = '${comment.id}';
    `);
    const restored = await database.query<{ restore_count: number; status: string }>(`
      select restore_count, status from interaction_comments where id = '${comment.id}'
    `);
    expect(restored.rows[0]).toEqual({ restore_count: 1, status: 'hidden' });
    await database.exec(`
      update interaction_comments
      set status = 'deleted', deleted_at = statement_timestamp(),
        deleted_by = '${tenantStaff}', deleted_by_type = 'tenant_staff',
        delete_reason = 'delete again',
        restore_until = statement_timestamp() + interval '30 days'
      where id = '${comment.id}';
    `);
    await expect(database.exec(`
      update interaction_comments set status = 'hidden' where id = '${comment.id}'
    `)).rejects.toThrow();
    await expect(database.exec(`
      delete from interaction_comments where id = '${comment.id}'
    `)).rejects.toThrow();
  });

  it('bounds bullet position by the locked published episode duration', async () => {
    await expect(interactions.createBulletComment(
      principalA,
      { body: 'too late', dramaId: dramaA, episodeId: episodeA, positionMs: 120_001 },
      customerCommand('bullet-late-0001'),
    )).rejects.toBeInstanceOf(BadRequestException);
    const bullet = await interactions.createBulletComment(
      principalA,
      { body: 'on time', dramaId: dramaA, episodeId: episodeA, positionMs: 12_000 },
      customerCommand('bullet-valid-0001'),
    );
    expect(bullet).toMatchObject({ positionMs: 12_000, status: 'visible' });
  });

  it('records tenant and platform moderation actions with delete/restore state transitions', async () => {
    const target = await interactions.createComment(
      principalA,
      { body: 'moderation target', dramaId: dramaA, episodeId: episodeA },
      customerCommand('moderation-target-0001'),
    );
    const hidden = await interactions.moderate(
      'tenant',
      tenantA,
      'comment',
      target.id,
      { action: 'hide', reason: 'tenant review' },
      staffCommand('tenant', tenantStaff, 'moderation-hide-0001'),
    );
    expect(hidden.status).toBe('hidden');
    const approved = await interactions.moderate(
      'platform',
      undefined,
      'comment',
      target.id,
      { action: 'approve', reason: 'platform review', tenantId: tenantA },
      staffCommand('platform', platformStaff, 'moderation-approve-0001'),
    );
    expect(approved.status).toBe('visible');
    await interactions.moderate(
      'platform',
      undefined,
      'comment',
      target.id,
      { action: 'delete', reason: 'policy removal', tenantId: tenantA },
      staffCommand('platform', platformStaff, 'moderation-delete-0001'),
    );
    const restored = await interactions.moderate(
      'platform',
      undefined,
      'comment',
      target.id,
      { action: 'restore', reason: 'appeal accepted', tenantId: tenantA },
      staffCommand('platform', platformStaff, 'moderation-restore-0001'),
    );
    expect(restored.status).toBe('hidden');
    const tenantQueue = await interactions.listModerationQueue('tenant', tenantA, {
      status: 'hidden',
      targetType: 'comment',
    });
    expect(tenantQueue.items).toContainEqual(expect.objectContaining({
      accountId: accountA,
      id: target.id,
      tenantId: tenantA,
    }));
    const platformQueue = await interactions.listModerationQueue('platform', undefined, {
      status: 'hidden',
      targetType: 'comment',
      tenantId: tenantA,
    });
    expect(platformQueue.items.map((item) => item.id)).toContain(target.id);
    const crossTarget = uuidV7();
    await database.exec(`
      insert into interaction_comments (
        id, tenant_id, drama_id, episode_id, account_id, body
      ) values (
        '${crossTarget}', '${tenantB}', '${dramaB}', '${episodeB}',
        '${accountB}', 'cross tenant moderation target'
      )
    `);
    await expect(interactions.moderate(
      'tenant',
      tenantA,
      'comment',
      crossTarget,
      { action: 'hide', reason: 'cross tenant attempt' },
      staffCommand('tenant', tenantStaff, 'moderation-cross-0001'),
    )).rejects.toBeInstanceOf(NotFoundException);
    const facts = await database.query<{
      actions: string;
      audits: string;
      events: string;
      restore_count: number;
    }>(`
      select
        (select count(*)::text from interaction_moderation_actions
          where target_id = '${target.id}') as actions,
        (select count(*)::text from audit_logs
          where resource_id = '${target.id}' and action like 'interaction.moderation.%') as audits,
        (select count(*)::text from outbox_events
          where aggregate_id = '${target.id}' and event_type = 'InteractionModerated') as events,
        (select restore_count from interaction_comments where id = '${target.id}') as restore_count
    `);
    expect(facts.rows[0]).toEqual({ actions: '4', audits: '4', events: '4', restore_count: 1 });
  });

  it('rejects cross-tenant private and expired-license platform targets at service and DB trigger layers', async () => {
    await expect(interactions.createComment(
      principalA,
      { body: 'cross tenant', dramaId: dramaB, episodeId: episodeB },
      customerCommand('cross-tenant-0001'),
    )).rejects.toBeInstanceOf(NotFoundException);
    await expect(interactions.createComment(
      principalA,
      { body: 'expired platform', dramaId: platformDrama, episodeId: platformEpisode },
      customerCommand('expired-license-0001'),
    )).rejects.toBeInstanceOf(NotFoundException);
    await expect(database.exec(`
      insert into interaction_comments (
        id, tenant_id, drama_id, episode_id, account_id, body
      ) values (
        '${uuidV7()}', '${tenantA}', '${dramaB}', '${episodeB}', '${accountA}',
        'direct forged cross tenant comment'
      )
    `)).rejects.toThrow();
  });

  it('freezes report evidence, prevents physical deletion, and makes duplicate reports conflict', async () => {
    const target = await interactions.createComment(
      principalA2,
      { body: 'report target', dramaId: dramaA, episodeId: episodeA },
      customerCommand('report-target-0001', accountA2),
    );
    const report = await interactions.createReport(
      principalA,
      { reasonCategory: 'spam', targetId: target.id, targetType: 'comment' },
      customerCommand('report-create-0001'),
    );
    expect(report.status).toBe('open');
    await expect(interactions.createReport(
      principalA,
      { reasonCategory: 'abuse', targetId: target.id, targetType: 'comment' },
      customerCommand('report-create-0002'),
    )).rejects.toBeInstanceOf(ConflictException);
    await expect(database.exec(`
      update interaction_reports set reason_category = 'abuse' where id = '${report.id}'
    `)).rejects.toThrow();
    await expect(database.exec(`
      delete from interaction_reports where id = '${report.id}'
    `)).rejects.toThrow();
  });

  it('fails closed when the user site is disabled and rate-limits before DB work', async () => {
    expect(consume).toHaveBeenCalled();
    await database.exec(`update tenants set user_site_enabled = false where id = '${tenantA}'`);
    try {
      await expect(interactions.createComment(
        principalA,
        { body: 'closed site', dramaId: dramaA, episodeId: episodeA },
        customerCommand('closed-site-0001'),
      )).rejects.toBeInstanceOf(ForbiddenException);
      await expect(database.exec(`
        insert into interaction_comments (
          id, tenant_id, drama_id, episode_id, account_id, body
        ) values (
          '${uuidV7()}', '${tenantA}', '${dramaA}', '${episodeA}', '${accountA}',
          'direct closed site comment'
        )
      `)).rejects.toThrow();
    } finally {
      await database.exec(`update tenants set user_site_enabled = true where id = '${tenantA}'`);
    }
    const reportTarget = await interactions.createComment(
      principalA2,
      { body: 'platform switch report target', dramaId: dramaA, episodeId: episodeA },
      customerCommand('platform-report-target-0001', accountA2),
    );
    await database.exec(`update tenants set platform_site_enabled = false where id = '${tenantA}'`);
    try {
      await expect(interactions.createComment(
        principalA,
        { body: 'platform closed site', dramaId: dramaA, episodeId: episodeA },
        customerCommand('platform-closed-0001'),
      )).rejects.toBeInstanceOf(ForbiddenException);
      await expect(database.exec(`
        insert into interaction_reports (
          id, tenant_id, reporter_account_id, target_type, target_id,
          reason_category
        )
        values (
          '${uuidV7()}', '${tenantA}', '${accountA}', 'comment',
          '${reportTarget.id}', 'spam'
        )
      `)).rejects.toThrow();
    } finally {
      await database.exec(`update tenants set platform_site_enabled = true where id = '${tenantA}'`);
    }
  });

  it('keeps interaction rows tenant-isolated under a non-owner DB role', async () => {
    const tenantBComment = uuidV7();
    await database.exec(`
      insert into interaction_comments (
        id, tenant_id, drama_id, episode_id, account_id, body
      ) values (
        '${tenantBComment}', '${tenantB}', '${dramaB}', '${episodeB}',
        '${accountB}', 'tenant b private comment'
      );
      insert into interaction_sensitive_words (
        id, scope_type, tenant_id, term, normalized_term, created_by
      ) values (
        '${uuidV7()}', 'tenant', '${tenantB}', 'private-b', 'private-b',
        '${tenantStaff}'
      );
      create role interaction_tenant_probe nosuperuser nobypassrls;
      grant usage on schema app, public to interaction_tenant_probe;
      grant select on interaction_comments, interaction_bullet_comments,
        interaction_reports, interaction_moderation_actions,
        interaction_sensitive_words to interaction_tenant_probe;
      grant insert on interaction_comments to interaction_tenant_probe;
      set role interaction_tenant_probe;
      begin;
      set local app.access_scope = 'tenant';
      set local app.tenant_id = '${tenantA}';
    `);
    try {
      const visible = await database.query<{ tenant_id: string }>(`
        select distinct tenant_id from interaction_comments order by tenant_id
      `);
      expect(visible.rows).toEqual([{ tenant_id: tenantA }]);
      const words = await database.query<{ scope_type: string; tenant_id: string | null }>(`
        select scope_type, tenant_id from interaction_sensitive_words order by scope_type, tenant_id
      `);
      expect(words.rows).toContainEqual({ scope_type: 'platform', tenant_id: null });
      expect(words.rows).not.toContainEqual({ scope_type: 'tenant', tenant_id: tenantB });
      await expect(database.exec(`
        insert into interaction_comments (
          id, tenant_id, drama_id, episode_id, account_id, body
        ) values (
          '${uuidV7()}', '${tenantB}', '${dramaB}', '${episodeB}',
          '${accountB}', 'rls cross tenant forge'
        )
      `)).rejects.toThrow();
    } finally {
      await database.exec('rollback; reset role');
    }
  });
});

function customerCommand(
  idempotencyKey: string,
  actorId = accountA,
): InteractionCommandMetadata {
  return {
    actorId,
    actorType: 'user',
    idempotencyKey,
    ip: '203.0.113.10',
    requestId: uuidV7(),
    scope: 'tenant',
  };
}

function staffCommand(
  scope: 'platform' | 'tenant',
  actorId: string,
  idempotencyKey: string,
): InteractionCommandMetadata {
  return {
    actorId,
    actorType: scope === 'platform' ? 'platform_staff' : 'tenant_staff',
    idempotencyKey,
    ip: '203.0.113.20',
    requestId: uuidV7(),
    scope,
  };
}
