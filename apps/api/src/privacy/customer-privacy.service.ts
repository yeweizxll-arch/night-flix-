import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { CryptoWorkLimiterService } from '../auth/crypto-work-limiter.service';
import { verifyPassword } from '../auth/password';
import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import {
  idempotencyKey,
  integer,
  object,
  rejectUnknown,
  requireUuid,
  text,
} from './legal-document.service';
import type {
  CustomerErasureRequestInput,
  CustomerPrivacyExportInput,
  CustomerPrivacyPrincipal,
  PrivacyRequestMetadata,
} from './privacy.types';

const EXPORT_SECTIONS = [
  'profile',
  'consents',
  'orders',
  'comments',
  'bulletComments',
  'watchProgress',
  'favorites',
  'following',
  'feedback',
  'notifications',
] as const;
type ExportSection = (typeof EXPORT_SECTIONS)[number];

interface CredentialRow {
  password_hash: string | null;
  status: string;
}

interface PrivacyRequestRow {
  account_id: string;
  completed_at: Date | null;
  data_erasure_performed: boolean;
  id: string;
  retention_summary_json: RetentionSummary[];
  status: 'submitted' | 'processing' | 'completed' | 'failed';
  subprocessor_status_json: SubprocessorStatus[];
  submitted_at: Date;
}

export interface RetentionSummary {
  category: string;
  reason: string;
  retainedUntil: string;
}

export interface SubprocessorStatus {
  boundary: string;
  provider: string;
  status: 'operator_follow_up_required';
}

