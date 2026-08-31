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
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service';
import {
  PaymentAdapterDefinitiveError,
  PaymentAdapterRegistry,
  type PaymentProviderContext,
  type VerifiedRefundWebhook,
  type AdapterRefundResult,
} from './payment-adapter';
import {
  PaymentSecretCipher,
  type StripeMode,
} from './payment-secret-cipher';
import { amountNumber, requireUuid } from './commerce-validation';

type RefundScope = 'platform' | 'tenant';
type RefundStatus = 'failed' | 'manual_reconciliation' | 'processing' | 'succeeded';

export interface RefundResponse {
  amountMinor: number;
  collectionMode: 'platform_collect' | 'tenant_direct';
  createdAt: string;
  currency: string;
  fullRefund: true;
  id: string;
  manualReconciliation: boolean;
  orderId: string;
  reason: string;
  reconciliationRequired: boolean;
  status: RefundStatus;
}

interface RefundActor {
  actorId: string;
  scope: RefundScope;
  tenantId: string | null;
}

interface RefundCommandRow {
  id: string;
  request_hash: string;
  resource_id: string | null;
  response_json: RefundResponse | null;
  status: 'completed' | 'failed' | 'processing';
}

interface PreparedRefund {
  adapterCode: string;
  amountMinor: number;
  chargeExternalTransactionId: string;
  collectionMode: 'platform_collect' | 'tenant_direct';
  currency: 'CNY' | 'EUR' | 'JPY' | 'KRW' | 'USD';
  externalPaymentId: string;
  orderId: string;
  processingStartedAt: Date;
  providerContext?: PaymentProviderContext;
  refundId: string;
  tenantId: string;
}

interface LockedRefund {
  account_id: string;
  adapter_code_snapshot: string;
  amount_minor: string | number | bigint;
  attempt_id: string;
  collection_mode: 'platform_collect' | 'tenant_direct';
  created_at: Date;
  currency: PreparedRefund['currency'];
  id: string;
  external_payment_id_snapshot: string;
  external_refund_id: string | null;
  order_id: string;
  payment_transaction_id: string;
  processing_at: Date;
  reason: string;
  reconciliation_required: boolean;
  requested_by: string;
  requested_by_type: 'platform_staff' | 'tenant_staff';
  status: string;
  tenant_id: string;
}

