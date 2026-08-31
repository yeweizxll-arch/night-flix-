import type { CustomerRequestInit, StorageLike } from './api/client';
import type {
  CommerceCurrency,
  CommerceOrderInput,
  CommerceOrderSummary,
  CommerceQuote,
  PaymentAttempt,
  RedirectCheckoutAction,
} from './api/types';

const PENDING_CHECKOUT_KEY = 'drama_h5_pending_checkout';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CheckoutApi {
  request<T>(path: string, init?: CustomerRequestInit): Promise<T>;
}

export interface PendingCheckout {
  attemptId: string;
  createdAt: string;
  orderId: string;
}

export interface CheckoutIdempotencyKeys {
  order: string;
  payment: string;
}

export type CheckoutStartResult =
  | { order: CommerceOrderSummary; status: 'price_changed' }
  | { attempt: PaymentAttempt; order: CommerceOrderSummary; status: 'unavailable' }
  | { attempt: PaymentAttempt; order: CommerceOrderSummary; status: 'redirected' };

export async function beginHostedCheckout(input: {
  api: CheckoutApi;
  idempotencyKeys: CheckoutIdempotencyKeys;
  now?: number;
  orderInput: CommerceOrderInput;
  quote: CommerceQuote;
  redirect: (url: string) => void;
  storage: StorageLike;
}): Promise<CheckoutStartResult> {
  const order = await input.api.request<CommerceOrderSummary>(
    '/api/v1/customer/commerce/orders',
    {
      cache: 'no-store',
      headers: { 'Idempotency-Key': input.idempotencyKeys.order },
      json: input.orderInput,
      method: 'POST',
    },
  );
  if (!orderMatchesQuote(order, input.quote, input.orderInput)) {
    return { order, status: 'price_changed' };
  }
  const attempt = await input.api.request<PaymentAttempt>(
    `/api/v1/customer/commerce/orders/${encodeURIComponent(order.id)}/payments`,
    {
      cache: 'no-store',
      headers: { 'Idempotency-Key': input.idempotencyKeys.payment },
      json: {},
      method: 'POST',
    },
  );
  const actionUrl = validatedStripeCheckoutUrl(
    attempt.checkoutAction,
    input.now ?? Date.now(),
  );
  if (
    !actionUrl
    || attempt.status !== 'pending'
    || attempt.orderId !== order.id
    || attempt.amountMinor !== order.totalMinor
    || attempt.currency !== order.currency
    || !UUID.test(attempt.id)
    || !['platform_collect', 'tenant_direct'].includes(attempt.collectionMode)
    || Date.parse(attempt.checkoutAction?.expiresAt ?? '')
      !== Math.floor(Date.parse(order.expiresAt) / 1_000) * 1_000
  ) {
    return { attempt, order, status: 'unavailable' };
  }
  writePendingCheckout(input.storage, {
    attemptId: attempt.id,
    createdAt: new Date(input.now ?? Date.now()).toISOString(),
    orderId: order.id,
  });
  input.redirect(actionUrl);
  return { attempt, order, status: 'redirected' };
}

export function validatedStripeCheckoutUrl(
  action: RedirectCheckoutAction | null | undefined,
  now = Date.now(),
): string | undefined {
  if (!action || action.type !== 'redirect' || typeof action.url !== 'string') return undefined;
  if (action.url.length < 1 || action.url.length > 8_192) return undefined;
  const expiresAt = Date.parse(action.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return undefined;
  try {
    const url = new URL(action.url);
    if (
      url.protocol !== 'https:'
      || url.hostname !== 'checkout.stripe.com'
      || url.port
      || url.username
      || url.password
      || url.hash
      || url.origin !== 'https://checkout.stripe.com'
    ) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

export function readPendingCheckout(
  storage: StorageLike,
  orderId: string,
): PendingCheckout | undefined {
  if (!UUID.test(orderId)) return undefined;
  try {
    const parsed = JSON.parse(storage.getItem(PENDING_CHECKOUT_KEY) ?? 'null') as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const value = parsed as Record<string, unknown>;
    if (
      value.orderId !== orderId
      || typeof value.attemptId !== 'string'
      || !UUID.test(value.attemptId)
      || typeof value.createdAt !== 'string'
      || !Number.isFinite(Date.parse(value.createdAt))
    ) return undefined;
    return {
      attemptId: value.attemptId,
      createdAt: value.createdAt,
      orderId,
    };
  } catch {
    return undefined;
  }
}

export function clearPendingCheckout(storage: StorageLike): void {
  storage.removeItem(PENDING_CHECKOUT_KEY);
}

export function createCheckoutIdempotencyKeys(): CheckoutIdempotencyKeys {
  return { order: crypto.randomUUID(), payment: crypto.randomUUID() };
}

export function isUuid(value: string | undefined): value is string {
  return Boolean(value && UUID.test(value));
}

export function formatMinorAmount(amountMinor: number, currency: CommerceCurrency): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) return `${currency} —`;
  const digits = currency === 'JPY' || currency === 'KRW' ? 0 : 2;
  const factor = 10n ** BigInt(digits);
  const amount = BigInt(amountMinor);
  const whole = (amount / factor).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = digits ? `.${(amount % factor).toString().padStart(digits, '0')}` : '';
  return `${currency} ${whole}${fraction}`;
}

function orderMatchesQuote(
  order: CommerceOrderSummary,
  quote: CommerceQuote,
  input: CommerceOrderInput,
): boolean {
  return UUID.test(order.id)
    && order.currency === quote.currency
    && order.currency === input.currency
    && order.locale === quote.locale
    && order.locale === input.locale
    && order.orderType === input.productType
    && order.item.id === input.productId
    && order.totalMinor === quote.totalMinor
    && order.item.unitAmountMinor === quote.totalMinor
    && Number.isSafeInteger(order.totalMinor)
    && order.totalMinor >= 0
    && Number.isFinite(Date.parse(order.expiresAt));
}

function writePendingCheckout(storage: StorageLike, value: PendingCheckout): void {
  storage.setItem(PENDING_CHECKOUT_KEY, JSON.stringify(value));
}
