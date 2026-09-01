import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { uuidV7 } from '../common/uuid-v7';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import { DatabaseService } from '../database/database.service';
import { CustomerPlaybackAccessService } from '../playback/customer-playback-access.service';
import type { VerifiedAdMobReward } from './admob-ssv-verifier.service';
import type {
  CreateRewardedUnlockChallengeInput,
  RewardedUnlockChallengeResponse,
  RewardedUnlockStatusResponse,
} from './rewarded-unlock.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface UnlockRow {
  ad_unit_id: string;
  account_id: string;
  created_at: Date;
  drama_id: string;
  episode_id: string;
  expires_at: Date;
  granted_at: Date | null;
  id: string;
  placement_key: string;
  provider_transaction_id: string | null;
  status: 'expired' | 'granted' | 'pending';
  tenant_id: string;
}

@Injectable()
export class RewardedUnlockService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CustomerPlaybackAccessService)
    private readonly playbackAccess: CustomerPlaybackAccessService,
  ) {}

  async createChallenge(
    principal: CustomerPrincipal,
    episodeId: string,
    rawInput: CreateRewardedUnlockChallengeInput,
  ): Promise<RewardedUnlockChallengeResponse> {
    assertUuid(episodeId, 'episodeId');
    const input = challengeInput(rawInput);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      const access = await this.playbackAccess.resolveInTransaction(
        transaction, principal, episodeId,
      );
      if (access.access === 'full') {
        return { alreadyUnlocked: true, status: 'granted' as const };
      }
      const content = await transaction<Array<{
        legacy_license: boolean;
        owner_type: 'platform' | 'tenant';
        publication_status: string | null;
      }>>`
        select drama.owner_type, publication.status as publication_status,
          exists (
            select 1 from content_license_items as item
            inner join content_licenses as license
              on license.id = item.license_id and license.tenant_id = item.tenant_id
            where item.tenant_id = ${principal.tenantId}
              and item.drama_id = drama.id
              and license.status in ('scheduled', 'active')
              and license.starts_at <= statement_timestamp()
              and license.expires_at > statement_timestamp()
          ) as legacy_license
        from dramas as drama
        left join tenant_public_drama_publications as publication
          on publication.tenant_id = ${principal.tenantId}
          and publication.drama_id = drama.id
        where drama.id = ${access.dramaId}
      `;
      if (content[0]?.owner_type === 'platform'
          && content[0].publication_status !== 'published'
          && !content[0].legacy_license) {
        throw new ConflictException('Rewarded unlock is unavailable after unpublishing');
      }
      const configs = await transaction<{ admob_json: unknown }[]>`
        select admob_json from tenant_app_runtime_configs
        where tenant_id = ${principal.tenantId} for share
      `;
      const adUnitId = rewardedAdUnit(configs[0]?.admob_json, input.platform);
      if (!adUnitId) {
        throw new ConflictException('Rewarded episode ad is not configured');
      }
      await transaction`
        update rewarded_episode_unlocks set status = 'expired'
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and episode_id = ${episodeId}
          and status = 'pending' and expires_at <= statement_timestamp()
      `;
      const existing = await transaction<UnlockRow[]>`
        select * from rewarded_episode_unlocks
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and episode_id = ${episodeId}
          and status = 'pending' and expires_at > statement_timestamp()
        order by created_at desc limit 1 for update
      `;
      const current = existing[0];
      if (current) return challengeResponse(current);
      const id = uuidV7();
      const rows = await transaction<UnlockRow[]>`
        insert into rewarded_episode_unlocks (
          id, tenant_id, account_id, drama_id, episode_id, placement_key,
          ad_unit_id, expires_at
        ) values (
          ${id}, ${principal.tenantId}, ${principal.accountId}, ${access.dramaId},
          ${episodeId}, ${input.placementKey}, ${adUnitId},
          statement_timestamp() + interval '15 minutes'
        ) on conflict (tenant_id, account_id, episode_id)
          where status = 'pending' do nothing
        returning *
      `;
      if (rows[0]) return challengeResponse(rows[0]);
      const concurrent = await transaction<UnlockRow[]>`
        select * from rewarded_episode_unlocks
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and episode_id = ${episodeId} and status = 'pending'
        order by created_at desc limit 1
      `;
      return challengeResponse(required(
        concurrent[0], 'Rewarded challenge was not created',
      ));
    });
  }

  async status(
    principal: CustomerPrincipal,
    challengeId: string,
  ): Promise<RewardedUnlockStatusResponse> {
    assertUuid(challengeId, 'challengeId');
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      const rows = await transaction<UnlockRow[]>`
        update rewarded_episode_unlocks
        set status = 'expired'
        where tenant_id = ${principal.tenantId} and id = ${challengeId}
          and account_id = ${principal.accountId}
          and status = 'pending' and expires_at <= statement_timestamp()
        returning *
      `;
      const selected = rows[0] ? rows : await transaction<UnlockRow[]>`
        select * from rewarded_episode_unlocks
        where tenant_id = ${principal.tenantId} and id = ${challengeId}
          and account_id = ${principal.accountId}
      `;
      return statusResponse(required(selected[0], 'Rewarded challenge was not found'));
    });
  }

  async grantVerifiedReward(reward: VerifiedAdMobReward): Promise<{ granted: boolean }> {
    assertUuid(reward.challengeId, 'custom_data');
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<UnlockRow[]>`
        select * from rewarded_episode_unlocks
        where id = ${reward.challengeId} for update
      `;
      const unlock = required(rows[0], 'Rewarded challenge was not found');
      if (unlock.status === 'granted') {
        if (unlock.provider_transaction_id !== reward.transactionId) {
          throw new ConflictException('Rewarded challenge was already consumed');
        }
        return { granted: true };
      }
      if (unlock.status !== 'pending' || unlock.expires_at <= new Date()) {
        if (unlock.status === 'pending') {
          await transaction`
            update rewarded_episode_unlocks set status = 'expired'
            where id = ${unlock.id}
          `;
        }
        throw new ConflictException('Rewarded challenge has expired');
      }
      if (unlock.ad_unit_id !== reward.adUnitId) {
        throw new BadRequestException('AdMob ad unit does not match the challenge');
      }
      const duplicates = await transaction<{ id: string }[]>`
        select id from rewarded_episode_unlocks
        where provider = 'admob'
          and provider_transaction_id = ${reward.transactionId}
        limit 1 for update
      `;
      if (duplicates[0]) throw new ConflictException('AdMob reward was already used');
      const granted = await transaction<Array<{ granted_at: Date }>>`
        update rewarded_episode_unlocks
        set status = 'granted', provider_transaction_id = ${reward.transactionId},
          reward_amount = ${reward.rewardAmount}, reward_item = ${reward.rewardItem},
          granted_at = statement_timestamp()
        where id = ${unlock.id} and status = 'pending'
        returning granted_at
      `;
      const grant = required(granted[0], 'Rewarded challenge state has changed');
      await transaction`
        insert into entitlements (
          id, tenant_id, account_id, entitlement_type, product_id,
          source_type, source_rewarded_unlock_id, starts_at
        ) values (
          ${uuidV7()}, ${unlock.tenant_id}, ${unlock.account_id}, 'episode',
          ${unlock.episode_id}, 'rewarded_ad', ${unlock.id}, ${grant.granted_at}
        ) on conflict (tenant_id, account_id, entitlement_type, product_id)
          where revoked_at is null do nothing
      `;
      return { granted: true };
    });
  }
}

