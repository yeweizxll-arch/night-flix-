import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, createHmac, randomInt } from 'node:crypto';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { CommunicationSecretCipher } from './communication-secret-cipher';
import { CommunicationTestRateLimiterService } from './communication-test-rate-limiter.service';
import type {
  CommunicationChannel,
  CommunicationMutationMetadata,
  CommunicationProvider,
  TestCommunicationConfigInput,
  UpsertCommunicationConfigInput,
} from './communication.types';

interface ConfigRow {
  channel: CommunicationChannel;
  id: string;
  last_test_error: string | null;
  last_test_status: string | null;
  last_tested_at: Date | string | null;
  provider: CommunicationProvider;
  status: string;
  version: number;
}

@Injectable()
export class TenantCommunicationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CommunicationSecretCipher) private readonly cipher: CommunicationSecretCipher,
    @Inject(CommunicationTestRateLimiterService)
    private readonly testRateLimiter: CommunicationTestRateLimiterService,
  ) {}

  async listConfigs(tenantIdValue: unknown) {
    const tenantId = uuid(tenantIdValue, 'tenantId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      await requireTenant(transaction, tenantId);
      const rows = await transaction<ConfigRow[]>`
        select id, channel, provider, status, last_test_status, last_tested_at,
          last_test_error, version from tenant_communication_configs
        where tenant_id = ${tenantId} order by channel
      `;
      return { items: rows.map(safeConfig) };
    });
  }

  async upsertConfig(
    tenantIdValue: unknown,
    channelValue: unknown,
    rawInput: UpsertCommunicationConfigInput,
    metadata: CommunicationMutationMetadata,
  ) {
    const tenantId = uuid(tenantIdValue, 'tenantId');
    const channel = communicationChannel(channelValue);
    const input = upsertInput(rawInput);
    const provider = providerFor(channel, input.credentials);
    const provisionalId = uuidV7();
    if (!this.cipher.configured) throw new ServiceUnavailableException('Communication encryption is unavailable');
    return this.database.inPlatformContext(async (transaction) => {
      await requireTenant(transaction, tenantId);
      const command = await beginCommand<ReturnType<typeof safeConfig>>(transaction, {
        metadata,
        request: { channel, credentialFingerprint: fingerprint(input.credentials),
          expectedVersion: input.expectedVersion, provider },
        routeKey: `communication.config.${channel}.upsert`,
        tenantId,
      });
      if (command.cached) return command.cached;
      const current = await transaction<{ id: string; version: number }[]>`
        select id, version from tenant_communication_configs
        where tenant_id = ${tenantId} and channel = ${channel} for update
      `;
      if (current[0] && current[0].version !== input.expectedVersion) {
        throw new ConflictException('Communication configuration version changed');
      }
      if (!current[0] && input.expectedVersion !== 0) {
        throw new ConflictException('Communication configuration does not exist at that version');
      }
      const configId = current[0]?.id ?? provisionalId;
      let encrypted: { ciphertext: string; keyVersion: number };
      try {
        encrypted = this.cipher.encryptCredentials(input.credentials, {
          channel, configId, kind: 'provider', provider, tenantId,
        });
      } catch (error) {
        if (error instanceof TypeError) throw new BadRequestException(error.message);
        throw new ServiceUnavailableException('Communication encryption is unavailable');
      }
      const rows = await transaction<ConfigRow[]>`
        insert into tenant_communication_configs (
          id, tenant_id, channel, provider, status, version, created_by, updated_by
        ) values (
          ${configId}, ${tenantId}, ${channel}, ${provider}, 'disabled', 0,
          ${metadata.actorId}, ${metadata.actorId}
        ) on conflict (tenant_id, channel) do update set
          provider = excluded.provider,
          status = 'disabled', last_test_status = null, last_tested_at = null,
          last_test_error = null, version = tenant_communication_configs.version + 1,
          updated_by = excluded.updated_by
        returning id, channel, provider, status, last_test_status, last_tested_at,
          last_test_error, version
      `;
      await transaction`
        insert into tenant_communication_secrets (
          config_id, tenant_id, channel, provider, credentials_ciphertext, key_version
        ) values (
          ${configId}, ${tenantId}, ${channel}, ${provider},
          ${encrypted.ciphertext}, ${encrypted.keyVersion}
        ) on conflict (config_id) do update set
          provider = excluded.provider,
          credentials_ciphertext = excluded.credentials_ciphertext,
          key_version = excluded.key_version
      `;
      const response = safeConfig(required(rows[0]));
      await audit(transaction, tenantId, metadata, 'communication.config.upsert', configId,
        { channel, provider, status: 'disabled', version: response.version });
      await outbox(transaction, tenantId, metadata.requestId, configId,
        'CommunicationConfigUpdated', { channel, configId, provider, version: response.version });
      await completeCommand(transaction, command.id, response, 200, configId);
      return response;
    });
  }

  async testConfig(
    tenantIdValue: unknown,
    channelValue: unknown,
    rawInput: TestCommunicationConfigInput,
    metadata: CommunicationMutationMetadata,
  ) {
    const tenantId = uuid(tenantIdValue, 'tenantId');
    const channel = communicationChannel(channelValue);
    const input = testInput(rawInput, channel);
    await this.testRateLimiter.consume({ actorId: metadata.actorId,
      destination: input.destination, ip: metadata.ip, tenantId });
    if (!this.cipher.configured) throw new ServiceUnavailableException('Communication encryption is unavailable');
    return this.database.inPlatformContext(async (transaction) => {
      await requireTenant(transaction, tenantId);
      const command = await beginCommand<{ jobId: string; status: 'pending'; version: number }>(transaction, {
        metadata,
        request: { channel, destinationDigest: sensitiveFingerprint(input.destination),
          expectedVersion: input.expectedVersion },
        routeKey: `communication.config.${channel}.test`, tenantId,
      });
      if (command.cached) return command.cached;
      const configs = await transaction<{ id: string; version: number; provider: CommunicationProvider }[]>`
        update tenant_communication_configs set status = 'disabled',
          last_test_status = null, last_tested_at = null, last_test_error = null,
          version = version + 1, updated_by = ${metadata.actorId}
        where tenant_id = ${tenantId} and channel = ${channel}
          and version = ${input.expectedVersion}
        returning id, version, provider
      `;
      const config = configs[0];
      if (!config) throw new ConflictException('Communication configuration version changed or does not exist');
      const provider = config.provider;
      const jobId = uuidV7();
      const encrypted = this.cipher.encryptTestPayload({
        code: randomInt(0, 1_000_000).toString().padStart(6, '0'),
        destination: input.destination,
      }, { channel, configId: config.id, jobId, kind: 'config_test', provider, tenantId });
      await transaction`
        insert into customer_otp_delivery_jobs (
          id, tenant_id, config_id, config_version, job_type, channel, purpose,
          payload_ciphertext, key_version, expires_at
        ) values (
          ${jobId}, ${tenantId}, ${config.id}, ${config.version}, 'config_test',
          ${channel}, 'config_test', ${encrypted.ciphertext}, ${encrypted.keyVersion},
          statement_timestamp() + interval '10 minutes'
        )
      `;
      const response = { jobId, status: 'pending' as const, version: config.version };
      await audit(transaction, tenantId, metadata, 'communication.config.test_requested', config.id,
        { channel, jobId, provider, version: config.version });
      await outbox(transaction, tenantId, metadata.requestId, config.id,
        'CommunicationConfigTestRequested', { channel, configId: config.id, jobId, provider });
      await completeCommand(transaction, command.id, response, 202, config.id);
      return response;
    });
  }

  async setConfigStatus(
    tenantIdValue: unknown,
    channelValue: unknown,
    active: boolean,
    expectedVersionValue: unknown,
    metadata: CommunicationMutationMetadata,
  ) {
    const tenantId = uuid(tenantIdValue, 'tenantId');
    const channel = communicationChannel(channelValue);
    const expectedVersion = integer(expectedVersionValue, 'expectedVersion', 0);
    return this.database.inPlatformContext(async (transaction) => {
      await requireTenant(transaction, tenantId);
      const command = await beginCommand<ReturnType<typeof safeConfig>>(transaction, {
        metadata, request: { active, channel, expectedVersion },
        routeKey: `communication.config.${channel}.${active ? 'enable' : 'disable'}`, tenantId,
      });
      if (command.cached) return command.cached;
      const rows = await transaction<ConfigRow[]>`
        update tenant_communication_configs set status = ${active ? 'active' : 'disabled'},
          version = version + 1, updated_by = ${metadata.actorId}
        where tenant_id = ${tenantId} and channel = ${channel} and version = ${expectedVersion}
          and (${!active} or last_test_status = 'passed')
        returning id, channel, provider, status, last_test_status, last_tested_at,
          last_test_error, version
      `;
      const row = rows[0];
      if (!row) throw new ConflictException(
        active ? 'Communication configuration must pass testing before activation'
          : 'Communication configuration version changed',
      );
      const response = safeConfig(row);
      await audit(transaction, tenantId, metadata,
        active ? 'communication.config.enable' : 'communication.config.disable', row.id, response);
      await outbox(transaction, tenantId, metadata.requestId, row.id,
        active ? 'CommunicationConfigEnabled' : 'CommunicationConfigDisabled',
        { channel, configId: row.id, version: row.version });
      await completeCommand(transaction, command.id, response, 200, row.id);
      return response;
    });
  }
}

