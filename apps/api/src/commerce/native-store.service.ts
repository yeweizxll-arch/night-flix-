import { BadRequestException, ConflictException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';
import { assertCustomerSiteAvailable } from '../customer-auth/customer-site-policy';
import { requireUuid } from './commerce-validation';
import { nativeStoreConfig, type NativeStore, type NativeStoreConfig } from './native-store-config';
import { NativeReceiptVerifier, type VerifiedNativePurchase } from './native-receipt-verifier';

@Injectable()
export class NativeStoreService {
  constructor(@Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(NativeReceiptVerifier) private readonly verifier: NativeReceiptVerifier) {}

  async prepare(principal: CustomerPrincipal, product?: { store: NativeStore; productId: string }) {
    return this.database.inPlatformContext(async tx => {
      await assertCustomerSiteAvailable(tx, principal.tenantId);
      await lockAccount(tx, principal.tenantId, principal.accountId);
      if (product?.store !== undefined || product?.productId !== undefined) {
        if (!['apple', 'google'].includes(product.store) || typeof product.productId !== 'string') throw new BadRequestException('Invalid product');
        const config = nativeStoreConfig(principal.tenantId, product.store);
        if (!config || !Object.hasOwn(config.products, product.productId)) throw new BadRequestException('Unknown store product');
        const region = await tx<{ allowed: boolean }[]>`select app.customer_region_allowed(${principal.tenantId}::uuid, null::uuid) as allowed`;
        if (!region[0]?.allowed) throw new UnauthorizedException('Purchase unavailable in this region');
        await pinProduct(tx, principal.tenantId, product.store, product.productId, config, true);
      }
      await tx`insert into native_purchase_accounts(tenant_id, account_id, binding)
        values (${principal.tenantId}, ${principal.accountId}, ${uuidV7()}) on conflict (tenant_id, account_id) do nothing`;
      const rows = await tx<{ binding: string }[]>`select binding from native_purchase_accounts
        where tenant_id = ${principal.tenantId} and account_id = ${principal.accountId}`;
      return { accountBinding: rows[0]!.binding };
    });
  }

  async verify(principal: CustomerPrincipal, input: { store: NativeStore; productId: string; receipt: string }) {
    if (!input || !['apple', 'google'].includes(input.store) || typeof input.productId !== 'string') throw new BadRequestException('Invalid store input');
    const verified = await this.verifier.verify(principal.tenantId, input.store, input.productId, input.receipt);
    const result = await this.apply(principal.tenantId, verified, principal.accountId);
    await this.verifier.acknowledgeGoogle(principal.tenantId, verified, input.receipt);
    return result;
  }

  async appleNotification(tenantId: string, payload: string) {
    requireUuid(tenantId, 'tenantId');
    const verified = await this.verifier.appleNotification(tenantId, payload);
    return verified ? this.apply(tenantId, verified) : { ignored: true };
  }

  async googleNotification(tenantId: string, authorization: string, body: { message?: { data?: string } }) {
    requireUuid(tenantId, 'tenantId');
    await this.verifier.googleNotificationIdentity(tenantId, authorization);
    const encoded = body?.message?.data;
    if (typeof encoded !== 'string' || encoded.length > 48000 || !/^[A-Za-z0-9+/=]+$/.test(encoded)) throw new BadRequestException('Invalid store message');
    const message = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')) as Record<string, any>;
    const config = nativeStoreConfig(tenantId, 'google');
    if (message.packageName !== config?.applicationId) throw new UnauthorizedException('Store application mismatch');
    if (message.testNotification) return { test: true };
    const notice = message.subscriptionNotification ?? message.oneTimeProductNotification ?? message.voidedPurchaseNotification;
    if (!notice || typeof notice.purchaseToken !== 'string') throw new BadRequestException('Unsupported store message');
    if (message.voidedPurchaseNotification && typeof notice.orderId === 'string') {
      const rows = await this.database.inPlatformContext(tx => tx<Record<string, any>[]>`select t.*, a.binding
        from native_store_transactions t join native_purchase_accounts a on a.tenant_id = t.tenant_id and a.account_id = t.account_id
        where t.tenant_id = ${tenantId} and t.store = 'google' and t.application_id = ${config!.applicationId}
          and t.external_id = ${notice.orderId} and t.environment = ${config!.environment}
          and t.token_hash = ${createHash('sha256').update(notice.purchaseToken).digest('hex')}`);
      const row = rows[0];
      if (!row) throw new ConflictException('Original order confirmation missing; retry refund');
      const previous: VerifiedNativePurchase = { store: 'google', applicationId: row.application_id, environment: row.environment,
        externalId: row.external_id, originalId: row.original_id, productId: row.store_product_id, accountBinding: row.binding,
        kind: row.kind, currency: row.currency, grossMinor: String(row.gross_minor), netMinor: row.net_minor === null ? null : String(row.net_minor),
        refundedMinor: String(row.refunded_minor), tokenHash: row.token_hash, purchasedAt: new Date(row.purchased_at),
        expiresAt: row.expires_at ? new Date(row.expires_at) : null, observedAt: new Date(row.observed_at), status: row.status };
      // A voided prior renewal must not be applied to the subscription's newest order.
      return this.apply(tenantId, await this.verifier.googleHistoricalRefund(tenantId, notice.purchaseToken, previous));
    }
    let productId = notice.subscriptionId ?? notice.sku;
    if (!productId) {
      const records = await this.database.inPlatformContext(tx => tx<{ store_product_id: string }[]>`
        select store_product_id from native_store_transactions where tenant_id = ${tenantId} and store = 'google'
          and token_hash = ${createHash('sha256').update(notice.purchaseToken).digest('hex')} limit 1`);
      productId = records[0]?.store_product_id;
    }
    // A notification may arrive before the client confirmation. Do not ACK/drop unknown refunds.
    if (!productId) throw new ConflictException('Purchase confirmation has not arrived; retry notification');
    const verified = await this.verifier.verify(tenantId, 'google', productId, notice.purchaseToken);
    const result = await this.apply(tenantId, verified);
    await this.verifier.acknowledgeGoogle(tenantId, verified, notice.purchaseToken);
    return result;
  }

  async apply(tenantId: string, purchase: VerifiedNativePurchase, expectedAccountId?: string) {
    requireUuid(tenantId, 'tenantId');
    requireUuid(purchase.accountBinding, 'accountBinding');
    const config = nativeStoreConfig(tenantId, purchase.store);
    const mapping = config?.products[purchase.productId];
    if (!mapping || config?.applicationId !== purchase.applicationId || config.environment !== purchase.environment
      || mapping.kind !== purchase.kind) throw new UnauthorizedException('Purchase does not belong to this tenant');
    return this.database.inPlatformContext(async tx => {
      const bindings = await tx<{ account_id: string }[]>`select account_id from native_purchase_accounts
        where tenant_id = ${tenantId} and binding = ${purchase.accountBinding}`;
      const accountId = bindings[0]?.account_id;
      if (!accountId || (expectedAccountId && accountId !== expectedAccountId)) throw new UnauthorizedException('Purchase belongs to another account');
      // Notifications must reconcile refunds even when the customer/tenant has since been disabled.
      if (expectedAccountId) await assertCustomerSiteAvailable(tx, tenantId);
      await lockAccount(tx, tenantId, accountId, !expectedAccountId);
      const rows = await tx<Record<string, any>[]>`select * from native_store_transactions
        where store = ${purchase.store} and application_id = ${purchase.applicationId}
          and environment = ${purchase.environment} and external_id = ${purchase.externalId} for update`;
      let existing = rows[0];
      if (existing && (existing.tenant_id !== tenantId || existing.account_id !== accountId
        || existing.product_id !== mapping.productId || existing.currency !== purchase.currency
        || BigInt(existing.gross_minor) !== BigInt(purchase.grossMinor))) throw new ConflictException('Immutable store transaction mismatch');
      if (existing && (existing.status === 'refunded' || new Date(existing.observed_at) > purchase.observedAt)) {
        return { id: existing.id as string, duplicate: true, status: existing.status as string };
      }
      let points = 0n; let bonus = 0n;
      if (existing) { points = BigInt(existing.points_snapshot); bonus = BigInt(existing.bonus_snapshot); }
      else {
        const pinned = await pinProduct(tx, tenantId, purchase.store, purchase.productId, config);
        points = BigInt(pinned.points); bonus = BigInt(pinned.bonus);
      }
      const id: string = existing?.id ?? uuidV7();
      const wasCredited = existing !== undefined;
      if (!existing) {
        await tx`insert into native_store_transactions(id, tenant_id, account_id, store, application_id, environment,
          external_id, original_id, token_hash, store_product_id, product_id, kind, currency, gross_minor, net_minor,
          refunded_minor, points_snapshot, bonus_snapshot, status, purchased_at, expires_at, observed_at) values
          (${id}, ${tenantId}, ${accountId}, ${purchase.store}, ${purchase.applicationId}, ${purchase.environment},
          ${purchase.externalId}, ${purchase.originalId}, ${purchase.tokenHash}, ${purchase.productId}, ${mapping.productId},
          ${mapping.kind}, ${purchase.currency}, ${purchase.grossMinor}, ${purchase.netMinor}, ${purchase.refundedMinor},
          ${points.toString()}, ${bonus.toString()}, ${purchase.status}, ${purchase.purchasedAt}, ${purchase.expiresAt}, ${purchase.observedAt})`;
      } else {
        await tx`update native_store_transactions set refunded_minor = greatest(refunded_minor, ${purchase.refundedMinor}),
          net_minor = ${purchase.netMinor}, status = ${purchase.status}, expires_at = ${purchase.expiresAt}, observed_at = ${purchase.observedAt}
          where id = ${id}`;
      }
      if (mapping.kind === 'membership') {
        await tx`update entitlements set revoked_at = greatest(statement_timestamp(), starts_at), revoked_reason = 'native_store_state'
          where source_native_transaction_id = ${id} and revoked_at is null
            and (${purchase.status !== 'active'} or expires_at is distinct from ${purchase.expiresAt})`;
        if (purchase.status === 'active') {
          await tx`insert into entitlements(id, tenant_id, account_id, entitlement_type, product_id, source_type,
            source_native_transaction_id, starts_at, expires_at) values
            (${uuidV7()}, ${tenantId}, ${accountId}, 'membership', ${mapping.productId}, 'native_store', ${id}, ${purchase.purchasedAt}, ${purchase.expiresAt})
            on conflict (source_native_transaction_id, expires_at) where source_native_transaction_id is not null
            do update set revoked_at = null, revoked_reason = null
              where entitlements.revoked_reason = 'native_store_state'`;
        }
      } else {
        await tx`insert into point_accounts(id, tenant_id, account_id) values (${uuidV7()}, ${tenantId}, ${accountId})
          on conflict (tenant_id, account_id) do nothing`;
        const accounts = await tx<{ id: string; balance: string }[]>`select id, balance::text from point_accounts
          where tenant_id = ${tenantId} and account_id = ${accountId} for update`;
        const wallet = accounts[0]!;
        const credit = await tx<{ id: string }[]>`select id from point_ledger where tenant_id = ${tenantId}
          and reference_type = 'native_store_transaction' and reference_id = ${id} and entry_type = 'topup'`;
        if (!credit[0] && purchase.status === 'active') {
          await tx`insert into point_ledger(id, tenant_id, account_id, point_account_id, entry_type, delta, balance_after,
            reference_type, reference_id, idempotency_key, created_by_type, metadata_json) values
            (${uuidV7()}, ${tenantId}, ${accountId}, ${wallet.id}, 'topup', ${(points + bonus).toString()}, 0,
            'native_store_transaction', ${id}, ${'native:' + id + ':credit'}, 'system',
            ${tx.json({ pointsAmount: points.toString(), bonusPoints: bonus.toString() })})`;
        }
        // Reclaim only credits actually delivered; unknown pre-confirmation refunds never create a debt.
        if (credit[0] || purchase.status === 'active') {
          const total = points + bonus;
          const refunded = purchase.status === 'refunded' ? total : BigInt(purchase.grossMinor) === 0n ? 0n
            : (total * BigInt(purchase.refundedMinor) + BigInt(purchase.grossMinor) - 1n) / BigInt(purchase.grossMinor);
          const delta = refunded - BigInt(existing?.refunded_points ?? 0);
          if (delta > 0n) {
            // Split the cumulative reclaimed balance monotonically; bonus coins are not cash.
            const refundedPaid = (refunded * points + total - 1n) / total;
            const previouslyPaid = (BigInt(existing?.refunded_points ?? 0) * points + total - 1n) / total;
            const paidDelta = refundedPaid - previouslyPaid;
            await tx`insert into native_refund_debts(transaction_id, tenant_id, account_id, points, paid_points, bonus_points)
              values (${id}, ${tenantId}, ${accountId}, ${delta.toString()}, ${paidDelta.toString()}, ${(delta - paidDelta).toString()}) on conflict (transaction_id)
              do update set points = native_refund_debts.points + excluded.points,
                paid_points = native_refund_debts.paid_points + excluded.paid_points,
                bonus_points = native_refund_debts.bonus_points + excluded.bonus_points`;
            await tx`update native_store_transactions set refunded_points = ${refunded.toString()} where id = ${id}`;
          }
          await settleNativeRefundDebt(tx, tenantId, accountId);
        }
      }
      return { id, duplicate: wasCredited, status: purchase.status };
    });
  }

  async list(tenantId: string, accountId?: string) {
    return this.database.inPlatformContext(tx => tx<Record<string, unknown>[]>`select id, store, environment, store_product_id,
      kind, currency, gross_minor::text, net_minor::text, refunded_minor::text, status, purchased_at, expires_at
      from native_store_transactions where tenant_id = ${tenantId} and (${accountId ?? null}::uuid is null or account_id = ${accountId ?? null})
      order by purchased_at desc, id desc limit 100`);
  }
}

async function pinProduct(tx: DatabaseTransaction, tenantId: string, store: NativeStore, sku: string, config: NativeStoreConfig, requireActive = false) {
  const mapping = config.products[sku]!;
  const existing = await tx<{ product_id: string; kind: string; points: string; bonus: string }[]>`select product_id, kind, points::text, bonus::text
    from native_store_product_snapshots where tenant_id = ${tenantId} and store = ${store} and application_id = ${config.applicationId}
      and environment = ${config.environment} and store_product_id = ${sku}`;
  if (existing[0] && (existing[0].product_id !== mapping.productId || existing[0].kind !== mapping.kind))
    throw new ConflictException('Store SKU mapping is immutable; create a new SKU');
  if (existing[0] && !requireActive) return existing[0];
  const products = mapping.kind === 'points_topup'
    ? await tx<{ points: string; bonus: string; status: string }[]>`select points_amount::text as points, bonus_points::text as bonus, status
        from points_topup_packages where tenant_id = ${tenantId} and id = ${mapping.productId} for share`
    : await tx<{ points: string; bonus: string; status: string }[]>`select '0' as points, '0' as bonus, status
        from membership_plans where tenant_id = ${tenantId} and id = ${mapping.productId} for share`;
  const product = products[0];
  if (!product || (requireActive && product.status !== 'active')) throw new ConflictException('Store product is unavailable');
  if (existing[0]) return existing[0];
  await tx`insert into native_store_product_snapshots(tenant_id, store, application_id, environment, store_product_id, product_id, kind, points, bonus)
    values (${tenantId}, ${store}, ${config.applicationId}, ${config.environment}, ${sku}, ${mapping.productId}, ${mapping.kind}, ${product.points}, ${product.bonus})
    on conflict do nothing`;
  const pinned = await tx<{ product_id: string; kind: string; points: string; bonus: string }[]>`select product_id, kind, points::text, bonus::text
    from native_store_product_snapshots where tenant_id = ${tenantId} and store = ${store} and application_id = ${config.applicationId}
      and environment = ${config.environment} and store_product_id = ${sku}`;
  if (!pinned[0] || pinned[0].product_id !== mapping.productId || pinned[0].kind !== mapping.kind) throw new ConflictException('Concurrent SKU mapping mismatch');
  return pinned[0];
}

async function lockAccount(tx: DatabaseTransaction, tenantId: string, accountId: string, allowDisabled = false) {
  const rows = await tx<{ id: string }[]>`select id from customer_accounts where tenant_id = ${tenantId} and id = ${accountId}
    and (${allowDisabled} or status = 'active') for update`;
  if (!rows[0]) throw new UnauthorizedException('Customer account is unavailable');
}

export async function settleNativeRefundDebt(tx: DatabaseTransaction, tenantId: string, accountId: string) {
  const wallets = await tx<{ id: string; balance: string }[]>`select id, balance::text from point_accounts
    where tenant_id = ${tenantId} and account_id = ${accountId} for update`;
  const debts = await tx<{ transaction_id: string; points: string; paid_points: string; bonus_points: string }[]>`select transaction_id, points::text, paid_points::text, bonus_points::text from native_refund_debts
    where tenant_id = ${tenantId} and account_id = ${accountId} and points > 0 order by transaction_id for update`;
  const wallet = wallets[0];
  let balance = BigInt(wallet?.balance ?? 0);
  let remaining = 0n;
  for (const debt of debts) {
    const amount = balance < BigInt(debt.points) ? balance : BigInt(debt.points);
    if (wallet && amount > 0n) {
      const key = uuidV7();
      const paid = amount < BigInt(debt.paid_points) ? amount : BigInt(debt.paid_points);
      await tx`insert into point_ledger(id, tenant_id, account_id, point_account_id, entry_type, delta, balance_after,
        reference_type, reference_id, idempotency_key, created_by_type, metadata_json) values
        (${key}, ${tenantId}, ${accountId}, ${wallet.id}, 'adjustment', ${(-amount).toString()}, 0,
        'native_store_refund', ${debt.transaction_id}, ${'native-debt:' + key}, 'system', ${tx.json({ paidRefundPoints: paid.toString() })})`;
      await tx`update native_refund_debts set points = points - ${amount.toString()},
        paid_points = paid_points - ${paid.toString()}, bonus_points = bonus_points - ${(amount - paid).toString()}
        where transaction_id = ${debt.transaction_id}`;
      balance -= amount;
    }
    remaining += BigInt(debt.points) - amount;
  }
  return remaining;
}