@Injectable()
export class RefundService {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(PaymentAdapterRegistry)
    private readonly adapters: PaymentAdapterRegistry,
    @Optional()
    @Inject(PaymentSecretCipher)
    private readonly cipher?: PaymentSecretCipher,
  ) {}

  async handleProviderWebhook(
    config: { adapter_code: string; config_id: string; provider_id: string },
    event: VerifiedRefundWebhook,
    payloadHash: string,
  ): Promise<{ duplicate: boolean; status: string }> {
    if (config.adapter_code !== 'stripe') {
      throw new BadRequestException('Refund webhook provider is invalid');
    }
    const reserved = await this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<LockedRefund & {
        charge_external_transaction_id: string;
      }>>`
        select refund.*, commerce_order.account_id,
          charge.external_transaction_id as charge_external_transaction_id
        from payment_refunds as refund
        inner join orders as commerce_order
          on commerce_order.id = refund.order_id and commerce_order.tenant_id = refund.tenant_id
        inner join payment_transactions as charge
          on charge.id = refund.payment_transaction_id
          and charge.tenant_id = refund.tenant_id
          and charge.attempt_id = refund.attempt_id
          and charge.order_id = refund.order_id
          and charge.transaction_type = 'charge' and charge.status = 'succeeded'
        where refund.id = ${event.refundReference}
          and refund.payment_config_id = ${config.config_id}
          and refund.provider_id = ${config.provider_id}
          and refund.adapter_code_snapshot = 'stripe'
        for update of refund, commerce_order
        for share of charge
      `;
      const refund = rows[0];
      if (!refund) throw new NotFoundException('Refund not found');
      const existing = await transaction<Array<{
        id: string; payload_hash: string; status: string;
      }>>`
        select id, payload_hash, status from payment_webhook_inbox
        where payment_config_id = ${config.config_id}
          and external_event_id = ${event.eventId}
        for update
      `;
      if (existing[0]) {
        if (existing[0].payload_hash !== payloadHash) {
          await transaction`
            insert into audit_logs (
              id, scope_type, tenant_id, actor_type, actor_id, action,
              resource_type, resource_id, after_json, request_id
            ) values (
              ${uuidV7()}, 'platform', null, 'system', null,
              'commerce.payment.webhook.event_reuse', 'payment_config',
              ${config.config_id},
              ${transaction.json({ externalEventId: event.eventId,
                receivedPayloadHash: payloadHash })}, ${uuidV7()}
            )
          `;
          const alertId = uuidV7();
          await transaction`
            insert into outbox_events (
              id, scope_type, tenant_id, event_key, idempotency_key,
              aggregate_type, aggregate_id, event_type, payload_json
            ) values (
              ${alertId}, 'tenant', ${refund.tenant_id}, ${`event:${alertId}`},
              ${`refund-webhook-event-reuse:${existing[0].id}:${payloadHash}`},
              'payment_webhook', ${existing[0].id},
              'PaymentWebhookEventReuseDetected',
              ${transaction.json({
                externalEventId: event.eventId,
                paymentConfigId: config.config_id,
                refundId: refund.id,
              })}
            ) on conflict do nothing
          `;
          return { result: { duplicate: true, status: 'rejected' } } as const;
        }
        if (existing[0].status !== 'received') {
          return {
            result: { duplicate: true, status: existing[0].status },
          } as const;
        }
      }
      if (
        event.amountMinor !== amountNumber(refund.amount_minor)
        || event.currency !== refund.currency
        || event.externalPaymentId !== refund.charge_external_transaction_id
        || (refund.external_refund_id && refund.external_refund_id !== event.externalRefundId)
      ) {
        throw new BadRequestException('Refund webhook does not match the refund snapshot');
      }
      let inboxId = existing[0]?.id;
      if (!inboxId) {
        inboxId = uuidV7();
        await transaction`
          insert into payment_webhook_inbox (
            id, tenant_id, provider_id, payment_config_id, external_event_id,
            event_type, payload_hash, payload_json, signature_verified, attempt_id
          ) values (
            ${inboxId}, ${refund.tenant_id}, ${config.provider_id}, ${config.config_id},
            ${event.eventId}, ${event.eventType}, ${payloadHash},
            ${transaction.json({
              amountMinor: event.amountMinor,
              currency: event.currency,
              eventId: event.eventId,
              eventType: event.eventType,
              externalPaymentId: event.externalPaymentId,
              externalRefundId: event.externalRefundId,
              refundReference: event.refundReference,
            })}, true, ${refund.attempt_id}
          )
        `;
      }
      if (!refund.external_refund_id) {
        const updated = await transaction<LockedRefund[]>`
          update payment_refunds set external_refund_id = ${event.externalRefundId},
            version = version + 1
          where id = ${refund.id} and status = 'processing'
            and external_refund_id is null
          returning *, ${refund.account_id}::uuid as account_id
        `;
        if (updated[0]) Object.assign(refund, updated[0]);
      }
      if (event.eventType === 'refund.pending') {
        await markRefundInboxProcessed(transaction, inboxId, refund.id);
        const response = mapRefund(refund);
        await completeRefundCommand(transaction, refund.id, response);
        return { result: { duplicate: false, status: 'processed' } } as const;
      }
      return {
        actor: {
          actorId: refund.requested_by,
          scope: refund.requested_by_type === 'platform_staff' ? 'platform' : 'tenant',
          tenantId: refund.requested_by_type === 'platform_staff' ? null : refund.tenant_id,
        } satisfies RefundActor,
        inboxId,
        prepared: {
          adapterCode: refund.adapter_code_snapshot,
          amountMinor: amountNumber(refund.amount_minor),
          chargeExternalTransactionId: refund.charge_external_transaction_id,
          collectionMode: refund.collection_mode,
          currency: refund.currency as PreparedRefund['currency'],
          externalPaymentId: refund.external_payment_id_snapshot,
          orderId: refund.order_id,
          processingStartedAt: refund.processing_at,
          refundId: refund.id,
          tenantId: refund.tenant_id,
        } satisfies PreparedRefund,
      } as const;
    });
    if (!reserved) throw new Error('Refund webhook reservation is unavailable');
    if ('result' in reserved && reserved.result) return reserved.result;
    const result: AdapterRefundResult = {
      amountMinor: event.amountMinor,
      currency: event.currency,
      externalRefundId: event.externalRefundId,
      occurredAt: event.occurredAt,
      status: event.eventType === 'refund.succeeded' ? 'succeeded' : 'failed',
    };
    if (result.status === 'succeeded') {
      await this.finalizeSuccess(reserved.actor, reserved.prepared, result, uuidV7());
    } else {
      await this.finalizeDefinitiveFailure(
        reserved.actor, reserved.prepared.refundId, uuidV7(),
      );
    }
    await this.database.inPlatformContext(async (transaction) => {
      await markRefundInboxProcessed(
        transaction, reserved.inboxId, reserved.prepared.refundId,
      );
    });
    return { duplicate: false, status: 'processed' };
  }

  createTenantRefund(
    tenantId: string,
    actorId: string,
    orderId: string,
    rawInput: unknown,
    idempotencyKeyValue: unknown,
    requestId: string,
  ): Promise<RefundResponse> {
    requireUuid(tenantId, 'tenantId');
    return this.create(
      { actorId, scope: 'tenant', tenantId },
      orderId,
      rawInput,
      idempotencyKeyValue,
      requestId,
    );
  }

  createPlatformRefund(
    actorId: string,
    orderId: string,
    rawInput: unknown,
    idempotencyKeyValue: unknown,
    requestId: string,
  ): Promise<RefundResponse> {
    return this.create(
      { actorId, scope: 'platform', tenantId: null },
      orderId,
      rawInput,
      idempotencyKeyValue,
      requestId,
    );
  }

  listTenantRefunds(tenantId: string, rawQuery: Record<string, unknown>) {
    requireUuid(tenantId, 'tenantId');
    return this.list({ actorId: tenantId, scope: 'tenant', tenantId }, rawQuery);
  }

  listPlatformRefunds(rawQuery: Record<string, unknown>) {
    return this.list({ actorId: uuidV7(), scope: 'platform', tenantId: null }, rawQuery);
  }

  getTenantRefund(tenantId: string, refundId: string) {
    requireUuid(tenantId, 'tenantId');
    return this.get({ actorId: tenantId, scope: 'tenant', tenantId }, refundId);
  }

  getPlatformRefund(refundId: string) {
    return this.get({ actorId: uuidV7(), scope: 'platform', tenantId: null }, refundId);
  }

  private async create(
    actor: RefundActor,
    orderIdValue: unknown,
    rawInput: unknown,
    idempotencyKeyValue: unknown,
    requestId: string,
  ): Promise<RefundResponse> {
    requireUuid(actor.actorId, 'actorId');
    const orderId = requireUuid(orderIdValue, 'orderId');
    const reason = parseReason(rawInput);
    const idempotencyKey = requireIdempotencyKey(idempotencyKeyValue);
    let preparation: { cached?: RefundResponse; prepared?: PreparedRefund };
    try {
      preparation = await this.database.inPlatformContext(async (transaction) => {
        const command = await beginRefundCommand(
          transaction,
          actor,
          orderId,
          reason,
          idempotencyKey,
        );
        if (command.cached) return { cached: command.cached };
        if (command.existingRefundId) {
          return resumePreparedRefund(
            transaction,
            command.existingRefundId,
            actor,
          );
        }

        const orderDirectory = await transaction<Array<{
          account_id: string;
          tenant_id: string;
        }>>`
          select tenant_id, account_id from orders where id = ${orderId}
        `;
        const directory = orderDirectory[0];
        if (!directory || (actor.scope === 'tenant' && directory.tenant_id !== actor.tenantId)) {
          throw new NotFoundException('Paid order not found');
        }
        const tenants = await transaction<{ id: string }[]>`
          select id from tenants where id = ${directory.tenant_id} for share
        `;
        if (!tenants[0]) throw new NotFoundException('Paid order not found');
        const customers = await transaction<{ id: string }[]>`
          select id from customer_accounts
          where tenant_id = ${directory.tenant_id} and id = ${directory.account_id}
          for update
        `;
        if (!customers[0]) throw new NotFoundException('Paid order customer not found');

        const rows = await transaction<Array<{
          account_id: string;
          adapter_code_snapshot: string;
          amount_minor: string | number | bigint;
          attempt_id: string;
          charge_external_transaction_id: string;
          charge_id: string;
          collection_mode: 'platform_collect' | 'tenant_direct';
          config_id: string;
          config_version: number;
          active_secret_version: number | null;
          credential_key_version: number | null;
          currency: PreparedRefund['currency'];
          external_payment_id: string;
          order_id: string;
          order_type: string;
          provider_id: string;
          owner_type: 'platform' | 'tenant';
          owner_tenant_id: string | null;
          provider_account_id: string | null;
          provider_mode: StripeMode | null;
          secret_key_ciphertext: string | null;
          webhook_secret_ciphertext: string | null;
          tenant_id: string;
        }>>`
          select
            commerce_order.id as order_id,
            commerce_order.tenant_id,
            commerce_order.account_id,
            commerce_order.order_type,
            commerce_order.currency,
            commerce_order.total_minor as amount_minor,
            attempt.id as attempt_id,
            attempt.provider_id,
            attempt.payment_config_id as config_id,
            attempt.adapter_code_snapshot,
            attempt.collection_mode,
            config.version as config_version,
            config.active_secret_version,
            config.owner_type,
            config.owner_tenant_id,
            config.provider_mode,
            config.provider_account_id,
            secret.credential_key_version,
            secret.secret_key_ciphertext,
            secret.webhook_secret_ciphertext,
            attempt.external_payment_id,
            charge.id as charge_id,
            charge.external_transaction_id as charge_external_transaction_id
          from orders as commerce_order
          inner join payment_attempts as attempt
            on attempt.order_id = commerce_order.id
            and attempt.tenant_id = commerce_order.tenant_id
            and attempt.account_id = commerce_order.account_id
            and attempt.status = 'succeeded'
          inner join payment_transactions as charge
            on charge.attempt_id = attempt.id
            and charge.tenant_id = attempt.tenant_id
            and charge.order_id = commerce_order.id
            and charge.transaction_type = 'charge'
            and charge.status = 'succeeded'
          inner join payment_configs as config
            on config.id = attempt.payment_config_id
          left join payment_config_secret_versions as secret
            on secret.payment_config_id = config.id
            and secret.secret_version = config.active_secret_version
            and secret.status = 'active'
          inner join payment_providers as provider
            on provider.id = attempt.provider_id
          where commerce_order.id = ${orderId}
            and commerce_order.tenant_id = ${directory.tenant_id}
            and commerce_order.status = 'paid'
            and charge.currency = commerce_order.currency
            and charge.amount_minor = commerce_order.total_minor
            and (
              (${actor.scope === 'tenant'} and attempt.collection_mode = 'tenant_direct'
                and config.owner_type = 'tenant'
                and config.owner_tenant_id = commerce_order.tenant_id)
              or (${actor.scope === 'platform'} and attempt.collection_mode = 'platform_collect'
                and config.owner_type = 'platform' and config.owner_tenant_id is null)
            )
          for update of commerce_order, attempt
          for share of charge, config, provider
        `;
        const source = rows[0];
        if (!source?.external_payment_id) {
          throw new NotFoundException('Paid order is not refundable in this collection scope');
        }
        const active = await transaction<{ id: string }[]>`
          select id from payment_refunds
          where order_id = ${source.order_id}
            and status in ('requested', 'processing', 'succeeded', 'manual_reconciliation')
          for update
        `;
        if (active[0]) throw new ConflictException('Order already has a refund in progress or completed');

        const amountMinor = amountNumber(source.amount_minor);
        const providerContext = this.providerContext(source);
        const refundId = uuidV7();
        await transaction`
          insert into payment_refunds (
            id, tenant_id, order_id, attempt_id, payment_transaction_id,
            provider_id, payment_config_id, adapter_code_snapshot,
            collection_mode, external_payment_id_snapshot,
            provider_idempotency_key, status, currency, amount_minor,
            reason, requested_by_type, requested_by
          ) values (
            ${refundId}, ${source.tenant_id}, ${source.order_id}, ${source.attempt_id},
            ${source.charge_id}, ${source.provider_id}, ${source.config_id},
            ${source.adapter_code_snapshot}, ${source.collection_mode},
            ${source.external_payment_id}, ${refundId}, 'requested', ${source.currency},
            ${amountMinor}, ${reason},
            ${actor.scope === 'tenant' ? 'tenant_staff' : 'platform_staff'}, ${actor.actorId}
          )
        `;
        const processingRows = await transaction<{ processing_at: Date }[]>`
          update payment_refunds
          set status = 'processing',
            processing_at = greatest(transaction_timestamp(), created_at),
            version = version + 1
          where id = ${refundId} and status = 'requested'
          returning processing_at
        `;
        const processingStartedAt = processingRows[0]?.processing_at;
        if (!processingStartedAt) {
          throw new ConflictException('Refund could not enter provider processing');
        }
        if (source.order_type === 'points_topup') {
          await reserveTopupPoints(
            transaction,
            source.tenant_id,
            source.account_id,
            source.order_id,
            refundId,
          );
        }
        await transaction`
          update command_idempotency
          set resource_type = 'payment_refund', resource_id = ${refundId}
          where id = ${command.id} and status = 'processing'
        `;
        await transaction`
          insert into audit_logs (
            id, scope_type, tenant_id, actor_type, actor_id, action,
            resource_type, resource_id, after_json, request_id
          ) values (
            ${uuidV7()}, 'tenant', ${source.tenant_id},
            ${actor.scope === 'tenant' ? 'tenant_staff' : 'platform_staff'}, ${actor.actorId},
            'commerce.refund.request', 'payment_refund', ${refundId},
            ${transaction.json({
              amountMinor,
              collectionMode: source.collection_mode,
              currency: source.currency,
              fullRefund: true,
              orderId: source.order_id,
            })}, ${requestId}
          )
        `;
        return {
          prepared: {
            adapterCode: source.adapter_code_snapshot,
            amountMinor,
            chargeExternalTransactionId: source.charge_external_transaction_id,
            collectionMode: source.collection_mode,
            currency: source.currency,
            externalPaymentId: source.external_payment_id,
            orderId: source.order_id,
            processingStartedAt,
            providerContext,
            refundId,
            tenantId: source.tenant_id,
          },
        };
      });
    } catch (error) {
      if (databaseCode(error) === '23505') {
        throw new ConflictException('Order already has a refund in progress or completed');
      }
      throw error;
    }

    if (preparation.cached) return preparation.cached;
    const prepared = preparation.prepared;
    if (!prepared) throw new Error('Refund preparation did not return a provider request');
    const providerContext = prepared.providerContext
      ?? await this.loadProviderContext(prepared.refundId);

    let adapterResult: AdapterRefundResult;
    try {
      adapterResult = await this.adapters.require(prepared.adapterCode).refundPayment({
        amountMinor: prepared.amountMinor,
        chargeExternalTransactionId: prepared.chargeExternalTransactionId,
        config: providerContext,
        currency: prepared.currency,
        externalPaymentId: prepared.externalPaymentId,
        orderId: prepared.orderId,
        providerIdempotencyKey: prepared.refundId,
        refundId: prepared.refundId,
      });
    } catch (error) {
      if (error instanceof PaymentAdapterDefinitiveError) {
        return this.finalizeDefinitiveFailure(actor, prepared.refundId, requestId);
      }
      return this.markAmbiguous(actor, prepared.refundId, requestId);
    }
    if (!isValidAdapterRefundResult(adapterResult, prepared)) {
      return this.markAmbiguous(actor, prepared.refundId, requestId);
    }
    if (adapterResult.status === 'failed') {
      return this.finalizeDefinitiveFailure(actor, prepared.refundId, requestId);
    }
    if (adapterResult.status === 'pending') {
      return this.recordProviderPending(actor, prepared, adapterResult, requestId);
    }
    return this.finalizeSuccess(actor, prepared, adapterResult, requestId);
  }

  private providerContext(source: {
    active_secret_version: number | null;
    adapter_code_snapshot: string;
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
      configId: source.config_id,
      configVersion: source.config_version,
      providerId: source.provider_id,
    };
    if (source.adapter_code_snapshot !== 'stripe') return context;
    if (
      !this.cipher?.configured || !source.active_secret_version
      || !source.credential_key_version || !source.provider_account_id
      || !source.provider_mode || !source.secret_key_ciphertext
      || !source.webhook_secret_ciphertext
    ) {
      throw new ConflictException('Stripe payment configuration is unavailable');
    }
    return {
      ...context,
      credentials: this.cipher.decryptStripeCredentials({
        secretKeyCiphertext: source.secret_key_ciphertext,
        webhookSecretCiphertext: source.webhook_secret_ciphertext,
      }, {
        accountId: source.provider_account_id,
        configId: source.config_id,
        credentialKeyVersion: source.credential_key_version,
        mode: source.provider_mode,
        ownerType: source.owner_type,
        secretVersion: source.active_secret_version,
        tenantId: source.owner_tenant_id,
      }),
      secretVersion: source.active_secret_version,
    };
  }

  private loadProviderContext(refundId: string): Promise<PaymentProviderContext> {
    return this.database.inPlatformContext(async (transaction) => {
      const rows = await transaction<Array<{
        active_secret_version: number | null;
        adapter_code_snapshot: string;
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
      }>>`
        select refund.adapter_code_snapshot, refund.payment_config_id as config_id,
          refund.provider_id, config.version as config_version,
          config.active_secret_version, config.owner_type, config.owner_tenant_id,
          config.provider_mode, config.provider_account_id,
          secret.credential_key_version, secret.secret_key_ciphertext,
          secret.webhook_secret_ciphertext
        from payment_refunds as refund
        inner join payment_configs as config on config.id = refund.payment_config_id
        left join payment_config_secret_versions as secret
          on secret.payment_config_id = config.id
          and secret.secret_version = config.active_secret_version
          and secret.status = 'active'
        where refund.id = ${refundId}
      `;
      if (!rows[0]) throw new NotFoundException('Refund not found');
      return this.providerContext(rows[0]);
    });
  }

  private recordProviderPending(
    actor: RefundActor,
    prepared: PreparedRefund,
    result: AdapterRefundResult,
    requestId: string,
  ): Promise<RefundResponse> {
    return this.database.inPlatformContext(async (transaction) => {
      const refund = await lockRefund(transaction, prepared.refundId, actor);
      if (refund.status !== 'processing') return mapRefund(refund);
      const updated = await transaction<LockedRefund[]>`
        update payment_refunds set external_refund_id = ${result.externalRefundId},
          version = version + 1
        where id = ${prepared.refundId} and status = 'processing'
          and external_refund_id is null
        returning *, ${refund.account_id}::uuid as account_id
      `;
      const pending = updated[0] ?? refund;
      const response = mapRefund(pending);
      await completeRefundCommand(transaction, prepared.refundId, response);
      await transaction`
        insert into audit_logs (
          id, scope_type, tenant_id, actor_type, actor_id, action,
          resource_type, resource_id, after_json, request_id
        ) values (
          ${uuidV7()}, 'tenant', ${pending.tenant_id}, ${pending.requested_by_type},
          ${pending.requested_by}, 'commerce.refund.provider_pending',
          'payment_refund', ${pending.id},
          ${transaction.json({ status: 'processing' })}, ${requestId}
        )
      `;
      return response;
    });
  }

  private finalizeSuccess(
    actor: RefundActor,
    prepared: PreparedRefund,
    adapterResult: AdapterRefundResult,
    requestId: string,
  ): Promise<RefundResponse> {
    return this.database.inPlatformContext(async (transaction) => {
      const refund = await lockRefund(transaction, prepared.refundId, actor);
      if (refund.status !== 'processing') return mapRefund(refund);
      const orderRows = await transaction<Array<{
        account_id: string;
        order_type: string;
        status: string;
      }>>`
        select account_id, order_type, status from orders
        where id = ${refund.order_id} and tenant_id = ${refund.tenant_id}
        for update
      `;
      const order = orderRows[0];
      if (!order || order.status !== 'paid') {
        throw new ConflictException('Paid order changed before refund completion');
      }
      const refundTransactionId = uuidV7();
      const payloadHash = createHash('sha256')
        .update(JSON.stringify({
          amountMinor: adapterResult.amountMinor,
          currency: adapterResult.currency,
          externalRefundId: adapterResult.externalRefundId,
          refundId: prepared.refundId,
        }))
        .digest('hex');
      await transaction`
        insert into payment_transactions (
          id, tenant_id, attempt_id, order_id, provider_id,
          transaction_type, status, external_transaction_id,
          currency, amount_minor, payload_hash, occurred_at
        )
        select
          ${refundTransactionId}, refund.tenant_id, refund.attempt_id, refund.order_id,
          refund.provider_id, 'refund', 'succeeded', ${adapterResult.externalRefundId},
          refund.currency, refund.amount_minor, ${payloadHash}, ${adapterResult.occurredAt}
        from payment_refunds as refund where refund.id = ${prepared.refundId}
      `;

      const merchant = refund.collection_mode === 'platform_collect'
        ? await chooseMerchantRefundBucket(transaction, refund)
        : { accountId: null, bucket: null, reconciliationReason: null };
      const finalStatus: 'manual_reconciliation' | 'succeeded' =
        merchant.reconciliationReason ? 'manual_reconciliation' : 'succeeded';
      const updated = await transaction<LockedRefund[]>`
        update payment_refunds
        set status = ${finalStatus}, external_refund_id = ${adapterResult.externalRefundId},
          refund_transaction_id = ${refundTransactionId},
          succeeded_at = transaction_timestamp(),
          reconciliation_required = ${finalStatus === 'manual_reconciliation'},
          reconciliation_reason = ${merchant.reconciliationReason},
          last_error = null,
          merchant_balance_account_id = ${merchant.accountId},
          merchant_balance_bucket = ${merchant.bucket},
          version = version + 1
        where id = ${prepared.refundId} and status = 'processing'
        returning *, ${order.account_id}::uuid as account_id
      `;
      const completed = updated[0];
      if (!completed) throw new ConflictException('Refund completion lost its state lock');
      await transaction`
        update orders
        set status = 'refunded', refunded_at = transaction_timestamp(), version = version + 1
        where id = ${refund.order_id} and tenant_id = ${refund.tenant_id} and status = 'paid'
      `;
      if (order.order_type !== 'points_topup') {
        await transaction`
          update entitlements
          set revoked_at = coalesce(revoked_at, transaction_timestamp()),
            revoked_reason = coalesce(revoked_reason, 'full_order_refund')
          where tenant_id = ${refund.tenant_id}
            and source_type = 'order' and source_order_id = ${refund.order_id}
            and revoked_at is null
        `;
      }
      if (refund.collection_mode === 'platform_collect') {
        if (finalStatus === 'succeeded' && merchant.accountId && merchant.bucket) {
          await transaction`
            insert into merchant_balance_ledger (
              id, tenant_id, balance_account_id, bucket, entry_type,
              delta_minor, balance_after_minor, currency, reference_type,
              reference_id, idempotency_key
            ) values (
              ${uuidV7()}, ${refund.tenant_id}, ${merchant.accountId}, ${merchant.bucket},
              'refund', ${-amountNumber(refund.amount_minor)}, 0, ${refund.currency},
              'payment_refund', ${prepared.refundId},
              ${`refund:${prepared.refundId}:merchant:${merchant.bucket}`}
            )
          `;
        }
        await transaction`
          update merchant_settlements
          set status = 'refunded', payment_refund_id = ${prepared.refundId},
            refunded_at = transaction_timestamp(), version = version + 1
          where payment_transaction_id = ${refund.payment_transaction_id}
            and status in ('pending', 'settled')
        `;
      }
      await reverseReferralCommission(
        transaction,
        refund.tenant_id,
        refund.order_id,
        refundTransactionId,
      );
      const response = mapRefund(completed);
      await completeRefundCommand(transaction, prepared.refundId, response);
      await insertRefundAuditAndOutbox(
        transaction,
        completed,
        actor,
        response,
        requestId,
      );
      return response;
    });
  }

  private finalizeDefinitiveFailure(
    actor: RefundActor,
    refundId: string,
    requestId: string,
  ): Promise<RefundResponse> {
    return this.database.inPlatformContext(async (transaction) => {
      const refund = await lockRefund(transaction, refundId, actor);
      if (refund.status !== 'processing') return mapRefund(refund);
      const updated = await transaction<LockedRefund[]>`
        update payment_refunds
        set status = 'failed', failure_code = 'provider_rejected',
          failure_message = 'Payment provider definitively rejected the full refund',
          failed_at = transaction_timestamp(), reconciliation_required = false,
          last_error = null, version = version + 1
        where id = ${refundId} and status = 'processing'
        returning *, ${refund.account_id}::uuid as account_id
      `;
      await releaseTopupPointsIfNeeded(transaction, refund, refundId);
      const response = mapRefund(updated[0] ?? refund);
      await completeRefundCommand(transaction, refundId, response);
      await insertRefundAuditAndOutbox(
        transaction,
        updated[0] ?? refund,
        actor,
        response,
        requestId,
      );
      return response;
    });
  }

  private markAmbiguous(
    actor: RefundActor,
    refundId: string,
    requestId: string,
  ): Promise<RefundResponse> {
    return this.database.inPlatformContext(async (transaction) => {
      const refund = await lockRefund(transaction, refundId, actor);
      if (refund.status !== 'processing') return mapRefund(refund);
      if (refund.reconciliation_required) return mapRefund(refund);
      const safeMessage = 'Provider refund outcome is ambiguous and requires reconciliation';
      const updated = await transaction<LockedRefund[]>`
        update payment_refunds
        set reconciliation_required = true, last_error = ${safeMessage}, version = version + 1
        where id = ${refundId} and status = 'processing'
          and not reconciliation_required
        returning *, ${refund.account_id}::uuid as account_id
      `;
      const response = mapRefund(updated[0] ?? refund);
      await transaction`
        insert into audit_logs (
          id, scope_type, tenant_id, actor_type, actor_id, action,
          resource_type, resource_id, after_json, request_id
        ) values (
          ${uuidV7()}, 'tenant', ${refund.tenant_id}, ${refund.requested_by_type},
          ${refund.requested_by}, 'commerce.refund.reconciliation_required',
          'payment_refund', ${refundId},
          ${transaction.json({
            errorCode: 'provider_outcome_ambiguous',
            message: safeMessage,
            status: 'processing',
          })}, ${requestId}
        )
      `;
      const eventId = uuidV7();
      await transaction`
        insert into outbox_events (
          id, scope_type, tenant_id, event_key, idempotency_key,
          aggregate_type, aggregate_id, event_type, payload_json
        ) values (
          ${eventId}, 'tenant', ${refund.tenant_id}, ${`event:${eventId}`},
          ${`PaymentRefundReconciliationRequired:${refundId}:provider_ambiguous`},
          'payment_refund', ${refundId}, 'PaymentRefundReconciliationRequired',
          ${transaction.json({
            errorCode: 'provider_outcome_ambiguous',
            refundId,
            tenantId: refund.tenant_id,
          })}
        ) on conflict do nothing
      `;
      return response;
    });
  }

  private list(actor: RefundActor, rawQuery: Record<string, unknown>) {
    const page = positiveInteger(rawQuery.page, 1, 10_000);
    const pageSize = positiveInteger(rawQuery.pageSize, 20, 100);
    const status = optionalRefundStatus(rawQuery.status);
    const offset = (page - 1) * pageSize;
    const execute = actor.scope === 'tenant'
      ? this.database.inTenantContext.bind(this.database, actor.tenantId as string)
      : this.database.inPlatformContext.bind(this.database);
    return execute(async (transaction: DatabaseTransaction) => {
      const rows = await transaction<LockedRefund[]>`
        select refund.*, commerce_order.account_id
        from payment_refunds as refund
        inner join orders as commerce_order
          on commerce_order.id = refund.order_id and commerce_order.tenant_id = refund.tenant_id
        where refund.collection_mode = ${actor.scope === 'tenant' ? 'tenant_direct' : 'platform_collect'}
          and (${actor.scope === 'platform'} or refund.tenant_id = ${actor.tenantId})
          and (${status ?? null}::text is null or refund.status = ${status ?? null})
        order by refund.created_at desc, refund.id desc
        limit ${pageSize} offset ${offset}
      `;
      return { items: rows.map(mapRefund), page, pageSize };
    });
  }

  private get(actor: RefundActor, refundIdValue: unknown) {
    const refundId = requireUuid(refundIdValue, 'refundId');
    const execute = actor.scope === 'tenant'
      ? this.database.inTenantContext.bind(this.database, actor.tenantId as string)
      : this.database.inPlatformContext.bind(this.database);
    return execute(async (transaction: DatabaseTransaction) => {
      const rows = await transaction<LockedRefund[]>`
        select refund.*, commerce_order.account_id
        from payment_refunds as refund
        inner join orders as commerce_order
          on commerce_order.id = refund.order_id and commerce_order.tenant_id = refund.tenant_id
        where refund.id = ${refundId}
          and refund.collection_mode = ${actor.scope === 'tenant' ? 'tenant_direct' : 'platform_collect'}
          and (${actor.scope === 'platform'} or refund.tenant_id = ${actor.tenantId})
      `;
      if (!rows[0]) throw new NotFoundException('Refund not found');
      return mapRefund(rows[0]);
    });
  }
}

