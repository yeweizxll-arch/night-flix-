import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';

import { uuidV7 } from '../common/uuid-v7';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';

interface ErasureTargetRow {
  account_id: string;
  attempt_count: number;
  email: string | null;
  id: string;
  max_attempts: number;
  locked_at: Date | null;
  locked_by: string | null;
  lock_is_stale: boolean;
  phone: string | null;
  retention_summary_json: Array<{
    category: string;
    reason: string;
    retainedUntil: string;
  }>;
  status: 'submitted' | 'processing' | 'completed' | 'failed';
  tenant_id: string;
}

@Injectable()
export class PrivacyErasureWorkerService {
  private readonly logger = new Logger(PrivacyErasureWorkerService.name);
  private readonly otpHmacKey: Buffer;

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {
    const raw = process.env.CUSTOMER_OTP_HMAC_SECRET;
    this.otpHmacKey = Buffer.from(
      raw && raw.length >= 32
        ? raw
        : 'non-production-erasure-placeholder-key-32-bytes',
      'utf8',
    );
  }

  async processDue(limit = 10, workerId = 'privacy-erasure-worker') {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new TypeError('limit must be between 1 and 100');
    }
    const due = await this.database.inPlatformContext(
      (transaction) => transaction<Array<{ id: string }>>`
        select id from customer_privacy_requests
        where request_type = 'account_erasure'
          and (
            (status = 'submitted' and available_at <= transaction_timestamp())
            or (
              status = 'processing'
              and locked_at < transaction_timestamp() - interval '5 minutes'
            )
          )
        order by available_at, submitted_at, id
        limit ${limit}
      `,
    );
    let completed = 0;
    let failed = 0;
    for (const request of due) {
      try {
        const result = await this.processRequest(request.id, workerId);
        if (result.status === 'completed') completed += 1;
      } catch {
        failed += 1;
        this.logger.warn(`Privacy erasure request ${request.id} failed and was rescheduled`);
      }
    }
    return { completed, failed, inspected: due.length };
  }

  async processRequest(requestId: string, workerId = 'privacy-erasure-worker') {
    const claimed = await this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<ErasureTargetRow[]>`
        select request.id, request.tenant_id, request.account_id, request.status,
          request.attempt_count, request.max_attempts, request.retention_summary_json,
          request.locked_at, request.locked_by,
          (request.locked_at is null
            or request.locked_at < transaction_timestamp() - interval '5 minutes')
            as lock_is_stale,
          account.email::text, account.phone
        from customer_privacy_requests as request
        inner join customer_accounts as account
          on account.tenant_id = request.tenant_id and account.id = request.account_id
        where request.id = ${requestId} and request.request_type = 'account_erasure'
        for update of request, account
      `;
      const row = rows[0];
      if (!row) throw new Error('Privacy erasure request was not found');
      if (row.status === 'completed' || row.status === 'failed') {
        return { acquired: false, target: row };
      }
      if (row.status === 'processing'
        && row.locked_at !== null
        && !row.lock_is_stale) {
        return { acquired: false, target: row };
      }
      const updated = await transaction<ErasureTargetRow[]>`
        update customer_privacy_requests
        set status = 'processing',
          processing_at = coalesce(processing_at, transaction_timestamp()),
          locked_at = transaction_timestamp(), locked_by = ${safeWorkerId(workerId)},
          attempt_count = attempt_count + 1, version = version + 1
        where id = ${requestId} and status in ('submitted', 'processing')
        returning id, tenant_id, account_id, status, attempt_count, max_attempts,
          retention_summary_json, locked_at, locked_by,
          false as lock_is_stale, null::text as email, null::text as phone
      `;
      const target = updated[0];
      if (!target) return { acquired: false, target: row };
      return {
        acquired: true,
        target: { ...row, ...target, email: row.email, phone: row.phone },
      };
    });
    if (!claimed.acquired) {
      return {
        dataErasurePerformed: claimed.target.status === 'completed',
        status: claimed.target.status,
      };
    }
    try {
      return await this.performLocalErasure(claimed.target, workerId);
    } catch (error) {
      await this.recordFailure(claimed.target);
      throw error;
    }
  }

  private performLocalErasure(target: ErasureTargetRow, workerId: string) {
    const destinationHashes = [
      target.email ? this.destinationHash('email', target.email) : null,
      target.phone ? this.destinationHash('phone', target.phone) : null,
    ].filter((value): value is string => value !== null);
    return this.database.inPlatformContext(async (transaction) => {
      await transaction`
        select set_config('app.customer_erasure_request_id', ${target.id}, true)
      `;
      const requests = await transaction<ErasureTargetRow[]>`
        select request.id, request.tenant_id, request.account_id, request.status,
          request.attempt_count, request.max_attempts, request.retention_summary_json,
          request.locked_at, request.locked_by,
          false as lock_is_stale,
          account.email::text, account.phone
        from customer_privacy_requests as request
        inner join customer_accounts as account
          on account.tenant_id = request.tenant_id and account.id = request.account_id
        where request.id = ${target.id} and request.status = 'processing'
          and request.locked_by = ${safeWorkerId(workerId)}
        for update of request, account
      `;
      const request = requests[0];
      if (!request) throw new Error('Privacy erasure request claim was lost');

      const counts = await retainedFactCounts(
        transaction, request.tenant_id, request.account_id,
      );
      await deleteNotifications(transaction, request.tenant_id, request.account_id);
      await deleteOtpSecrets(
        transaction, request.tenant_id, request.account_id, destinationHashes,
      );
      await transaction`
        delete from customer_refresh_token_history
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
      `;
      await transaction`
        delete from customer_sessions
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
      `;
      await transaction`
        delete from customer_devices
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
      `;
      await transaction`
        delete from watch_progress
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
      `;
      await transaction`
        delete from customer_favorites
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
      `;
      await transaction`
        delete from customer_feedback
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
      `;
      await transaction`
        delete from customer_drama_follows
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
      `;
      await transaction`
        update interaction_comments set body = '[content erased]',
          sensitive_match_ids = '{}'::uuid[], version = version + 1
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
          and (body <> '[content erased]' or sensitive_match_ids <> '{}'::uuid[])
      `;
      await transaction`
        update interaction_bullet_comments set body = '[content erased]',
          sensitive_match_ids = '{}'::uuid[], version = version + 1
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
          and (body <> '[content erased]' or sensitive_match_ids <> '{}'::uuid[])
      `;
      await transaction`
        update interaction_reports set details = null, version = version + 1
        where tenant_id = ${request.tenant_id}
          and reporter_account_id = ${request.account_id} and details is not null
      `;
      await transaction`
        update entitlements set revoked_at = coalesce(
            revoked_at, greatest(transaction_timestamp(), starts_at)
          ),
          revoked_reason = coalesce(revoked_reason, 'account_erased')
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
          and revoked_at is null
      `;
      await transaction`
        update orders
        set customer_snapshot_json = jsonb_build_object(
          'erased', true, 'subjectId', account_id
        )
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
          and customer_snapshot_json <> jsonb_build_object(
            'erased', true, 'subjectId', account_id
          )
      `;
      await transaction`
        update audit_logs
        set before_json = jsonb_build_object('redacted', 'customer_erasure'),
          after_json = jsonb_build_object('redacted', 'customer_erasure'),
          ip = null, user_agent = null
        where tenant_id = ${request.tenant_id}
          and (
            (actor_type = 'user' and actor_id = ${request.account_id})
            or (resource_type = 'customer_account' and resource_id = ${request.account_id})
          )
      `;
      await transaction`
        update command_idempotency
        set response_json = jsonb_build_object('redacted', 'customer_erasure')
        where tenant_id = ${request.tenant_id} and actor_id = ${request.account_id}
          and actor_type in ('customer', 'user') and response_json is not null
      `;
      await transaction`
        update customer_referral_codes
        set code = 'ER' || upper(substr(translate(md5(id::text), '01', '23'), 1, 8))
        where tenant_id = ${request.tenant_id} and account_id = ${request.account_id}
      `;
      await createRetentionItems(transaction, request, counts);
      await transaction`
        update customer_accounts
        set username = 'erased_' || replace(id::text, '-', ''),
          email = null, phone = null, password_hash = null,
          email_verified_at = null, phone_verified_at = null,
          status = 'erased', disable_reason = 'account_erased',
          version = version + 1
        where tenant_id = ${request.tenant_id} and id = ${request.account_id}
          and status = 'erasure_pending'
      `;
      const completed = await transaction<Array<{ completed_at: Date }>>`
        update customer_privacy_requests
        set status = 'completed', completed_at = transaction_timestamp(),
          data_erasure_performed = true, locked_at = null, locked_by = null,
          version = version + 1
        where id = ${request.id} and status = 'processing'
        returning completed_at
      `;
      if (!completed[0]) throw new Error('Privacy erasure request was not completed');
      await transaction`
        insert into audit_logs (
          id, scope_type, tenant_id, actor_type, actor_id, action,
          resource_type, resource_id, after_json, request_id
        ) values (
          ${uuidV7()}, 'tenant', ${request.tenant_id}, 'system', null,
          'customer.privacy.erasure_complete', 'customer_privacy_request',
          ${request.id}, ${transaction.json({
            dataErasurePerformed: true,
            localOnly: true,
            subprocessorFollowUpRequired: true,
          })}, ${`privacy-erasure:${request.id}`}
        )
      `;
      const eventId = uuidV7();
      await transaction`
        insert into outbox_events (
          id, scope_type, tenant_id, event_key, idempotency_key,
          aggregate_type, aggregate_id, event_type, payload_json
        ) values (
          ${eventId}, 'tenant', ${request.tenant_id}, ${`event:${eventId}`},
          ${`privacy-erasure-complete:${request.id}`}, 'customer_privacy_request',
          ${request.id}, 'CustomerLocalErasureCompleted', ${transaction.json({
            accountSubjectId: request.account_id,
            dataErasurePerformed: true,
            requestId: request.id,
            subprocessorFollowUpRequired: true,
            tenantId: request.tenant_id,
          })}
        )
      `;
      return {
        completedAt: completed[0].completed_at.toISOString(),
        dataErasurePerformed: true as const,
        requestId: request.id,
        status: 'completed' as const,
        subprocessorFollowUpRequired: true,
      };
    });
  }

  private recordFailure(target: ErasureTargetRow): Promise<void> {
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{
        attempt_count: number; max_attempts: number; status: string;
      }>>`
        select attempt_count, max_attempts, status
        from customer_privacy_requests where id = ${target.id} for update
      `;
      const row = rows[0];
      if (!row || row.status !== 'processing') return;
      if (row.attempt_count >= row.max_attempts) {
        await transaction`
          update customer_privacy_requests
          set status = 'failed', failed_at = transaction_timestamp(),
            locked_at = null, locked_by = null, failure_code = 'retry_exhausted',
            version = version + 1
          where id = ${target.id} and status = 'processing'
        `;
      } else {
        await transaction`
          update customer_privacy_requests
          set status = 'submitted', processing_at = null,
            available_at = transaction_timestamp() + interval '1 minute',
            locked_at = null, locked_by = null, version = version + 1
          where id = ${target.id} and status = 'processing'
        `;
      }
    });
  }

  private destinationHash(channel: 'email' | 'phone', destination: string): string {
    return createHmac('sha256', this.otpHmacKey)
      .update(`destination\0${channel}\0${destination}`)
      .digest('hex');
  }
}

