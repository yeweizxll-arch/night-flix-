import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { AppStoreServerAPIClient, Environment, SignedDataVerifier, type JWSTransactionDecodedPayload } from '@apple/app-store-server-library';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { nativeStoreConfig, privateFile, type NativeStore, type NativeStoreConfig } from './native-store-config';

export interface VerifiedNativePurchase {
  store: NativeStore; applicationId: string; environment: 'Sandbox' | 'Production';
  externalId: string; originalId: string; productId: string; accountBinding: string;
  kind: 'points_topup' | 'membership'; currency: string; grossMinor: string;
  netMinor: string | null; refundedMinor: string; tokenHash: string;
  purchasedAt: Date; expiresAt: Date | null; observedAt: Date;
  status: 'active' | 'inactive' | 'refunded';
  needsAcknowledgement?: boolean;
}
type Json = Record<string, any>;
const currencies = new Set(Intl.supportedValuesOf('currency'));
export function storeMoney(currency: unknown, numerator: bigint, denominator: bigint): string {
  if (typeof currency !== 'string' || !currencies.has(currency) || numerator < 0n) throw new Error('Invalid store money');
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  const scaled = numerator * (10n ** BigInt(digits));
  if (scaled % denominator !== 0n || scaled / denominator > 9_000_000_000_000_000n) throw new Error('Unrepresentable store money');
  return (scaled / denominator).toString();
}
function money(value: Json, currency: string) {
  if (!value || value.currencyCode !== currency || !/^[0-9]{1,16}$/.test(String(value.units ?? '0'))
    || !Number.isInteger(value.nanos ?? 0) || (value.nanos ?? 0) < 0 || (value.nanos ?? 0) >= 1e9) throw new Error('Invalid verified money');
  return storeMoney(currency, BigInt(value.units ?? '0') * 1_000_000_000n + BigInt(value.nanos ?? 0), 1_000_000_000n);
}
function date(value: unknown): Date {
  const result = new Date(value as string | number);
  if (!value || Number.isNaN(result.getTime()) || result.getTime() > Date.now() + 60_000) throw new Error('Invalid store timestamp');
  return result;
}
function expiry(value: unknown): Date | null {
  if (!value) return null;
  const result = new Date(value as string | number);
  if (Number.isNaN(result.getTime())) throw new Error('Invalid store expiry');
  return result;
}
export function verifiedApplePurchase(payload: JWSTransactionDecodedPayload, config: NativeStoreConfig): VerifiedNativePurchase {
  const mapping = config.products[payload.productId ?? ''];
  if (!mapping || payload.bundleId !== config.applicationId || payload.environment !== config.environment
    || !payload.transactionId || !/^[0-9]{1,40}$/.test(payload.transactionId)
    || !payload.originalTransactionId || payload.quantity !== 1 || !payload.appAccountToken
    || payload.inAppOwnershipType !== 'PURCHASED' || !Number.isSafeInteger(payload.price)
    || (mapping.kind === 'membership' ? payload.type !== 'Auto-Renewable Subscription' : payload.type !== 'Consumable')) {
    throw new Error('Apple transaction scope or product mismatch');
  }
  const grossMinor = storeMoney(payload.currency, BigInt(payload.price!), 1000n);
  const expiresAt = expiry(payload.expiresDate);
  if (mapping.kind === 'membership' && !expiresAt) throw new Error('Subscription expiry missing');
  return { store: 'apple', applicationId: config.applicationId, environment: config.environment,
    externalId: payload.transactionId, originalId: payload.originalTransactionId, productId: payload.productId!,
    accountBinding: payload.appAccountToken.toLowerCase(), kind: mapping.kind, currency: payload.currency!, grossMinor,
    netMinor: null, refundedMinor: payload.revocationDate ? grossMinor : '0',
    tokenHash: createHash('sha256').update(payload.originalTransactionId).digest('hex'),
    purchasedAt: date(payload.purchaseDate), expiresAt, observedAt: date(payload.signedDate),
    status: payload.revocationDate ? 'refunded' : expiresAt && expiresAt <= new Date() ? 'inactive' : 'active' };
}

