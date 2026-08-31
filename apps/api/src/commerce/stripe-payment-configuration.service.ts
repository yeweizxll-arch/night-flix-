import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { requireUuid } from './commerce-validation';
import {
  PaymentSecretCipher,
  type PaymentConfigOwner,
  type StripeMode,
} from './payment-secret-cipher';
import { PaymentAdapterDefinitiveError } from './payment-adapter';
import {
  StripeAccountMismatchError,
  StripePaymentAdapter,
  StripeProviderUnavailableError,
} from './stripe-payment.adapter';

export interface StripeConfigResponse {
  accountId: string;
  collectionMode: 'platform_collect' | 'tenant_direct';
  id: string;
  label: string;
  mode: StripeMode;
  providerCode: 'stripe';
  status: 'active' | 'disabled';
  testStatus: 'failed' | 'passed' | 'untested';
  version: number;
}

interface ConfigRow {
  active_secret_version: number;
  id: string;
  label: string;
  last_test_status: StripeConfigResponse['testStatus'];
  owner_tenant_id: string | null;
  owner_type: 'platform' | 'tenant';
  provider_account_id: string;
  provider_mode: StripeMode;
  status: StripeConfigResponse['status'];
  version: number;
}

interface SecretRow {
  credential_key_version: number;
  secret_key_ciphertext: string;
  secret_version: number;
  webhook_secret_ciphertext: string;
}

interface CommandRow {
  id: string;
  request_hash: string;
  response_json: StripeConfigResponse | null;
  status: string;
}

type Scope = PaymentConfigOwner & { actorId: string };

