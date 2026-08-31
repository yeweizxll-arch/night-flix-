import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { sanitizeAuditJson } from '../audit/audit-sanitizer';
import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { requireUuid } from './commerce-validation';

interface PaymentConfigInput {
  credentials?: unknown;
  label: string;
  providerCode?: 'fake';
}

interface CommandRow {
  request_hash: string;
  response_json: unknown;
  status: string;
}

export interface FakeConfigRecord {
  collectionMode: 'platform_collect' | 'tenant_direct';
  id: string;
  label: string;
  providerCode: 'fake';
  status: 'active';
}

export interface RoutingRecord {
  collectionMode: 'platform_collect' | 'tenant_direct';
  paymentConfigId: string;
  version: number;
}

@Injectable()
export class PaymentConfigurationService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  createPlatformFakeConfig(
    rawInput: PaymentConfigInput,
    actorId: string,
    requestId: string,
    idempotencyKey = requestId,
  ) {
    const input = validateFakeConfig(rawInput);
    requireUuid(actorId, 'actorId');
    return this.database.inPlatformContext(async (transaction) => {
      const command = await this.beginCommand<FakeConfigRecord>(transaction, {
        actorId,
        idempotencyKey,
        request: { label: input.label, providerCode: 'fake' },
        routeKey: 'platform.payment.config.fake.create',
        scope: 'platform',
        tenantId: null,
      });
      if (command.cached) return command.cached;
      const providerId = await this.ensureFakeProvider(transaction, actorId);
      const configId = uuidV7();
      try {
        await transaction`
          insert into payment_configs (
            id, owner_type, owner_tenant_id, provider_id, label,
            public_metadata_json, created_by
          ) values (
            ${configId}, 'platform', null, ${providerId}, ${input.label},
            ${transaction.json({ localOnly: true })}, ${actorId}
          )
        `;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException('Payment config label exists');
        throw error;
      }
      await insertAudit(transaction, null, actorId, requestId, {
        action: 'platform.payment.config.create',
        resourceId: configId,
      });
      const response: FakeConfigRecord = {
        collectionMode: 'platform_collect' as const,
        id: configId,
        label: input.label,
        providerCode: 'fake' as const,
        status: 'active' as const,
      };
      await this.completeCommand(transaction, command.id, response, 201, configId);
      return response;
    });
  }

  listPlatformPaymentConfigs() {
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{
        id: string;
        label: string;
        provider: string;
        public_metadata_json: unknown;
        provider_account_id: string | null;
        provider_mode: string | null;
        status: string;
        last_test_status: string | null;
        version: number;
      }>>`
        select
          config.id, config.label, provider.code::text as provider,
          config.status, config.public_metadata_json, config.version,
          config.provider_mode, config.provider_account_id, config.last_test_status
        from payment_configs as config
        inner join payment_providers as provider on provider.id = config.provider_id
        where config.owner_type = 'platform'
        order by config.created_at desc, config.id desc
      `;
      return rows.map((row) => ({
        id: row.id,
        label: row.label,
        provider: row.provider,
        publicMetadata: safePublicMetadata(row.public_metadata_json),
        status: row.status,
        version: row.version,
        ...(row.provider === 'stripe' ? {
          accountId: row.provider_account_id,
          mode: row.provider_mode,
          testStatus: row.last_test_status,
        } : {}),
      }));
    });
  }

  createTenantFakeConfig(
    tenantId: string,
    rawInput: PaymentConfigInput,
    actorId: string,
    requestId: string,
    idempotencyKey = requestId,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(actorId, 'actorId');
    const input = validateFakeConfig(rawInput);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<FakeConfigRecord>(transaction, {
        actorId,
        idempotencyKey,
        request: { label: input.label, providerCode: 'fake' },
        routeKey: 'tenant.payment.config.fake.create',
        scope: 'tenant',
        tenantId,
      });
      if (command.cached) return command.cached;
      await assertTenantAvailable(transaction, tenantId);
      const providers = await transaction<{ id: string }[]>`
        select id from payment_providers
        where code = 'fake' and adapter_code = 'fake' and status = 'active'
      `;
      const provider = providers[0];
      if (!provider) throw new NotFoundException('Fake payment provider is not registered');
      const configId = uuidV7();
      try {
        await transaction`
          insert into payment_configs (
            id, owner_type, owner_tenant_id, provider_id, label,
            public_metadata_json, created_by
          ) values (
            ${configId}, 'tenant', ${tenantId}, ${provider.id}, ${input.label},
            ${transaction.json({ localOnly: true })}, ${actorId}
          )
        `;
      } catch (error) {
        if (isUniqueViolation(error)) throw new ConflictException('Payment config label exists');
        throw error;
      }
      await insertAudit(transaction, tenantId, actorId, requestId, {
        action: 'commerce.payment.config.create',
        resourceId: configId,
      });
      const response: FakeConfigRecord = {
        collectionMode: 'tenant_direct' as const,
        id: configId,
        label: input.label,
        providerCode: 'fake' as const,
        status: 'active' as const,
      };
      await this.completeCommand(transaction, command.id, response, 201, configId);
      return response;
    });
  }

  setTenantRouting(
    tenantId: string,
    configId: string,
    collectionMode: unknown,
    actorId: string,
    requestId: string,
    idempotencyKey = requestId,
  ) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(configId, 'configId');
    requireUuid(actorId, 'actorId');
    if (collectionMode !== 'platform_collect' && collectionMode !== 'tenant_direct') {
      throw new BadRequestException('collectionMode is invalid');
    }
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const command = await this.beginCommand<RoutingRecord>(transaction, {
        actorId,
        idempotencyKey,
        request: { collectionMode, paymentConfigId: configId },
        routeKey: 'tenant.payment.routing.update',
        scope: 'tenant',
        tenantId,
      });
      if (command.cached) return command.cached;
      await assertTenantAvailable(transaction, tenantId);
      const configs = await transaction<Array<{
        owner_tenant_id: string | null;
        owner_type: string;
        status: string;
      }>>`
        select config.owner_type, config.owner_tenant_id, config.status
        from payment_configs as config
        inner join payment_providers as provider
          on provider.id = config.provider_id and provider.status = 'active'
        where config.id = ${configId}
      `;
      const config = configs[0];
      if (
        !config
        || config.status !== 'active'
        || (collectionMode === 'platform_collect' && config.owner_type !== 'platform')
        || (
          collectionMode === 'tenant_direct'
          && (config.owner_type !== 'tenant' || config.owner_tenant_id !== tenantId)
        )
      ) {
        throw new BadRequestException('Payment config does not match collection mode');
      }
      const rows = await transaction<Array<{ version: number }>>`
        insert into tenant_payment_routing (
          tenant_id, collection_mode, payment_config_id, created_by, updated_by
        ) values (
          ${tenantId}, ${collectionMode}, ${configId}, ${actorId}, ${actorId}
        )
        on conflict (tenant_id) do update
        set
          collection_mode = excluded.collection_mode,
          payment_config_id = excluded.payment_config_id,
          version = tenant_payment_routing.version + 1,
          updated_by = excluded.updated_by
        returning version
      `;
      await insertAudit(transaction, tenantId, actorId, requestId, {
        action: 'commerce.payment.routing.update',
        resourceId: configId,
      });
      const response: RoutingRecord = {
        collectionMode,
        paymentConfigId: configId,
        version: rows[0]?.version ?? 0,
      };
      await this.completeCommand(transaction, command.id, response, 200, configId);
      return response;
    });
  }

  listTenantPaymentConfigs(tenantId: string) {
    requireUuid(tenantId, 'tenantId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const configs = await transaction<Array<{
        id: string;
        label: string;
        owner_type: string;
        provider: string;
        public_metadata_json: unknown;
        provider_account_id: string | null;
        provider_mode: string | null;
        status: string;
        last_test_status: string | null;
        version: number;
      }>>`
        select config.id, config.owner_type, config.label, config.status,
          config.public_metadata_json, config.version,
          config.provider_mode, config.provider_account_id, config.last_test_status,
          provider.code::text as provider
        from payment_configs as config
        inner join payment_providers as provider on provider.id = config.provider_id
        where provider.status = 'active'
          and (
            (config.owner_type = 'platform' and config.status = 'active')
            or (
              config.owner_type = 'tenant'
              and config.owner_tenant_id = ${tenantId}
              and config.status in ('active', 'disabled')
            )
          )
        order by config.owner_type, config.label, config.id
      `;
      const routing = await transaction<Array<{
        collection_mode: 'platform_collect' | 'tenant_direct';
        payment_config_id: string;
        version: number;
      }>>`
        select collection_mode, payment_config_id, version
        from tenant_payment_routing where tenant_id = ${tenantId}
      `;
      return {
        configs: configs.map((config) => ({
          id: config.id,
          label: config.label,
          ownerType: config.owner_type,
          provider: config.provider,
          publicMetadata: safePublicMetadata(config.public_metadata_json),
          status: config.status,
          version: config.version,
          ...(config.provider === 'stripe' ? {
            accountId: config.provider_account_id,
            mode: config.provider_mode,
            testStatus: config.last_test_status,
          } : {}),
        })),
        routing: routing[0]
          ? {
              collectionMode: routing[0].collection_mode,
              paymentConfigId: routing[0].payment_config_id,
              version: routing[0].version,
            }
          : null,
      };
    });
  }

  private async ensureFakeProvider(
    transaction: DatabaseTransaction,
    actorId: string,
  ): Promise<string> {
    const id = uuidV7();
    const rows = await transaction<{ id: string }[]>`
      insert into payment_providers (
        id, code, adapter_code, capabilities_json, created_by
      ) values (
        ${id}, 'fake', 'fake', ${transaction.json({ localOnly: true })}, ${actorId}
      )
      on conflict (code) do update set code = excluded.code
      returning id
    `;
    const providerId = rows[0]?.id;
    if (!providerId) throw new Error('Fake payment provider was not registered');
    return providerId;
  }

  private async beginCommand<T>(
    transaction: DatabaseTransaction,
    input: {
      actorId: string;
      idempotencyKey: string;
      request: unknown;
      routeKey: string;
      scope: 'platform' | 'tenant';
      tenantId: string | null;
    },
  ): Promise<{ cached?: T; id?: string }> {
    const key = input.idempotencyKey.trim();
    if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw new BadRequestException('A valid Idempotency-Key is required');
    }
    const actorType = input.scope === 'platform' ? 'platform_staff' : 'tenant_staff';
    const requestHash = createHash('sha256')
      .update(JSON.stringify(toJsonValue(input.request)))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, ${input.scope}, ${input.tenantId}, ${actorType}, ${input.actorId},
        ${input.routeKey}, ${key}, ${requestHash},
        statement_timestamp() + interval '24 hours'
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) return { id };
    const rows = await transaction<CommandRow[]>`
      select request_hash, status, response_json
      from command_idempotency
      where scope_type = ${input.scope}
        and tenant_id is not distinct from ${input.tenantId}
        and actor_type = ${actorType}
        and actor_id = ${input.actorId}
        and route_key = ${input.routeKey}
        and idempotency_key = ${key}
      for update
    `;
    const existing = rows[0];
    if (!existing) throw new ConflictException('Idempotency record is unavailable');
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
    response: FakeConfigRecord | RoutingRecord,
    responseStatus: number,
    configId: string,
  ): Promise<void> {
    if (!commandId) return;
    await transaction`
      update command_idempotency
      set
        status = 'completed', response_status = ${responseStatus},
        response_json = ${transaction.json(toJsonValue(response))},
        resource_type = 'payment_config', resource_id = ${configId},
        locked_at = null
      where id = ${commandId} and status = 'processing'
    `;
  }
}

