import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';

import { uuidV7 } from '../common/uuid-v7';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import { amountNumber, requireUuid } from './commerce-validation';
import { ReferralService } from '../referrals/referral.service';
import {
  PaymentAdapterDefinitiveError,
  PaymentAdapterRegistry,
  type PaymentProviderContext,
  type RedirectCheckoutAction,
  type VerifiedChargeWebhook,
} from './payment-adapter';
import {
  PaymentSecretCipher,
  type StripeMode,
} from './payment-secret-cipher';
import { RefundService } from './refund.service';
import { settleNativeRefundDebt } from './native-store.service';

interface PaymentRouteRow {
  active_secret_version: number | null;
  adapter_code: string;
  collection_mode: 'platform_collect' | 'tenant_direct';
  config_version: number;
  config_id: string;
  credential_key_version: number | null;
  owner_tenant_id: string | null;
  owner_type: 'platform' | 'tenant';
  provider_account_id: string | null;
  provider_id: string;
  provider_mode: StripeMode | null;
  secret_key_ciphertext: string | null;
  webhook_secret_ciphertext: string | null;
}

interface OrderPaymentRow {
  account_id: string;
  currency: 'CNY' | 'USD' | 'EUR' | 'JPY' | 'KRW';
  expires_at: Date;
  id: string;
  order_no: string;
  status: string;
  total_minor: string | number | bigint;
}

export interface PaymentAttemptResponse {
  amountMinor: number;
  checkoutAction: RedirectCheckoutAction | null;
  collectionMode: 'platform_collect' | 'tenant_direct';
  createdAt: string;
  currency: string;
  externalPaymentId: string;
  id: string;
  orderId: string;
  status: string;
}

interface PaymentCommandRow {
  id: string;
  request_hash: string;
  resource_id: string | null;
  response_json: PaymentAttemptResponse | null;
  status: 'completed' | 'failed' | 'processing';
}

interface PreparedPayment {
  adapterCode: string;
  amountMinor: number;
  attemptId: string;
  collectionMode: 'platform_collect' | 'tenant_direct';
  createdAt: Date;
  expiresAt: Date;
  currency: 'CNY' | 'USD' | 'EUR' | 'JPY' | 'KRW';
  orderId: string;
  orderNo: string;
  providerContext: PaymentProviderContext;
  cancelUrl: string;
  successUrl: string;
}

interface WebhookConfigRow {
  adapter_code: string;
  config_id: string;
  provider_id: string;
  owner_tenant_id: string | null;
  owner_type: 'platform' | 'tenant';
  provider_account_id: string | null;
  provider_mode: StripeMode | null;
  version: number;
}

interface WebhookSecretRow {
  credential_key_version: number;
  secret_key_ciphertext: string;
  secret_version: number;
  webhook_secret_ciphertext: string;
}

interface ExistingWebhookRow {
  attempt_id?: string | null;
  id?: string;
  payload_hash: string;
  status: string;
  tenant_id?: string;
}

interface WebhookAttemptRow {
  account_id: string;
  amount_minor: string | number | bigint;
  collection_mode: 'platform_collect' | 'tenant_direct';
  currency: string;
  attempt_id: string;
  attempt_created_at: Date;
  checkout_reference: string | null;
  order_id: string;
  order_created_at: Date;
  order_expires_at: Date;
  order_status: string;
  order_expired: boolean;
  provider_id: string;
  status: string;
  tenant_id: string;
}