async function deleteNotifications(
  transaction: DatabaseTransaction,
  tenantId: string,
  accountId: string,
): Promise<void> {
  await transaction`
    delete from notification_deliveries
    where tenant_id = ${tenantId} and account_id = ${accountId}
  `;
  await transaction`
    delete from notification_campaign_recipients
    where tenant_id = ${tenantId} and account_id = ${accountId}
  `;
  await transaction`
    delete from customer_inbox_messages
    where tenant_id = ${tenantId} and account_id = ${accountId}
  `;
  await transaction`
    delete from customer_push_tokens
    where tenant_id = ${tenantId} and account_id = ${accountId}
  `;
  await transaction`
    delete from customer_notification_preferences
    where tenant_id = ${tenantId} and account_id = ${accountId}
  `;
}

async function deleteOtpSecrets(
  transaction: DatabaseTransaction,
  tenantId: string,
  accountId: string,
  destinationHashes: string[],
): Promise<void> {
  await transaction`
    delete from customer_otp_delivery_jobs as job
    using customer_otp_challenges as challenge
    where job.challenge_id = challenge.id and job.tenant_id = challenge.tenant_id
      and challenge.tenant_id = ${tenantId}
      and (
        challenge.account_id = ${accountId}
        or challenge.destination_hash = any(${destinationHashes}::text[])
      )
  `;
  await transaction`
    delete from customer_otp_challenges
    where tenant_id = ${tenantId}
      and (account_id = ${accountId} or destination_hash = any(${destinationHashes}::text[]))
  `;
}