@Injectable()
export class StripePaymentConfigurationService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PaymentSecretCipher) private readonly cipher: PaymentSecretCipher,
    @Inject(StripePaymentAdapter) private readonly stripe: StripePaymentAdapter,
  ) {}

  createPlatform(
    actorId: string,
    rawInput: unknown,
    idempotencyKey: unknown,
    requestId: string,
  ) {
    return this.create(
      { actorId: requireUuid(actorId, 'actorId'), ownerType: 'platform', tenantId: null },
      rawInput,
      idempotencyKey,
      requestId,
    );
  }

  createTenant(
    tenantId: string,
    actorId: string,
    rawInput: unknown,
    idempotencyKey: unknown,
    requestId: string,
  ) {
    return this.create(
      {
        actorId: requireUuid(actorId, 'actorId'),
        ownerType: 'tenant',
        tenantId: requireUuid(tenantId, 'tenantId'),
      },
      rawInput,
      idempotencyKey,
      requestId,
    );
  }

  rotatePlatform(
    actorId: string,
    configId: string,
    rawInput: unknown,
    idempotencyKey: unknown,
    requestId: string,
  ) {
    return this.rotate(
      { actorId: requireUuid(actorId, 'actorId'), ownerType: 'platform', tenantId: null },
      requireUuid(configId, 'configId'), rawInput, idempotencyKey, requestId,
    );
  }

  rotateTenant(
    tenantId: string,
    actorId: string,
    configId: string,
    rawInput: unknown,
    idempotencyKey: unknown,
    requestId: string,
  ) {
    return this.rotate(
      {
        actorId: requireUuid(actorId, 'actorId'),
        ownerType: 'tenant', tenantId: requireUuid(tenantId, 'tenantId'),
      },
      requireUuid(configId, 'configId'), rawInput, idempotencyKey, requestId,
    );
  }

  testPlatform(
    actorId: string, configId: string, rawInput: unknown,
    idempotencyKey: unknown, requestId: string,
  ) {
    return this.test(
      { actorId: requireUuid(actorId, 'actorId'), ownerType: 'platform', tenantId: null },
      requireUuid(configId, 'configId'), rawInput, idempotencyKey, requestId,
    );
  }

  testTenant(
    tenantId: string, actorId: string, configId: string, rawInput: unknown,
    idempotencyKey: unknown, requestId: string,
  ) {
    return this.test(
      {
        actorId: requireUuid(actorId, 'actorId'),
        ownerType: 'tenant', tenantId: requireUuid(tenantId, 'tenantId'),
      },
      requireUuid(configId, 'configId'), rawInput, idempotencyKey, requestId,
    );
  }

  setPlatformStatus(
    actorId: string, configId: string, enabled: boolean, rawInput: unknown,
    idempotencyKey: unknown, requestId: string,
  ) {
    return this.setStatus(
      { actorId: requireUuid(actorId, 'actorId'), ownerType: 'platform', tenantId: null },
      requireUuid(configId, 'configId'), enabled, rawInput, idempotencyKey, requestId,
    );
  }

  setTenantStatus(
    tenantId: string, actorId: string, configId: string, enabled: boolean,
    rawInput: unknown, idempotencyKey: unknown, requestId: string,
  ) {
    return this.setStatus(
      {
        actorId: requireUuid(actorId, 'actorId'),
        ownerType: 'tenant', tenantId: requireUuid(tenantId, 'tenantId'),
      },
      requireUuid(configId, 'configId'), enabled, rawInput, idempotencyKey, requestId,
    );
  }

  private async create(
    scope: Scope,
    rawInput: unknown,
    idempotencyKeyValue: unknown,
    requestId: string,
  ): Promise<StripeConfigResponse> {
    const input = createInput(rawInput);
    const idempotencyKey = requiredIdempotencyKey(idempotencyKeyValue);
    if (!this.cipher.configured) {
      throw new ServiceUnavailableException('Payment secret encryption is not configured');
    }
    return this.database.inPlatformContext(async (transaction) => {
      if (scope.tenantId) await assertTenantAvailable(transaction, scope.tenantId);
      const command = await beginCommand(transaction, scope, {
        accountId: input.accountId, label: input.label, mode: input.mode,
      }, 'stripe.create', idempotencyKey);
      if (command.cached) return command.cached;
      const providerId = await ensureStripeProvider(transaction, scope.actorId);
      const configId = uuidV7();
      const encrypted = this.cipher.encryptStripeCredentials({
        accountId: input.accountId,
        mode: input.mode,
        secretKey: input.secretKey,
        webhookSecret: input.webhookSecret,
      }, {
        accountId: input.accountId,
        configId,
        mode: input.mode,
        ownerType: scope.ownerType,
        secretVersion: 1,
        tenantId: scope.tenantId,
      });
      try {
        await transaction`
          insert into payment_configs (
            id, owner_type, owner_tenant_id, provider_id, label, status,
            public_metadata_json, provider_mode, provider_account_id,
            active_secret_version, last_test_status, created_by
          ) values (
            ${configId}, ${scope.ownerType}, ${scope.tenantId}, ${providerId},
            ${input.label}, 'disabled',
            ${transaction.json({ accountId: input.accountId, mode: input.mode,
              ui: 'hosted_checkout' })}, ${input.mode}, ${input.accountId},
            null, 'untested', ${scope.actorId}
          )
        `;
        await transaction`
          insert into payment_config_secret_versions (
            id, payment_config_id, owner_type, owner_tenant_id, secret_version,
            provider_mode, provider_account_id, secret_key_ciphertext,
            webhook_secret_ciphertext, credential_key_version, created_by
          ) values (
            ${uuidV7()}, ${configId}, ${scope.ownerType}, ${scope.tenantId}, 1,
            ${input.mode}, ${input.accountId}, ${encrypted.secretKeyCiphertext},
            ${encrypted.webhookSecretCiphertext}, ${encrypted.credentialKeyVersion},
            ${scope.actorId}
          )
        `;
        await transaction`
          update payment_configs set active_secret_version = 1
          where id = ${configId}
        `;
      } catch (error) {
        if (databaseCode(error) === '23505') {
          throw new ConflictException('Payment config label already exists');
        }
        throw error;
      }
      const response: StripeConfigResponse = {
        accountId: input.accountId,
        collectionMode: scope.ownerType === 'platform' ? 'platform_collect' : 'tenant_direct',
        id: configId,
        label: input.label,
        mode: input.mode,
        providerCode: 'stripe',
        status: 'disabled',
        testStatus: 'untested',
        version: 0,
      };
      await audit(transaction, scope, requestId, 'commerce.payment.config.create', response);
      await completeCommand(transaction, command.id, configId, response, 201);
      return response;
    });
  }

  private rotate(
    scope: Scope, configId: string, rawInput: unknown,
    idempotencyKeyValue: unknown, requestId: string,
  ): Promise<StripeConfigResponse> {
    const input = rotateInput(rawInput);
    const idempotencyKey = requiredIdempotencyKey(idempotencyKeyValue);
    if (!this.cipher.configured) {
      throw new ServiceUnavailableException('Payment secret encryption is not configured');
    }
    return this.database.inPlatformContext(async (transaction) => {
      const command = await beginCommand(transaction, scope, {
        accountId: input.accountId, expectedVersion: input.expectedVersion,
        mode: input.mode,
      }, 'stripe.rotate', idempotencyKey);
      if (command.cached) return command.cached;
      const config = await lockConfig(transaction, scope, configId);
      requireExpectedVersion(config, input.expectedVersion);
      if (config.provider_account_id !== input.accountId || config.provider_mode !== input.mode) {
        throw new ConflictException('Receiving account or mode changes require a new config');
      }
      const live = await transaction<{ count: string | number | bigint }[]>`
        select count(*) as count from payment_config_secret_versions
        where payment_config_id = ${configId}
          and status in ('active', 'grace')
          and (status = 'active' or verify_webhooks_until > statement_timestamp())
      `;
      if (Number(live[0]?.count ?? 0) >= 5) {
        throw new ConflictException('Too many unexpired credential versions; retry after grace expiry');
      }
      const versions = await transaction<{ next_version: number }[]>`
        select coalesce(max(secret_version), 0)::integer + 1 as next_version
        from payment_config_secret_versions where payment_config_id = ${configId}
      `;
      const secretVersion = versions[0]?.next_version;
      if (!secretVersion) throw new Error('Payment secret version is unavailable');
      const encrypted = this.cipher.encryptStripeCredentials({
        accountId: input.accountId,
        mode: input.mode,
        secretKey: input.secretKey,
        webhookSecret: input.webhookSecret,
      }, {
        accountId: input.accountId, configId, mode: input.mode,
        ownerType: scope.ownerType, secretVersion, tenantId: scope.tenantId,
      });
      await transaction`
        update payment_config_secret_versions
        set status = 'grace',
          verify_webhooks_until = statement_timestamp() + interval '30 days'
        where payment_config_id = ${configId} and status = 'active'
      `;
      await transaction`
        insert into payment_config_secret_versions (
          id, payment_config_id, owner_type, owner_tenant_id, secret_version,
          provider_mode, provider_account_id, secret_key_ciphertext,
          webhook_secret_ciphertext, credential_key_version, created_by
        ) values (
          ${uuidV7()}, ${configId}, ${scope.ownerType}, ${scope.tenantId}, ${secretVersion},
          ${input.mode}, ${input.accountId}, ${encrypted.secretKeyCiphertext},
          ${encrypted.webhookSecretCiphertext}, ${encrypted.credentialKeyVersion},
          ${scope.actorId}
        )
      `;
      const rows = await transaction<ConfigRow[]>`
        update payment_configs set status = 'disabled',
          active_secret_version = ${secretVersion}, last_test_status = 'untested',
          last_tested_secret_version = null, last_test_at = null, last_test_error = null,
          version = version + 1, updated_by = ${scope.actorId}
        where id = ${configId} and version = ${input.expectedVersion}
        returning *
      `;
      const updated = rows[0];
      if (!updated) throw new ConflictException('Payment config version changed');
      const response = mapConfig(updated);
      await audit(transaction, scope, requestId, 'commerce.payment.config.rotate', response);
      await completeCommand(transaction, command.id, configId, response, 200);
      return response;
    });
  }

  private async test(
    scope: Scope, configId: string, rawInput: unknown,
    idempotencyKeyValue: unknown, requestId: string,
  ): Promise<StripeConfigResponse> {
    const { expectedVersion } = versionInput(rawInput);
    const idempotencyKey = requiredIdempotencyKey(idempotencyKeyValue);
    const prepared = await this.database.inPlatformContext(async (transaction) => {
      const command = await beginCommand(transaction, scope, { expectedVersion },
        'stripe.test', idempotencyKey);
      if (command.cached) return { cached: command.cached } as const;
      const config = await lockConfig(transaction, scope, configId);
      requireExpectedVersion(config, expectedVersion);
      const secret = await activeSecret(transaction, configId, config.active_secret_version);
      return {
        commandId: command.id,
        config,
        credentials: this.cipher.decryptStripeCredentials({
          secretKeyCiphertext: secret.secret_key_ciphertext,
          webhookSecretCiphertext: secret.webhook_secret_ciphertext,
        }, {
          accountId: config.provider_account_id,
          configId,
          credentialKeyVersion: secret.credential_key_version,
          mode: config.provider_mode,
          ownerType: scope.ownerType,
          secretVersion: secret.secret_version,
          tenantId: scope.tenantId,
        }),
      } as const;
    });
    if ('cached' in prepared && prepared.cached) return prepared.cached;
    let testStatus: 'failed' | 'passed' = 'passed';
    let errorCode: string | null = null;
    try {
      await this.stripe.testCredentials({
        configId,
        configVersion: prepared.config.version,
        credentials: prepared.credentials,
        providerId: 'stripe-config-test',
        secretVersion: prepared.config.active_secret_version,
      });
    } catch (error) {
      testStatus = 'failed';
      errorCode = error instanceof StripeAccountMismatchError
        ? 'provider_account_mismatch'
        : error instanceof StripeProviderUnavailableError
          ? 'provider_unavailable'
          : error instanceof PaymentAdapterDefinitiveError
            ? 'provider_auth_failed'
            : 'provider_invalid_response';
    }
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<ConfigRow[]>`
        update payment_configs set last_test_status = ${testStatus},
          last_tested_secret_version = ${prepared.config.active_secret_version},
          last_test_at = statement_timestamp(), last_test_error = ${errorCode},
          version = version + 1, updated_by = ${scope.actorId}
        where id = ${configId} and version = ${prepared.config.version}
          and active_secret_version = ${prepared.config.active_secret_version}
        returning *
      `;
      const updated = rows[0];
      if (!updated) throw new ConflictException('Payment config changed during credential test');
      const response = mapConfig(updated);
      await audit(transaction, scope, requestId, 'commerce.payment.config.test', response);
      await completeCommand(transaction, prepared.commandId, configId, response, 200);
      return response;
    });
  }

  private setStatus(
    scope: Scope, configId: string, enabled: boolean, rawInput: unknown,
    idempotencyKeyValue: unknown, requestId: string,
  ): Promise<StripeConfigResponse> {
    const { expectedVersion } = versionInput(rawInput);
    const idempotencyKey = requiredIdempotencyKey(idempotencyKeyValue);
    return this.database.inPlatformContext(async (transaction) => {
      const command = await beginCommand(transaction, scope, {
        enabled, expectedVersion,
      }, enabled ? 'stripe.enable' : 'stripe.disable', idempotencyKey);
      if (command.cached) return command.cached;
      const config = await lockConfig(transaction, scope, configId);
      requireExpectedVersion(config, expectedVersion);
      if (enabled && config.last_test_status !== 'passed') {
        throw new ConflictException('Payment config has not passed credential testing');
      }
      const rows = await transaction<ConfigRow[]>`
        update payment_configs set status = ${enabled ? 'active' : 'disabled'},
          version = version + 1, updated_by = ${scope.actorId}
        where id = ${configId} and version = ${expectedVersion}
        returning *
      `;
      const updated = rows[0];
      if (!updated) throw new ConflictException('Payment config version changed');
      const response = mapConfig(updated);
      await audit(transaction, scope, requestId,
        enabled ? 'commerce.payment.config.enable' : 'commerce.payment.config.disable',
        response);
      await completeCommand(transaction, command.id, configId, response, 200);
      return response;
    });
  }
}