@Injectable()
export class CustomerPrivacyService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(CryptoWorkLimiterService)
    private readonly cryptoWorkLimiter: CryptoWorkLimiterService,
  ) {}

  listConsents(principal: CustomerPrivacyPrincipal) {
    assertPrincipal(principal);
    return this.database.inTenantContext(principal.tenantId, async (transaction) => {
      await requireActiveAccount(transaction, principal);
      const rows = await transaction<Array<{
        consent_source: string;
        consented_at: Date;
        document_id: string;
        document_type: string;
        document_version_no: number;
        id: string;
        locale: string;
        title: string;
      }>>`
        select consent.id, consent.document_id, consent.document_version_no,
          consent.document_type, consent.locale, consent.consent_source,
          consent.consented_at, document.title
        from customer_legal_consents as consent
        inner join tenant_legal_document_versions as document
          on document.tenant_id = consent.tenant_id
          and document.id = consent.document_id
          and document.version_no = consent.document_version_no
        where consent.tenant_id = ${principal.tenantId}
          and consent.account_id = ${principal.accountId}
        order by consent.consented_at desc, consent.id desc
        limit 1000
      `;
      return {
        items: rows.map((row) => ({
          consentSource: row.consent_source,
          consentedAt: row.consented_at.toISOString(),
          documentId: row.document_id,
          documentType: row.document_type,
          id: row.id,
          locale: row.locale,
          title: row.title,
          version: row.document_version_no,
        })),
      };
    });
  }

  async exportData(
    principal: CustomerPrivacyPrincipal,
    rawInput: CustomerPrivacyExportInput,
    metadata: Pick<PrivacyRequestMetadata, 'requestId'>,
  ) {
    assertPrincipal(principal);
    const input = parseExportInput(rawInput);
    const credential = await this.verifyCurrentPassword(
      principal, input.currentPassword, false,
    );
    return this.database.inPlatformContext(async (transaction) => {
      await lockVerifiedCredential(transaction, principal, credential.password_hash);
      const cursor = decodeCursor(input.cursor, input.section, principal);
      const page = await exportSection(
        transaction, principal, input.section, input.pageSize, cursor,
      );
      await safeAudit(transaction, principal, metadata.requestId, {
        action: 'customer.privacy.data_export',
        after: { itemCount: page.items.length, section: input.section },
        resourceId: principal.accountId,
        resourceType: 'customer_account',
      });
      return {
        exportedAt: new Date().toISOString(),
        items: page.items,
        nextCursor: page.nextCursor,
        notice: 'This export excludes passwords, tokens, hashes, encrypted credentials, and internal risk data.',
        section: input.section,
      };
    });
  }

  async requestErasure(
    principal: CustomerPrivacyPrincipal,
    rawInput: CustomerErasureRequestInput,
    metadata: PrivacyRequestMetadata,
  ) {
    assertPrincipal(principal);
    const input = parseErasureInput(rawInput);
    const key = idempotencyKey(metadata.idempotencyKey);
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ acknowledgeRetention: input.acknowledgeRetention }))
      .digest('hex');
    const credential = await this.verifyCurrentPassword(
      principal, input.currentPassword, true,
    );
    return this.database.inPlatformContext(async (transaction) => {
      const existing = await transaction<PrivacyRequestRow[]>`
        select id, account_id, status, submitted_at, completed_at,
          data_erasure_performed, retention_summary_json, subprocessor_status_json
        from customer_privacy_requests
        where tenant_id = ${principal.tenantId} and account_id = ${principal.accountId}
          and request_type = 'account_erasure' and idempotency_key = ${key}
        for update
      `;
      if (existing[0]) {
        const hashes = await transaction<Array<{ request_hash: string }>>`
          select request_hash from customer_privacy_requests where id = ${existing[0].id}
        `;
        if (hashes[0]?.request_hash !== requestHash) {
          throw new ConflictException('Idempotency-Key was reused with a different request');
        }
        return erasureResponse(existing[0]);
      }
      const locked = await transaction<CredentialRow[]>`
        select password_hash, status from customer_accounts
        where tenant_id = ${principal.tenantId} and id = ${principal.accountId}
        for update
      `;
      if (!locked[0]
        || locked[0].status !== 'active'
        || locked[0].password_hash !== credential.password_hash) {
        const active = await transaction<PrivacyRequestRow[]>`
          select id, account_id, status, submitted_at, completed_at,
            data_erasure_performed, retention_summary_json, subprocessor_status_json
          from customer_privacy_requests
          where tenant_id = ${principal.tenantId} and account_id = ${principal.accountId}
            and request_type = 'account_erasure'
            and status in ('submitted', 'processing')
          limit 1
        `;
        if (active[0]) return erasureResponse(active[0]);
        throw new UnauthorizedException('Current password is invalid');
      }
      const settings = await privacySettings(transaction, principal.tenantId);
      const submittedAt = await databaseNow(transaction);
      const retention = buildRetentionSummary(submittedAt, settings);
      const subprocessors = await subprocessorBoundaries(transaction, principal);
      const requestId = uuidV7();
      await transaction`
        insert into customer_privacy_requests (
          id, tenant_id, account_id, request_type, idempotency_key, request_hash,
          password_reverified_at, submitted_at, available_at,
          retention_summary_json, subprocessor_status_json
        ) values (
          ${requestId}, ${principal.tenantId}, ${principal.accountId},
          'account_erasure', ${key}, ${requestHash}, ${submittedAt}, ${submittedAt},
          ${submittedAt}, ${transaction.json(toJsonValue(retention))},
          ${transaction.json(toJsonValue(subprocessors))}
        )
      `;
      await transaction`
        select set_config('app.customer_erasure_request_id', ${requestId}, true)
      `;
      await transaction`
        update customer_accounts
        set status = 'erasure_pending', disabled_at = transaction_timestamp(),
          disabled_by = id, disable_reason = 'account_erasure_requested',
          version = version + 1
        where tenant_id = ${principal.tenantId} and id = ${principal.accountId}
          and status = 'active'
      `;
      await transaction`
        update customer_sessions
        set revoked_at = coalesce(revoked_at, transaction_timestamp()),
          revoked_reason = coalesce(revoked_reason, 'account_erasure_requested')
        where tenant_id = ${principal.tenantId} and account_id = ${principal.accountId}
      `;
      await transaction`
        update customer_devices
        set status = 'revoked', revoked_at = transaction_timestamp(),
          revoke_reason = 'account_erasure_requested'
        where tenant_id = ${principal.tenantId} and account_id = ${principal.accountId}
          and status = 'active'
      `;
      await safeAudit(transaction, principal, metadata.requestId, {
        action: 'customer.privacy.erasure_request',
        after: {
          dataErasurePerformed: false,
          requestId,
          status: 'submitted',
        },
        resourceId: requestId,
        resourceType: 'customer_privacy_request',
      });
      await safeOutbox(transaction, principal, metadata.requestId,
        requestId, 'CustomerErasureRequested', {
          accountId: principal.accountId, requestId, tenantId: principal.tenantId,
        });
      return {
        dataErasurePerformed: false,
        estimatedCompletionBy: addDays(
          submittedAt, settings.erasure_processing_days,
        ).toISOString(),
        message: 'The local erasure request is queued. Third-party processor follow-up is tracked separately.',
        requestId,
        retentionSummary: retention,
        status: 'submitted' as const,
        subprocessorStatus: subprocessors,
        submittedAt: submittedAt.toISOString(),
      };
    });
  }

  listTenantRequests(tenantId: string, rawQuery: Record<string, unknown>) {
    const page = rawQuery.page === undefined
      ? 1 : integer(rawQuery.page, 'page', 1, 10_000);
    const pageSize = rawQuery.pageSize === undefined
      ? 20 : integer(rawQuery.pageSize, 'pageSize', 1, 100);
    const status = rawQuery.status === undefined ? undefined : String(rawQuery.status);
    rejectUnknown(rawQuery, ['page', 'pageSize', 'status']);
    if (status !== undefined
      && !['submitted', 'processing', 'completed', 'failed'].includes(status)) {
      throw new BadRequestException('status is invalid');
    }
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<PrivacyRequestRow[]>`
        select id, account_id, status, submitted_at, completed_at,
          data_erasure_performed, retention_summary_json, subprocessor_status_json
        from customer_privacy_requests
        where tenant_id = ${tenantId}
          and (${status ?? null}::text is null or status = ${status ?? null})
        order by submitted_at desc, id desc
        limit ${pageSize} offset ${(page - 1) * pageSize}
      `;
      return {
        items: rows.map(staffRequest),
        page,
        pageSize,
      };
    });
  }

  tenantRequestDetail(tenantId: string, requestId: string) {
    requireUuid(requestId, 'requestId');
    return this.database.inTenantContext(tenantId, async (transaction) => {
      const rows = await transaction<PrivacyRequestRow[]>`
        select id, account_id, status, submitted_at, completed_at,
          data_erasure_performed, retention_summary_json, subprocessor_status_json
        from customer_privacy_requests
        where tenant_id = ${tenantId} and id = ${requestId}
        limit 1
      `;
      if (!rows[0]) throw new NotFoundException('Privacy request was not found');
      const retention = await transaction<Array<{
        data_category: string;
        reason_code: string;
        record_count: number;
        retained_until: Date;
      }>>`
        select data_category, reason_code, record_count, retained_until
        from customer_privacy_retention_items
        where tenant_id = ${tenantId} and request_id = ${requestId}
        order by data_category
      `;
      return {
        ...staffRequest(rows[0]),
        retainedItems: retention.map((row) => ({
          category: row.data_category,
          reason: row.reason_code,
          recordCount: row.record_count,
          retainedUntil: row.retained_until.toISOString(),
        })),
      };
    });
  }

  private async verifyCurrentPassword(
    principal: CustomerPrivacyPrincipal,
    currentPassword: string,
    allowErasurePending: boolean,
  ): Promise<CredentialRow> {
    const rows = await this.database.inTenantContext(
      principal.tenantId,
      (transaction) => transaction<CredentialRow[]>`
        select password_hash, status from customer_accounts
        where tenant_id = ${principal.tenantId} and id = ${principal.accountId}
        limit 1
      `,
    );
    const credential = rows[0];
    const matches = credential?.password_hash
      ? await this.cryptoWorkLimiter.run(
        () => verifyPassword(currentPassword, credential.password_hash as string),
      )
      : false;
    if (!credential
      || !['active', ...(allowErasurePending ? ['erasure_pending'] : [])]
        .includes(credential.status)
      || !matches) {
      throw new UnauthorizedException('Current password is invalid');
    }
    return credential;
  }
}