@Injectable()
export class PaymentCoreService {
  private readonly referrals: ReferralService;
  private readonly cipher: PaymentSecretCipher | undefined;
  private readonly refunds: RefundService | undefined;

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(PaymentAdapterRegistry)
    private readonly adapters: PaymentAdapterRegistry,
    @Optional()
    @Inject(ReferralService)
    referrals?: ReferralService,
    @Optional()
    @Inject(PaymentSecretCipher)
    cipher?: PaymentSecretCipher,
    @Optional()
    @Inject(RefundService)
    refunds?: RefundService,
  ) {
    this.referrals = referrals ?? new ReferralService(database);
    this.cipher = cipher;
    this.refunds = refunds;
  }

  async createPayment(
    principal: CustomerPrincipal,
    orderId: string,
    rawInput: unknown,
    idempotencyKeyValue: unknown,
    requestId: string,
    trustedHostValue?: unknown,
  ): Promise<PaymentAttemptResponse> {
    requireUuid(orderId, 'orderId');
    rejectClientPaymentAmounts(rawInput);
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    const preparation = await this.database.inPlatformContext(
      async (transaction) => {
      await lockCustomerCommerceAvailability(transaction, principal);
      const command = await this.beginCommand(
        transaction,
        principal,
        orderId,
        idempotencyKey,
      );
      if (command.cached) return { cached: command.cached };

      if (command.resumeAttemptId) {
        const attempts = await transaction<Array<{
          adapter_code_snapshot: string;
          active_secret_version: number | null;
          amount_minor: string | number | bigint;
          collection_mode: 'platform_collect' | 'tenant_direct';
          created_at: Date;
          expires_at: Date;
          config_id: string;
          config_version: number;
          credential_key_version: number | null;
          currency: PreparedPayment['currency'];
          id: string;
          order_id: string;
          order_no: string;
          owner_tenant_id: string | null;
          owner_type: 'platform' | 'tenant';
          provider_account_id: string | null;
          provider_id: string;
          provider_mode: StripeMode | null;
          secret_key_ciphertext: string | null;
          webhook_secret_ciphertext: string | null;
          status: string;
        }>>`
          select
            attempt.id, attempt.order_id, attempt.adapter_code_snapshot,
            attempt.collection_mode, attempt.currency, attempt.amount_minor,
            attempt.status, attempt.created_at, commerce_order.order_no,
            commerce_order.expires_at, attempt.payment_config_id as config_id,
            attempt.provider_id, attempt.payment_config_version as config_version,
            attempt.payment_secret_version as active_secret_version,
            config.owner_type, config.owner_tenant_id, config.provider_mode,
            config.provider_account_id, secret.credential_key_version,
            secret.secret_key_ciphertext, secret.webhook_secret_ciphertext
          from payment_attempts as attempt
          inner join orders as commerce_order
            on commerce_order.id = attempt.order_id
            and commerce_order.tenant_id = attempt.tenant_id
          inner join payment_configs as config on config.id = attempt.payment_config_id
          left join payment_config_secret_versions as secret
            on secret.payment_config_id = attempt.payment_config_id
            and secret.secret_version = attempt.payment_secret_version
            and secret.status = 'active'
          where attempt.id = ${command.resumeAttemptId}
            and attempt.tenant_id = ${principal.tenantId}
            and attempt.account_id = ${principal.accountId}
          for update of attempt, commerce_order
        `;
        const attempt = attempts[0];
        if (!attempt || attempt.status !== 'initialized') {
          throw new ConflictException('The payment command cannot be resumed');
        }
        const providerContext = this.providerContext({
          ...attempt,
          adapter_code: attempt.adapter_code_snapshot,
        });
        const returnUrls = attempt.adapter_code_snapshot === 'stripe'
          ? await trustedCheckoutReturnUrls(
            transaction, principal.tenantId, trustedHostValue, attempt.order_id,
          )
          : fakeCheckoutReturnUrls(attempt.order_id);
        return {
          payment: {
            adapterCode: attempt.adapter_code_snapshot,
            amountMinor: amountNumber(attempt.amount_minor),
            attemptId: attempt.id,
            collectionMode: attempt.collection_mode,
            createdAt: attempt.created_at,
            expiresAt: attempt.expires_at,
            currency: attempt.currency,
            orderId: attempt.order_id,
            orderNo: attempt.order_no,
            providerContext,
            cancelUrl: returnUrls.cancelUrl,
            successUrl: returnUrls.successUrl,
          } satisfies PreparedPayment,
        };
      }

      const orders = await transaction<OrderPaymentRow[]>`
        select id, account_id, order_no, status, currency, total_minor, expires_at
        from orders
        where id = ${orderId}
          and tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
        for update
      `;
      const order = orders[0];
      if (!order) throw new NotFoundException('Order not found');
      if (order.status !== 'pending_payment') {
        throw new ConflictException('Order is not pending payment');
      }
      const databaseNow = await transaction<{ now: Date }[]>`
        select statement_timestamp() as now
      `;
      if (!databaseNow[0] || order.expires_at <= databaseNow[0].now) {
        await transaction`
          update orders set status = 'expired', version = version + 1
          where id = ${order.id} and status = 'pending_payment'
        `;
        throw new ConflictException('Order has expired');
      }
      const routes = await transaction<PaymentRouteRow[]>`
        select
          routing.collection_mode,
          config.id as config_id,
          config.version as config_version,
          config.owner_type,
          config.owner_tenant_id,
          config.provider_mode,
          config.provider_account_id,
          config.active_secret_version,
          provider.id as provider_id,
          provider.adapter_code,
          secret.credential_key_version,
          secret.secret_key_ciphertext,
          secret.webhook_secret_ciphertext
        from tenant_payment_routing as routing
        inner join payment_configs as config
          on config.id = routing.payment_config_id and config.status = 'active'
        inner join payment_providers as provider
          on provider.id = config.provider_id and provider.status = 'active'
        left join payment_config_secret_versions as secret
          on secret.payment_config_id = config.id
          and secret.secret_version = config.active_secret_version
          and secret.status = 'active'
        where routing.tenant_id = ${principal.tenantId}
        for share of routing, config, provider
      `;
      const route = routes[0];
      if (!route) throw new ConflictException('Payment is not configured');
      const providerContext = this.providerContext(route);
      if (route.adapter_code === 'stripe') {
        const remainingMs = order.expires_at.getTime() - databaseNow[0]!.now.getTime();
        if (remainingMs < 30 * 60_000 || remainingMs > 24 * 60 * 60_000) {
          throw new ConflictException('Order has insufficient time remaining for hosted checkout');
        }
      }
      const returnUrls = route.adapter_code === 'stripe'
        ? await trustedCheckoutReturnUrls(
          transaction, principal.tenantId, trustedHostValue, order.id,
        )
        : fakeCheckoutReturnUrls(order.id);
      const attemptId = uuidV7();
      const orderAmount = amountNumber(order.total_minor);
      const inserted = await transaction<Array<{ created_at: Date }>>`
        insert into payment_attempts (
          id, tenant_id, account_id, order_id, provider_id, payment_config_id,
          adapter_code_snapshot, collection_mode, status, currency, amount_minor,
          idempotency_key, payment_config_version, payment_secret_version
        ) values (
          ${attemptId}, ${principal.tenantId}, ${principal.accountId}, ${order.id},
          ${route.provider_id}, ${route.config_id}, ${route.adapter_code},
          ${route.collection_mode}, 'initialized', ${order.currency}, ${orderAmount},
          ${idempotencyKey}, ${route.config_version}, ${route.active_secret_version}
        )
        returning created_at
      `;
      const createdAt = inserted[0]?.created_at;
      if (!createdAt) throw new Error('Payment attempt was not created');
      await transaction`
        update command_idempotency
        set
          resource_type = 'payment_attempt',
          resource_id = ${attemptId},
          locked_at = statement_timestamp()
        where id = ${command.id} and status = 'processing'
      `;
      return {
        payment: {
          adapterCode: route.adapter_code,
          amountMinor: orderAmount,
          attemptId,
          collectionMode: route.collection_mode,
          createdAt,
          expiresAt: order.expires_at,
          currency: order.currency,
          orderId: order.id,
          orderNo: order.order_no,
          providerContext,
          cancelUrl: returnUrls.cancelUrl,
          successUrl: returnUrls.successUrl,
        } satisfies PreparedPayment,
      };
    });
    if ('cached' in preparation && preparation.cached) {
      const hydrated = await this.getPayment(principal, preparation.cached.id);
      const { succeededAt: _succeededAt, ...response } = hydrated;
      return response as PaymentAttemptResponse;
    }
    if (!('payment' in preparation) || !preparation.payment) {
      throw new Error('Payment preparation did not return an attempt');
    }
    const prepared = preparation.payment;
    let adapterResult;
    try {
      adapterResult = await this.adapters.require(prepared.adapterCode).createPayment({
        amountMinor: prepared.amountMinor,
        attemptId: prepared.attemptId,
        cancelUrl: prepared.cancelUrl,
        config: prepared.providerContext,
        currency: prepared.currency,
        expiresAt: prepared.expiresAt,
        orderId: prepared.orderId,
        orderNo: prepared.orderNo,
        providerIdempotencyKey: prepared.attemptId,
        successUrl: prepared.successUrl,
      });
    } catch (error) {
      if (error instanceof PaymentAdapterDefinitiveError) {
        await this.markInitializationFailed(principal, prepared.attemptId);
      }
      throw error;
    }
    const finalized = await this.database.inPlatformContext(
      async (transaction) => {
        const available = await lockCustomerCommerceAvailability(
          transaction,
          principal,
          false,
        );
        const attempts = await transaction<Array<{
          account_id: string;
          amount_minor: string | number | bigint;
          checkout_reference: string | null;
          collection_mode: PreparedPayment['collectionMode'];
          created_at: Date;
          currency: PreparedPayment['currency'];
          external_payment_id: string | null;
          order_id: string;
          order_expires_at: Date;
          order_status: string;
          config_status: string;
          config_version: number;
          active_secret_version: number | null;
          status: string;
        }>>`
          select
            attempt.account_id, attempt.order_id, attempt.collection_mode,
            attempt.status, attempt.currency, attempt.amount_minor,
            attempt.external_payment_id, attempt.checkout_reference,
            attempt.created_at, commerce_order.status as order_status,
            commerce_order.expires_at as order_expires_at,
            config.status as config_status, config.version as config_version,
            config.active_secret_version
          from payment_attempts as attempt
          inner join orders as commerce_order
            on commerce_order.id = attempt.order_id
            and commerce_order.tenant_id = attempt.tenant_id
          inner join payment_configs as config on config.id = attempt.payment_config_id
          where attempt.id = ${prepared.attemptId}
            and attempt.tenant_id = ${principal.tenantId}
          for update of attempt, commerce_order
        `;
        const attempt = attempts[0];
        if (!attempt || attempt.account_id !== principal.accountId) {
          throw new NotFoundException('Payment attempt not found');
        }
        const databaseNow = await transaction<{ now: Date }[]>`
          select statement_timestamp() as now
        `;
        const unavailable = !available
          || attempt.order_status !== 'pending_payment'
          || !databaseNow[0]
          || attempt.order_expires_at <= databaseNow[0].now
          || attempt.config_status !== 'active'
          || attempt.config_version !== prepared.providerContext.configVersion
          || attempt.active_secret_version !== (prepared.providerContext.secretVersion ?? null);
        if (attempt.status === 'initialized' && unavailable) {
          await transaction`
            update payment_attempts
            set status = 'expired', version = version + 1
            where id = ${prepared.attemptId} and status = 'initialized'
          `;
          if (attempt.order_status === 'pending_payment'
            && databaseNow[0]
            && attempt.order_expires_at <= databaseNow[0].now) {
            await transaction`
              update orders set status = 'expired', version = version + 1
              where id = ${attempt.order_id} and status = 'pending_payment'
            `;
          }
          await transaction`
            update command_idempotency
            set status = 'failed', response_status = 409, locked_at = null
            where resource_type = 'payment_attempt'
              and resource_id = ${prepared.attemptId}
              and status = 'processing'
          `;
          return { error: 'Tenant, customer, or order is no longer available' } as const;
        }
        if (attempt.status !== 'initialized' && attempt.status !== 'pending') {
          return { error: 'Payment attempt is no longer pending' } as const;
        }
        if (attempt.status === 'initialized') {
          await transaction`
            update payment_attempts
            set status = 'pending', external_payment_id = ${adapterResult.externalPaymentId},
              version = version + 1
            where id = ${prepared.attemptId} and status = 'initialized'
          `;
        }
        const response: PaymentAttemptResponse = {
          amountMinor: amountNumber(attempt.amount_minor),
          checkoutAction: adapterResult.checkoutAction ?? null,
          collectionMode: attempt.collection_mode,
          createdAt: attempt.created_at.toISOString(),
          currency: attempt.currency,
          externalPaymentId: attempt.external_payment_id ?? adapterResult.externalPaymentId,
          id: prepared.attemptId,
          orderId: attempt.order_id,
          status: 'pending',
        };
        await transaction`
          update command_idempotency
          set status = 'completed', response_status = 201,
            response_json = ${transaction.json(toJsonValue({ ...response, checkoutAction: null }))},
            locked_at = null
          where resource_type = 'payment_attempt'
            and resource_id = ${prepared.attemptId}
            and status = 'processing'
        `;
        await transaction`
          insert into audit_logs (
            id, scope_type, tenant_id, actor_type, actor_id, action,
            resource_type, resource_id, after_json, request_id
          ) values (
            ${uuidV7()}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
            'commerce.payment.create', 'payment_attempt', ${prepared.attemptId},
            ${transaction.json({
              amountMinor: response.amountMinor,
              collectionMode: response.collectionMode,
              currency: response.currency,
              orderId: response.orderId,
              status: response.status,
            })}, ${requestId}
          )
        `;
        return { response } as const;
      },
    );
    if ('error' in finalized) throw new ConflictException(finalized.error);
    return finalized.response;
  }

  async getPayment(principal: CustomerPrincipal, attemptId: string) {
    requireUuid(attemptId, 'attemptId');
    const prepared = await this.database.inPlatformContext(async (transaction) => {
      await assertCustomerCommerceAvailable(transaction, principal);
      const rows = await transaction<Array<{
        adapter_code_snapshot: string;
        active_secret_version: number | null;
        amount_minor: string | number | bigint;
        collection_mode: 'platform_collect' | 'tenant_direct';
        config_id: string;
        config_status: string;
        config_version: number;
        created_at: Date;
        credential_key_version: number | null;
        currency: string;
        external_payment_id: string | null;
        id: string;
        order_id: string;
        order_expires_at: Date;
        owner_tenant_id: string | null;
        owner_type: 'platform' | 'tenant';
        provider_account_id: string | null;
        provider_id: string;
        provider_mode: StripeMode | null;
        secret_key_ciphertext: string | null;
        status: string;
        succeeded_at: Date | null;
        webhook_secret_ciphertext: string | null;
      }>>`
        select
          attempt.id, attempt.order_id, attempt.collection_mode, attempt.status,
          attempt.currency, attempt.amount_minor, attempt.external_payment_id,
          attempt.created_at, attempt.succeeded_at, attempt.adapter_code_snapshot,
          commerce_order.expires_at as order_expires_at,
          attempt.payment_config_id as config_id, attempt.provider_id,
          attempt.payment_config_version as config_version,
          attempt.payment_secret_version as active_secret_version,
          config.status as config_status, config.owner_type, config.owner_tenant_id,
          config.provider_mode, config.provider_account_id,
          secret.credential_key_version, secret.secret_key_ciphertext,
          secret.webhook_secret_ciphertext
        from payment_attempts as attempt
        inner join orders as commerce_order
          on commerce_order.id = attempt.order_id
          and commerce_order.tenant_id = attempt.tenant_id
        inner join payment_configs as config on config.id = attempt.payment_config_id
        left join payment_config_secret_versions as secret
          on secret.payment_config_id = attempt.payment_config_id
          and secret.secret_version = attempt.payment_secret_version
          and secret.status = 'active'
        where attempt.id = ${attemptId}
          and attempt.tenant_id = ${principal.tenantId}
          and attempt.account_id = ${principal.accountId}
      `;
      const row = rows[0];
      if (!row) throw new NotFoundException('Payment attempt not found');
      return { row, providerContext: this.providerContext({
        ...row,
        adapter_code: row.adapter_code_snapshot,
      }) };
    });
    let checkoutAction: RedirectCheckoutAction | null = null;
    if (
      prepared.row.status === 'pending' && prepared.row.external_payment_id
      && prepared.row.config_status === 'active'
    ) {
      const adapter = this.adapters.require(prepared.row.adapter_code_snapshot);
      checkoutAction = adapter.getCheckoutAction ? await adapter.getCheckoutAction({
          amountMinor: amountNumber(prepared.row.amount_minor),
          attemptId,
          config: prepared.providerContext,
          currency: prepared.row.currency as PreparedPayment['currency'],
          expiresAt: prepared.row.order_expires_at,
          externalPaymentId: prepared.row.external_payment_id,
          orderId: prepared.row.order_id,
        }) : null;
      const unchanged = await this.database.inPlatformContext(async (transaction) => {
        const rows = await transaction<{ valid: boolean }[]>`
          select exists (
            select 1 from payment_configs
            where id = ${prepared.row.config_id} and status = 'active'
              and version = ${prepared.row.config_version}
              and active_secret_version is not distinct from ${prepared.row.active_secret_version}
          ) as valid
        `;
        return Boolean(rows[0]?.valid);
      });
      if (!unchanged) checkoutAction = null;
    }
    return {
        amountMinor: amountNumber(prepared.row.amount_minor),
        checkoutAction,
        collectionMode: prepared.row.collection_mode,
        createdAt: prepared.row.created_at.toISOString(),
        currency: prepared.row.currency,
        externalPaymentId: prepared.row.external_payment_id,
        id: prepared.row.id,
        orderId: prepared.row.order_id,
        status: prepared.row.status,
        succeededAt: prepared.row.succeeded_at?.toISOString(),
      };
  }

  async handleWebhook(
    configId: string,
    rawPayload: Buffer,
    signature: string,
    expectedAdapter?: 'fake' | 'stripe',
  ): Promise<{ duplicate: boolean; status: string }> {
    requireUuid(configId, 'configId');
    const config = await this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<WebhookConfigRow[]>`
        select config.id as config_id, provider.id as provider_id, provider.adapter_code,
          config.owner_type, config.owner_tenant_id, config.provider_mode,
          config.provider_account_id, config.version
        from payment_configs as config
        inner join payment_providers as provider on provider.id = config.provider_id
        where config.id = ${configId}
      `;
      return rows[0];
    });
    if (!config) throw new NotFoundException('Payment webhook config not found');
    if (expectedAdapter && config.adapter_code !== expectedAdapter) {
      throw new NotFoundException('Payment webhook config not found');
    }
    const webhookContexts: PaymentProviderContext[] = [];
    if (config.adapter_code === 'stripe') {
      if (
        !this.cipher?.configured || !config.provider_mode
        || !config.provider_account_id
      ) {
        throw new NotFoundException('Payment webhook config not found');
      }
      const secrets = await this.database.inPlatformContext(async (transaction) =>
        transaction<WebhookSecretRow[]>`
          select secret_version, credential_key_version, secret_key_ciphertext,
            webhook_secret_ciphertext
          from payment_config_secret_versions
          where payment_config_id = ${config.config_id}
            and (status = 'active' or (
              status = 'grace' and verify_webhooks_until > statement_timestamp()
            ))
          order by (status = 'active') desc, secret_version desc
          limit 5
        `);
      for (const secret of secrets) {
        webhookContexts.push({
          configId: config.config_id,
          configVersion: config.version,
          credentials: this.cipher.decryptStripeCredentials({
            secretKeyCiphertext: secret.secret_key_ciphertext,
            webhookSecretCiphertext: secret.webhook_secret_ciphertext,
          }, {
            accountId: config.provider_account_id,
            configId: config.config_id,
            credentialKeyVersion: secret.credential_key_version,
            mode: config.provider_mode,
            ownerType: config.owner_type,
            secretVersion: secret.secret_version,
            tenantId: config.owner_tenant_id,
          }),
          providerId: config.provider_id,
          secretVersion: secret.secret_version,
        });
      }
    }
    const event = this.adapters.require(config.adapter_code).verifyWebhook(
      rawPayload,
      signature,
      webhookContexts,
    );
    const payloadHash = createHash('sha256').update(rawPayload).digest('hex');
    if (event.kind === 'refund') {
      if (!this.refunds) throw new Error('Refund service is unavailable');
      return this.refunds.handleProviderWebhook(config, event, payloadHash);
    }
    return this.database.inPlatformContext(async (transaction) => {
      const existingEvents = await transaction<ExistingWebhookRow[]>`
        select payload_hash, status from payment_webhook_inbox
        where payment_config_id = ${config.config_id}
          and external_event_id = ${event.eventId}
        for update
      `;
      const existingEvent = existingEvents[0];
      if (existingEvent) {
        if (existingEvent.payload_hash !== payloadHash) {
          await this.recordWebhookEventReuse(
            transaction,
            config.config_id,
            existingEvent,
            event.eventId,
            payloadHash,
          );
          return { duplicate: true, status: 'rejected' };
        }
        return { duplicate: true, status: existingEvent.status };
      }
      const attempts = await transaction<WebhookAttemptRow[]>`
        select
          attempt.id as attempt_id,
          attempt.created_at as attempt_created_at,
          attempt.checkout_reference,
          attempt.tenant_id,
          attempt.account_id,
          attempt.order_id,
          attempt.provider_id,
          attempt.collection_mode,
          attempt.status,
          attempt.currency,
          attempt.amount_minor,
          commerce_order.status as order_status,
          commerce_order.created_at as order_created_at,
          commerce_order.expires_at as order_expires_at,
          commerce_order.expires_at <= transaction_timestamp() as order_expired
        from payment_attempts as attempt
        inner join orders as commerce_order
          on commerce_order.id = attempt.order_id
          and commerce_order.tenant_id = attempt.tenant_id
        where attempt.payment_config_id = ${config.config_id}
          and attempt.provider_id = ${config.provider_id}
          and attempt.adapter_code_snapshot = ${config.adapter_code}
          and (
            attempt.external_payment_id = ${event.externalPaymentId}
            or (
              attempt.id = ${event.attemptReference}
              and attempt.status = 'initialized'
            )
          )
        for update of attempt, commerce_order
      `;
      const attempt = attempts[0];
      if (!attempt) throw new NotFoundException('Payment attempt not found');
      const lockedCustomers = await transaction<{ id: string }[]>`
        select id from customer_accounts
        where tenant_id = ${attempt.tenant_id}
          and id = ${attempt.account_id}
        for update
      `;
      if (!lockedCustomers[0]) throw new NotFoundException('Payment customer not found');
      const inboxId = uuidV7();
      const inserted = await transaction<{ id: string }[]>`
        insert into payment_webhook_inbox (
          id, tenant_id, provider_id, payment_config_id, external_event_id,
          event_type, payload_hash, payload_json, signature_verified, attempt_id
        ) values (
          ${inboxId}, ${attempt.tenant_id}, ${config.provider_id}, ${config.config_id},
          ${event.eventId}, ${event.eventType}, ${payloadHash},
          ${transaction.json(toJsonValue(safeWebhookPayload(event)))}, true,
          ${attempt.attempt_id}
        )
        on conflict (payment_config_id, external_event_id) do nothing
        returning id
      `;
      if (!inserted[0]) {
        const racedEvents = await transaction<ExistingWebhookRow[]>`
          select payload_hash, status from payment_webhook_inbox
          where payment_config_id = ${config.config_id}
            and external_event_id = ${event.eventId}
          for update
        `;
        const racedEvent = racedEvents[0];
        if (!racedEvent) throw new ConflictException('Webhook idempotency row is unavailable');
        if (racedEvent.payload_hash !== payloadHash) {
          await this.recordWebhookEventReuse(
            transaction,
            config.config_id,
            racedEvent,
            event.eventId,
            payloadHash,
          );
          return { duplicate: true, status: 'rejected' };
        }
        return { duplicate: true, status: racedEvent.status };
      }
      const attemptId = attempt.attempt_id;
      if (attemptId !== event.attemptReference) {
        await this.insertReconciliationEvent(
          transaction,
          attempt,
          inboxId,
          'Signed attempt reference does not match the external payment',
        );
        await this.rejectInbox(
          transaction,
          inboxId,
          attemptId,
          'Signed attempt reference does not match the external payment',
        );
        return { duplicate: false, status: 'rejected' };
      }
      if (attempt.status === 'succeeded' && attempt.order_status === 'paid') {
        await this.completeInbox(transaction, inboxId, attemptId);
        return { duplicate: true, status: 'processed' };
      }
      if (
        !['initialized', 'pending'].includes(attempt.status)
        || attempt.order_status !== 'pending_payment'
      ) {
        if (event.eventType === 'payment.succeeded') {
          await this.insertReconciliationEvent(
            transaction,
            attempt,
            inboxId,
            'Payment succeeded after its local state became terminal',
          );
        }
        await this.rejectInbox(
          transaction,
          inboxId,
          attemptId,
          'Payment or order is not pending',
        );
        return { duplicate: false, status: 'rejected' };
      }
      if (
        event.amountMinor !== amountNumber(attempt.amount_minor)
        || event.currency !== attempt.currency
      ) {
        await this.failAttempt(transaction, attemptId, 'snapshot_mismatch', 'Webhook amount mismatch');
        await this.rejectInbox(transaction, inboxId, attemptId, 'Webhook amount mismatch');
        return { duplicate: false, status: 'rejected' };
      }
      if (event.eventType === 'payment.expired') {
        if (!attempt.order_expired) {
          await this.rejectInbox(
            transaction, inboxId, attemptId,
            'Provider checkout expired before the fixed local order deadline',
          );
          return { duplicate: false, status: 'rejected' };
        }
        await transaction`
          update payment_attempts set status = 'expired', version = version + 1
          where id = ${attemptId} and status in ('initialized', 'pending')
        `;
        await transaction`
          update orders set status = 'expired', version = version + 1
          where id = ${attempt.order_id} and status = 'pending_payment'
        `;
        await this.completeInbox(transaction, inboxId, attemptId);
        return { duplicate: false, status: 'processed' };
      }
      if (attempt.order_expired) {
        await transaction`
          update payment_attempts
          set status = 'expired', version = version + 1
          where id = ${attemptId} and status in ('initialized', 'pending')
        `;
        await transaction`
          update orders set status = 'expired', version = version + 1
          where id = ${attempt.order_id} and status = 'pending_payment'
        `;
        await this.rejectInbox(transaction, inboxId, attemptId, 'Order expired before payment');
        return { duplicate: false, status: 'rejected' };
      }
      if (
        event.occurredAt < new Date(attempt.attempt_created_at.getTime() - 5 * 60_000)
        // Stripe event timestamps have whole-second precision while PostgreSQL
        // order timestamps retain sub-second precision.
        || event.occurredAt < new Date(attempt.order_created_at.getTime() - 2_000)
        || event.occurredAt > attempt.order_expires_at
      ) {
        await this.insertReconciliationEvent(
          transaction,
          attempt,
          inboxId,
          'Webhook occurredAt is outside the order payment window',
        );
        await this.rejectInbox(
          transaction,
          inboxId,
          attemptId,
          'Webhook occurredAt is outside the order payment window',
        );
        return { duplicate: false, status: 'rejected' };
      }
      const transactionId = uuidV7();
      const insertedTransactions = await transaction<{ id: string }[]>`
        insert into payment_transactions (
          id, tenant_id, attempt_id, order_id, provider_id,
          transaction_type, status, external_transaction_id,
          currency, amount_minor, payload_hash, occurred_at
        ) values (
          ${transactionId}, ${attempt.tenant_id}, ${attemptId}, ${attempt.order_id},
          ${config.provider_id}, 'charge',
          ${event.eventType === 'payment.succeeded' ? 'succeeded' : 'failed'},
          ${event.externalTransactionId}, ${event.currency}, ${event.amountMinor},
          ${payloadHash}, ${event.occurredAt}
        )
        on conflict (provider_id, external_transaction_id, transaction_type)
        do nothing
        returning id
      `;
      if (!insertedTransactions[0]) {
        await this.insertReconciliationEvent(
          transaction,
          attempt,
          inboxId,
          'Provider transaction ID was reused',
        );
        await this.rejectInbox(
          transaction,
          inboxId,
          attemptId,
          'Provider transaction ID was reused',
        );
        return { duplicate: false, status: 'rejected' };
      }
      if (event.eventType === 'payment.failed') {
        await this.failAttempt(transaction, attemptId, 'provider_failed', 'Provider reported failure');
        await this.completeInbox(transaction, inboxId, attemptId);
        return { duplicate: false, status: 'processed' };
      }
      await transaction`
        update payment_attempts
        set status = 'succeeded', succeeded_at = transaction_timestamp(),
          external_payment_id = coalesce(external_payment_id, ${event.externalPaymentId}),
          version = version + 1
        where id = ${attemptId} and status in ('initialized', 'pending')
      `;
      const paidOrders = await transaction<{ id: string }[]>`
        update orders
        set status = 'paid', paid_at = transaction_timestamp(), version = version + 1
        where id = ${attempt.order_id}
          and status = 'pending_payment'
          and expires_at > transaction_timestamp()
        returning id
      `;
      if (!paidOrders[0]) {
        throw new ConflictException('Order could not be paid inside its fixed transaction window');
      }
      await transaction`
        update command_idempotency
        set status = 'failed', response_status = 409, locked_at = null
        where resource_type = 'payment_attempt'
          and resource_id = ${attemptId}
          and status = 'processing'
      `;
      await this.fulfillOrder(transaction, attempt, attemptId, transactionId);
      await this.referrals.recordPaidOrderCommission(transaction, {
        accountId: attempt.account_id,
        orderId: attempt.order_id,
        paymentTransactionId: transactionId,
        tenantId: attempt.tenant_id,
      });
      await this.completeInbox(transaction, inboxId, attemptId);
      await this.insertPaymentOutboxes(transaction, attempt, inboxId, attemptId);
      return { duplicate: false, status: 'processed' };
    });
  }

  private providerContext(route: {
    active_secret_version: number | null;
    adapter_code: string;
    config_id: string;
    config_version: number;
    credential_key_version: number | null;
    owner_tenant_id: string | null;
    owner_type: 'platform' | 'tenant';
    provider_account_id: string | null;
    provider_id: string;
    provider_mode: StripeMode | null;
    secret_key_ciphertext: string | null;
    webhook_secret_ciphertext: string | null;
  }): PaymentProviderContext {
    const context: PaymentProviderContext = {
      configId: route.config_id,
      configVersion: route.config_version,
      providerId: route.provider_id,
    };
    if (route.adapter_code !== 'stripe') return context;
    if (
      !this.cipher?.configured || !route.active_secret_version
      || !route.credential_key_version || !route.provider_account_id
      || !route.provider_mode || !route.secret_key_ciphertext
      || !route.webhook_secret_ciphertext
    ) {
      throw new ConflictException('Stripe payment configuration is unavailable');
    }
    return {
      ...context,
      credentials: this.cipher.decryptStripeCredentials({
        secretKeyCiphertext: route.secret_key_ciphertext,
        webhookSecretCiphertext: route.webhook_secret_ciphertext,
      }, {
        accountId: route.provider_account_id,
        configId: route.config_id,
        credentialKeyVersion: route.credential_key_version,
        mode: route.provider_mode,
        ownerType: route.owner_type,
        secretVersion: route.active_secret_version,
        tenantId: route.owner_tenant_id,
      }),
      secretVersion: route.active_secret_version,
    };
  }

  private async fulfillOrder(
    transaction: DatabaseTransaction,
    attempt: WebhookAttemptRow,
    attemptId: string,
    transactionId: string,
  ): Promise<void> {
    const items = await transaction<Array<{
      id: string;
      item_type: 'drama' | 'episode' | 'membership' | 'points_topup';
      product_id: string;
      product_snapshot_json: Record<string, unknown>;
    }>>`
      select id, item_type, product_id, product_snapshot_json
      from order_items
      where tenant_id = ${attempt.tenant_id}
        and order_id = ${attempt.order_id}
        and line_no = 1
      for update
    `;
    const item = items[0];
    if (!item) throw new Error('Paid order item is unavailable');
    if (item.item_type === 'points_topup') {
      const points = snapshotSafeInteger(item.product_snapshot_json.pointsAmount, 'pointsAmount');
      const bonus = snapshotSafeInteger(item.product_snapshot_json.bonusPoints ?? 0, 'bonusPoints');
      if (points > 9_000_000_000_000_000 - bonus) throw new Error('Points snapshot overflow');
      const accountId = uuidV7();
      await transaction`
        insert into point_accounts (id, tenant_id, account_id)
        values (${accountId}, ${attempt.tenant_id}, ${attempt.account_id})
        on conflict (tenant_id, account_id) do nothing
      `;
      const accounts = await transaction<{ id: string }[]>`
        select id from point_accounts
        where tenant_id = ${attempt.tenant_id} and account_id = ${attempt.account_id}
        for update
      `;
      const pointAccountId = accounts[0]?.id;
      if (!pointAccountId) throw new Error('Point account is unavailable');
      await transaction`
        insert into point_ledger (
          id, tenant_id, account_id, point_account_id, entry_type, delta,
          balance_after, reference_type, reference_id, idempotency_key,
          metadata_json, created_by_type, created_by
        ) values (
          ${uuidV7()}, ${attempt.tenant_id}, ${attempt.account_id}, ${pointAccountId},
          'topup', ${points + bonus}, 0, 'payment_transaction', ${transactionId},
          ${`payment:${transactionId}:points`},
          ${transaction.json({ bonusPoints: bonus, pointsAmount: points })},
          'system', null
        )
        on conflict (tenant_id, idempotency_key) do nothing
      `;
      await settleNativeRefundDebt(transaction, attempt.tenant_id, attempt.account_id);
    } else {
      const durationDays = item.item_type === 'membership'
        ? snapshotSafeInteger(item.product_snapshot_json.durationDays, 'durationDays', 3650)
        : null;
      await transaction`
        insert into entitlements (
          id, tenant_id, account_id, entitlement_type, product_id,
          source_order_id, source_order_item_id, starts_at, expires_at
        ) values (
          ${uuidV7()}, ${attempt.tenant_id}, ${attempt.account_id}, ${item.item_type},
          ${item.product_id}, ${attempt.order_id}, ${item.id}, statement_timestamp(),
          case when ${durationDays}::integer is null then null
            else statement_timestamp() + (${durationDays} * interval '1 day') end
        )
        on conflict (source_order_item_id) do nothing
      `;
    }
    if (attempt.collection_mode === 'platform_collect') {
      const balanceId = uuidV7();
      await transaction`
        insert into merchant_balance_accounts (id, tenant_id, currency)
        values (${balanceId}, ${attempt.tenant_id}, ${attempt.currency})
        on conflict (tenant_id, currency) do nothing
      `;
      const balances = await transaction<{ id: string }[]>`
        select id from merchant_balance_accounts
        where tenant_id = ${attempt.tenant_id} and currency = ${attempt.currency}
        for update
      `;
      const merchantBalanceId = balances[0]?.id;
      if (!merchantBalanceId) throw new Error('Merchant balance account is unavailable');
      await transaction`
        insert into merchant_balance_ledger (
          id, tenant_id, balance_account_id, bucket, entry_type,
          delta_minor, balance_after_minor, currency, reference_type,
          reference_id, idempotency_key
        ) values (
          ${uuidV7()}, ${attempt.tenant_id}, ${merchantBalanceId}, 'pending',
          'payment_pending', ${amountNumber(attempt.amount_minor)}, 0, ${attempt.currency},
          'payment_transaction', ${transactionId},
          ${`payment:${transactionId}:merchant-pending`}
        )
        on conflict (tenant_id, idempotency_key) do nothing
      `;
      await transaction`
        insert into merchant_settlements (
          id, tenant_id, balance_account_id, payment_transaction_id,
          currency, amount_minor, eligible_at
        ) values (
          ${uuidV7()}, ${attempt.tenant_id}, ${merchantBalanceId}, ${transactionId},
          ${attempt.currency}, ${amountNumber(attempt.amount_minor)},
          transaction_timestamp() + coalesce((
            select delay_days from tenant_settlement_policies
            where tenant_id = ${attempt.tenant_id}
              and currency = ${attempt.currency}
              and status = 'active'
          ), 7) * interval '1 day'
        )
        on conflict (payment_transaction_id) do nothing
      `;
    }
  }

  private async beginCommand(
    transaction: DatabaseTransaction,
    principal: CustomerPrincipal,
    orderId: string,
    idempotencyKey: string,
  ): Promise<{
    cached?: PaymentAttemptResponse;
    id: string;
    resumeAttemptId?: string;
  }> {
    const requestHash = createHash('sha256')
      .update(JSON.stringify({ orderId }))
      .digest('hex');
    const id = uuidV7();
    const inserted = await transaction<{ id: string }[]>`
      insert into command_idempotency (
        id, scope_type, tenant_id, actor_type, actor_id, route_key,
        idempotency_key, request_hash, expires_at
      ) values (
        ${id}, 'tenant', ${principal.tenantId}, 'user', ${principal.accountId},
        'customer.commerce.payment.create', ${idempotencyKey}, ${requestHash},
        statement_timestamp() + interval '24 hours'
      )
      on conflict do nothing
      returning id
    `;
    if (inserted[0]) return { id };
    const rows = await transaction<PaymentCommandRow[]>`
      select id, request_hash, status, response_json, resource_id
      from command_idempotency
      where scope_type = 'tenant'
        and tenant_id = ${principal.tenantId}
        and actor_type = 'user'
        and actor_id = ${principal.accountId}
        and route_key = 'customer.commerce.payment.create'
        and idempotency_key = ${idempotencyKey}
      for update
    `;
    const existing = rows[0];
    if (!existing) throw new ConflictException('Idempotency record is unavailable');
    if (existing.request_hash !== requestHash) {
      throw new ConflictException('Idempotency-Key was used for another payment');
    }
    if (existing.status === 'completed' && existing.response_json) {
      return { cached: existing.response_json, id: existing.id };
    }
    if (existing.status === 'processing' && existing.resource_id) {
      return { id: existing.id, resumeAttemptId: existing.resource_id };
    }
    throw new ConflictException('The same payment is already processing');
  }

  private async markInitializationFailed(
    principal: CustomerPrincipal,
    attemptId: string,
  ): Promise<void> {
    await this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<{ status: string }[]>`
        select status from payment_attempts
        where id = ${attemptId}
          and tenant_id = ${principal.tenantId}
          and account_id = ${principal.accountId}
        for update
      `;
      if (rows[0]?.status !== 'initialized') return;
      await transaction`
        update payment_attempts
        set status = 'failed', failure_code = 'adapter_initialization_failed',
          failure_message = 'Payment adapter initialization failed',
          failed_at = statement_timestamp(), version = version + 1
        where id = ${attemptId} and status = 'initialized'
      `;
      await transaction`
        update command_idempotency
        set status = 'failed', response_status = 503, locked_at = null
        where resource_type = 'payment_attempt'
          and resource_id = ${attemptId}
          and status = 'processing'
      `;
    });
  }

  private async failAttempt(
    transaction: DatabaseTransaction,
    attemptId: string,
    code: string,
    message: string,
  ): Promise<void> {
    await transaction`
      update payment_attempts
      set
        status = 'failed',
        failure_code = ${code},
        failure_message = ${message},
        failed_at = statement_timestamp(),
        version = version + 1
      where id = ${attemptId} and status in ('initialized', 'pending')
    `;
  }

  private async completeInbox(
    transaction: DatabaseTransaction,
    inboxId: string,
    attemptId: string,
  ): Promise<void> {
    await transaction`
      update payment_webhook_inbox
      set status = 'processed', attempt_id = ${attemptId},
        processed_at = statement_timestamp()
      where id = ${inboxId} and status = 'received'
    `;
  }

  private async rejectInbox(
    transaction: DatabaseTransaction,
    inboxId: string,
    attemptId: string,
    message: string,
  ): Promise<void> {
    await transaction`
      update payment_webhook_inbox
      set status = 'rejected', attempt_id = ${attemptId},
        processed_at = statement_timestamp(), error_message = ${message}
      where id = ${inboxId} and status = 'received'
    `;
  }

  private async insertPaymentOutboxes(
    transaction: DatabaseTransaction,
    attempt: WebhookAttemptRow,
    inboxId: string,
    attemptId: string,
  ): Promise<void> {
    await transaction`
      insert into payment_webhook_outbox (
        id, tenant_id, inbox_id, event_type, event_key, payload_json
      ) values (
        ${uuidV7()}, ${attempt.tenant_id}, ${inboxId}, 'PaymentSucceeded',
        ${`payment-webhook:${inboxId}:succeeded`},
        ${transaction.json({ attemptId, orderId: attempt.order_id })}
      ) on conflict (event_key) do nothing
    `;
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, 'tenant', ${attempt.tenant_id}, ${`event:${eventId}`},
        ${`payment:${attemptId}:succeeded`}, 'payment_attempt', ${attemptId},
        'PaymentSucceeded',
        ${transaction.json({
          accountId: attempt.account_id,
          attemptId,
          orderId: attempt.order_id,
          tenantId: attempt.tenant_id,
        })}
      ) on conflict do nothing
    `;
  }

  private async insertReconciliationEvent(
    transaction: DatabaseTransaction,
    attempt: WebhookAttemptRow,
    inboxId: string,
    reason: string,
  ): Promise<void> {
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, request_id
      ) values (
        ${uuidV7()}, 'platform', null, 'system', null,
        'commerce.payment.reconciliation.required', 'payment_attempt',
        ${attempt.attempt_id},
        ${transaction.json({ inboxId, reason, tenantId: attempt.tenant_id })},
        ${uuidV7()}
      )
    `;
    const eventId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${eventId}, 'tenant', ${attempt.tenant_id}, ${`event:${eventId}`},
        ${`payment-reconciliation:${inboxId}`}, 'payment_attempt',
        ${attempt.attempt_id}, 'PaymentReconciliationRequired',
        ${transaction.json({
          attemptId: attempt.attempt_id,
          inboxId,
          orderId: attempt.order_id,
          reason,
        })}
      ) on conflict do nothing
    `;
  }

  private async recordWebhookEventReuse(
    transaction: DatabaseTransaction,
    configId: string,
    existing: ExistingWebhookRow,
    externalEventId: string,
    receivedPayloadHash: string,
  ): Promise<void> {
    const detailRows = await transaction<Array<{
      attempt_id: string | null;
      id: string;
      tenant_id: string;
    }>>`
      select id, tenant_id, attempt_id from payment_webhook_inbox
      where payment_config_id = ${configId}
        and external_event_id = ${externalEventId}
      for update
    `;
    const detail = detailRows[0];
    await transaction`
      insert into audit_logs (
        id, scope_type, tenant_id, actor_type, actor_id, action,
        resource_type, resource_id, after_json, request_id
      ) values (
        ${uuidV7()}, 'platform', null, 'system', null,
        'commerce.payment.webhook.event_reuse', 'payment_config', ${configId},
        ${transaction.json({
          existingPayloadHash: existing.payload_hash,
          externalEventId,
          receivedPayloadHash,
        })}, ${uuidV7()}
      )
    `;
    if (!detail) return;
    const outboxId = uuidV7();
    await transaction`
      insert into outbox_events (
        id, scope_type, tenant_id, event_key, idempotency_key,
        aggregate_type, aggregate_id, event_type, payload_json
      ) values (
        ${outboxId}, 'tenant', ${detail.tenant_id}, ${`event:${outboxId}`},
        ${`payment-webhook-event-reuse:${detail.id}:${receivedPayloadHash}`},
        'payment_webhook', ${detail.id}, 'PaymentWebhookEventReuseDetected',
        ${transaction.json({
          attemptId: detail.attempt_id,
          externalEventId,
          paymentConfigId: configId,
        })}
      ) on conflict do nothing
    `;
  }
}

async function assertCustomerCommerceAvailable(
  transaction: DatabaseTransaction,
  principal: CustomerPrincipal,
): Promise<void> {
  const rows = await transaction<{ available: boolean }[]>`
    select exists (
      select 1
      from tenants as tenant
      inner join customer_accounts as customer on customer.tenant_id = tenant.id
      where tenant.id = ${principal.tenantId}
        and tenant.status = 'active'
        and tenant.expires_at > statement_timestamp()
        and tenant.user_site_enabled
        and tenant.platform_site_enabled
        and customer.id = ${principal.accountId}
        and customer.status = 'active'
    ) as available
  `;
  if (!rows[0]?.available) throw new ConflictException('Tenant or customer is not available');
}

async function trustedCheckoutReturnUrls(
  transaction: DatabaseTransaction,
  tenantId: string,
  trustedHostValue: unknown,
  orderId: string,
): Promise<{ cancelUrl: string; successUrl: string }> {
  const requestedHost = normalizedHost(trustedHostValue);
  const rows = await transaction<{ host: string }[]>`
    select host::text as host from tenant_domains
    where tenant_id = ${tenantId} and verified_at is not null
      and disabled_at is null and tls_status = 'active'
      and (${requestedHost}::text is null or host::text = ${requestedHost})
    order by (host::text = ${requestedHost}) desc, is_primary desc, id
    limit 1
  `;
  let host = rows[0]?.host;
  if (!host && requestedHost) {
    const primary = await transaction<{ host: string }[]>`
      select host::text as host from tenant_domains
      where tenant_id = ${tenantId} and verified_at is not null
        and disabled_at is null and tls_status = 'active' and is_primary
      limit 1
    `;
    host = primary[0]?.host;
  }
  if (!host || !/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host)) {
    throw new ConflictException('A trusted HTTPS tenant domain is required for checkout');
  }
  const origin = `https://${host}`;
  const cancel = new URL('/payment/cancel', origin);
  cancel.searchParams.set('orderId', orderId);
  const success = new URL('/payment/result', origin);
  success.searchParams.set('orderId', orderId);
  success.searchParams.set('session_id', '{CHECKOUT_SESSION_ID}');
  return {
    cancelUrl: cancel.toString(),
    successUrl: success.toString().replace(
      '%7BCHECKOUT_SESSION_ID%7D',
      '{CHECKOUT_SESSION_ID}',
    ),
  };
}

