import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import {
  type S3StorageCredentials,
  StorageCredentialCipher,
} from './storage-credentials';
import {
  validatePublicHttpsOrigin,
  validateStorageEndpoint,
} from './storage-endpoint-policy';

export interface StorageProviderMutationMetadata {
  actorId: string;
  idempotencyKey?: string;
  ip?: string;
  requestId: string;
}

export interface StorageProviderRecord {
  bucket: string;
  cdnBaseUrl?: string;
  createdAt: string;
  credentialConfigured: true;
  endpoint?: string;
  forcePathStyle: boolean;
  id: string;
  label: string;
  ownerType: 'platform' | 'tenant';
  provider: 's3';
  readOnly: boolean;
  region: string;
  status: 'active' | 'disabled';
  updatedAt: string;
  version: number;
}

interface ProviderRow {
  account_label: string;
  bucket: string;
  cdn_base_url: string | null;
  created_at: Date;
  credential_ciphertext: string;
  endpoint: string | null;
  id: string;
  key_version: number;
  owner_tenant_id: string | null;
  owner_type: 'platform' | 'tenant';
  provider: 's3';
  status: 'active' | 'disabled';
  total_count?: number;
  updated_at: Date;
  version: number;
}

interface OwnerContext {
  actorType: 'platform_staff' | 'tenant_staff';
  scope: 'platform' | 'tenant';
  tenantId: string | null;
}