function parseExportInput(value: CustomerPrivacyExportInput) {
  const record = object(value);
  rejectUnknown(record, ['currentPassword', 'cursor', 'pageSize', 'section']);
  const section = record.section;
  if (typeof section !== 'string'
    || !EXPORT_SECTIONS.includes(section as ExportSection)) {
    throw new BadRequestException('section is invalid');
  }
  return {
    currentPassword: text(record.currentPassword, 'currentPassword', 8, 256),
    cursor: record.cursor,
    pageSize: record.pageSize === undefined
      ? 50 : integer(record.pageSize, 'pageSize', 1, 100),
    section: section as ExportSection,
  };
}

function parseErasureInput(value: CustomerErasureRequestInput) {
  const record = object(value);
  rejectUnknown(record, ['acknowledgeRetention', 'currentPassword']);
  if (record.acknowledgeRetention !== true) {
    throw new BadRequestException('acknowledgeRetention must be true');
  }
  return {
    acknowledgeRetention: true,
    currentPassword: text(record.currentPassword, 'currentPassword', 8, 256),
  };
}

async function lockVerifiedCredential(
  transaction: DatabaseTransaction,
  principal: CustomerPrivacyPrincipal,
  passwordHash: string | null,
): Promise<void> {
  const rows = await transaction<CredentialRow[]>`
    select password_hash, status from customer_accounts
    where tenant_id = ${principal.tenantId} and id = ${principal.accountId}
    for share
  `;
  if (!rows[0]
    || rows[0].status !== 'active'
    || rows[0].password_hash !== passwordHash) {
    throw new UnauthorizedException('Current password is invalid');
  }
}

