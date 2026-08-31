import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import { NotificationSecretCipher } from './notification-secret-cipher';
import {
  NOTIFICATION_LOCALES,
  type NotificationLocale,
  type NotificationMutationMetadata,
  type RegisterPushTokenInput,
  type UpdateNotificationPreferencesInput,
} from './notification.types';

@Injectable()
export class CustomerNotificationService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(NotificationSecretCipher)
    private readonly cipher: NotificationSecretCipher,
  ) {}

  async getPreferences(principal: CustomerPrincipal) {
    assertPrincipal(principal);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      const tenant = await requireCustomerSite(transaction, principal);
      const rows = await transaction<Array<{
        marketing_in_app_enabled: boolean;
        marketing_push_enabled: boolean;
        preferred_locale: NotificationLocale;
      }>>`
        select preferred_locale, marketing_in_app_enabled, marketing_push_enabled
        from customer_notification_preferences
        where tenant_id = ${principal.tenantId} and account_id = ${principal.accountId}
      `;
      return mapPreferences(rows[0] ?? {
        marketing_in_app_enabled: true,
        marketing_push_enabled: true,
        preferred_locale: tenant.default_locale,
      });
    });
  }

  async updatePreferences(
    principal: CustomerPrincipal,
    rawInput: UpdateNotificationPreferencesInput,
    metadata: NotificationMutationMetadata,
  ) {
    assertPrincipal(principal);
    const input = preferencesInput(rawInput);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      const tenant = await requireCustomerSite(transaction, principal);
      const existing = await transaction<Array<{
        marketing_in_app_enabled: boolean;
        marketing_push_enabled: boolean;
        preferred_locale: NotificationLocale;
      }>>`
        select preferred_locale, marketing_in_app_enabled, marketing_push_enabled
        from customer_notification_preferences
        where tenant_id = ${principal.tenantId} and account_id = ${principal.accountId}
        for update
      `;
      const before = existing[0] ?? {
        marketing_in_app_enabled: true,
        marketing_push_enabled: true,
        preferred_locale: tenant.default_locale,
      };
      const rows = await transaction<typeof existing>`
        insert into customer_notification_preferences (
          tenant_id, account_id, preferred_locale, marketing_in_app_enabled,
          marketing_push_enabled
        ) values (
          ${principal.tenantId}, ${principal.accountId},
          ${input.preferredLocale ?? before.preferred_locale},
          ${input.marketingInAppEnabled ?? before.marketing_in_app_enabled},
          ${input.marketingPushEnabled ?? before.marketing_push_enabled}
        )
        on conflict (tenant_id, account_id) do update set
          preferred_locale = excluded.preferred_locale,
          marketing_in_app_enabled = excluded.marketing_in_app_enabled,
          marketing_push_enabled = excluded.marketing_push_enabled,
          version = customer_notification_preferences.version + 1
        returning preferred_locale, marketing_in_app_enabled, marketing_push_enabled
      `;
      const response = mapPreferences(requiredRow(rows[0], 'Preferences were not updated'));
      await insertCustomerAudit(transaction, principal, metadata, {
        action: 'notification.preferences.update',
        after: response,
        before: mapPreferences(before),
        resourceId: principal.accountId,
        resourceType: 'notification_preference',
      });
      return response;
    });
  }

  async registerPushToken(
    principal: CustomerPrincipal,
    rawInput: RegisterPushTokenInput,
    metadata: NotificationMutationMetadata,
  ) {
    assertPrincipal(principal);
    const input = pushTokenInput(rawInput);
    const tokenId = uuidV7();
    let encrypted: ReturnType<NotificationSecretCipher['encryptDeviceToken']>;
    try {
      encrypted = this.cipher.encryptDeviceToken(input.token, {
        accountId: principal.accountId,
        deviceId: input.deviceId,
        kind: 'device_token',
        platform: input.platform,
        tenantId: principal.tenantId,
        tokenId,
      });
    } catch (error: unknown) {
      throw new BadRequestException(error instanceof Error ? error.message : 'Push token is invalid');
    }
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await requireCustomerSite(transaction, principal);
      const devices = await transaction<{ id: string }[]>`
        select id from customer_devices
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and id = ${input.deviceId}
          and platform = ${input.platform}
          and status = 'active'
        for share
      `;
      if (!devices[0]) throw new NotFoundException('Active customer device not found');
      const duplicate = await transaction<Array<{
        account_id: string;
        device_id: string;
        id: string;
        platform: 'android' | 'ios';
        status: 'active' | 'revoked';
      }>>`
        select id, account_id, device_id, platform, status
        from customer_push_tokens
        where tenant_id = ${principal.tenantId}
          and token_sha256 = ${encrypted.tokenSha256}
        order by (status = 'active') desc, created_at desc
        limit 1
        for update
      `;
      if (duplicate[0]) {
        if (duplicate[0].status === 'active' && (
          duplicate[0].account_id !== principal.accountId
          || duplicate[0].device_id !== input.deviceId
          || duplicate[0].platform !== input.platform
        )) {
          throw new ConflictException('Push token is already bound to another device');
        }
        if (duplicate[0].status === 'revoked'
          && duplicate[0].account_id === principal.accountId
          && duplicate[0].device_id === input.deviceId
          && duplicate[0].platform === input.platform) {
          await transaction`
            update customer_push_tokens
            set status = 'active', revoked_at = null, revoke_reason = null
            where tenant_id = ${principal.tenantId} and id = ${duplicate[0].id}
          `;
          duplicate[0].status = 'active';
          await insertCustomerAudit(transaction, principal, metadata, {
            action: 'notification.push_token.register',
            after: safeToken(duplicate[0]),
            resourceId: duplicate[0].id,
            resourceType: 'customer_push_token',
          });
        }
        if (duplicate[0].status === 'active') return safeToken(duplicate[0]);
      }
      await transaction`
        update customer_push_tokens
        set status = 'revoked', revoked_at = statement_timestamp(),
          revoke_reason = 'replaced by a newer token'
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and device_id = ${input.deviceId}
          and platform = ${input.platform}
          and status = 'active'
      `;
      const inserted = await transaction<Array<{
        account_id: string;
        device_id: string;
        id: string;
        platform: 'android' | 'ios';
        status: 'active' | 'revoked';
      }>>`
        insert into customer_push_tokens (
          id, tenant_id, account_id, device_id, platform, token_ciphertext,
          token_digest, token_sha256, key_version
        ) values (
          ${tokenId}, ${principal.tenantId}, ${principal.accountId}, ${input.deviceId},
          ${input.platform}, ${encrypted.ciphertext}, ${encrypted.tokenDigest},
          ${encrypted.tokenSha256}, ${encrypted.keyVersion}
        )
        returning id, account_id, device_id, platform, status
      `;
      const response = safeToken(requiredRow(inserted[0], 'Push token was not registered'));
      await insertCustomerAudit(transaction, principal, metadata, {
        action: 'notification.push_token.register',
        after: response,
        resourceId: tokenId,
        resourceType: 'customer_push_token',
      });
      return response;
    }).catch((error: unknown) => {
      if (isPushTokenUniqueConflict(error)) {
        throw new ConflictException('Push token is already bound to another device');
      }
      throw error;
    });
  }

  async unregisterPushToken(
    principal: CustomerPrincipal,
    tokenId: string,
    metadata: NotificationMutationMetadata,
  ) {
    assertPrincipal(principal);
    assertUuid(tokenId, 'tokenId');
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await requireCustomerSite(transaction, principal);
      const rows = await transaction<Array<{
        account_id: string;
        device_id: string;
        id: string;
        platform: 'android' | 'ios';
        status: 'active' | 'revoked';
      }>>`
        select id, account_id, device_id, platform, status
        from customer_push_tokens
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and id = ${tokenId}
        for update
      `;
      const token = rows[0];
      if (!token) throw new NotFoundException('Push token not found');
      if (token.status === 'active') {
        await transaction`
          update customer_push_tokens
          set status = 'revoked', revoked_at = statement_timestamp(),
            revoke_reason = 'unregistered by customer'
          where tenant_id = ${principal.tenantId} and id = ${tokenId}
        `;
        token.status = 'revoked';
        await insertCustomerAudit(transaction, principal, metadata, {
          action: 'notification.push_token.unregister',
          after: safeToken(token),
          resourceId: tokenId,
          resourceType: 'customer_push_token',
        });
      }
      return safeToken(token);
    });
  }

  async listInbox(principal: CustomerPrincipal, pageValue: unknown, pageSizeValue: unknown) {
    assertPrincipal(principal);
    const page = integer(pageValue, 'page', 1, 1, 10_000);
    const pageSize = integer(pageSizeValue, 'pageSize', 20, 1, 50);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await requireCustomerSite(transaction, principal);
      const rows = await transaction<Array<{
        body: string;
        category: 'marketing' | 'transactional';
        created_at: Date | string;
        deep_link: string | null;
        id: string;
        locale: NotificationLocale;
        read_at: Date | string | null;
        status: 'read' | 'unread';
        title: string;
      }>>`
        select id, category, locale, title, body, deep_link, status, read_at, created_at
        from customer_inbox_messages
        where tenant_id = ${principal.tenantId} and account_id = ${principal.accountId}
        order by created_at desc, id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map((row) => ({
          body: row.body,
          category: row.category,
          createdAt: iso(row.created_at),
          deepLink: row.deep_link ?? undefined,
          id: row.id,
          locale: row.locale,
          readAt: row.read_at ? iso(row.read_at) : undefined,
          status: row.status,
          title: row.title,
        })),
        page,
        pageSize,
      };
    });
  }

  async markInboxRead(principal: CustomerPrincipal, messageId: string) {
    assertPrincipal(principal);
    assertUuid(messageId, 'messageId');
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await requireCustomerSite(transaction, principal);
      const rows = await transaction<Array<{ id: string; read_at: Date | string; status: 'read' }>>`
        update customer_inbox_messages
        set status = 'read', read_at = coalesce(read_at, statement_timestamp())
        where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
          and id = ${messageId}
        returning id, status, read_at
      `;
      const row = rows[0];
      if (!row) throw new NotFoundException('Inbox message not found');
      return { id: row.id, readAt: iso(row.read_at), status: row.status };
    });
  }
}

export async function requireCustomerSite(
  transaction: DatabaseTransaction,
  principal: Pick<CustomerPrincipal, 'accountId' | 'tenantId'>,
): Promise<{ default_locale: NotificationLocale }> {
  const rows = await transaction<{ default_locale: NotificationLocale }[]>`
    select tenant.default_locale
    from tenants as tenant
    inner join customer_accounts as account
      on account.tenant_id = tenant.id
      and account.id = ${principal.accountId}
      and account.status = 'active'
    where tenant.id = ${principal.tenantId}
      and tenant.status = 'active'
      and tenant.expires_at > statement_timestamp()
      and tenant.user_site_enabled
      and tenant.platform_site_enabled
    for share of tenant, account
  `;
  if (!rows[0]) throw new ForbiddenException('Customer site is unavailable');
  return rows[0];
}

function preferencesInput(value: UpdateNotificationPreferencesInput) {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  rejectUnknown(value as Record<string, unknown>, [
    'marketingInAppEnabled', 'marketingPushEnabled', 'preferredLocale',
  ]);
  const output: {
    marketingInAppEnabled?: boolean;
    marketingPushEnabled?: boolean;
    preferredLocale?: NotificationLocale;
  } = {};
  if (value.preferredLocale !== undefined) {
    if (
      typeof value.preferredLocale !== 'string'
      || !NOTIFICATION_LOCALES.includes(value.preferredLocale as NotificationLocale)
    ) throw new BadRequestException('preferredLocale is invalid');
    output.preferredLocale = value.preferredLocale as NotificationLocale;
  }
  for (const [inputKey, outputKey] of [
    ['marketingInAppEnabled', 'marketingInAppEnabled'],
    ['marketingPushEnabled', 'marketingPushEnabled'],
  ] as const) {
    const candidate = value[inputKey];
    if (candidate !== undefined && typeof candidate !== 'boolean') {
      throw new BadRequestException(`${inputKey} is invalid`);
    }
    if (candidate !== undefined) output[outputKey] = candidate;
  }
  if (!Object.keys(output).length) throw new BadRequestException('No preference change was supplied');
  return output;
}

function pushTokenInput(value: RegisterPushTokenInput): {
  deviceId: string;
  platform: 'android' | 'ios';
  token: string;
} {
  if (!value || typeof value !== 'object') throw new BadRequestException('Body is required');
  rejectUnknown(value as Record<string, unknown>, ['deviceId', 'platform', 'token']);
  const deviceId = requiredUuid(value.deviceId, 'deviceId');
  if (value.platform !== 'android' && value.platform !== 'ios') {
    throw new BadRequestException('platform is invalid');
  }
  if (typeof value.token !== 'string') throw new BadRequestException('token is invalid');
  return { deviceId, platform: value.platform, token: value.token };
}

function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new BadRequestException('Body contains unsupported fields');
  }
}

function mapPreferences(row: {
  marketing_in_app_enabled: boolean;
  marketing_push_enabled: boolean;
  preferred_locale: NotificationLocale;
}) {
  return {
    marketingInAppEnabled: row.marketing_in_app_enabled,
    marketingPushEnabled: row.marketing_push_enabled,
    preferredLocale: row.preferred_locale,
    transactionalInAppEnabled: true,
    transactionalPushEnabled: true,
  };
}

function safeToken(row: {
  device_id: string;
  id: string;
  platform: 'android' | 'ios';
  status: 'active' | 'revoked';
}) {
  return { deviceId: row.device_id, id: row.id, platform: row.platform, status: row.status };
}

async function insertCustomerAudit(
  transaction: DatabaseTransaction,
  principal: CustomerPrincipal,
  metadata: NotificationMutationMetadata,
  input: {
    action: string;
    after: object;
    before?: object;
    resourceId: string;
    resourceType: string;
  },
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, before_json, after_json, ip, request_id
    ) values (
      ${uuidV7()}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
      ${input.action}, ${input.resourceType}, ${input.resourceId},
      ${input.before ? transaction.json(json(input.before)) : null},
      ${transaction.json(json(input.after))}, ${metadata.ip ?? null}, ${metadata.requestId}
    )
  `;
}

function assertPrincipal(value: CustomerPrincipal): void {
  if (!value || typeof value !== 'object') throw new ForbiddenException('Customer principal is required');
  assertUuid(value.tenantId, 'tenantId');
  assertUuid(value.accountId, 'accountId');
}

function requiredUuid(value: unknown, field: string): string {
  assertUuid(value, field);
  return value;
}

function assertUuid(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) throw new BadRequestException(`${field} must be a UUID`);
}

function integer(
  value: unknown,
  field: string,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && typeof value !== 'string') {
    throw new BadRequestException(`${field} is invalid`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`${field} is invalid`);
  }
  return parsed;
}

function iso(value: Date | string): string {
  return new Date(value).toISOString();
}

function requiredRow<T>(value: T | undefined, message: string): T {
  if (!value) throw new Error(message);
  return value;
}

function json(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

function isPushTokenUniqueConflict(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; constraint_name?: unknown };
  return candidate.code === '23505'
    && typeof candidate.constraint_name === 'string'
    && candidate.constraint_name.startsWith('customer_push_tokens_');
}
