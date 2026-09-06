import { BadRequestException, Body, Controller, Header, Inject, Injectable, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { AuthenticationRateLimiterService } from '../auth/authentication-rate-limiter.service';
import { DatabaseService } from '../database/database.service';
import { assertCustomerSiteAvailable } from '../customer-auth/customer-site-policy';
import { TenantContextService } from '../tenancy/tenant-context.service';
import { requireUuid } from '../commerce/commerce-validation';

export interface AdObservationInput {
  eventId: string; platform: 'android' | 'ios'; format: string; adUnitId: string;
  currency: string; valueMicros: string; precision: string; dramaId?: string; episodeId?: string;
}
@Injectable()
export class AdObservationService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}
  async record(tenantId: string, input: AdObservationInput) {
    if (!input || !/^[A-Za-z0-9_-]{16,100}$/.test(input.eventId ?? '') || !['ios', 'android'].includes(input.platform)
      || !['rewardedEpisode', 'interstitial', 'appOpen', 'native'].includes(input.format)
      || !/^ca-app-pub-\d{16}\/\d{10}$/.test(input.adUnitId ?? '') || !/^[A-Z]{3}$/.test(input.currency ?? '')
      || !/^(0|[1-9][0-9]{0,15})$/.test(input.valueMicros ?? '') || BigInt(input.valueMicros) > 9_000_000_000_000_000n
      || typeof input.precision !== 'string' || !/^[a-zA-Z]{1,30}$/.test(input.precision)) throw new BadRequestException('Invalid ad observation');
    if (input.dramaId) requireUuid(input.dramaId, 'dramaId');
    if (input.episodeId) { requireUuid(input.episodeId, 'episodeId'); if (!input.dramaId) throw new BadRequestException('Episode requires drama'); }
    return this.database.inPlatformContext(async tx => {
      await assertCustomerSiteAvailable(tx, tenantId);
      const rows = await tx<{ admob_json: Record<string, any> }[]>`select admob_json from tenant_app_runtime_configs where tenant_id = ${tenantId}`;
      const config = rows[0]?.admob_json ?? {};
      const nested = config[input.platform];
      const unit = nested && typeof nested === 'object' ? nested[input.format]
        : config[input.format + (input.platform === 'ios' ? 'Ios' : 'Android')]
          ?? (input.format === 'rewardedEpisode' ? config.rewardedEpisode ?? config.rewarded : undefined);
      if (config.enabled === false || unit !== input.adUnitId) throw new BadRequestException('Ad unit does not belong to this tenant platform');
      if (input.dramaId) {
        const drama = await tx`select id from dramas where id = ${input.dramaId}
          and (owner_type = 'platform' or owner_tenant_id = ${tenantId}) and app.customer_region_allowed(${tenantId}::uuid, id)`;
        if (!drama[0]) throw new BadRequestException('Invalid ad content');
      }
      if (input.episodeId) {
        const episode = await tx`select id from episodes where id = ${input.episodeId} and drama_id = ${input.dramaId!}`;
        if (!episode[0]) throw new BadRequestException('Invalid ad episode');
      }
      await tx`insert into ad_paid_observations(tenant_id, event_id, platform, format, ad_unit_id, drama_id, episode_id, currency, value_micros, precision_type)
        values (${tenantId}, ${input.eventId}, ${input.platform}, ${input.format}, ${input.adUnitId}, ${input.dramaId ?? null}, ${input.episodeId ?? null},
          ${input.currency}, ${input.valueMicros}, ${input.precision}) on conflict do nothing`;
      // Telemetry is not an accounting record. Bound retention and cleanup work per request.
      await tx`delete from ad_paid_observations where tenant_id = ${tenantId} and event_id in
        (select event_id from ad_paid_observations where tenant_id = ${tenantId}
          and created_at < statement_timestamp() - interval '90 days' order by created_at limit 100)`;
      return { accepted: true, trustLevel: 'client_unverified' as const };
    });
  }
}
@Controller('customer/ads')
export class AdObservationController {
  constructor(@Inject(AdObservationService) private readonly observations: AdObservationService,
    @Inject(TenantContextService) private readonly context: TenantContextService,
    @Inject(AuthenticationRateLimiterService) private readonly limits: AuthenticationRateLimiterService) {}
  @Post('observations') @PublicEndpoint() @Header('Cache-Control', 'no-store')
  async record(@Body() input: AdObservationInput, @Req() request: FastifyRequest) {
    const tenant = this.context.current();
    if (!tenant?.tenantId || tenant.tenantStatus !== 'active') throw new BadRequestException('Verified tenant required');
    await this.limits.consume({ operation: 'ad_observation', scope: 'tenant', tenantId: tenant.tenantId, login: request.ip, ip: request.ip });
    return this.observations.record(tenant.tenantId, input);
  }
}
