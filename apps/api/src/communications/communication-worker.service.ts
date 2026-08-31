import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import {
  CommunicationAdapterRegistry,
  CommunicationProviderError,
} from './communication-provider.adapter';
import { CommunicationSecretCipher } from './communication-secret-cipher';
import { communicationLocale } from './otp-delivery.service';
import type {
  CommunicationChannel,
  CommunicationProvider,
} from './communication.types';

type SafeError =
  | 'config_changed'
  | 'delivery_expired'
  | 'provider_rejected'
  | 'provider_timeout'
  | 'secret_authentication_failed'
  | 'unexpected_provider_response';

interface ClaimedJob {
  challenge_id: string | null;
  channel: CommunicationChannel;
  config_id: string;
  config_version: number;
  credentials_ciphertext: string;
  expires_at: Date;
  id: string;
  job_type: 'config_test' | 'otp';
  key_version: number;
  locale: string;
  payload_ciphertext: string;
  provider: CommunicationProvider;
  secret_key_version: number;
  site_name: string;
  tenant_id: string;
  purpose: string;
}

@Injectable()
export class CommunicationWorkerService {
  private readonly workerId = `communication-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(CommunicationSecretCipher) private readonly cipher: CommunicationSecretCipher,
    @Inject(CommunicationAdapterRegistry) private readonly adapters: CommunicationAdapterRegistry,
  ) {}

  async processAvailable(limit = 25): Promise<{ claimed: number }> {
    const maximum = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 25;
    let claimed = 0;
    for (; claimed < maximum; claimed += 1) {
      const job = await this.claim();
      if (!job) break;
      await this.process(job);
    }
    return { claimed };
  }

  async recoverStaleLocks(): Promise<number> {
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{
        config_id: string; config_version: number; id: string; job_type: string;
        last_error: SafeError; status: string; tenant_id: string;
      }>>`
        update customer_otp_delivery_jobs set
          attempt_count = attempt_count + 1,
          status = case
            when expires_at <= statement_timestamp() then 'expired'
            when attempt_count + 1 >= max_attempts then 'dead_letter'
            else 'retry'
          end,
          available_at = statement_timestamp(), locked_at = null, locked_by = null,
          payload_ciphertext = case
            when expires_at <= statement_timestamp() or attempt_count + 1 >= max_attempts
              then null else payload_ciphertext end,
          last_error = case
            when expires_at <= statement_timestamp() then 'delivery_expired'
            else 'provider_timeout'
          end
        where status = 'processing'
          and locked_at < statement_timestamp() - interval '2 minutes'
        returning id, tenant_id, config_id, config_version, job_type, status, last_error
      `;
      for (const row of rows) {
        if (row.job_type === 'config_test' && row.status !== 'retry') {
          await transaction`
            update tenant_communication_configs set status = 'disabled',
              last_test_status = 'failed', last_tested_at = statement_timestamp(),
              last_test_error = ${row.last_error}
            where id = ${row.config_id} and tenant_id = ${row.tenant_id}
              and version = ${row.config_version}
          `;
        }
      }
      return rows.length;
    });
  }

  private async claim(): Promise<ClaimedJob | undefined> {
    return this.database.inPlatformContext(async (transaction) => {
      await transaction`
        update customer_otp_delivery_jobs set status = 'expired',
          last_error = 'delivery_expired', payload_ciphertext = null,
          locked_at = null, locked_by = null
        where status in ('pending', 'retry') and expires_at <= statement_timestamp()
      `;
      const rows = await transaction<ClaimedJob[]>`
        with candidate as (
          select job.id from customer_otp_delivery_jobs as job
          inner join tenant_communication_configs as config
            on config.id = job.config_id and config.tenant_id = job.tenant_id
          inner join tenant_communication_secrets as secret
            on secret.config_id = config.id and secret.tenant_id = config.tenant_id
          inner join tenants as tenant on tenant.id = job.tenant_id
          where job.status in ('pending', 'retry')
            and job.available_at <= statement_timestamp()
            and job.expires_at > statement_timestamp()
          order by job.available_at, job.created_at, job.id
          for update skip locked limit 1
        ), claimed as (
          update customer_otp_delivery_jobs as job set status = 'processing',
            locked_at = statement_timestamp(), locked_by = ${this.workerId}, last_error = null
          from candidate where job.id = candidate.id
          returning job.*
        )
        select claimed.id, claimed.tenant_id, claimed.challenge_id, claimed.config_id,
          claimed.config_version, claimed.job_type, claimed.channel, claimed.purpose,
          claimed.payload_ciphertext, claimed.key_version, claimed.expires_at,
          config.provider, secret.credentials_ciphertext,
          secret.key_version as secret_key_version,
          tenant.name as site_name, tenant.default_locale as locale
        from claimed
        inner join tenant_communication_configs as config
          on config.id = claimed.config_id and config.tenant_id = claimed.tenant_id
        inner join tenant_communication_secrets as secret
          on secret.config_id = config.id and secret.tenant_id = config.tenant_id
          and secret.channel = config.channel and secret.provider = config.provider
        inner join tenants as tenant on tenant.id = claimed.tenant_id
      `;
      return rows[0];
    });
  }

  private async process(job: ClaimedJob): Promise<void> {
    let providerPhase = false;
    try {
      if (!await this.stillEligible(job)) {
        await this.fail(job, 'config_changed', false);
        return;
      }
      const credentials = this.cipher.decryptCredentials(job.credentials_ciphertext, {
        channel: job.channel,
        configId: job.config_id,
        keyVersion: job.secret_key_version,
        kind: 'provider',
        provider: job.provider,
        tenantId: job.tenant_id,
      });
      const payload = job.job_type === 'otp'
        ? this.cipher.decryptOtpPayload(job.payload_ciphertext, {
          challengeId: required(job.challenge_id), channel: job.channel,
          jobId: job.id, keyVersion: job.key_version, kind: 'otp',
          purpose: job.purpose, tenantId: job.tenant_id,
        })
        : this.cipher.decryptTestPayload(job.payload_ciphertext, {
          channel: job.channel, configId: job.config_id, jobId: job.id,
          keyVersion: job.key_version, kind: 'config_test', provider: job.provider,
          tenantId: job.tenant_id,
        });
      providerPhase = true;
      const result = await this.adapters.get(job.provider, job.channel).sendOtp({
        ...payload,
        credentials,
        expiresInMinutes: 10,
        jobId: job.id,
        locale: communicationLocale(job.locale),
        siteName: job.site_name,
      });
      await this.succeed(job, result.providerMessageId);
    } catch (error) {
      if (error instanceof CommunicationProviderError) {
        await this.fail(job, error.code, error.retryable);
      } else {
        await this.fail(job, providerPhase
          ? 'unexpected_provider_response' : 'secret_authentication_failed', false);
      }
    }
  }

  private stillEligible(job: ClaimedJob): Promise<boolean> {
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<{ eligible: boolean }[]>`
        select exists (
          select 1 from tenant_communication_configs as config
          inner join tenant_communication_secrets as secret on secret.config_id = config.id
          where config.id = ${job.config_id} and config.tenant_id = ${job.tenant_id}
            and config.channel = ${job.channel} and config.provider = ${job.provider}
            and config.version = ${job.config_version}
            and secret.key_version = ${job.secret_key_version}
            and (${job.job_type} = 'config_test' or config.status = 'active')
        ) and exists (
          select 1 from customer_otp_delivery_jobs
          where id = ${job.id} and status = 'processing' and locked_by = ${this.workerId}
            and expires_at > statement_timestamp()
        ) as eligible
      `;
      return rows[0]?.eligible === true;
    });
  }

  private async succeed(job: ClaimedJob, providerMessageId: string): Promise<void> {
    if (!safeMessageId(providerMessageId)) {
      await this.fail(job, 'unexpected_provider_response', true);
      return;
    }
    await this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<{ id: string }[]>`
        update customer_otp_delivery_jobs set status = 'sent', sent_at = statement_timestamp(),
          provider_message_id = ${providerMessageId}, attempt_count = attempt_count + 1,
          payload_ciphertext = null, locked_at = null, locked_by = null
        where id = ${job.id} and status = 'processing' and locked_by = ${this.workerId}
          and expires_at > statement_timestamp()
        returning id
      `;
      if (job.job_type === 'config_test' && rows[0]) {
        await transaction`
          update tenant_communication_configs set last_test_status = 'passed',
            last_tested_at = statement_timestamp(), last_test_error = null
          where id = ${job.config_id} and tenant_id = ${job.tenant_id}
            and version = ${job.config_version}
        `;
      }
    });
  }

  private async fail(job: ClaimedJob, error: SafeError, retryable: boolean): Promise<void> {
    await this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<{ status: string }[]>`
        update customer_otp_delivery_jobs set
          attempt_count = attempt_count + 1,
          status = case
            when expires_at <= statement_timestamp() then 'expired'
            when ${retryable} and attempt_count + 1 < max_attempts then 'retry'
            else 'dead_letter'
          end,
          available_at = statement_timestamp()
            + least(interval '60 seconds', interval '1 second' * power(2, attempt_count + 1)),
          last_error = case when expires_at <= statement_timestamp()
            then 'delivery_expired' else ${error} end,
          payload_ciphertext = case
            when expires_at <= statement_timestamp()
              or not ${retryable} or attempt_count + 1 >= max_attempts
              then null else payload_ciphertext end,
          locked_at = null, locked_by = null
        where id = ${job.id} and status = 'processing' and locked_by = ${this.workerId}
        returning status
      `;
      if (job.job_type === 'config_test' && rows[0] && rows[0].status !== 'retry') {
        await transaction`
          update tenant_communication_configs set status = 'disabled',
            last_test_status = 'failed', last_tested_at = statement_timestamp(),
            last_test_error = ${error}
          where id = ${job.config_id} and tenant_id = ${job.tenant_id}
            and version = ${job.config_version}
        `;
      }
    });
  }
}

function required<T>(value: T | null): T {
  if (value === null) throw new Error('OTP delivery challenge is unavailable');
  return value;
}
function safeMessageId(value: string): boolean {
  return value.length >= 1 && value.length <= 500 && /^[-A-Za-z0-9._:@/+=]+$/.test(value);
}