async function beginRefundCommand(
  transaction: DatabaseTransaction,
  actor: RefundActor,
  orderId: string,
  reason: string,
  idempotencyKey: string,
): Promise<{ cached?: RefundResponse; existingRefundId?: string; id: string }> {
  const requestHash = createHash('sha256')
    .update(JSON.stringify({ fullRefund: true, orderId, reason }))
    .digest('hex');
  const id = uuidV7();
  const routeKey = actor.scope === 'tenant'
    ? 'tenant.commerce.refund.create'
    : 'platform.finance.refund.create';
  const inserted = await transaction<{ id: string }[]>`
    insert into command_idempotency (
      id, scope_type, tenant_id, actor_type, actor_id, route_key,
      idempotency_key, request_hash, expires_at
    ) values (
      ${id}, ${actor.scope}, ${actor.tenantId},
      ${actor.scope === 'tenant' ? 'tenant_staff' : 'platform_staff'}, ${actor.actorId},
      ${routeKey}, ${idempotencyKey}, ${requestHash},
      transaction_timestamp() + interval '7 days'
    ) on conflict do nothing returning id
  `;
  if (inserted[0]) return { id };
  const rows = await transaction<RefundCommandRow[]>`
    select id, request_hash, status, response_json, resource_id
    from command_idempotency
    where scope_type = ${actor.scope}
      and tenant_id is not distinct from ${actor.tenantId}
      and actor_type = ${actor.scope === 'tenant' ? 'tenant_staff' : 'platform_staff'}
      and actor_id = ${actor.actorId}
      and route_key = ${routeKey} and idempotency_key = ${idempotencyKey}
    for update
  `;
  const existing = rows[0];
  if (!existing) throw new ConflictException('Refund idempotency record is unavailable');
  if (existing.request_hash !== requestHash) {
    throw new ConflictException('Idempotency-Key was used for another refund request');
  }
  if (existing.status === 'completed' && existing.response_json) {
    return { cached: existing.response_json, id: existing.id };
  }
  if (existing.status === 'processing' && existing.resource_id) {
    return { existingRefundId: existing.resource_id, id: existing.id };
  }
  throw new ConflictException('Refund idempotency command cannot be resumed');
}