function safePublicMetadata(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeAuditJson(value);
  if (!sanitized || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
    return {};
  }
  return sanitized as Record<string, unknown>;
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function validateFakeConfig(rawInput: PaymentConfigInput) {
  if (!rawInput || typeof rawInput !== 'object') {
    throw new BadRequestException('Body is required');
  }
  if (Object.hasOwn(rawInput, 'credentials')) {
    throw new BadRequestException('Fake payment configs do not accept credentials');
  }
  if (rawInput.providerCode !== undefined && rawInput.providerCode !== 'fake') {
    throw new BadRequestException('Only the local fake provider is available');
  }
  if (typeof rawInput.label !== 'string') throw new BadRequestException('label is required');
  const label = rawInput.label.trim();
  if (label.length < 1 || label.length > 100) throw new BadRequestException('label is invalid');
  if (process.env.NODE_ENV === 'production') {
    throw new BadRequestException('Fake payment configs are disabled in production');
  }
  return { label };
}

async function assertTenantAvailable(
  transaction: DatabaseTransaction,
  tenantId: string,
): Promise<void> {
  const rows = await transaction<{ available: boolean }[]>`
    select status = 'active' and expires_at > statement_timestamp() as available
    from tenants where id = ${tenantId}
  `;
  if (!rows[0]?.available) throw new ConflictException('Tenant is not available');
}

async function insertAudit(
  transaction: DatabaseTransaction,
  tenantId: string | null,
  actorId: string,
  requestId: string,
  input: { action: string; resourceId: string },
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, request_id
    ) values (
      ${uuidV7()}, ${tenantId ? 'tenant' : 'platform'}, ${tenantId},
      ${tenantId ? 'tenant_staff' : 'platform_staff'}, ${actorId},
      ${input.action}, 'payment_config', ${input.resourceId},
      ${transaction.json({ configured: true })}, ${requestId}
    )
  `;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error && typeof error === 'object' && 'code' in error
    && (error as { code?: unknown }).code === '23505',
  );
}