async function lockConfig(
  transaction: DatabaseTransaction,
  scope: Scope,
  configId: string,
): Promise<ConfigRow> {
  const rows = await transaction<ConfigRow[]>`
    select config.* from payment_configs as config
    inner join payment_providers as provider
      on provider.id = config.provider_id and provider.adapter_code = 'stripe'
    where config.id = ${configId} and config.owner_type = ${scope.ownerType}
      and config.owner_tenant_id is not distinct from ${scope.tenantId}
    for update of config
  `;
  if (!rows[0]) throw new NotFoundException('Stripe payment config not found');
  return rows[0];
}

async function activeSecret(
  transaction: DatabaseTransaction,
  configId: string,
  version: number,
): Promise<SecretRow> {
  const rows = await transaction<SecretRow[]>`
    select credential_key_version, secret_key_ciphertext, secret_version,
      webhook_secret_ciphertext
    from payment_config_secret_versions
    where payment_config_id = ${configId} and secret_version = ${version}
      and status = 'active'
    for share
  `;
  if (!rows[0]) throw new ConflictException('Active payment credential is unavailable');
  return rows[0];
}

async function ensureStripeProvider(
  transaction: DatabaseTransaction,
  actorId: string,
): Promise<string> {
  const existing = await transaction<{ id: string }[]>`
    select id from payment_providers
    where code = 'stripe' and adapter_code = 'stripe'
  `;
  if (existing[0]) return existing[0].id;
  const id = uuidV7();
  await transaction`
    insert into payment_providers (
      id, code, adapter_code, capabilities_json, created_by
    ) values (
      ${id}, 'stripe', 'stripe',
      ${transaction.json({ checkout: 'hosted', currencies: ['USD', 'EUR', 'JPY', 'KRW'],
        paymentMethods: ['card'] })}, ${actorId}
    ) on conflict (code) do nothing
  `;
  const rows = await transaction<{ id: string }[]>`
    select id from payment_providers
    where code = 'stripe' and adapter_code = 'stripe'
  `;
  if (!rows[0]) throw new ConflictException('Stripe provider registration conflicts');
  return rows[0].id;
}