async function reserveTopupPoints(
  transaction: DatabaseTransaction,
  tenantId: string,
  accountId: string,
  orderId: string,
  refundId: string,
): Promise<void> {
  const rows = await transaction<Array<{
    balance: string | number | bigint;
    id: string;
    points: string | number | bigint;
  }>>`
    select point_account.id, point_account.balance,
      (item.product_snapshot_json ->> 'pointsAmount')::bigint
        + coalesce(item.product_snapshot_json ->> 'bonusPoints', '0')::bigint as points
    from orders as commerce_order
    inner join order_items as item
      on item.order_id = commerce_order.id and item.tenant_id = commerce_order.tenant_id
      and item.line_no = 1 and item.item_type = 'points_topup'
    inner join point_accounts as point_account
      on point_account.tenant_id = commerce_order.tenant_id
      and point_account.account_id = commerce_order.account_id
    where commerce_order.id = ${orderId} and commerce_order.tenant_id = ${tenantId}
      and commerce_order.account_id = ${accountId}
    for update of point_account
  `;
  const account = rows[0];
  if (!account || amountNumber(account.balance) < amountNumber(account.points)) {
    throw new ConflictException('Top-up points have already been consumed and cannot be refunded');
  }
  await transaction`
    insert into point_ledger (
      id, tenant_id, account_id, point_account_id, entry_type, delta,
      balance_after, reference_type, reference_id, idempotency_key,
      metadata_json, created_by_type, created_by
    ) values (
      ${uuidV7()}, ${tenantId}, ${accountId}, ${account.id}, 'refund_reserve',
      ${-amountNumber(account.points)}, 0, 'payment_refund', ${refundId},
      ${`refund:${refundId}:points:reserve`},
      ${transaction.json({ fullRefund: true, orderId })}, 'system', null
    )
  `;
}