async function requireActiveAccount(
  transaction: DatabaseTransaction,
  principal: CustomerPrivacyPrincipal,
): Promise<void> {
  const rows = await transaction<{ id: string }[]>`
    select id from customer_accounts
    where tenant_id = ${principal.tenantId} and id = ${principal.accountId}
      and status = 'active'
  `;
  if (!rows[0]) throw new UnauthorizedException('Customer account is unavailable');
}

interface ExportCursor {
  accountId: string;
  createdAt: string;
  id: string;
  section: ExportSection;
  tenantId: string;
}

function decodeCursor(
  value: unknown,
  section: ExportSection,
  principal: CustomerPrivacyPrincipal,
): ExportCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 1000) {
    throw new BadRequestException('cursor is invalid');
  }
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ExportCursor;
    if (parsed.section !== section || parsed.accountId !== principal.accountId
      || parsed.tenantId !== principal.tenantId || !parsed.id
      || Number.isNaN(new Date(parsed.createdAt).getTime())) {
      throw new Error('mismatch');
    }
    return parsed;
  } catch {
    throw new BadRequestException('cursor is invalid');
  }
}

async function exportSection(
  transaction: DatabaseTransaction,
  principal: CustomerPrivacyPrincipal,
  section: ExportSection,
  pageSize: number,
  cursor?: ExportCursor,
): Promise<{ items: unknown[]; nextCursor?: string }> {
  if (section === 'profile') {
    const rows = await transaction<Array<{
      created_at: Date; email: string | null; email_verified_at: Date | null;
      id: string; phone: string | null; phone_verified_at: Date | null;
      status: string; username: string;
    }>>`
      select id, username::text, email::text, phone, email_verified_at,
        phone_verified_at, status, created_at
      from customer_accounts where tenant_id = ${principal.tenantId}
        and id = ${principal.accountId} limit 1
    `;
    return { items: rows.map((row) => ({
      accountId: row.id,
      createdAt: row.created_at.toISOString(),
      email: row.email,
      emailVerified: row.email_verified_at !== null,
      phone: row.phone,
      phoneVerified: row.phone_verified_at !== null,
      status: row.status,
      username: row.username,
    })) };
  }
  const limit = pageSize + 1;
  const boundaryAt = cursor ? new Date(cursor.createdAt) : null;
  const boundaryId = cursor?.id ?? null;
  let rows: Array<Record<string, unknown> & { created_at: Date; id: string }>;
  if (section === 'consents') {
    rows = await transaction<typeof rows>`
      select consent.id, consent.document_id as "documentId",
        consent.document_version_no as "version", consent.document_type as "documentType",
        consent.locale, consent.consent_source as "consentSource",
        consent.consented_at as created_at
      from customer_legal_consents as consent
      where consent.tenant_id = ${principal.tenantId}
        and consent.account_id = ${principal.accountId}
        and (${boundaryAt}::timestamptz is null
          or (consent.consented_at, consent.id) < (${boundaryAt}, ${boundaryId}::uuid))
      order by consent.consented_at desc, consent.id desc limit ${limit}
    `;
  } else if (section === 'orders') {
    rows = await transaction<typeof rows>`
      select id, order_no as "orderNo", order_type as "orderType", currency,
        total_minor::text as "totalMinor", locale, status, paid_at as "paidAt",
        refunded_at as "refundedAt", created_at
      from orders where tenant_id = ${principal.tenantId}
        and account_id = ${principal.accountId}
        and (${boundaryAt}::timestamptz is null
          or (created_at, id) < (${boundaryAt}, ${boundaryId}::uuid))
      order by created_at desc, id desc limit ${limit}
    `;
  } else if (section === 'comments') {
    rows = await transaction<typeof rows>`
      select id, drama_id as "dramaId", episode_id as "episodeId", body, status,
        created_at from interaction_comments
      where tenant_id = ${principal.tenantId} and account_id = ${principal.accountId}
        and (${boundaryAt}::timestamptz is null
          or (created_at, id) < (${boundaryAt}, ${boundaryId}::uuid))
      order by created_at desc, id desc limit ${limit}
    `;
  } else if (section === 'bulletComments') {
    rows = await transaction<typeof rows>`
      select id, drama_id as "dramaId", episode_id as "episodeId",
        position_ms as "positionMs", body, status, created_at
      from interaction_bullet_comments
      where tenant_id = ${principal.tenantId} and account_id = ${principal.accountId}
        and (${boundaryAt}::timestamptz is null
          or (created_at, id) < (${boundaryAt}, ${boundaryId}::uuid))
      order by created_at desc, id desc limit ${limit}
    `;
  } else if (section === 'watchProgress') {
    rows = await transaction<typeof rows>`
      select id, drama_id as "dramaId", episode_id as "episodeId",
        position_seconds as "positionSeconds", completed, created_at
      from watch_progress where tenant_id = ${principal.tenantId}
        and account_id = ${principal.accountId}
        and (${boundaryAt}::timestamptz is null
          or (created_at, id) < (${boundaryAt}, ${boundaryId}::uuid))
      order by created_at desc, id desc limit ${limit}
    `;
  } else if (section === 'following') {
    rows = await transaction<typeof rows>`
      select drama_id as id, drama_id as "dramaId", created_at
      from customer_drama_follows where tenant_id = ${principal.tenantId}
        and account_id = ${principal.accountId}
        and (${boundaryAt}::timestamptz is null
          or (created_at, drama_id) < (${boundaryAt}, ${boundaryId}::uuid))
      order by created_at desc, drama_id desc limit ${limit}
    `;
  } else if (section === 'feedback') {
    rows = await transaction<typeof rows>`
      select id, locale, body, reply, replied_at as "repliedAt", created_at
      from customer_feedback where tenant_id = ${principal.tenantId}
        and account_id = ${principal.accountId}
        and (${boundaryAt}::timestamptz is null
          or (created_at, id) < (${boundaryAt}, ${boundaryId}::uuid))
      order by created_at desc, id desc limit ${limit}
    `;
  } else if (section === 'favorites') {
    rows = await transaction<typeof rows>`
      select drama_id as id, drama_id as "dramaId", created_at
      from customer_favorites where tenant_id = ${principal.tenantId}
        and account_id = ${principal.accountId}
        and (${boundaryAt}::timestamptz is null
          or (created_at, drama_id) < (${boundaryAt}, ${boundaryId}::uuid))
      order by created_at desc, drama_id desc limit ${limit}
    `;
  } else {
    rows = await transaction<typeof rows>`
      select id, category, source_type as "sourceType", locale, title, body,
        deep_link as "deepLink", status, created_at
      from customer_inbox_messages where tenant_id = ${principal.tenantId}
        and account_id = ${principal.accountId}
        and (${boundaryAt}::timestamptz is null
          or (created_at, id) < (${boundaryAt}, ${boundaryId}::uuid))
      order by created_at desc, id desc limit ${limit}
    `;
  }
  const hasMore = rows.length > pageSize;
  const selected = rows.slice(0, pageSize);
  const last = selected.at(-1);
  return {
    items: selected.map(({ created_at, ...row }) => ({
      ...row, createdAt: created_at.toISOString(),
      ...(row.paidAt instanceof Date ? { paidAt: row.paidAt.toISOString() } : {}),
      ...(row.refundedAt instanceof Date
        ? { refundedAt: row.refundedAt.toISOString() } : {}),
    })),
    ...(hasMore && last ? {
      nextCursor: Buffer.from(JSON.stringify({
        accountId: principal.accountId,
        createdAt: last.created_at.toISOString(),
        id: last.id,
        section,
        tenantId: principal.tenantId,
      } satisfies ExportCursor)).toString('base64url'),
    } : {}),
  };
}

