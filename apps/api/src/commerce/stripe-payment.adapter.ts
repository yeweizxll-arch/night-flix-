import {
  BadRequestException,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
  Inject,
} from '@nestjs/common';
import Stripe from 'stripe';

import {
  PaymentAdapterDefinitiveError,
  type AdapterPaymentResult,
  type AdapterRefundResult,
  type CreateAdapterPaymentInput,
  type CreateAdapterRefundInput,
  type GetAdapterCheckoutInput,
  type PaymentAdapter,
  type PaymentProviderContext,
  type RedirectCheckoutAction,
  type VerifiedPaymentWebhook,
} from './payment-adapter';
import type { CommerceCurrency } from './commerce.types';

export const STRIPE_API_VERSION = '2026-07-29.dahlia' as const;
const STRIPE_TIMEOUT_MS = 8_000;
const MAX_WEBHOOK_SECRETS = 5;

export type StripeClientFactory = (secretKey: string) => Stripe;

export class StripeProviderUnavailableError extends ServiceUnavailableException {
  constructor() {
    super('Payment provider is temporarily unavailable');
  }
}

export class StripeAccountMismatchError extends PaymentAdapterDefinitiveError {
  constructor() {
    super('Stripe account does not match configuration');
  }
}

@Injectable()
export class StripePaymentAdapter implements PaymentAdapter {
  readonly code = 'stripe';
  private readonly factory: StripeClientFactory;

  constructor(
    @Optional()
    @Inject('STRIPE_CLIENT_FACTORY')
    factory?: StripeClientFactory,
  ) {
    this.factory = factory ?? ((secretKey) => new Stripe(secretKey, {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 2,
      telemetry: false,
      timeout: STRIPE_TIMEOUT_MS,
    }));
  }

  async createPayment(input: CreateAdapterPaymentInput): Promise<AdapterPaymentResult> {
    const credentials = requireStripeContext(input.config);
    validateStripeAmount(input.amountMinor);
    const expiresAtSeconds = Math.floor(input.expiresAt.getTime() / 1000);
    if (!Number.isSafeInteger(expiresAtSeconds)) {
      throw new PaymentAdapterDefinitiveError('Stripe checkout expiry is invalid');
    }
    let session: Stripe.Checkout.Session;
    try {
      session = await this.factory(credentials.secretKey).checkout.sessions.create({
        cancel_url: trustedReturnUrl(input.cancelUrl),
        client_reference_id: input.attemptId,
        expires_at: expiresAtSeconds,
        line_items: [{
          price_data: {
            currency: input.currency.toLowerCase(),
            product_data: { name: `Order ${input.orderNo}` },
            unit_amount: input.amountMinor,
          },
          quantity: 1,
        }],
        metadata: safeMetadata(input),
        mode: 'payment',
        payment_intent_data: { metadata: safeMetadata(input) },
        payment_method_types: ['card'],
        success_url: trustedReturnUrl(input.successUrl, true),
      }, { idempotencyKey: input.providerIdempotencyKey });
    } catch (error) {
      throw classifyStripeError(error);
    }
    try {
      return {
        checkoutAction: checkoutAction(session, input),
        externalPaymentId: stripeId(session.id, 'cs_', 'Checkout Session'),
        status: 'pending',
      };
    } catch (error) {
      if (error instanceof PaymentAdapterDefinitiveError) throw error;
      throw new PaymentAdapterDefinitiveError('Stripe Checkout Session response is invalid');
    }
  }

  async getCheckoutAction(
    input: GetAdapterCheckoutInput,
  ): Promise<RedirectCheckoutAction | null> {
    const credentials = requireStripeContext(input.config);
    let session: Stripe.Checkout.Session;
    try {
      session = await this.factory(credentials.secretKey)
        .checkout.sessions.retrieve(stripeId(input.externalPaymentId, 'cs_', 'Checkout Session'));
    } catch (error) {
      throw classifyStripeError(error);
    }
    if (session.status !== 'open') return null;
    try {
      return checkoutAction(session, input);
    } catch (error) {
      if (error instanceof PaymentAdapterDefinitiveError) throw error;
      throw new PaymentAdapterDefinitiveError('Stripe Checkout Session response is invalid');
    }
  }

  async refundPayment(input: CreateAdapterRefundInput): Promise<AdapterRefundResult> {
    const credentials = requireStripeContext(input.config);
    validateStripeAmount(input.amountMinor);
    let refund: Stripe.Refund;
    try {
      refund = await this.factory(credentials.secretKey).refunds.create({
        amount: input.amountMinor,
        metadata: {
          orderId: input.orderId,
          refundId: input.refundId,
        },
        payment_intent: stripeId(
          input.chargeExternalTransactionId,
          'pi_',
          'PaymentIntent',
        ),
        reason: 'requested_by_customer',
      }, { idempotencyKey: input.providerIdempotencyKey });
    } catch (error) {
      throw classifyStripeError(error);
    }
    return {
      amountMinor: safeInteger(refund.amount, 'Stripe refund amount'),
      currency: stripeCurrency(refund.currency),
      externalRefundId: stripeId(refund.id, 're_', 'Refund'),
      occurredAt: stripeTimestamp(refund.created),
      status: refundStatus(refund.status),
    };
  }