function fakeCheckoutReturnUrls(orderId: string) {
  return {
    cancelUrl: `https://checkout.invalid/cancel?orderId=${orderId}`,
    successUrl: `https://checkout.invalid/result?orderId=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
  };
}

function normalizedHost(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 300) return null;
  const host = value.trim().toLowerCase().replace(/\.$/, '').replace(/:\d+$/, '');
  return /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(host) ? host : null;
}

async function lockCustomerCommerceAvailability(
  transaction: DatabaseTransaction,
  principal: CustomerPrincipal,
  reject = true,
): Promise<boolean> {
  const tenants = await transaction<{
    expires_at: Date;
    status: string;
    user_site_enabled: boolean;
    platform_site_enabled: boolean;
  }[]>`
    select status, expires_at, user_site_enabled, platform_site_enabled
    from tenants
    where id = ${principal.tenantId}
    for share
  `;
  const customers = await transaction<{ status: string }[]>`
    select status
    from customer_accounts
    where tenant_id = ${principal.tenantId}
      and id = ${principal.accountId}
    for share
  `;
  const nowRows = await transaction<{ now: Date }[]>`
    select statement_timestamp() as now
  `;
  const tenant = tenants[0];
  const available = Boolean(
    tenant
    && nowRows[0]
    && tenant.status === 'active'
    && tenant.expires_at > nowRows[0].now
    && tenant.user_site_enabled
    && tenant.platform_site_enabled
    && customers[0]?.status === 'active',
  );
  if (!available && reject) {
    throw new ConflictException('Tenant or customer is not available');
  }
  return available;
}

function rejectClientPaymentAmounts(rawInput: unknown): void {
  if (rawInput === undefined || rawInput === null) return;
  if (typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new BadRequestException('Payment body is invalid');
  }
  if (Object.keys(rawInput).length > 0) {
    throw new BadRequestException('Payment body does not accept client-provided fields');
  }
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.trim())) {
    throw new BadRequestException('A valid Idempotency-Key header is required');
  }
  return value.trim();
}

function safeWebhookPayload(event: VerifiedChargeWebhook) {
  return {
    amountMinor: event.amountMinor,
    attemptReference: event.attemptReference,
    currency: event.currency,
    eventId: event.eventId,
    eventType: event.eventType,
    externalPaymentId: event.externalPaymentId,
    externalTransactionId: event.externalTransactionId,
    occurredAt: event.occurredAt.toISOString(),
  };
}

function snapshotSafeInteger(value: unknown, field: string, maximum = 9_000_000_000_000_000) {
  if (
    typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < 0
    || value > maximum
  ) {
    throw new Error(`Order ${field} snapshot is invalid`);
  }
  return value;
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