async function privacySettings(transaction: DatabaseTransaction, tenantId: string) {
  await transaction`
    insert into tenant_privacy_settings (tenant_id)
    values (${tenantId}) on conflict (tenant_id) do nothing
  `;
  const rows = await transaction<Array<{
    erasure_processing_days: number;
    financial_retention_days: number;
    security_audit_retention_days: number;
  }>>`
    select financial_retention_days, security_audit_retention_days,
      erasure_processing_days from tenant_privacy_settings where tenant_id = ${tenantId}
  `;
  if (!rows[0]) throw new Error('Privacy settings were not initialized');
  return rows[0];
}

async function databaseNow(transaction: DatabaseTransaction): Promise<Date> {
  const rows = await transaction<Array<{ database_now: Date }>>`
    select transaction_timestamp() as database_now
  `;
  if (!rows[0]) throw new Error('Database clock was unavailable');
  return rows[0].database_now;
}

function buildRetentionSummary(
  now: Date,
  settings: {
    financial_retention_days: number;
    security_audit_retention_days: number;
  },
): RetentionSummary[] {
  return [
    {
      category: 'commerce_finance',
      reason: 'accounting_and_tax',
      retainedUntil: addDays(now, settings.financial_retention_days).toISOString(),
    },
    {
      category: 'commission_finance',
      reason: 'contract_and_dispute',
      retainedUntil: addDays(now, settings.financial_retention_days).toISOString(),
    },
    {
      category: 'security_audit',
      reason: 'security_and_fraud',
      retainedUntil: addDays(now, settings.security_audit_retention_days).toISOString(),
    },
  ];
}