async function releaseTopupPointsIfNeeded(
  transaction: DatabaseTransaction,
  refund: LockedRefund,
  refundId: string,
): Promise<void> {
  const reserves = await transaction<Array<{
    account_id: string;
    delta: string | number | bigint;
    point_account_id: string;
  }>>`
    select account_id, point_account_id, delta from point_ledger
    where tenant_id = ${refund.tenant_id} and reference_type = 'payment_refund'
      and reference_id = ${refundId} and entry_type = 'refund_reserve'
  `;
  const reserve = reserves[0];
  if (!reserve) return;
  await transaction`
    insert into point_ledger (
      id, tenant_id, account_id, point_account_id, entry_type, delta,
      balance_after, reference_type, reference_id, idempotency_key,
      metadata_json, created_by_type, created_by
    ) values (
      ${uuidV7()}, ${refund.tenant_id}, ${reserve.account_id}, ${reserve.point_account_id},
      'refund_release', ${amountNumber(-Number(reserve.delta))}, 0,
      'payment_refund', ${refundId},
      ${`refund:${refundId}:points:release`},
      ${transaction.json({ fullRefund: true, orderId: refund.order_id })}, 'system', null
    )
  `;
}

async function chooseMerchantRefundBucket(
  transaction: DatabaseTransaction,
  refund: LockedRefund,
): Promise<{
  accountId: string | null;
  bucket: 'available' | 'pending' | null;
  reconciliationReason: string | null;
}> {
  const rows = await transaction<Array<{
    available_minor: string | number | bigint;
    balance_account_id: string;
    pending_minor: string | number | bigint;
    settlement_status: string;
  }>>`
    select settlement.balance_account_id, settlement.status as settlement_status,
      account.pending_minor, account.available_minor
    from merchant_settlements as settlement
    inner join merchant_balance_accounts as account
      on account.id = settlement.balance_account_id
      and account.tenant_id = settlement.tenant_id
      and account.currency = settlement.currency
    where settlement.payment_transaction_id = ${refund.payment_transaction_id}
      and settlement.tenant_id = ${refund.tenant_id}
    for update of settlement, account
  `;
  const row = rows[0];
  if (!row) {
    return {
      accountId: null,
      bucket: null,
      reconciliationReason: 'Platform-collected refund has no merchant settlement account',
    };
  }
  const amount = amountNumber(refund.amount_minor);
  if (row.settlement_status === 'pending' && amountNumber(row.pending_minor) >= amount) {
    return { accountId: row.balance_account_id, bucket: 'pending', reconciliationReason: null };
  }
  if (row.settlement_status === 'settled' && amountNumber(row.available_minor) >= amount) {
    return { accountId: row.balance_account_id, bucket: 'available', reconciliationReason: null };
  }
  return {
    accountId: row.balance_account_id,
    bucket: null,
    reconciliationReason:
      'Provider refund succeeded but merchant pending/available balance cannot cover it',
  };
}

