import { tenantOwnerPermissions } from '@drama/contracts';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomBytes } from 'node:crypto';

import { hashPassword } from '../auth/password';
import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import type {
  CreateMerchantInput,
  MerchantMutationMetadata,
  MerchantRecord,
  UpdateMerchantInput,
} from './merchant.types';

const SUPPORTED_LOCALES = new Set([
  'zh-CN',
  'zh-TW',
  'en-US',
  'fr-FR',
  'ja-JP',
  'ko-KR',
]);
const CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_PATTERN = /^\+[1-9][0-9]{7,14}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface MerchantRow {
  code: string;
  created_at: Date;
  default_currency: string;
  default_locale: string;
  expires_at: Date;
  id: string;
  name: string;
  primary_domain: string;
  status: 'active' | 'expired' | 'suspended';
  timezone: string;
  version: number;
}

@Injectable()
export class MerchantService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async create(
    rawInput: CreateMerchantInput,
    metadata: MerchantMutationMetadata,
  ): Promise<MerchantRecord> {
    const input = validateCreateInput(rawInput);
    const passwordHash = await hashPassword(input.owner.password);
    const tenantId = uuidV7();
    const domainId = uuidV7();
    const ownerId = uuidV7();
    const roleId = uuidV7();
    const primaryDomain = `${input.code}.${tenantBaseDomain()}`;

    return this.database.inPlatformContext(async (transaction) => {
      const duplicate = await transaction<{ exists: boolean }[]>`
        select exists (
          select 1 from tenants where code = ${input.code}
          union all
          select 1 from tenant_domains where host = ${primaryDomain}
        ) as exists
      `;
      if (duplicate[0]?.exists) {
        throw new ConflictException('Merchant code or platform domain already exists');
      }

      await transaction`
        insert into tenants (
          id,
          code,
          name,
          status,
          expires_at,
          default_locale,
          timezone,
          default_currency,
          created_by
        ) values (
          ${tenantId},
          ${input.code},
          ${input.name},
          'active',
          ${input.expiresAt},
          ${input.defaultLocale},
          ${input.timezone},
          ${input.defaultCurrency},
          ${metadata.actorId}
        )
      `;
      await transaction`
        insert into tenant_domains (
          id,
          tenant_id,
          host,
          type,
          verification_token,
          verified_at,
          tls_status,
          is_primary,
          created_by
        ) values (
          ${domainId},
          ${tenantId},
          ${primaryDomain},
          'subdomain',
          ${randomBytes(24).toString('base64url')},
          statement_timestamp(),
          'pending',
          true,
          ${metadata.actorId}
        )
      `;
      await transaction`
        insert into tenant_staff (
          id,
          tenant_id,
          username,
          email,
          phone,
          password_hash,
          created_by
        ) values (
          ${ownerId},
          ${tenantId},
          ${input.owner.username},
          ${input.owner.email ?? null},
          ${input.owner.phone ?? null},
          ${passwordHash},
          ${metadata.actorId}
        )
      `;
      await transaction`
        insert into roles (
          id,
          scope_type,
          tenant_id,
          name,
          is_system,
          created_by
        ) values (
          ${roleId},
          'tenant',
          ${tenantId},
          'tenant_owner',
          true,
          ${metadata.actorId}
        )
      `;

      for (const permissionCode of tenantOwnerPermissions) {
        const granted = await transaction<{ id: string }[]>`
          insert into role_permissions (
            role_id,
            permission_id,
            scope_type,
            tenant_id,
            data_scope,
            created_by
          )
          select
            ${roleId},
            permission.id,
            'tenant',
            ${tenantId},
            'all',
            ${metadata.actorId}
          from permissions as permission
          where permission.code = ${permissionCode}
          returning permission_id as id
        `;
        if (!granted[0]) {
          throw new Error(`Required permission is not seeded: ${permissionCode}`);
        }
      }
      await transaction`
        insert into subject_roles (
          id,
          scope_type,
          tenant_id,
          subject_type,
          subject_id,
          role_id,
          created_by
        ) values (
          ${uuidV7()},
          'tenant',
          ${tenantId},
          'tenant_staff',
          ${ownerId},
          ${roleId},
          ${metadata.actorId}
        )
      `;
      await this.insertAudit(transaction, {
        action: 'platform.merchant.create',
        after: {
          code: input.code,
          expiresAt: input.expiresAt.toISOString(),
          name: input.name,
          primaryDomain,
        },
        metadata,
        tenantId,
      });

      return {
        code: input.code,
        createdAt: new Date().toISOString(),
        defaultCurrency: input.defaultCurrency,
        defaultLocale: input.defaultLocale,
        expiresAt: input.expiresAt.toISOString(),
        id: tenantId,
        name: input.name,
        primaryDomain,
        status: 'active',
        timezone: input.timezone,
        version: 0,
      };
    });
  }

  async list(page: number, pageSize: number): Promise<{
    items: MerchantRecord[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const safePage = Number.isInteger(page) && page > 0
      ? Math.min(page, 10_000)
      : 1;
    const safePageSize = Number.isInteger(pageSize)
      ? Math.min(Math.max(pageSize, 1), 100)
      : 20;
    return this.database.inPlatformContext(async (transaction) => {
      const [rows, totals] = await Promise.all([
        transaction<MerchantRow[]>`
          select
            tenant.id,
            tenant.code::text,
            tenant.name,
            case
              when tenant.status = 'active'
                and tenant.expires_at <= statement_timestamp() then 'expired'
              else tenant.status
            end as status,
            tenant.expires_at,
            tenant.default_locale,
            tenant.timezone,
            tenant.default_currency,
            tenant.version,
            tenant.created_at,
            coalesce(domain.host::text, '') as primary_domain
          from tenants as tenant
          left join tenant_domains as domain
            on domain.tenant_id = tenant.id and domain.is_primary
          order by tenant.created_at desc, tenant.id desc
          limit ${safePageSize}
          offset ${(safePage - 1) * safePageSize}
        `,
        transaction<{ total: string }[]>`select count(*)::text as total from tenants`,
      ]);
      return {
        items: rows.map(mapMerchantRow),
        page: safePage,
        pageSize: safePageSize,
        total: Number(totals[0]?.total ?? 0),
      };
    });
  }

  async update(
    tenantId: string,
    rawInput: UpdateMerchantInput,
    metadata: MerchantMutationMetadata,
  ): Promise<MerchantRecord> {
    if (!UUID_PATTERN.test(tenantId)) {
      throw new NotFoundException('Merchant was not found');
    }
    const input = validateUpdateInput(rawInput);
    return this.database.inPlatformContext(async (transaction) => {
      const currentRows = await transaction<MerchantRow[]>`
        select
          tenant.id,
          tenant.code::text,
          tenant.name,
          tenant.status,
          tenant.expires_at,
          tenant.default_locale,
          tenant.timezone,
          tenant.default_currency,
          tenant.version,
          tenant.created_at,
          coalesce(domain.host::text, '') as primary_domain
        from tenants as tenant
        left join tenant_domains as domain
          on domain.tenant_id = tenant.id and domain.is_primary
        where tenant.id = ${tenantId}
        for update of tenant
      `;
      const current = currentRows[0];
      if (!current) {
        throw new NotFoundException('Merchant was not found');
      }
      if (current.version !== input.version) {
        throw new ConflictException('Merchant was changed by another operator');
      }

      const nextName = input.name ?? current.name;
      const nextStatus = input.status ?? current.status;
      const nextExpiresAt = input.expiresAt ?? current.expires_at;
      await transaction`
        update tenants
        set
          name = ${nextName},
          status = ${nextStatus},
          expires_at = ${nextExpiresAt},
          version = version + 1,
          updated_by = ${metadata.actorId}
        where id = ${tenantId} and version = ${input.version}
      `;
      if (nextStatus !== current.status) {
        await transaction`
          insert into tenant_status_history (
            id,
            tenant_id,
            from_status,
            to_status,
            reason,
            operator_id
          ) values (
            ${uuidV7()},
            ${tenantId},
            ${current.status},
            ${nextStatus},
            ${input.reason},
            ${metadata.actorId}
          )
        `;
      }
      await this.insertAudit(transaction, {
        action: 'platform.merchant.update',
        after: {
          expiresAt: nextExpiresAt.toISOString(),
          name: nextName,
          status: nextStatus,
        },
        before: {
          expiresAt: current.expires_at.toISOString(),
          name: current.name,
          status: current.status,
        },
        metadata,
        tenantId,
      });

      return mapMerchantRow({
        ...current,
        expires_at: nextExpiresAt,
        name: nextName,
        status:
          nextStatus === 'active' && nextExpiresAt <= new Date()
            ? 'expired'
            : nextStatus,
        version: current.version + 1,
      });
    });
  }

  private async insertAudit(
    transaction: DatabaseTransaction,
    input: {
      action: string;
      after: Record<string, string>;
      before?: Record<string, string>;
      metadata: MerchantMutationMetadata;
      tenantId: string;
    },
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id,
        scope_type,
        actor_type,
        actor_id,
        action,
        resource_type,
        resource_id,
        before_json,
        after_json,
        ip,
        request_id
      ) values (
        ${uuidV7()},
        'platform',
        'platform_staff',
        ${input.metadata.actorId},
        ${input.action},
        'tenant',
        ${input.tenantId},
        ${input.before ? transaction.json(input.before) : null},
        ${transaction.json(input.after)},
        ${input.metadata.ip ?? null},
        ${input.metadata.requestId}
      )
    `;
  }
}

function validateCreateInput(raw: CreateMerchantInput): Omit<CreateMerchantInput, 'expiresAt'> & {
  expiresAt: Date;
} {
  if (!raw || typeof raw !== 'object' || !raw.owner || typeof raw.owner !== 'object') {
    throw new BadRequestException('Merchant input is required');
  }
  if (
    typeof raw.code !== 'string' ||
    typeof raw.name !== 'string' ||
    typeof raw.defaultCurrency !== 'string' ||
    typeof raw.defaultLocale !== 'string' ||
    typeof raw.timezone !== 'string' ||
    typeof raw.expiresAt !== 'string' ||
    typeof raw.owner.username !== 'string' ||
    typeof raw.owner.password !== 'string' ||
    (raw.owner.email !== undefined && typeof raw.owner.email !== 'string') ||
    (raw.owner.phone !== undefined && typeof raw.owner.phone !== 'string')
  ) {
    throw new BadRequestException('Merchant input types are invalid');
  }
  const code = raw.code.trim().toLowerCase();
  const name = raw.name.trim();
  const defaultCurrency = raw.defaultCurrency.trim().toUpperCase();
  const ownerUsername = raw.owner.username.trim().toLowerCase();
  const ownerEmail = raw.owner.email?.trim().toLowerCase() || undefined;
  const ownerPhone = raw.owner.phone?.trim() || undefined;
  const expiresAt = new Date(raw.expiresAt);
  if (!CODE_PATTERN.test(code)) {
    throw new BadRequestException('Merchant code format is invalid');
  }
  if (!name || name.length > 200) {
    throw new BadRequestException('Merchant name must contain 1 to 200 characters');
  }
  if (!SUPPORTED_LOCALES.has(raw.defaultLocale)) {
    throw new BadRequestException('Default locale is not supported');
  }
  if (!/^[A-Z]{3}$/.test(defaultCurrency)) {
    throw new BadRequestException('Default currency must be an ISO 4217 code');
  }
  assertTimezone(raw.timezone);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt <= new Date()) {
    throw new BadRequestException('Merchant expiry must be in the future');
  }
  if (!USERNAME_PATTERN.test(ownerUsername)) {
    throw new BadRequestException('Owner username format is invalid');
  }
  const passwordBytes = Buffer.byteLength(raw.owner.password, 'utf8');
  if (passwordBytes < 12 || passwordBytes > 4_096) {
    throw new BadRequestException('Owner password must contain 12 to 4096 UTF-8 bytes');
  }
  if (ownerEmail && !EMAIL_PATTERN.test(ownerEmail)) {
    throw new BadRequestException('Owner email format is invalid');
  }
  if (ownerPhone && !PHONE_PATTERN.test(ownerPhone)) {
    throw new BadRequestException('Owner phone must use E.164 format');
  }

  return {
    code,
    defaultCurrency,
    defaultLocale: raw.defaultLocale,
    expiresAt,
    name,
    owner: {
      email: ownerEmail,
      password: raw.owner.password,
      phone: ownerPhone,
      username: ownerUsername,
    },
    timezone: raw.timezone,
  };
}

function validateUpdateInput(raw: UpdateMerchantInput): {
  expiresAt?: Date;
  name?: string;
  reason: string;
  status?: 'active' | 'suspended';
  version: number;
} {
  if (
    !raw ||
    typeof raw !== 'object' ||
    !Number.isInteger(raw.version) ||
    raw.version < 0 ||
    typeof raw.reason !== 'string' ||
    (raw.name !== undefined && typeof raw.name !== 'string') ||
    (raw.expiresAt !== undefined && typeof raw.expiresAt !== 'string') ||
    (raw.status !== undefined && typeof raw.status !== 'string')
  ) {
    throw new BadRequestException('A valid merchant version is required');
  }
  const reason = raw.reason.trim();
  if (!reason || reason.length > 2_000) {
    throw new BadRequestException('Change reason must contain 1 to 2000 characters');
  }
  const name = raw.name?.trim();
  if (raw.name !== undefined && (!name || name.length > 200)) {
    throw new BadRequestException('Merchant name must contain 1 to 200 characters');
  }
  if (raw.status !== undefined && raw.status !== 'active' && raw.status !== 'suspended') {
    throw new BadRequestException('Merchant status is invalid');
  }
  const expiresAt = raw.expiresAt === undefined ? undefined : new Date(raw.expiresAt);
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) {
    throw new BadRequestException('Merchant expiry is invalid');
  }
  if (name === undefined && raw.status === undefined && expiresAt === undefined) {
    throw new BadRequestException('At least one merchant field must change');
  }
  return { expiresAt, name, reason, status: raw.status, version: raw.version };
}

function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
  } catch {
    throw new BadRequestException('Timezone is invalid');
  }
}

function tenantBaseDomain(): string {
  const value = process.env.PLATFORM_TENANT_BASE_DOMAIN?.trim().toLowerCase();
  if (value) {
    if (
      value.length > 220 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(
        value,
      )
    ) {
      throw new Error('PLATFORM_TENANT_BASE_DOMAIN is invalid');
    }
    return value;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PLATFORM_TENANT_BASE_DOMAIN is required in production');
  }
  return 'tenant.localhost';
}

function mapMerchantRow(row: MerchantRow): MerchantRecord {
  return {
    code: row.code,
    createdAt: row.created_at.toISOString(),
    defaultCurrency: row.default_currency,
    defaultLocale: row.default_locale,
    expiresAt: row.expires_at.toISOString(),
    id: row.id,
    name: row.name,
    primaryDomain: row.primary_domain,
    status: row.status,
    timezone: row.timezone,
    version: row.version,
  };
}
