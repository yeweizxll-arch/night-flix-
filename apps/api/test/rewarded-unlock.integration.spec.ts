import { PGlite, type Transaction } from '@electric-sql/pglite';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DatabaseService, DatabaseTransaction } from '../src/database/database.service';
import { CustomerPlaybackAccessService } from '../src/playback/customer-playback-access.service';
import { RewardedUnlockService } from '../src/rewarded-unlocks/rewarded-unlock.service';

const tenantId = '018f2f45-7f5e-7e70-b17f-f6e773573301';
const accountId = '018f2f45-7f5e-7e70-b17f-f6e773573302';
const dramaId = '018f2f45-7f5e-7e70-b17f-f6e773573303';
const episodeId = '018f2f45-7f5e-7e70-b17f-f6e773573304';
const mediaId = '018f2f45-7f5e-7e70-b17f-f6e773573305';
const principal = {
  accountId,
  deviceId: '018f2f45-7f5e-7e70-b17f-f6e773573307',
  sessionId: '018f2f45-7f5e-7e70-b17f-f6e773573308',
  tenantId,
  username: 'reward-viewer',
};

let database: PGlite;
let access: CustomerPlaybackAccessService;
let rewards: RewardedUnlockService;

function tag(transaction: Transaction): DatabaseTransaction {
  const sqlTag = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let sql = strings[0] ?? '';
    for (let index = 0; index < values.length; index += 1) {
      sql += `$${index + 1}${strings[index + 1] ?? ''}`;
    }
    return (await transaction.query(sql, values)).rows;
  };
  Object.assign(sqlTag, { json: (value: unknown) => JSON.stringify(value) });
  return sqlTag as unknown as DatabaseTransaction;
}

describe('rewarded episode unlock', () => {
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
        ('${tenantId}', 'reward-agent', 'Reward Agent', statement_timestamp() + interval '1 year');
      insert into customer_accounts (id, tenant_id, username, password_hash) values
        ('${accountId}', '${tenantId}', 'reward-viewer', '${'p'.repeat(64)}');
      insert into media_assets (
        id, owner_type, owner_tenant_id, source_url, kind, mime_type,
        size_bytes, checksum, metadata_json, status
      ) values (
        '${mediaId}', 'tenant', '${tenantId}', 'https://media.example.test/reward.m3u8',
        'video', 'application/vnd.apple.mpegurl', 1024, '${'a'.repeat(64)}',
        '{"immutable":true}'::jsonb, 'ready'
      );
      insert into dramas (
        id, owner_type, owner_tenant_id, code, status, total_episodes
      ) values ('${dramaId}', 'tenant', '${tenantId}', 'reward-drama', 'published', 1);
      insert into episodes (
        id, drama_id, episode_no, status, duration_seconds, preview_seconds,
        media_asset_id
      ) values ('${episodeId}', '${dramaId}', 1, 'published', 60, 10, '${mediaId}');
      insert into content_point_prices (
        id, tenant_id, target_type, target_id, points_amount, status,
        created_by, updated_by
      ) values (
        '018f2f45-7f5e-7e70-b17f-f6e773573306', '${tenantId}', 'episode',
        '${episodeId}', 5, 'active', '${accountId}', '${accountId}'
      );
      insert into tenant_app_runtime_configs (
        tenant_id, admob_json, created_by, updated_by
      ) values (
        '${tenantId}', '{"enabled":true,"rewardedEpisodeAndroid":"test-rewarded-unit"}'::jsonb,
        '${accountId}', '${accountId}'
      );
    `);
    const databaseService = {
      inPlatformContext: <T>(callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction((transaction) => callback(tag(transaction))),
      inTenantContext: <T>(selectedTenantId: string,
        callback: (transaction: DatabaseTransaction) => Promise<T>) =>
        database.transaction(async (transaction) => {
          await transaction.query(
            "select set_config('app.access_scope', 'tenant', true), set_config('app.tenant_id', $1, true)",
            [selectedTenantId],
          );
          return callback(tag(transaction));
        }),
    } as unknown as DatabaseService;
    access = new CustomerPlaybackAccessService(databaseService);
    rewards = new RewardedUnlockService(databaseService, access);
  }, 120_000);

  afterAll(async () => database?.close());

  it('creates one pending challenge and grants one permanent episode entitlement', async () => {
    expect((await access.getAccess(principal, episodeId)).access).toBe('preview');
    const first = await rewards.createChallenge(
      principal, episodeId, { platform: 'android' },
    );
    const repeated = await rewards.createChallenge(
      principal, episodeId, { platform: 'android' },
    );
    expect(repeated.challengeId).toBe(first.challengeId);
    expect(first).toMatchObject({
      adUnitId: 'test-rewarded-unit', alreadyUnlocked: false, status: 'pending',
    });

    await expect(rewards.grantVerifiedReward({
      adUnitId: 'test-rewarded-unit', challengeId: first.challengeId!,
      rewardAmount: 1, rewardItem: 'episode', transactionId: 'reward-tx-1',
    })).resolves.toEqual({ granted: true });
    await expect(rewards.grantVerifiedReward({
      adUnitId: 'test-rewarded-unit', challengeId: first.challengeId!,
      rewardAmount: 1, rewardItem: 'episode', transactionId: 'reward-tx-1',
    })).resolves.toEqual({ granted: true });

    expect(await rewards.status(principal, first.challengeId!))
      .toMatchObject({ episodeId, status: 'granted' });
    expect((await access.getAccess(principal, episodeId)).access).toBe('full');
    const entitlements = await database.query<{ source_type: string }>(`
      select source_type from entitlements
      where tenant_id = '${tenantId}' and account_id = '${accountId}'
        and entitlement_type = 'episode' and product_id = '${episodeId}'
    `);
    expect(entitlements.rows).toEqual([{ source_type: 'rewarded_ad' }]);
  });
});