async function reverseReferralCommission(
  transaction: DatabaseTransaction,
  tenantId: string,
  orderId: string,
  refundTransactionId: string,
): Promise<void> {
  const rows = await transaction<Array<{
    commission_account_id: string;
    commission_minor: string | number | bigint;
    currency: string;
    id: string;
    status: 'available' | 'pending' | 'reversed';
  }>>`
    select id, commission_account_id, commission_minor, currency, status
    from referral_commissions
    where tenant_id = ${tenantId} and order_id = ${orderId}
    for update
  `;
  const commission = rows[0];
  if (!commission || commission.status === 'reversed') return;
  const oldStatus = commission.status;
  await transaction`
    update referral_commissions
    set status = 'reversed', reversal_transaction_id = ${refundTransactionId},
      reversed_from_status = ${oldStatus}, reversed_at = transaction_timestamp()
    where id = ${commission.id} and status = ${oldStatus}
  `;
  await transaction`
    insert into referral_commission_ledger (
      id, tenant_id, commission_account_id, commission_id, bucket,
      entry_type, currency, delta_minor, balance_after_minor, idempotency_key
    ) values (
      ${uuidV7()}, ${tenantId}, ${commission.commission_account_id}, ${commission.id},
      ${oldStatus === 'pending' ? 'pending' : 'available'},
      ${oldStatus === 'pending' ? 'reversal_pending_debit' : 'reversal_available_debit'},
      ${commission.currency}, ${-amountNumber(commission.commission_minor)}, 0,
      ${`refund:${refundTransactionId}:referral:${commission.id}`}
    )
  `;
}