export function verifiedGooglePurchase(purchase: Json, order: Json, config: NativeStoreConfig,
  productId: string, token: string): VerifiedNativePurchase {
  const mapping = config.products[productId];
  if (!mapping) throw new Error('Unknown store product');
  const subscription = mapping.kind === 'membership';
  const lines = subscription ? purchase.lineItems : purchase.productLineItem;
  const line = Array.isArray(lines) && lines.length === 1 ? lines[0] : undefined;
  const externalId = subscription ? line?.latestSuccessfulOrderId : purchase.orderId;
  const test = Boolean(subscription ? purchase.testPurchase : purchase.testPurchaseContext);
  const orderLines = order.lineItems;
  if (!line || line.productId !== productId || !externalId || externalId !== order.orderId
    || order.purchaseToken !== token || test !== (config.environment === 'Sandbox')
    || !Array.isArray(orderLines) || orderLines.length !== 1 || orderLines[0]?.productId !== productId
    || (!subscription && orderLines[0]?.oneTimePurchaseDetails?.quantity !== 1)
    || !['PROCESSED', 'PENDING_REFUND', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(order.state)) {
    throw new Error('Google transaction scope or status mismatch');
  }
  const binding = subscription ? purchase.externalAccountIdentifiers?.obfuscatedExternalAccountId : purchase.obfuscatedExternalAccountId;
  if (typeof binding !== 'string') throw new Error('Purchase account binding is missing');
  const currency = order.total?.currencyCode;
  const grossMinor = money(order.total, currency);
  let refunded = 0n;
  if (order.state === 'REFUNDED') refunded = BigInt(grossMinor);
  else if (order.state === 'PARTIALLY_REFUNDED') {
    const refunds = order.orderHistory?.partialRefundEvents;
    if (!Array.isArray(refunds)) throw new Error('Refund history unavailable');
    for (const item of refunds) if (item.state === 'PROCESSED_SUCCESSFULLY') refunded += BigInt(money(item.refundDetails?.total, currency));
  }
  if (refunded > BigInt(grossMinor)) throw new Error('Refund exceeds charge');
  const expiresAt = expiry(subscription ? line.expiryTime : null);
  if (subscription && !expiresAt) throw new Error('Subscription expiry missing');
  const active = subscription ? ['SUBSCRIPTION_STATE_ACTIVE', 'SUBSCRIPTION_STATE_CANCELED', 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD'].includes(purchase.subscriptionState)
    && expiresAt! > new Date() : purchase.purchaseStateContext?.purchaseState === 'PURCHASED';
  return { store: 'google', applicationId: config.applicationId, environment: config.environment,
    needsAcknowledgement: purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_PENDING',
    externalId, originalId: token, productId, accountBinding: binding, kind: mapping.kind, currency,
    grossMinor, netMinor: optionalNetMoney(order.developerRevenueInBuyerCurrency, currency),
    refundedMinor: refunded.toString(), tokenHash: createHash('sha256').update(token).digest('hex'),
    purchasedAt: date(order.createTime), expiresAt, observedAt: date(order.lastEventTime),
    status: order.state === 'REFUNDED' ? 'refunded' : active ? 'active' : 'inactive' };
}

@Injectable()
export class NativeReceiptVerifier {
  private verifying = 0;
  async acknowledgeGoogle(tenantId: string, purchase: VerifiedNativePurchase, token: string) {
    if (purchase.store !== 'google' || !purchase.needsAcknowledgement || purchase.status === 'refunded') return;
    const config = nativeStoreConfig(tenantId, 'google');
    if (!config) throw new ServiceUnavailableException('Store configuration unavailable');
    const auth = new GoogleAuth({ credentials: JSON.parse(privateFile(config.google!.serviceAccountPath).toString('utf8')),
      scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
    const api = await auth.getClient();
    const kind = purchase.kind === 'membership' ? 'subscriptions' : 'products';
    try {
      await api.request({ url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(config.applicationId)}/purchases/${kind}/${encodeURIComponent(purchase.productId)}/tokens/${encodeURIComponent(token)}:acknowledge`,
        method: 'POST', data: {}, timeout: 10000, retry: false });
    } catch { throw new ServiceUnavailableException('Purchase saved; store acknowledgement needs retry'); }
  }

  async verify(tenantId: string, store: NativeStore, productId: string, receipt: string): Promise<VerifiedNativePurchase> {
    if (this.verifying >= 16) throw new ServiceUnavailableException('Store verification busy; retry later');
    this.verifying++;
    try { return await this.verifyPurchase(tenantId, store, productId, receipt); }
    finally { this.verifying--; }
  }

  private async verifyPurchase(tenantId: string, store: NativeStore, productId: string, receipt: string): Promise<VerifiedNativePurchase> {
    const verificationStarted = new Date();
    const config = nativeStoreConfig(tenantId, store);
    if (!config || !config.products[productId]) throw new UnauthorizedException('Store product is unavailable');
    if (typeof receipt !== 'string' || receipt.length < 8 || receipt.length > 32000) throw new UnauthorizedException('Invalid purchase proof');
    try {
      if (store === 'apple') {
        const verifier = this.appleVerifier(config);
        const clientProof = await verifier.verifyAndDecodeTransaction(receipt);
        if (clientProof.productId !== productId || !clientProof.transactionId) throw new Error('Product mismatch');
        const credentials = config.apple!;
        const api = new AppStoreServerAPIClient(privateFile(credentials.privateKeyPath).toString('utf8'),
          credentials.keyId, credentials.issuerId, config.applicationId, config.environment as Environment);
        // Retrieve current revocation state; a previously valid client JWS is not sufficient.
        const current = await api.getTransactionInfo(clientProof.transactionId);
        const verified = verifiedApplePurchase(await verifier.verifyAndDecodeTransaction(current.signedTransactionInfo!), config);
        if (verified.externalId !== clientProof.transactionId) throw new Error('Transaction mismatch');
        return verified;
      }
      const auth = new GoogleAuth({ credentials: JSON.parse(privateFile(config.google!.serviceAccountPath).toString('utf8')),
        scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
      const api = await auth.getClient();
      const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(config.applicationId)}`;
      const subscription = config.products[productId]!.kind === 'membership';
      const { data: purchase } = await api.request<Json>({ url: `${base}/purchases/${subscription ? 'subscriptionsv2' : 'productsv2'}/tokens/${encodeURIComponent(receipt)}`, timeout: 10000, retry: false });
      const orderId = subscription ? purchase.lineItems?.[0]?.latestSuccessfulOrderId : purchase.orderId;
      if (typeof orderId !== 'string') throw new Error('Purchase is not paid');
      const { data: order } = await api.request<Json>({ url: `${base}/orders/${encodeURIComponent(orderId)}`, timeout: 10000, retry: false });
      const verified = verifiedGooglePurchase(purchase, order, config, productId, receipt);
      // Raw purchase tokens are never persisted in the ledger or exposed by management APIs.
      verified.originalId = verified.tokenHash;
      // Order timestamps do not always change for subscription holds/grace periods.
      // Reject late results from an earlier verification request in the database.
      if (verified.observedAt < verificationStarted) verified.observedAt = verificationStarted;
      return verified;
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException('Store verification could not be completed; retry without repurchasing');
    }
  }

  async appleNotification(tenantId: string, payload: string) {
    const config = nativeStoreConfig(tenantId, 'apple');
    if (!config || typeof payload !== 'string' || payload.length > 64000) throw new UnauthorizedException();
    const decoded = await this.appleVerifier(config).verifyAndDecodeNotification(payload);
    const transaction = decoded.data?.signedTransactionInfo;
    if (!transaction) return undefined;
    const proof = await this.appleVerifier(config).verifyAndDecodeTransaction(transaction);
    if (!proof.productId) throw new UnauthorizedException();
    return this.verify(tenantId, 'apple', proof.productId, transaction);
  }

  async googleNotificationIdentity(tenantId: string, bearer: string) {
    const config = nativeStoreConfig(tenantId, 'google');
    if (!config || typeof bearer !== 'string' || !bearer.startsWith('Bearer ') || bearer.length > 16384) throw new UnauthorizedException();
    const result = await new OAuth2Client().verifyIdToken({ idToken: bearer.slice(7), audience: config.google!.notificationAudience });
    const payload = result.getPayload();
    if (!payload || payload.email_verified !== true || payload.email !== config.google!.notificationEmail) throw new UnauthorizedException();
  }

  async googleHistoricalRefund(tenantId: string, token: string, previous: VerifiedNativePurchase) {
    const config = nativeStoreConfig(tenantId, 'google');
    if (!config || this.verifying >= 16) throw new ServiceUnavailableException('Store verification unavailable');
    this.verifying++;
    try {
      const auth = new GoogleAuth({ credentials: JSON.parse(privateFile(config.google!.serviceAccountPath).toString('utf8')),
        scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
      const api = await auth.getClient();
      const { data: order } = await api.request<Json>({ url: `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(config.applicationId)}/orders/${encodeURIComponent(previous.externalId)}`, timeout: 10000, retry: false });
      return verifiedGoogleHistoricalRefund(order, config, token, previous);
    } catch { throw new ServiceUnavailableException('Historical refund needs verification retry'); }
    finally { this.verifying--; }
  }

  private appleVerifier(config: NativeStoreConfig) {
    return new SignedDataVerifier(config.apple!.rootCertificatePaths.map(path => privateFile(path)), true,
      config.environment as Environment, config.applicationId, config.apple!.appAppleId);
  }
}

function optionalNetMoney(value: Json | undefined, currency: string): string | null {
  // Sub-cent payout estimates do not justify rejecting a valid customer's purchase.
  // They remain unvalued until an exact headquarters-reconciled statement is available.
  try { return value ? money(value, currency) : null; } catch { return null; }
}

export function verifiedGoogleHistoricalRefund(order: Json, config: NativeStoreConfig, token: string, previous: VerifiedNativePurchase): VerifiedNativePurchase {
  if (previous.store !== 'google' || previous.applicationId !== config.applicationId || previous.environment !== config.environment
    || previous.tokenHash !== createHash('sha256').update(token).digest('hex')
    || order.orderId !== previous.externalId || order.purchaseToken !== token
    || !['REFUNDED', 'PARTIALLY_REFUNDED'].includes(order.state)
    || !Array.isArray(order.lineItems) || order.lineItems.length !== 1 || order.lineItems[0].productId !== previous.productId
    || money(order.total, previous.currency) !== previous.grossMinor) throw new Error('Historical refund scope mismatch');
  let refunded = order.state === 'REFUNDED' ? BigInt(previous.grossMinor) : 0n;
  if (order.state === 'PARTIALLY_REFUNDED') {
    const events = order.orderHistory?.partialRefundEvents;
    if (!Array.isArray(events)) throw new Error('Refund history missing');
    for (const event of events) if (event.state === 'PROCESSED_SUCCESSFULLY') refunded += BigInt(money(event.refundDetails?.total, previous.currency));
  }
  if (refunded > BigInt(previous.grossMinor)) throw new Error('Refund exceeds original purchase');
  return { ...previous, refundedMinor: refunded.toString(), observedAt: new Date(),
    status: order.state === 'REFUNDED' ? 'refunded' : previous.status, needsAcknowledgement: false };
}