function upsertInput(value: UpsertCommunicationConfigInput) {
  if (!record(value) || value.credentials === undefined) throw new BadRequestException('credentials are required');
  rejectUnknown(value, ['credentials', 'expectedVersion']);
  return { credentials: value.credentials,
    expectedVersion: integer(value.expectedVersion, 'expectedVersion', 0) };
}
function testInput(value: TestCommunicationConfigInput, channel: CommunicationChannel) {
  if (!record(value)) throw new BadRequestException('Body is required');
  rejectUnknown(value, ['destination', 'expectedVersion']);
  const destination = typeof value.destination === 'string' ? value.destination.trim() : '';
  if ((channel === 'email' && (destination.length > 320
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(destination)))
    || (channel === 'sms' && !/^\+[1-9][0-9]{7,14}$/.test(destination))) {
    throw new BadRequestException('destination is invalid');
  }
  return { destination: channel === 'email' ? destination.toLowerCase() : destination,
    expectedVersion: integer(value.expectedVersion, 'expectedVersion', 0) };
}
function safeConfig(row: ConfigRow) {
  return { id: row.id, channel: row.channel, provider: row.provider, status: row.status,
    lastTestStatus: row.last_test_status ?? undefined,
    lastTestedAt: row.last_tested_at ? new Date(row.last_tested_at).toISOString() : undefined,
    lastTestError: row.last_test_error ?? undefined, version: row.version };
}
function communicationChannel(value: unknown): CommunicationChannel {
  if (value !== 'email' && value !== 'sms') throw new BadRequestException('channel is invalid');
  return value;
}
function providerFor(channel: CommunicationChannel, credentials: unknown): CommunicationProvider {
  const type = record(credentials) ? credentials.type : undefined;
  if (channel === 'email' && (type === 'resend' || type === 'qq_smtp')) return type;
  if (channel === 'sms' && type === 'twilio') return type;
  throw new BadRequestException('Provider is not supported for this channel');
}
function uuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}
function integer(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > 2_147_483_647) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new BadRequestException('Body contains unsupported fields');
  }
}
function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function sensitiveFingerprint(value: string): string {
  const key = process.env.RATE_LIMIT_KEY_SECRET;
  if (!key || Buffer.byteLength(key) < 32) {
    if (process.env.NODE_ENV === 'production') {
      throw new ServiceUnavailableException('Communication request protection is unavailable');
    }
    return createHmac('sha256', 'development-only-communication-request-key')
      .update(value).digest('base64url');
  }
  return createHmac('sha256', key).update(value).digest('base64url');
}
function required<T>(value: T | undefined): T {
  if (!value) throw new Error('Communication configuration could not be persisted');
  return value;
}
async function requireTenant(transaction: DatabaseTransaction, tenantId: string): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    select id from tenants where id = ${tenantId} and status = 'active'
      and expires_at > statement_timestamp() for share
  `;
  if (!rows[0]) throw new ForbiddenException('Tenant is unavailable');
}

async function beginCommand<T>(transaction: DatabaseTransaction, input: {
  metadata: CommunicationMutationMetadata; request: unknown; routeKey: string; tenantId: string;
}): Promise<{ cached?: T; id?: string }> {
  const key = typeof input.metadata.idempotencyKey === 'string' ? input.metadata.idempotencyKey.trim() : '';
  if (!/^[A-Za-z0-9._:-]{8,200}$/.test(key)) throw new BadRequestException('A valid Idempotency-Key header is required');
  const requestHash = createHash('sha256').update(JSON.stringify(input.request)).digest('hex');
  const id = uuidV7();
  const inserted = await transaction<{ id: string }[]>`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, expires_at
    ) values (
      ${id}, 'tenant', ${input.tenantId}, 'tenant_staff', ${input.metadata.actorId},
      ${input.routeKey}, ${key}, ${requestHash}, statement_timestamp() + interval '24 hours'
    ) on conflict do nothing returning id
  `;
  if (inserted[0]) return { id };
  const rows = await transaction<Array<{ id: string; request_hash: string; response_json: unknown; status: string }>>`
    select id, request_hash, response_json, status from command_idempotency
    where scope_type = 'tenant' and tenant_id = ${input.tenantId}
      and actor_type = 'tenant_staff' and actor_id = ${input.metadata.actorId}
      and route_key = ${input.routeKey} and idempotency_key = ${key} for update
  `;
  const existing = rows[0];
  if (!existing || existing.request_hash !== requestHash) throw new ConflictException('Idempotency-Key was used for another request');
  if (existing.status === 'completed' && existing.response_json !== null) return { cached: existing.response_json as T };
  throw new ConflictException('The same command is already processing');
}
async function completeCommand(
  transaction: DatabaseTransaction, id: string | undefined, response: unknown,
  status: number, resourceId: string,
): Promise<void> {
  if (!id) return;
  await transaction`
    update command_idempotency set status = 'completed', response_status = ${status},
      response_json = ${transaction.json(json(response))},
      resource_type = 'tenant_communication_config', resource_id = ${resourceId}, locked_at = null
    where id = ${id} and status = 'processing'
  `;
}
async function audit(
  transaction: DatabaseTransaction, tenantId: string, metadata: CommunicationMutationMetadata,
  action: string, resourceId: string, after: unknown,
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action, resource_type,
      resource_id, after_json, ip, request_id
    ) values (
      ${uuidV7()}, 'tenant', ${tenantId}, 'tenant_staff', ${metadata.actorId}, ${action},
      'tenant_communication_config', ${resourceId}, ${transaction.json(json(after))},
      ${metadata.ip ?? null}, ${metadata.requestId}
    )
  `;
}
async function outbox(
  transaction: DatabaseTransaction, tenantId: string, requestId: string,
  configId: string, eventType: string, payload: unknown,
): Promise<void> {
  const eventId = uuidV7();
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key, aggregate_type,
      aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, 'tenant', ${tenantId}, ${`event:${eventId}`},
      ${`${requestId}:${eventType}`}, 'tenant_communication_config', ${configId},
      ${eventType}, ${transaction.json(json(payload))}
    )
  `;
}
function json(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