async function retainedFactCounts(
  transaction: DatabaseTransaction,
  tenantId: string,
  accountId: string,
) {
  const rows = await transaction<Array<{
    audit_count: number;
    commission_count: number;
    commerce_count: number;
  }>>`
    select
      (
        (select count(*) from orders where tenant_id = ${tenantId} and account_id = ${accountId})
        + (select count(*) from payment_attempts
            where tenant_id = ${tenantId} and account_id = ${accountId})
        + (select count(*) from point_ledger
            where tenant_id = ${tenantId} and account_id = ${accountId})
      )::integer as commerce_count,
      (
        (select count(*) from referral_commissions
          where tenant_id = ${tenantId}
            and (invitee_account_id = ${accountId} or inviter_account_id = ${accountId}))
        + (select count(*) from referral_commission_ledger as ledger
          inner join referral_commission_accounts as account
            on account.tenant_id = ledger.tenant_id
            and account.id = ledger.commission_account_id
          where account.tenant_id = ${tenantId} and account.account_id = ${accountId})
      )::integer as commission_count,
      (select count(*)::integer from audit_logs
        where tenant_id = ${tenantId}
          and ((actor_type = 'user' and actor_id = ${accountId})
            or (resource_type = 'customer_account' and resource_id = ${accountId})))
        as audit_count
  `;
  return rows[0] ?? { audit_count: 0, commission_count: 0, commerce_count: 0 };
}

