import { BadRequestException, Body, ConflictException, Controller, Get, Inject,
  Injectable, NotFoundException, Param, Put } from '@nestjs/common';
import { CurrentPrincipal, RequirePermissions, type AccessPrincipal } from '../access-control';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { uuidV7 } from '../common/uuid-v7';

interface RankingRow { weight: number; pinned_rank: number; version: number }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class TenantDramaDiscoveryService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService) {}

  private async target(sql: DatabaseTransaction, tenantId: string, dramaId: string) {
    if (!uuid.test(tenantId) || !uuid.test(dramaId)) throw new BadRequestException('Invalid drama or tenant');
    const rows = await sql<{ id: string }[]>`
      select id from dramas where id = ${dramaId} and deleted_at is null
        and ((owner_type = 'tenant' and owner_tenant_id = ${tenantId})
          or (owner_type = 'platform' and status = 'published'
            and emergency_takedown_at is null))
    `;
    // Do not row-lock the immutable public drama: FOR SHARE would also require
    // its UPDATE RLS policy. Only the tenant's ranking row is mutated/locked.
    // Catalog/playback independently enforce live publication and takedowns.
    if (!rows[0]) throw new NotFoundException('Drama is unavailable');
  }

  async get(tenantId: string, dramaId: string) {
    return this.database.inTenantContext(tenantId, async sql => {
      await this.target(sql, tenantId, dramaId);
      const rows = await sql<RankingRow[]>`
        select weight, pinned_rank, version from tenant_drama_discovery
        where tenant_id = ${tenantId} and drama_id = ${dramaId}
      `;
      return map(rows[0]);
    });
  }

  async set(tenantId: string, dramaId: string, input: Record<string, unknown>, actorId: string, requestId: string) {
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['weight', 'pinnedRank', 'expectedVersion'].includes(key))) {
      throw new BadRequestException('Invalid ranking settings');
    }
    const weight = integer(input.weight, -100000, 100000);
    const pinnedRank = integer(input.pinnedRank, 0, 1000);
    const expectedVersion = integer(input.expectedVersion, 0, 2147483646);
    return this.database.inTenantContext(tenantId, async sql => {
      await this.target(sql, tenantId, dramaId);
      // Serializes first creation as well as subsequent compare-and-swap saves.
      await sql`select pg_advisory_xact_lock(hashtextextended(${`${tenantId}:${dramaId}:discovery`}, 0))`;
      const before = await sql<RankingRow[]>`select weight, pinned_rank, version
        from tenant_drama_discovery where tenant_id = ${tenantId} and drama_id = ${dramaId} for update`;
      if ((before[0]?.version ?? 0) !== expectedVersion) {
        throw new ConflictException('Ranking changed. Reload before saving.');
      }
      const rows = await sql<RankingRow[]>`
        insert into tenant_drama_discovery (tenant_id, drama_id, weight, pinned_rank)
        values (${tenantId}, ${dramaId}, ${weight}, ${pinnedRank})
        on conflict (tenant_id, drama_id) do update set weight = excluded.weight,
          pinned_rank = excluded.pinned_rank, version = tenant_drama_discovery.version + 1,
          updated_at = statement_timestamp()
        returning weight, pinned_rank, version
      `;
      const result = map(rows[0]);
      await sql`insert into audit_logs (id, scope_type, tenant_id, actor_type, actor_id,
        action, resource_type, resource_id, before_json, after_json, request_id)
        values (${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff', ${actorId},
          'content.discovery.update', 'drama', ${dramaId}, ${sql.json(map(before[0]))},
          ${sql.json(result)}, ${requestId})`;
      return result;
    });
  }
}

function map(row?: RankingRow) {
  return { weight: row?.weight ?? 0, pinnedRank: row?.pinned_rank ?? 0, version: row?.version ?? 0 };
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new BadRequestException('Ranking values must be bounded integers');
  }
  return value;
}

@Controller('tenant/content/dramas/:dramaId/discovery')
export class TenantDramaDiscoveryController {
  constructor(@Inject(TenantDramaDiscoveryService) private readonly service: TenantDramaDiscoveryService) {}

  @Get()
  @RequirePermissions({ mode: 'read', scope: 'tenant', permissions: ['content.drama.read'] })
  get(@Param('dramaId') id: string, @CurrentPrincipal() principal: AccessPrincipal) {
    return this.service.get(tenant(principal), id);
  }

  @Put()
  @RequirePermissions({ mode: 'write', scope: 'tenant', permissions: ['content.drama.update'] })
  set(@Param('dramaId') id: string, @Body() input: Record<string, unknown>,
    @CurrentPrincipal() principal: AccessPrincipal) {
    return this.service.set(tenant(principal), id, input, principal.subjectId, uuidV7());
  }
}
function tenant(principal: AccessPrincipal) {
  if (!principal.tenantId || principal.scope !== 'tenant') throw new BadRequestException('Tenant scope required');
  return principal.tenantId;
}