async function lockRefund(
  transaction: DatabaseTransaction,
  refundId: string,
  actor: RefundActor,
): Promise<LockedRefund> {
  const rows = await transaction<LockedRefund[]>`
    select refund.*, commerce_order.account_id
    from payment_refunds as refund
    inner join orders as commerce_order
      on commerce_order.id = refund.order_id and commerce_order.tenant_id = refund.tenant_id
    where refund.id = ${refundId}
      and (${actor.scope === 'platform'} or refund.tenant_id = ${actor.tenantId})
      and refund.collection_mode = ${actor.scope === 'tenant' ? 'tenant_direct' : 'platform_collect'}
    for update of refund
  `;
  if (!rows[0]) throw new NotFoundException('Refund not found');
  return rows[0];
}

async function resumePreparedRefund(
  transaction: DatabaseTransaction,
  refundId: string,
  actor: RefundActor,
): Promise<{ cached?: RefundResponse; prepared?: PreparedRefund }> {
  const refund = await lockRefund(transaction, refundId, actor);
  if (refund.status !== 'processing') return { cached: mapRefund(refund) };
  const chargeRows = await transaction<Array<{ external_transaction_id: string }>>`
    select external_transaction_id
    from payment_transactions
    where id = ${refund.payment_transaction_id}
      and tenant_id = ${refund.tenant_id}
      and order_id = ${refund.order_id}
      and transaction_type = 'charge'
      and status = 'succeeded'
    for share
  `;
  const charge = chargeRows[0];
  if (!charge?.external_transaction_id || !refund.processing_at) {
    throw new ConflictException('Refund provider request cannot be resumed safely');
  }
  return {
    prepared: {
      adapterCode: refund.adapter_code_snapshot,
      amountMinor: amountNumber(refund.amount_minor),
      chargeExternalTransactionId: charge.external_transaction_id,
      collectionMode: refund.collection_mode,
      currency: refund.currency,
      externalPaymentId: refund.external_payment_id_snapshot,
      orderId: refund.order_id,
      processingStartedAt: refund.processing_at,
      refundId: refund.id,
      tenantId: refund.tenant_id,
    },
  };
}