async function subprocessorBoundaries(
  transaction: DatabaseTransaction,
  principal: CustomerPrivacyPrincipal,
): Promise<SubprocessorStatus[]> {
  const rows = await transaction<Array<{
    communications: boolean;
    payments: boolean;
    push: boolean;
  }>>`
    select
      exists (
        select 1 from payment_attempts where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
      ) as payments,
      exists (
        select 1 from notification_deliveries where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId} and channel = 'push'
      ) as push,
      exists (
        select 1 from customer_otp_challenges where tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
      ) as communications
  `;
  const result: SubprocessorStatus[] = [];
  if (rows[0]?.payments) result.push({
    boundary: 'Processor-held payment/transaction records may require separate retention or erasure handling; no card data is stored locally.',
    provider: 'payment_provider',
    status: 'operator_follow_up_required',
  });
  if (rows[0]?.communications) result.push({
    boundary: 'Email/SMS providers may retain delivery metadata under their own configured policy.',
    provider: 'email_sms_provider',
    status: 'operator_follow_up_required',
  });
  if (rows[0]?.push) result.push({
    boundary: 'APNs/FCM delivery metadata is outside local erasure and must be handled under provider policy.',
    provider: 'push_provider',
    status: 'operator_follow_up_required',
  });
  return result;
}

function erasureResponse(row: PrivacyRequestRow) {
  return {
    dataErasurePerformed: row.data_erasure_performed,
    message: row.data_erasure_performed
      ? 'Local erasure is complete. Third-party status remains listed separately.'
      : 'The local erasure request is queued or processing.',
    requestId: row.id,
    retentionSummary: row.retention_summary_json,
    status: row.status,
    subprocessorStatus: row.subprocessor_status_json,
    submittedAt: row.submitted_at.toISOString(),
  };
}

function staffRequest(row: PrivacyRequestRow) {
  return {
    accountSubjectId: row.account_id,
    completedAt: row.completed_at?.toISOString(),
    dataErasurePerformed: row.data_erasure_performed,
    id: row.id,
    retentionSummary: row.retention_summary_json,
    status: row.status,
    submittedAt: row.submitted_at.toISOString(),
    subprocessorStatus: row.subprocessor_status_json,
  };
}

function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * 86_400_000);
}

async function safeAudit(
  transaction: DatabaseTransaction,
  principal: CustomerPrivacyPrincipal,
  requestId: string,
  input: {
    action: string;
    after: object;
    resourceId: string;
    resourceType: string;
  },
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, request_id
    ) values (
      ${uuidV7()}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
      ${input.action}, ${input.resourceType}, ${input.resourceId},
      ${transaction.json(toJsonValue(input.after))}, ${requestId}
    )
  `;
}

async function safeOutbox(
  transaction: DatabaseTransaction,
  principal: CustomerPrivacyPrincipal,
  requestId: string,
  aggregateId: string,
  eventType: string,
  payload: object,
): Promise<void> {
  const id = uuidV7();
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key,
      aggregate_type, aggregate_id, event_type, payload_json
    ) values (
      ${id}, 'tenant', ${principal.tenantId}, ${`event:${id}`},
      ${`${requestId}:${eventType}`}, 'customer_privacy_request', ${aggregateId},
      ${eventType}, ${transaction.json(toJsonValue(payload))}
    )
  `;
}

function assertPrincipal(principal: CustomerPrivacyPrincipal): void {
  requireUuid(principal.tenantId, 'tenantId');
  requireUuid(principal.accountId, 'accountId');
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