function challengeInput(value: CreateRewardedUnlockChallengeInput): {
  placementKey: string;
  platform: 'android' | 'ios';
} {
  if (!value || typeof value !== 'object') {
    throw new BadRequestException('Body is required');
  }
  const platform = value.platform;
  if (platform !== 'android' && platform !== 'ios') {
    throw new BadRequestException('platform must be android or ios');
  }
  const placementKey = value.placementKey ?? 'episode_unlock';
  if (typeof placementKey !== 'string'
      || !/^[a-z][a-z0-9_]{0,99}$/.test(placementKey)) {
    throw new BadRequestException('placementKey is invalid');
  }
  return { placementKey, platform };
}

function rewardedAdUnit(value: unknown, platform: 'android' | 'ios'): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const config = value as Record<string, unknown>;
  if (config.enabled === false) return undefined;
  const nested = config[platform];
  const candidate = nested && typeof nested === 'object' && !Array.isArray(nested)
    ? (nested as Record<string, unknown>).rewardedEpisode
    : config[platform === 'ios' ? 'rewardedEpisodeIos' : 'rewardedEpisodeAndroid']
      ?? config.rewardedEpisode
      ?? config.rewarded;
  return typeof candidate === 'string' && candidate.trim().length <= 200
    ? candidate.trim()
    : undefined;
}

function challengeResponse(row: UnlockRow): RewardedUnlockChallengeResponse {
  return {
    adUnitId: row.ad_unit_id,
    alreadyUnlocked: false,
    challengeId: row.id,
    expiresAt: row.expires_at.toISOString(),
    placementKey: row.placement_key,
    status: 'pending',
  };
}

function statusResponse(row: UnlockRow): RewardedUnlockStatusResponse {
  return {
    challengeId: row.id,
    episodeId: row.episode_id,
    ...(row.granted_at ? { grantedAt: row.granted_at.toISOString() } : {}),
    status: row.status,
  };
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
}

function required<T>(value: T | undefined, message: string): T {
  if (!value) throw new NotFoundException(message);
  return value;
}