async function completeRefundCommand(
  transaction: DatabaseTransaction,
  refundId: string,
  response: RefundResponse,
): Promise<void> {
  await transaction`
    update command_idempotency
    set status = 'completed', response_status = 200,
      response_json = ${transaction.json(toJsonValue(response))}, locked_at = null
    where resource_type = 'payment_refund' and resource_id = ${refundId}
      and status in ('processing', 'completed')
  `;
}

async function markRefundInboxProcessed(
  transaction: DatabaseTransaction,
  inboxId: string,
  refundId: string,
): Promise<void> {
  await transaction`
    update payment_webhook_inbox set status = 'processed',
      processed_at = coalesce(processed_at, statement_timestamp()),
      error_message = null
    where id = ${inboxId} and status in ('received', 'processed')
  `;
  const outboxId = uuidV7();
  await transaction`
    insert into payment_webhook_outbox (
      id, tenant_id, inbox_id, event_type, event_key, payload_json
    ) select ${outboxId}, tenant_id, id, 'PaymentRefundWebhookProcessed',
      ${`refund-webhook:${inboxId}`},
      ${transaction.json({ inboxId, refundId })}
    from payment_webhook_inbox where id = ${inboxId}
    on conflict (event_key) do nothing
  `;
}

async function insertRefundAuditAndOutbox(
  transaction: DatabaseTransaction,
  refund: LockedRefund,
  actor: RefundActor,
  response: RefundResponse,
  requestId: string,
): Promise<void> {
  await transaction`
    insert into audit_logs (
      id, scope_type, tenant_id, actor_type, actor_id, action,
      resource_type, resource_id, after_json, request_id
    ) values (
      ${uuidV7()}, 'tenant', ${refund.tenant_id},
      ${actor.scope === 'tenant' ? 'tenant_staff' : 'platform_staff'}, ${actor.actorId},
      ${response.status === 'succeeded'
        ? 'commerce.refund.succeed'
        : response.status === 'manual_reconciliation'
          ? 'commerce.refund.manual_reconciliation'
          : 'commerce.refund.fail'},
      'payment_refund', ${refund.id}, ${transaction.json(toJsonValue(response))}, ${requestId}
    )
  `;
  const eventId = uuidV7();
  const eventType = response.status === 'succeeded'
    ? 'PaymentRefundSucceeded'
    : response.status === 'manual_reconciliation'
      ? 'PaymentRefundReconciliationRequired'
      : 'PaymentRefundFailed';
  await transaction`
    insert into outbox_events (
      id, scope_type, tenant_id, event_key, idempotency_key,
      aggregate_type, aggregate_id, event_type, payload_json
    ) values (
      ${eventId}, 'tenant', ${refund.tenant_id}, ${`event:${eventId}`},
      ${`${eventType}:${refund.id}`}, 'payment_refund', ${refund.id}, ${eventType},
      ${transaction.json(toJsonValue({ ...response, tenantId: refund.tenant_id }))}
    ) on conflict do nothing
  `;
}

function parseReason(rawInput: unknown): string {
  if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
    throw new BadRequestException('Refund body is invalid');
  }
  const input = rawInput as Record<string, unknown>;
  if (Object.keys(input).some((key) => key !== 'reason')) {
    throw new BadRequestException('Refund body only accepts reason');
  }
  const forbidden = ['amount', 'amountMinor', 'currency', 'partialAmount', 'refundAmount'];
  if (forbidden.some((key) => Object.hasOwn(input, key))) {
    throw new BadRequestException('Refund amount and currency are fixed by the paid order');
  }
  if (typeof input.reason !== 'string') throw new BadRequestException('reason is required');
  const reason = input.reason.trim();
  if (reason.length < 2 || reason.length > 2000) {
    throw new BadRequestException('reason must contain 2 to 2000 characters');
  }
  return reason;
}

function requireIdempotencyKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(value.trim())) {
    throw new BadRequestException('A valid Idempotency-Key header is required');
  }
  return value.trim();
}

function isValidAdapterRefundResult(
  result: AdapterRefundResult,
  prepared: PreparedRefund,
): boolean {
  const occurredAtMs = result.occurredAt instanceof Date
    ? result.occurredAt.getTime()
    : Number.NaN;
  const processingStartedAtMs = prepared.processingStartedAt.getTime();
  return ['failed', 'pending', 'succeeded'].includes(result.status)
    && result.amountMinor === prepared.amountMinor
    && result.currency === prepared.currency
    && /^[A-Za-z0-9][A-Za-z0-9._:-]{2,299}$/.test(result.externalRefundId)
    && Number.isFinite(occurredAtMs)
    && occurredAtMs >= processingStartedAtMs - 5 * 60_000
    && occurredAtMs <= Date.now() + 5 * 60_000;
}

function optionalRefundStatus(value: unknown): RefundStatus | undefined {
  if (value === undefined) return undefined;
  if (
    value === 'failed'
    || value === 'manual_reconciliation'
    || value === 'processing'
    || value === 'succeeded'
  ) return value;
  throw new BadRequestException('Refund status filter is invalid');
}

function mapRefund(row: LockedRefund): RefundResponse {
  return {
    amountMinor: amountNumber(row.amount_minor),
    collectionMode: row.collection_mode,
    createdAt: row.created_at.toISOString(),
    currency: row.currency,
    fullRefund: true,
    id: row.id,
    manualReconciliation: row.status === 'manual_reconciliation',
    orderId: row.order_id,
    reason: row.reason,
    reconciliationRequired:
      row.reconciliation_required || row.status === 'manual_reconciliation',
    status: row.status as RefundStatus,
  };
}

function positiveInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || Number(parsed) < 1 || Number(parsed) > maximum) {
    throw new BadRequestException('Pagination value is invalid');
  }
  return Number(parsed);
}

function databaseCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function toJsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}
