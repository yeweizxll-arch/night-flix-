import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createHmac,
  timingSafeEqual,
} from 'node:crypto';

import type { CommerceCurrency } from './commerce.types';
import type { StripeCredentials } from './payment-secret-cipher';

export interface RedirectCheckoutAction {
  expiresAt: string;
  type: 'redirect';
  url: string;
}

export interface PaymentProviderContext {
  configId: string;
  configVersion: number;
  credentials?: StripeCredentials;
  providerId: string;
  secretVersion?: number;
}

export interface CreateAdapterPaymentInput {
  amountMinor: number;
  attemptId: string;
  cancelUrl: string;
  config: PaymentProviderContext;
  currency: CommerceCurrency;
  expiresAt: Date;
  orderId: string;
  orderNo: string;
  providerIdempotencyKey: string;
  successUrl: string;
}

export interface AdapterPaymentResult {
  checkoutAction?: RedirectCheckoutAction;
  /** Legacy fake-adapter compatibility; never exposed by the customer API. */
  checkoutReference?: string;
  externalPaymentId: string;
  status: 'pending';
}

export interface GetAdapterCheckoutInput {
  amountMinor: number;
  attemptId: string;
  config: PaymentProviderContext;
  currency: CommerceCurrency;
  expiresAt: Date;
  externalPaymentId: string;
  orderId: string;
}

export interface CreateAdapterRefundInput {
  amountMinor: number;
  chargeExternalTransactionId: string;
  config: PaymentProviderContext;
  currency: CommerceCurrency;
  externalPaymentId: string;
  orderId: string;
  providerIdempotencyKey: string;
  refundId: string;
}

export interface AdapterRefundResult {
  amountMinor: number;
  currency: CommerceCurrency;
  externalRefundId: string;
  occurredAt: Date;
  status: 'failed' | 'pending' | 'succeeded';
}

export interface VerifiedChargeWebhook {
  amountMinor: number;
  attemptReference: string;
  currency: CommerceCurrency;
  eventId: string;
  eventType: 'payment.expired' | 'payment.failed' | 'payment.succeeded';
  externalPaymentId: string;
  externalTransactionId: string;
  occurredAt: Date;
  kind: 'payment';
  livemode?: boolean;
}

export interface VerifiedRefundWebhook {
  amountMinor: number;
  currency: CommerceCurrency;
  eventId: string;
  eventType: 'refund.failed' | 'refund.pending' | 'refund.succeeded';
  externalPaymentId: string;
  externalRefundId: string;
  kind: 'refund';
  livemode?: boolean;
  occurredAt: Date;
  refundReference: string;
}

export type VerifiedPaymentWebhook = VerifiedChargeWebhook | VerifiedRefundWebhook;

export interface PaymentAdapter {
  readonly code: string;
  createPayment(input: CreateAdapterPaymentInput): Promise<AdapterPaymentResult>;
  getCheckoutAction?(
    input: GetAdapterCheckoutInput,
  ): Promise<RedirectCheckoutAction | null>;
  refundPayment(input: CreateAdapterRefundInput): Promise<AdapterRefundResult>;
  verifyWebhook(
    rawPayload: Buffer,
    signature: string,
    configs?: readonly PaymentProviderContext[],
  ): VerifiedPaymentWebhook;
}

/** Only explicit, provider-confirmed rejections may terminally fail an initialized attempt. */
export class PaymentAdapterDefinitiveError extends Error {}

@Injectable()
export class FakePaymentAdapter implements PaymentAdapter {
  readonly code = 'fake';

  async createPayment(input: CreateAdapterPaymentInput): Promise<AdapterPaymentResult> {
    assertFakeAllowed();
    return {
      checkoutAction: {
        expiresAt: input.expiresAt.toISOString(),
        type: 'redirect',
        url: `https://checkout.invalid/${input.providerIdempotencyKey.replaceAll('-', '')}`,
      },
      checkoutReference: `fake_checkout_${input.providerIdempotencyKey.replaceAll('-', '')}`,
      externalPaymentId: `fake_pay_${input.attemptId.replaceAll('-', '')}`,
      status: 'pending',
    };
  }

  async getCheckoutAction(input: GetAdapterCheckoutInput): Promise<RedirectCheckoutAction> {
    assertFakeAllowed();
    return {
      expiresAt: input.expiresAt.toISOString(),
      type: 'redirect',
      url: `https://checkout.invalid/${input.attemptId.replaceAll('-', '')}`,
    };
  }