async function beginCommand(
  transaction: DatabaseTransaction,
  scope: Scope,
  request: unknown,
  operation: string,
  idempotencyKey: string,
): Promise<{ cached?: StripeConfigResponse; id: string }> {
  const requestHash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const id = uuidV7();
  const routeKey = `${scope.ownerType}.payment.config.${operation}`;
  const inserted = await transaction<{ id: string }[]>`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, expires_at
    ) values (
      ${id}, ${scope.ownerType}, ${scope.tenantId},
      ${scope.ownerType === 'platform' ? 'platform_staff' : 'tenant_staff'},
      ${scope.actorId}, ${routeKey}, ${idempotencyKey}, ${requestHash},
      statement_timestamp() + interval '7 days'
    ) on conflict do nothing returning id
  `;
  if (inserted[0]) return { id };
  const rows = await transaction<CommandRow[]>`
    select id, request_hash, status, response_json from command_idempotency
    where scope_type = ${scope.ownerType} and tenant_id is not distinct from ${scope.tenantId}
      and actor_type = ${scope.ownerType === 'platform' ? 'platform_staff' : 'tenant_staff'}
      and actor_id = ${scope.actorId} and route_key = ${routeKey}
      and idempotency_key = ${idempotencyKey}
    for update
  `;
  const existing = rows[0];
  if (!existing) throw new ConflictException('Payment config command is unavailable');
  if (existing.request_hash !== requestHash) {
    throw new ConflictException('Idempotency-Key was used with another request');
  }
  if (existing.status === 'completed' && existing.response_json) {
    return { cached: existing.response_json, id: existing.id };
  }
  throw new ConflictException('Payment config command is already processing');
}