  verifyWebhook(
    rawPayload: Buffer,
    signature: string,
    configs: readonly PaymentProviderContext[] = [],
  ): VerifiedPaymentWebhook {
    if (
      !Buffer.isBuffer(rawPayload) || rawPayload.byteLength < 2
      || rawPayload.byteLength > 64_000 || typeof signature !== 'string'
      || signature.length < 16 || signature.length > 8_192
    ) {
      throw new BadRequestException('Stripe webhook payload is invalid');
    }
    if (configs.length < 1 || configs.length > MAX_WEBHOOK_SECRETS) {
      throw new UnauthorizedException('Stripe webhook signature is invalid');
    }
    let event: Stripe.Event | undefined;
    let matched: PaymentProviderContext | undefined;
    for (const config of configs) {
      const credentials = requireStripeContext(config);
      try {
        const candidate = this.factory(credentials.secretKey).webhooks.constructEvent(
          rawPayload,
          signature,
          credentials.webhookSecret,
          300,
        );
        if (
          candidate.livemode !== (credentials.mode === 'live')
          || (typeof candidate.account === 'string'
            && candidate.account !== credentials.accountId)
        ) {
          continue;
        }
        event = candidate;
        matched = config;
        break;
      } catch {
        // Every candidate is intentionally tried with the same generic outcome.
      }
    }
    if (!event || !matched) {
      throw new UnauthorizedException('Stripe webhook signature is invalid');
    }
    return verifiedEvent(event);
  }

  async testCredentials(config: PaymentProviderContext): Promise<void> {
    const credentials = requireStripeContext(config);
    let account: Stripe.Account;
    try {
      account = await this.factory(credentials.secretKey).accounts.retrieveCurrent();
    } catch (error) {
      throw classifyStripeError(error);
    }
    if (account.id !== credentials.accountId) {
      throw new StripeAccountMismatchError();
    }
  }
}

function verifiedEvent(event: Stripe.Event): VerifiedPaymentWebhook {
  const eventId = stripeId(event.id, 'evt_', 'Stripe event');
  const occurredAt = stripeTimestamp(event.created);
  if (event.type === 'checkout.session.completed'
    || event.type === 'checkout.session.expired') {
    const session = event.data.object as Stripe.Checkout.Session;
    const attemptReference = uuid(session.client_reference_id, 'Stripe client reference');
    requireMetadataUuid(session.metadata, 'attemptId', attemptReference);
    requireMetadataUuid(session.metadata, 'orderId');
    const amountMinor = safeInteger(session.amount_total, 'Stripe checkout amount');
    const currency = stripeCurrency(session.currency);
    const externalPaymentId = stripeId(session.id, 'cs_', 'Checkout Session');
    if (event.type === 'checkout.session.expired') {
      return {
        amountMinor,
        attemptReference,
        currency,
        eventId,
        eventType: 'payment.expired',
        externalPaymentId,
        externalTransactionId: externalPaymentId,
        kind: 'payment',
        livemode: event.livemode,
        occurredAt,
      };
    }
    if (session.mode !== 'payment' || session.payment_status !== 'paid') {
      throw new BadRequestException('Stripe Checkout Session is not paid');
    }
    if (typeof session.payment_intent !== 'string') {
      throw new BadRequestException('Stripe Checkout Session has no PaymentIntent');
    }
    return {
      amountMinor,
      attemptReference,
      currency,
      eventId,
      eventType: 'payment.succeeded',
      externalPaymentId,
      externalTransactionId: stripeId(session.payment_intent, 'pi_', 'PaymentIntent'),
      kind: 'payment',
      livemode: event.livemode,
      occurredAt,
    };
  }
  if (event.type === 'refund.updated' || event.type === 'refund.failed') {
    const refund = event.data.object as Stripe.Refund;
    if (typeof refund.payment_intent !== 'string') {
      throw new BadRequestException('Stripe refund has no PaymentIntent');
    }
    const status = event.type === 'refund.failed' ? 'failed' : refund.status;
    return {
      amountMinor: safeInteger(refund.amount, 'Stripe refund amount'),
      currency: stripeCurrency(refund.currency),
      eventId,
      eventType: `refund.${refundStatus(status)}` as
        'refund.failed' | 'refund.pending' | 'refund.succeeded',
      externalPaymentId: stripeId(refund.payment_intent, 'pi_', 'PaymentIntent'),
      externalRefundId: stripeId(refund.id, 're_', 'Refund'),
      kind: 'refund',
      livemode: event.livemode,
      occurredAt,
      refundReference: requireMetadataUuid(refund.metadata, 'refundId'),
    };
  }
  throw new BadRequestException('Stripe webhook event type is not supported');
}