  async refundPayment(input: CreateAdapterRefundInput): Promise<AdapterRefundResult> {
    assertFakeAllowed();
    return {
      amountMinor: input.amountMinor,
      currency: input.currency,
      externalRefundId: `fake_refund_${input.refundId.replaceAll('-', '')}`,
      occurredAt: new Date(),
      status: 'succeeded',
    };
  }

  verifyWebhook(rawPayload: Buffer, signature: string): VerifiedPaymentWebhook {
    assertFakeAllowed();
    if (!Buffer.isBuffer(rawPayload) || rawPayload.byteLength < 2 || rawPayload.byteLength > 64_000) {
      throw new BadRequestException('Webhook payload is invalid');
    }
    const expected = createHmac('sha256', fakeWebhookSecret())
      .update(rawPayload)
      .digest();
    let received: Buffer;
    try {
      received = Buffer.from(signature, 'hex');
    } catch {
      throw new UnauthorizedException('Webhook signature is invalid');
    }
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      throw new UnauthorizedException('Webhook signature is invalid');
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawPayload.toString('utf8'));
    } catch {
      throw new BadRequestException('Webhook payload is invalid');
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new BadRequestException('Webhook payload is invalid');
    }
    const value = raw as Record<string, unknown>;
    if (
      typeof value.eventId !== 'string'
      || !/^[A-Za-z0-9._:-]{3,300}$/.test(value.eventId)
      || (value.eventType !== 'payment.succeeded' && value.eventType !== 'payment.failed')
      || typeof value.externalPaymentId !== 'string'
      || !/^fake_pay_[a-f0-9]{32}$/.test(value.externalPaymentId)
      || typeof value.externalTransactionId !== 'string'
      || !/^[A-Za-z0-9._:-]{3,300}$/.test(value.externalTransactionId)
      || typeof value.amountMinor !== 'number'
      || !Number.isSafeInteger(value.amountMinor)
      || value.amountMinor < 1
      || value.amountMinor > 9_000_000_000_000_000
      || !['CNY', 'USD', 'EUR', 'JPY', 'KRW'].includes(String(value.currency))
      || typeof value.occurredAt !== 'string'
      || typeof value.attemptReference !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        value.attemptReference,
      )
    ) {
      throw new BadRequestException('Webhook event fields are invalid');
    }
    const occurredAt = new Date(value.occurredAt);
    if (
      !Number.isFinite(occurredAt.getTime())
      || occurredAt.getTime() > Date.now() + 60_000
      || occurredAt.getTime() <= Date.now() - 24 * 60 * 60 * 1000
    ) {
      throw new BadRequestException('Webhook occurredAt is invalid');
    }
    return {
      amountMinor: value.amountMinor,
      attemptReference: value.attemptReference,
      currency: value.currency as CommerceCurrency,
      eventId: value.eventId,
      eventType: value.eventType,
      externalPaymentId: value.externalPaymentId,
      externalTransactionId: value.externalTransactionId,
      occurredAt,
      kind: 'payment',
    };
  }
}

@Injectable()
export class PaymentAdapterRegistry {
  private readonly adapters: ReadonlyMap<string, PaymentAdapter>;

  constructor(
    @Inject(FakePaymentAdapter) fake: FakePaymentAdapter,
    @Optional()
    @Inject('STRIPE_PAYMENT_ADAPTER') stripe?: PaymentAdapter,
  ) {
    const adapters: Array<[string, PaymentAdapter]> = [[fake.code, fake]];
    if (stripe) adapters.push([stripe.code, stripe]);
    this.adapters = new Map(adapters);
  }

  require(adapterCode: string): PaymentAdapter {
    const adapter = this.adapters.get(adapterCode);
    if (!adapter) throw new ServiceUnavailableException('Payment adapter is not installed');
    return adapter;
  }
}

export function signFakePaymentWebhook(rawPayload: string | Buffer): string {
  assertFakeAllowed();
  return createHmac('sha256', fakeWebhookSecret()).update(rawPayload).digest('hex');
}

function assertFakeAllowed(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new ServiceUnavailableException('The fake payment adapter is disabled in production');
  }
}

function fakeWebhookSecret(): string {
  const secret = process.env.FAKE_PAYMENT_WEBHOOK_SECRET
    ?? 'local-test-only-fake-payment-secret-change-me';
  if (secret.length < 32 || secret.length > 512 || /[\r\n\0]/.test(secret)) {
    throw new Error('FAKE_PAYMENT_WEBHOOK_SECRET must contain 32 to 512 safe characters');
  }
  return secret;
}