interface CommandRow {
  request_hash: string;
  response_json: unknown;
  status: 'completed' | 'failed' | 'processing';
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BUCKET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{1,253}[A-Za-z0-9]$/;
const REGION_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

@Injectable()
export class StorageProviderService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(StorageCredentialCipher)
    private readonly cipher: StorageCredentialCipher,
  ) {}

  listPlatform(
    pageValue: number,
    pageSizeValue: number,
  ): Promise<{ items: StorageProviderRecord[]; page: number; pageSize: number; total: number }> {
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<ProviderRow[]>`
        select
          id, owner_type, owner_tenant_id, provider, account_label,
          endpoint, bucket, credential_ciphertext, key_version, cdn_base_url,
          status, version, created_at, updated_at,
          count(*) over()::integer as total_count
        from storage_providers
        where owner_type = 'platform' and owner_tenant_id is null
        order by created_at desc, id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map((row) => this.toRecord(row, false)),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  listTenant(
    tenantId: string,
    pageValue: number,
    pageSizeValue: number,
  ): Promise<{ items: StorageProviderRecord[]; page: number; pageSize: number; total: number }> {
    assertUuid(tenantId, 'tenantId');
    const page = boundedInteger(pageValue, 1, 1, 10_000);
    const pageSize = boundedInteger(pageSizeValue, 20, 1, 100);
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<ProviderRow[]>`
        select
          id, owner_type, owner_tenant_id, provider, account_label,
          endpoint, bucket, credential_ciphertext, key_version, cdn_base_url,
          status, version, created_at, updated_at,
          count(*) over()::integer as total_count
        from storage_providers
        where
          (owner_type = 'tenant' and owner_tenant_id = ${tenantId})
          or (owner_type = 'platform' and owner_tenant_id is null and status = 'active')
        order by
          case when owner_type = 'tenant' then 0 else 1 end,
          created_at desc,
          id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map((row) => this.toRecord(row, row.owner_type === 'platform')),
        page,
        pageSize,
        total: rows[0]?.total_count ?? 0,
      };
    });
  }

  createPlatform(
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<StorageProviderRecord> {
    return this.create(ownerContext('platform'), rawInput, metadata);
  }

  createTenant(
    tenantId: string,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<StorageProviderRecord> {
    assertUuid(tenantId, 'tenantId');
    return this.create(ownerContext('tenant', tenantId), rawInput, metadata);
  }

  updatePlatform(
    providerId: string,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<StorageProviderRecord> {
    return this.update(ownerContext('platform'), providerId, rawInput, metadata);
  }

  updateTenant(
    tenantId: string,
    providerId: string,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<StorageProviderRecord> {
    assertUuid(tenantId, 'tenantId');
    return this.update(ownerContext('tenant', tenantId), providerId, rawInput, metadata);
  }

  setPlatformStatus(
    providerId: string,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<StorageProviderRecord> {
    return this.setStatus(ownerContext('platform'), providerId, rawInput, metadata);
  }

  setTenantStatus(
    tenantId: string,
    providerId: string,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<StorageProviderRecord> {
    assertUuid(tenantId, 'tenantId');
    return this.setStatus(ownerContext('tenant', tenantId), providerId, rawInput, metadata);
  }

  deletePlatform(
    providerId: string,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<{ deleted: true; id: string }> {
    return this.delete(ownerContext('platform'), providerId, rawInput, metadata);
  }

  deleteTenant(
    tenantId: string,
    providerId: string,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<{ deleted: true; id: string }> {
    assertUuid(tenantId, 'tenantId');
    return this.delete(ownerContext('tenant', tenantId), providerId, rawInput, metadata);
  }

  private create(
    owner: OwnerContext,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<StorageProviderRecord> {
    const input = parseCreateInput(rawInput);
    assertMetadata(metadata);
    return this.inOwnerContext(owner, async (transaction) => {
      const command = await this.beginCreateCommand<StorageProviderRecord>(
        transaction,
        owner,
        input,
        metadata,
      );
      if (command.cached) return command.cached;
      const providerId = uuidV7();
      const encrypted = encryptCredentials(this.cipher, input.credentials, {
        ownerTenantId: owner.tenantId,
        ownerType: owner.scope,
        providerId,
      });
      let rows: ProviderRow[];
      try {
        rows = await transaction<ProviderRow[]>`
          insert into storage_providers (
            id, owner_type, owner_tenant_id, provider, account_label,
            endpoint, bucket, credential_ciphertext, key_version, cdn_base_url,
            created_by, updated_by
          ) values (
            ${providerId}, ${owner.scope}, ${owner.tenantId}, 's3', ${input.label},
            ${input.endpoint}, ${input.bucket}, ${encrypted.ciphertext},
            ${encrypted.keyVersion}, ${input.cdnBaseUrl},
            ${metadata.actorId}, ${metadata.actorId}
          )
          returning
            id, owner_type, owner_tenant_id, provider, account_label,
            endpoint, bucket, credential_ciphertext, key_version, cdn_base_url,
            status, version, created_at, updated_at
        `;
      } catch (error) {
        if (isDatabaseError(error, '23505')) {
          throw new ConflictException('A storage provider with this label already exists');
        }
        throw error;
      }
      const row = rows[0];
      if (!row) throw new Error('Created storage provider could not be loaded');
      const response = this.toRecord(row, false);
      await this.insertAudit(transaction, owner, metadata, {
        action: 'storage.provider.create',
        after: response,
        resourceId: providerId,
      });
      await this.completeCommand(transaction, command.id, response, providerId);
      return response;
    });
  }

  private update(
    owner: OwnerContext,
    providerId: string,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<StorageProviderRecord> {
    assertUuid(providerId, 'providerId');
    const input = parseUpdateInput(rawInput);
    assertMetadata(metadata);
    return this.inOwnerContext(owner, async (transaction) => {
      const current = await this.lockOwnedProvider(transaction, owner, providerId);
      if (current.version !== input.version) {
        throw new ConflictException('Storage provider was changed by another operator');
      }
      const previous = this.toRecord(current, false);
      const existingCredentials = decryptCredentials(this.cipher, current);
      const credentials: S3StorageCredentials = input.replaceCredentials
        ? {
            accessKeyId: input.accessKeyId!,
            forcePathStyle: input.forcePathStyle ?? existingCredentials.forcePathStyle,
            region: input.region ?? existingCredentials.region,
            secretAccessKey: input.secretAccessKey!,
            sessionToken: input.sessionToken,
          }
        : {
            ...existingCredentials,
            forcePathStyle: input.forcePathStyle ?? existingCredentials.forcePathStyle,
            region: input.region ?? existingCredentials.region,
          };
      const encrypted = encryptCredentials(this.cipher, credentials, {
        ownerTenantId: owner.tenantId,
        ownerType: owner.scope,
        providerId,
      });
      const nextEndpoint = input.hasEndpoint ? (input.endpoint ?? null) : current.endpoint;
      const nextCdnBaseUrl = input.hasCdnBaseUrl
        ? (input.cdnBaseUrl ?? null)
        : current.cdn_base_url;
      let rows: ProviderRow[];
      try {
        rows = await transaction<ProviderRow[]>`
          update storage_providers
          set
            account_label = ${input.label ?? current.account_label},
            endpoint = ${nextEndpoint},
            bucket = ${input.bucket ?? current.bucket},
            credential_ciphertext = ${encrypted.ciphertext},
            key_version = ${encrypted.keyVersion},
            cdn_base_url = ${nextCdnBaseUrl},
            version = version + 1,
            updated_by = ${metadata.actorId}
          where id = ${providerId}
            and owner_type = ${owner.scope}
            and owner_tenant_id is not distinct from ${owner.tenantId}
            and version = ${input.version}
          returning
            id, owner_type, owner_tenant_id, provider, account_label,
            endpoint, bucket, credential_ciphertext, key_version, cdn_base_url,
            status, version, created_at, updated_at
        `;
      } catch (error) {
        if (isDatabaseError(error, '23505')) {
          throw new ConflictException('A storage provider with this label already exists');
        }
        throw error;
      }
      const row = rows[0];
      if (!row) throw new ConflictException('Storage provider was changed by another operator');
      const response = this.toRecord(row, false);
      await this.insertAudit(transaction, owner, metadata, {
        action: 'storage.provider.update',
        after: response,
        before: previous,
        resourceId: providerId,
      });
      return response;
    });
  }

  private setStatus(
    owner: OwnerContext,
    providerId: string,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<StorageProviderRecord> {
    assertUuid(providerId, 'providerId');
    const input = parseStatusInput(rawInput);
    assertMetadata(metadata);
    return this.inOwnerContext(owner, async (transaction) => {
      const current = await this.lockOwnedProvider(transaction, owner, providerId);
      if (current.version !== input.version) {
        throw new ConflictException('Storage provider was changed by another operator');
      }
      const previous = this.toRecord(current, false);
      const rows = await transaction<ProviderRow[]>`
        update storage_providers
        set status = ${input.status}, version = version + 1, updated_by = ${metadata.actorId}
        where id = ${providerId}
          and owner_type = ${owner.scope}
          and owner_tenant_id is not distinct from ${owner.tenantId}
          and version = ${input.version}
        returning
          id, owner_type, owner_tenant_id, provider, account_label,
          endpoint, bucket, credential_ciphertext, key_version, cdn_base_url,
          status, version, created_at, updated_at
      `;
      const row = rows[0];
      if (!row) throw new ConflictException('Storage provider was changed by another operator');
      const response = this.toRecord(row, false);
      await this.insertAudit(transaction, owner, metadata, {
        action: 'storage.provider.status',
        after: response,
        before: previous,
        resourceId: providerId,
      });
      return response;
    });
  }

  private delete(
    owner: OwnerContext,
    providerId: string,
    rawInput: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<{ deleted: true; id: string }> {
    assertUuid(providerId, 'providerId');
    const input = parseVersionInput(rawInput);
    assertMetadata(metadata);
    return this.inOwnerContext(owner, async (transaction) => {
      const current = await this.lockOwnedProvider(transaction, owner, providerId);
      if (current.version !== input.version) {
        throw new ConflictException('Storage provider was changed by another operator');
      }
      const previous = this.toRecord(current, false);
      await this.insertAudit(transaction, owner, metadata, {
        action: 'storage.provider.delete',
        after: { deleted: true },
        before: previous,
        resourceId: providerId,
      });
      try {
        const rows = await transaction<{ id: string }[]>`
          delete from storage_providers
          where id = ${providerId}
            and owner_type = ${owner.scope}
            and owner_tenant_id is not distinct from ${owner.tenantId}
            and version = ${input.version}
          returning id
        `;
        if (!rows[0]) {
          throw new ConflictException('Storage provider was changed by another operator');
        }
      } catch (error) {
        if (isDatabaseError(error, '23503')) {
          throw new ConflictException('Storage provider is already used by media and cannot be deleted');
        }
        throw error;
      }
      return { deleted: true, id: providerId };
    });
  }

  private inOwnerContext<T>(
    owner: OwnerContext,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    return owner.scope === 'platform'
      ? this.database.inPlatformContext(callback)
      : this.database.inTenantContext(owner.tenantId!, callback);
  }

  private async lockOwnedProvider(
    transaction: DatabaseTransaction,
    owner: OwnerContext,
    providerId: string,
  ): Promise<ProviderRow> {
    const rows = await transaction<ProviderRow[]>`
      select
        id, owner_type, owner_tenant_id, provider, account_label,
        endpoint, bucket, credential_ciphertext, key_version, cdn_base_url,
        status, version, created_at, updated_at
      from storage_providers
      where id = ${providerId}
        and owner_type = ${owner.scope}
        and owner_tenant_id is not distinct from ${owner.tenantId}
      for update
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('Storage provider not found');
    return row;
  }

  private toRecord(row: ProviderRow, readOnly: boolean): StorageProviderRecord {
    const credentials = decryptCredentials(this.cipher, row);
    return {
      bucket: row.bucket,
      cdnBaseUrl: row.cdn_base_url ?? undefined,
      createdAt: row.created_at.toISOString(),
      credentialConfigured: true,
      endpoint: row.endpoint ?? undefined,
      forcePathStyle: credentials.forcePathStyle ?? Boolean(row.endpoint),
      id: row.id,
      label: row.account_label,
      ownerType: row.owner_type,
      provider: 's3',
      readOnly,
      region: credentials.region,
      status: row.status,
      updatedAt: row.updated_at.toISOString(),
      version: row.version,
    };
  }

  private async insertAudit(
    transaction: DatabaseTransaction,
    owner: OwnerContext,
    metadata: StorageProviderMutationMetadata,
    input: {
      action: string;
      after: object;
      before?: object;
      resourceId: string;
    },
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, before_json, after_json, ip, request_id
      ) values (
        ${uuidV7()}, ${owner.scope}, ${owner.tenantId}, ${owner.actorType},
        ${metadata.actorId}, ${input.action}, 'storage_provider', ${input.resourceId},
        ${input.before ? transaction.json(toJsonValue(input.before)) : null},
        ${transaction.json(toJsonValue(input.after))}, ${metadata.ip ?? null},
        ${metadata.requestId}
      )
    `;
  }

  private async beginCreateCommand<T>(
    transaction: DatabaseTransaction,
    owner: OwnerContext,
    request: unknown,
    metadata: StorageProviderMutationMetadata,
  ): Promise<{ cached?: T; id?: string }> {
    const key = metadata.idempotencyKey?.trim();
    if (!key || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) {
      throw new BadRequestException('A valid Idempotency-Key is required');
    }
    const routeKey = `${owner.scope}.storage.provider.create`;
    const requestHash = createHash('sha256')
      .update(JSON.stringify(toJsonValue(request)))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, ${owner.scope}, ${owner.tenantId}, ${owner.actorType},
        ${metadata.actorId}, ${routeKey}, ${key}, ${requestHash},
        statement_timestamp() + interval '24 hours'
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) return { id };
    const rows = await transaction<CommandRow[]>`
      select request_hash, status, response_json
      from command_idempotency
      where scope_type = ${owner.scope}
        and tenant_id is not distinct from ${owner.tenantId}
        and actor_type = ${owner.actorType}
        and actor_id = ${metadata.actorId}
        and route_key = ${routeKey}
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
    response: StorageProviderRecord,
    providerId: string,
  ): Promise<void> {
    if (!commandId) return;
    await transaction`
      update command_idempotency
      set
        status = 'completed', response_status = 201,
        response_json = ${transaction.json(toJsonValue(response))},
        resource_type = 'storage_provider', resource_id = ${providerId},
        locked_at = null
      where id = ${commandId} and status = 'processing'
    `;
  }
}

function ownerContext(scope: 'platform', tenantId?: null): OwnerContext;
function ownerContext(scope: 'tenant', tenantId: string): OwnerContext;
function ownerContext(
  scope: 'platform' | 'tenant',
  tenantId: string | null = null,
): OwnerContext {
  return {
    actorType: scope === 'platform' ? 'platform_staff' : 'tenant_staff',
    scope,
    tenantId,
  };
}

function parseCreateInput(raw: unknown) {
  const value = requiredRecord(raw);
  rejectTenantId(value);
  if (value.provider !== 's3') throw new BadRequestException('Only s3 storage is supported');
  const endpoint = optionalOrigin(value.endpoint, 'endpoint');
  return {
    bucket: bucket(value.bucket),
    cdnBaseUrl: optionalCdnOrigin(value.cdnBaseUrl),
    credentials: credentials({
      accessKeyId: value.accessKeyId,
      forcePathStyle: value.forcePathStyle,
      region: value.region,
      secretAccessKey: value.secretAccessKey,
      sessionToken: value.sessionToken,
    }, true),
    endpoint,
    label: requiredText(value.label, 'label', 1, 100),
  };
}

function parseUpdateInput(raw: unknown) {
  const value = requiredRecord(raw);
  rejectTenantId(value);
  if (Object.hasOwn(value, 'provider') && value.provider !== 's3') {
    throw new BadRequestException('Only s3 storage is supported');
  }
  const hasAccessKey = Object.hasOwn(value, 'accessKeyId');
  const hasSecretKey = Object.hasOwn(value, 'secretAccessKey');
  if (hasAccessKey !== hasSecretKey) {
    throw new BadRequestException('accessKeyId and secretAccessKey must be replaced together');
  }
  if (!hasAccessKey && Object.hasOwn(value, 'sessionToken')) {
    throw new BadRequestException('sessionToken can only be changed with credentials');
  }
  const replaceCredentials = hasAccessKey && hasSecretKey;
  const hasEndpoint = Object.hasOwn(value, 'endpoint');
  const hasCdnBaseUrl = Object.hasOwn(value, 'cdnBaseUrl');
  const hasChange = ['label', 'bucket', 'region', 'forcePathStyle', 'provider'].some(
    (field) => Object.hasOwn(value, field),
  ) || hasEndpoint || hasCdnBaseUrl || replaceCredentials;
  if (!hasChange) throw new BadRequestException('At least one storage field must be changed');
  if (Object.hasOwn(value, 'forcePathStyle') && typeof value.forcePathStyle !== 'boolean') {
    throw new BadRequestException('forcePathStyle must be boolean');
  }
  return {
    accessKeyId: replaceCredentials
      ? requiredSecret(value.accessKeyId, 'accessKeyId', 3, 256)
      : undefined,
    bucket: Object.hasOwn(value, 'bucket') ? bucket(value.bucket) : undefined,
    cdnBaseUrl: hasCdnBaseUrl ? optionalCdnOrigin(value.cdnBaseUrl) : undefined,
    endpoint: hasEndpoint ? optionalOrigin(value.endpoint, 'endpoint') : undefined,
    forcePathStyle: value.forcePathStyle as boolean | undefined,
    hasCdnBaseUrl,
    hasEndpoint,
    label: Object.hasOwn(value, 'label')
      ? requiredText(value.label, 'label', 1, 100)
      : undefined,
    region: Object.hasOwn(value, 'region') ? region(value.region) : undefined,
    replaceCredentials,
    secretAccessKey: replaceCredentials
      ? requiredSecret(value.secretAccessKey, 'secretAccessKey', 16, 512)
      : undefined,
    sessionToken: replaceCredentials ? optionalSessionToken(value.sessionToken) : undefined,
    version: version(value.version),
  };
}

function parseStatusInput(raw: unknown) {
  const value = requiredRecord(raw);
  rejectTenantId(value);
  if (value.status !== 'active' && value.status !== 'disabled') {
    throw new BadRequestException('status must be active or disabled');
  }
  return { status: value.status, version: version(value.version) };
}

function parseVersionInput(raw: unknown) {
  const value = requiredRecord(raw);
  rejectTenantId(value);
  return { version: version(value.version) };
}

function credentials(
  value: Record<string, unknown>,
  requirePair: boolean,
): S3StorageCredentials {
  if (requirePair && (!Object.hasOwn(value, 'accessKeyId') || !Object.hasOwn(value, 'secretAccessKey'))) {
    throw new BadRequestException('Storage credentials are required');
  }
  if (value.forcePathStyle !== undefined && typeof value.forcePathStyle !== 'boolean') {
    throw new BadRequestException('forcePathStyle must be boolean');
  }
  return {
    accessKeyId: requiredSecret(value.accessKeyId, 'accessKeyId', 3, 256),
    forcePathStyle: value.forcePathStyle as boolean | undefined,
    region: region(value.region),
    secretAccessKey: requiredSecret(value.secretAccessKey, 'secretAccessKey', 16, 512),
    sessionToken: optionalSessionToken(value.sessionToken),
  };
}

function optionalOrigin(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new BadRequestException(`${field} is invalid`);
  }
  try {
    return validateStorageEndpoint(value).origin;
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : `${field} is invalid`);
  }
}

function optionalCdnOrigin(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2_048) {
    throw new BadRequestException('cdnBaseUrl is invalid');
  }
  try {
    return validatePublicHttpsOrigin(value).origin;
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : 'cdnBaseUrl is invalid');
  }
}

function bucket(value: unknown): string {
  if (typeof value !== 'string' || !BUCKET_PATTERN.test(value.trim())) {
    throw new BadRequestException('bucket is invalid');
  }
  return value.trim();
}

function region(value: unknown): string {
  if (typeof value !== 'string' || !REGION_PATTERN.test(value.trim())) {
    throw new BadRequestException('region is invalid');
  }
  return value.trim();
}

function requiredSecret(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== 'string'
    || value.length < minimum
    || value.length > maximum
    || /[\u0000\r\n]/.test(value)
  ) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return value;
}

function optionalSessionToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return requiredSecret(value, 'sessionToken', 1, 8_192);
}

function requiredText(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} is required`);
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return result;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException('Body is required');
  }
  return value as Record<string, unknown>;
}

function rejectTenantId(value: Record<string, unknown>): void {
  if (Object.hasOwn(value, 'tenantId')) {
    throw new BadRequestException('tenantId must not be supplied in the request body');
  }
}

function version(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1_000_000_000) {
    throw new BadRequestException('version is invalid');
  }
  return value as number;
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

function assertMetadata(value: StorageProviderMutationMetadata): void {
  if (!value || typeof value !== 'object') throw new TypeError('Mutation metadata is required');
  assertUuid(value.actorId, 'actorId');
  if (typeof value.requestId !== 'string' || value.requestId.length < 8 || value.requestId.length > 128) {
    throw new TypeError('requestId is invalid');
  }
}

function encryptCredentials(
  cipher: StorageCredentialCipher,
  value: S3StorageCredentials,
  binding: { ownerTenantId: string | null; ownerType: 'platform' | 'tenant'; providerId: string },
) {
  try {
    return cipher.encrypt(value, binding);
  } catch (error) {
    if (error instanceof TypeError) throw new BadRequestException(error.message);
    throw error;
  }
}

function decryptCredentials(
  cipher: StorageCredentialCipher,
  row: ProviderRow,
): S3StorageCredentials {
  return cipher.decrypt(row.credential_ciphertext, {
    keyVersion: row.key_version,
    ownerTenantId: row.owner_tenant_id,
    ownerType: row.owner_type,
    providerId: row.id,
  });
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function isDatabaseError(error: unknown, code: string): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === code);
}