function checkoutAction(
  session: Stripe.Checkout.Session,
  expected: Pick<
    GetAdapterCheckoutInput,
    'amountMinor' | 'attemptId' | 'currency' | 'expiresAt' | 'orderId'
  >,
): RedirectCheckoutAction {
  const sessionExpiresAt = stripeTimestamp(session.expires_at);
  if (
    session.mode !== 'payment'
    || session.client_reference_id !== expected.attemptId
    || safeInteger(session.amount_total, 'Stripe checkout amount') !== expected.amountMinor
    || stripeCurrency(session.currency) !== expected.currency
    || sessionExpiresAt.getTime()
      !== Math.floor(expected.expiresAt.getTime() / 1_000) * 1_000
  ) {
    throw new PaymentAdapterDefinitiveError('Stripe Checkout Session does not match the order');
  }
  requireMetadataUuid(session.metadata, 'attemptId', expected.attemptId);
  requireMetadataUuid(session.metadata, 'orderId', expected.orderId);
  if (typeof session.url !== 'string') {
    throw new PaymentAdapterDefinitiveError('Stripe Checkout Session URL is unavailable');
  }
  const url = new URL(session.url);
  if (
    url.protocol !== 'https:' || url.hostname !== 'checkout.stripe.com'
    || url.username || url.password || session.url.length > 8_192
  ) {
    throw new PaymentAdapterDefinitiveError('Stripe Checkout Session URL is invalid');
  }
  return {
    expiresAt: sessionExpiresAt.toISOString(),
    type: 'redirect',
    url: session.url,
  };
}

function requireStripeContext(config: PaymentProviderContext) {
  const credentials = config.credentials;
  if (
    !credentials || config.secretVersion === undefined
    || !Number.isInteger(config.secretVersion) || config.secretVersion < 1
  ) {
    throw new ServiceUnavailableException('Stripe payment configuration is unavailable');
  }
  return credentials;
}

function validateStripeAmount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 99_999_999) {
    throw new PaymentAdapterDefinitiveError('Amount is outside Stripe limits');
  }
}

function safeMetadata(input: CreateAdapterPaymentInput): Record<string, string> {
  return {
    attemptId: input.attemptId,
    orderId: input.orderId,
  };
}

function trustedReturnUrl(value: string, allowSessionTemplate = false): string {
  if (typeof value !== 'string' || value.length > 1_024) {
    throw new PaymentAdapterDefinitiveError('Checkout return URL is invalid');
  }
  const template = '{CHECKOUT_SESSION_ID}';
  const parseable = allowSessionTemplate ? value.replace(template, 'session') : value;
  let url: URL;
  try {
    url = new URL(parseable);
  } catch {
    throw new PaymentAdapterDefinitiveError('Checkout return URL is invalid');
  }
  if (
    url.protocol !== 'https:' || url.username || url.password || url.hash
    || !/^[a-z0-9.-]{1,253}$/.test(url.hostname)
    || (allowSessionTemplate && !value.includes(template))
  ) {
    throw new PaymentAdapterDefinitiveError('Checkout return URL is invalid');
  }
  return value;
}

function stripeCurrency(value: string | null): CommerceCurrency {
  const currency = value?.toUpperCase();
  if (!['CNY', 'USD', 'EUR', 'JPY', 'KRW'].includes(currency ?? '')) {
    throw new BadRequestException('Stripe currency is unsupported');
  }
  return currency as CommerceCurrency;
}

function refundStatus(value: string | null): 'failed' | 'pending' | 'succeeded' {
  if (value === 'succeeded') return 'succeeded';
  if (value === 'pending' || value === 'requires_action') return 'pending';
  if (value === 'failed' || value === 'canceled') return 'failed';
  throw new BadRequestException('Stripe refund status is invalid');
}

function stripeId(value: unknown, prefix: string, label: string): string {
  if (typeof value !== 'string' || !new RegExp(`^${prefix}[A-Za-z0-9_]{8,255}$`).test(value)) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return value;
}

function uuid(value: unknown, label: string): string {
  if (
    typeof value !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return value;
}

function requireMetadataUuid(
  metadata: Stripe.Metadata | null,
  key: string,
  expected?: string,
): string {
  const value = metadata?.[key];
  const parsed = uuid(value, `Stripe metadata ${key}`);
  if (expected && parsed !== expected) {
    throw new BadRequestException(`Stripe metadata ${key} does not match`);
  }
  return parsed;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new BadRequestException(`${label} is invalid`);
  }
  return value;
}

function stripeTimestamp(value: unknown): Date {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new BadRequestException('Stripe timestamp is invalid');
  }
  const date = new Date(value * 1000);
  if (!Number.isFinite(date.getTime())) {
    throw new BadRequestException('Stripe timestamp is invalid');
  }
  return date;
}

function classifyStripeError(error: unknown): Error {
  if (error instanceof PaymentAdapterDefinitiveError) return error;
  if (error instanceof Stripe.errors.StripeError) {
    if (
      error.statusCode === 429
      || (typeof error.statusCode === 'number' && error.statusCode >= 500)
      || error.type === 'StripeConnectionError'
      || error.type === 'StripeAPIError'
    ) {
      return new StripeProviderUnavailableError();
    }
    return new PaymentAdapterDefinitiveError('Stripe rejected the request');
  }
  return new StripeProviderUnavailableError();
}