async function createRetentionItems(
  transaction: DatabaseTransaction,
  request: ErasureTargetRow,
  counts: { audit_count: number; commission_count: number; commerce_count: number },
): Promise<void> {
  const byCategory = new Map(
    request.retention_summary_json.map((item) => [item.category, item]),
  );
  const items = [
    ['commerce_finance', 'accounting_and_tax', counts.commerce_count],
    ['commission_finance', 'contract_and_dispute', counts.commission_count],
    ['security_audit', 'security_and_fraud', counts.audit_count],
  ] as const;
  for (const [category, reason, recordCount] of items) {
    const retainedUntil = byCategory.get(category)?.retainedUntil;
    if (!retainedUntil) throw new Error(`Retention policy is missing: ${category}`);
    await transaction`
      insert into customer_privacy_retention_items (
        id, tenant_id, account_id, request_id, data_category,
        reason_code, retained_until, record_count
      ) values (
        ${uuidV7()}, ${request.tenant_id}, ${request.account_id}, ${request.id},
        ${category}, ${reason}, ${new Date(retainedUntil)}, ${recordCount}
      ) on conflict (request_id, data_category) do nothing
    `;
  }
}

function safeWorkerId(value: string): string {
  const result = value.trim();
  if (!/^[A-Za-z0-9._:-]{3,200}$/.test(result)) {
    throw new TypeError('workerId is invalid');
  }
  return result;
}