async function completeCommand(
  transaction: DatabaseTransaction,
  commandId: string,
  configId: string,
  response: StripeConfigResponse,
  status: number,
): Promise<void> {
  await transaction`
    update command_idempotency set status = 'completed', resource_type = 'payment_config',
      resource_id = ${configId}, response_status = ${status},
      response_json = ${transaction.json(toJsonValue(response))}, locked_at = null
    where id = ${commandId} and status = 'processing'
  `;
}

async function audit(
  transaction: DatabaseTransaction,
  scope: Scope,
  requestId: string,
  action: string,
  response: StripeConfigResponse,
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, request_id
    ) values (
      ${uuidV7()}, ${scope.ownerType}, ${scope.tenantId},
      ${scope.ownerType === 'platform' ? 'platform_staff' : 'tenant_staff'},
      ${scope.actorId}, ${action}, 'payment_config', ${response.id},
      ${transaction.json({
        accountId: response.accountId,
        mode: response.mode,
        providerCode: response.providerCode,
        status: response.status,
        testStatus: response.testStatus,
        version: response.version,
      })}, ${requestId}
    )
  `;
}

function createInput(value: unknown) {
  if (!record(value)) throw new BadRequestException('Stripe config input is invalid');
  rejectUnknown(value, ['accountId', 'label', 'mode', 'secretKey', 'webhookSecret']);
  const label = labelValue(value.label);
  const mode = modeValue(value.mode);
  const accountId = accountValue(value.accountId);
  if (typeof value.secretKey !== 'string' || typeof value.webhookSecret !== 'string') {
    throw new BadRequestException('Stripe credentials are required');
  }
  return { accountId, label, mode, secretKey: value.secretKey, webhookSecret: value.webhookSecret };
}

function rotateInput(value: unknown) {
  if (!record(value)) throw new BadRequestException('Stripe credential input is invalid');
  rejectUnknown(value, ['accountId', 'expectedVersion', 'mode', 'secretKey', 'webhookSecret']);
  const expectedVersion = expectedVersionValue(value.expectedVersion);
  const mode = modeValue(value.mode);
  const accountId = accountValue(value.accountId);
  if (typeof value.secretKey !== 'string' || typeof value.webhookSecret !== 'string') {
    throw new BadRequestException('Stripe credentials are required');
  }
  return { accountId, expectedVersion, mode,
    secretKey: value.secretKey, webhookSecret: value.webhookSecret };
}

function versionInput(value: unknown): { expectedVersion: number } {
  if (!record(value)) throw new BadRequestException('Expected version is required');
  rejectUnknown(value, ['expectedVersion']);
  return { expectedVersion: expectedVersionValue(value.expectedVersion) };
}

function requireExpectedVersion(config: ConfigRow, expected: number): void {
  if (config.version !== expected) throw new ConflictException('Payment config version changed');
}

function mapConfig(config: ConfigRow): StripeConfigResponse {
  return {
    accountId: config.provider_account_id,
    collectionMode: config.owner_type === 'platform' ? 'platform_collect' : 'tenant_direct',
    id: config.id,
    label: config.label,
    mode: config.provider_mode,
    providerCode: 'stripe',
    status: config.status,
    testStatus: config.last_test_status,
    version: config.version,
  };
}

function requiredIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{8,200}$/.test(value)) {
    throw new BadRequestException('Idempotency-Key is required');
  }
  return value;
}

function expectedVersionValue(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 2_147_483_647) {
    throw new BadRequestException('expectedVersion is invalid');
  }
  return Number(value);
}

function labelValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length < 1 || value.trim().length > 100) {
    throw new BadRequestException('label is invalid');
  }
  return value.trim();
}

function modeValue(value: unknown): StripeMode {
  if (value !== 'test' && value !== 'live') throw new BadRequestException('mode is invalid');
  return value;
}

function accountValue(value: unknown): string {
  if (typeof value !== 'string' || !/^acct_[A-Za-z0-9]{8,64}$/.test(value)) {
    throw new BadRequestException('accountId is invalid');
  }
  return value;
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

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function rejectUnknown(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new BadRequestException('Request contains unknown fields');
  }
}

function databaseCode(error: unknown): string | undefined {
  return record(error) && typeof error.code === 'string' ? error.code : undefined;
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
