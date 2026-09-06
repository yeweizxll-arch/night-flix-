import { SUPPORTED_APP_LOCALES } from '@drama/contracts';
import { Inject, Injectable } from '@nestjs/common';

import { DatabaseService, type DatabaseTransaction } from '../database/database.service';
import type { NotificationLocale } from './notification.types';
import { NotificationWorkerService } from './notification-worker.service';

const CONSUMER = 'notification.dispatch.v1.transactional';
const EVENT_TYPES = [
  'OrderPendingPaymentCreated',
  'PaymentSucceeded',
  'PaymentRefundSucceeded',
  'PaymentRefundFailed',
  'CustomerPasswordChanged',
  'CustomerPasswordReset',
  'CustomerDeviceRevoked',
] as const;
type EventType = (typeof EVENT_TYPES)[number];

interface EventRow {
  aggregate_id: string;
  aggregate_type: string;
  event_type: EventType;
  id: string;
  tenant_id: string;
}

interface TrustedRecipient {
  accountId: string;
  locale: NotificationLocale;
  orderId?: string;
  tenantId: string;
}

@Injectable()
export class TransactionalNotificationOutboxWorkerService {
  constructor(
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(NotificationWorkerService) private readonly notifications: NotificationWorkerService,
  ) {}

  async processAvailable(maximum = 50): Promise<{ failed: number; processed: number }> {
    const limit = Number.isInteger(maximum) ? Math.min(Math.max(maximum, 1), 200) : 50;
    const events = await this.database.inPlatformContext((transaction) => transaction<EventRow[]>`
      select event.id, event.tenant_id, event.aggregate_type, event.aggregate_id, event.event_type
      from outbox_events as event
      where event.scope_type = 'tenant' and event.tenant_id is not null
        and event.event_type = any(${[...EVENT_TYPES]})
        and not exists (
          select 1 from notification_event_consumptions as consumption
          where consumption.event_id = event.id and consumption.consumer = ${CONSUMER}
        )
      order by event.created_at, event.id limit ${limit}
    `);
    let failed = 0;
    let processed = 0;
    for (const event of events) {
      try {
        const recipient = await this.resolveTrustedRecipient(event);
        if (!recipient) {
          await this.markIgnored(event.id);
          processed += 1;
          continue;
        }
        const template = transactionalTemplate(event.event_type, recipient.locale);
        await this.notifications.enqueueTransactional({
          accountId: recipient.accountId,
          body: template.body,
          channels: ['in_app', 'push'],
          deepLink: deepLink(event.event_type, recipient.orderId),
          eventId: event.id,
          locale: recipient.locale,
          tenantId: recipient.tenantId,
          title: template.title,
        });
        processed += 1;
      } catch {
        // No raw DB/provider error is logged or persisted here. Absence of the
        // atomic consumption marker makes the event eligible on the next poll.
        failed += 1;
      }
    }
    return { failed, processed };
  }

  private resolveTrustedRecipient(event: EventRow): Promise<TrustedRecipient | undefined> {
    return this.database.inPlatformContext(async (transaction) => {
      if (event.aggregate_type === 'customer_account' && [
        'CustomerPasswordChanged', 'CustomerPasswordReset', 'CustomerDeviceRevoked',
      ].includes(event.event_type)) {
        return first(await transaction<TrustedRecipientRow[]>`
          select account.id as account_id, account.tenant_id,
            coalesce(preference.preferred_locale, tenant.default_locale)::text as locale,
            null::uuid as order_id
          from customer_accounts as account
          inner join tenants as tenant on tenant.id = account.tenant_id
          left join customer_notification_preferences as preference
            on preference.tenant_id = account.tenant_id and preference.account_id = account.id
          where account.id = ${event.aggregate_id} and account.tenant_id = ${event.tenant_id}
            and account.status = 'active' and tenant.status = 'active'
            and tenant.expires_at > statement_timestamp()
            and tenant.user_site_enabled and tenant.platform_site_enabled
        `);
      }
      if (event.event_type === 'OrderPendingPaymentCreated' && event.aggregate_type === 'order') {
        return first(await transaction<TrustedRecipientRow[]>`
          select orders.account_id, orders.tenant_id, orders.locale, orders.id as order_id
          from orders inner join customer_accounts as account
            on account.id = orders.account_id and account.tenant_id = orders.tenant_id
          inner join tenants as tenant on tenant.id = orders.tenant_id
          where orders.id = ${event.aggregate_id} and orders.tenant_id = ${event.tenant_id}
            and orders.status = 'pending_payment' and orders.expires_at > statement_timestamp()
            and account.status = 'active' and tenant.status = 'active'
            and tenant.expires_at > statement_timestamp()
            and tenant.user_site_enabled and tenant.platform_site_enabled
        `);
      }
      if (event.event_type === 'PaymentSucceeded' && event.aggregate_type === 'payment_attempt') {
        return first(await transaction<TrustedRecipientRow[]>`
          select orders.account_id, attempt.tenant_id, orders.locale, orders.id as order_id
          from payment_attempts as attempt
          inner join orders on orders.id = attempt.order_id and orders.tenant_id = attempt.tenant_id
            and orders.account_id = attempt.account_id
          inner join customer_accounts as account
            on account.id = attempt.account_id and account.tenant_id = attempt.tenant_id
          inner join tenants as tenant on tenant.id = attempt.tenant_id
          where attempt.id = ${event.aggregate_id} and attempt.tenant_id = ${event.tenant_id}
            and attempt.status = 'succeeded' and orders.status in ('paid', 'refunded')
            and exists (
              select 1 from payment_transactions as payment
              where payment.tenant_id = attempt.tenant_id and payment.attempt_id = attempt.id
                and payment.order_id = attempt.order_id and payment.transaction_type = 'charge'
                and payment.status = 'succeeded'
            )
            and account.status = 'active' and tenant.status = 'active'
            and tenant.expires_at > statement_timestamp()
            and tenant.user_site_enabled and tenant.platform_site_enabled
        `);
      }
      if ((event.event_type === 'PaymentRefundSucceeded'
          || event.event_type === 'PaymentRefundFailed')
        && event.aggregate_type === 'payment_refund') {
        const expectedStatus = event.event_type === 'PaymentRefundSucceeded' ? 'succeeded' : 'failed';
        return first(await transaction<TrustedRecipientRow[]>`
          select orders.account_id, refund.tenant_id, orders.locale, orders.id as order_id
          from payment_refunds as refund
          inner join orders on orders.id = refund.order_id and orders.tenant_id = refund.tenant_id
          inner join customer_accounts as account
            on account.id = orders.account_id and account.tenant_id = orders.tenant_id
          inner join tenants as tenant on tenant.id = refund.tenant_id
          where refund.id = ${event.aggregate_id} and refund.tenant_id = ${event.tenant_id}
            and refund.status = ${expectedStatus}
            and account.status = 'active' and tenant.status = 'active'
            and tenant.expires_at > statement_timestamp()
            and tenant.user_site_enabled and tenant.platform_site_enabled
        `);
      }
      return undefined;
    });
  }

  private async markIgnored(eventId: string): Promise<void> {
    await this.database.inPlatformContext(async (transaction) => {
      await transaction`
        insert into notification_event_consumptions (event_id, consumer)
        values (${eventId}, ${CONSUMER}) on conflict do nothing
      `;
    });
  }
}

interface TrustedRecipientRow {
  account_id: string;
  locale: NotificationLocale;
  order_id: string | null;
  tenant_id: string;
}

function first(rows: TrustedRecipientRow[]): TrustedRecipient | undefined {
  const row = rows[0];
  if (!row || ![...SUPPORTED_APP_LOCALES].includes(row.locale)) {
    return undefined;
  }
  return { accountId: row.account_id, locale: row.locale,
    orderId: row.order_id ?? undefined, tenantId: row.tenant_id };
}

type LocalizedCopy = Partial<Record<NotificationLocale, [string, string]>> & { 'en-US': [string, string] };
const COPY: Record<EventType, LocalizedCopy> = {
  OrderPendingPaymentCreated: localeSet(
    ['订单待支付', '请完成订单支付。'], ['訂單待付款', '請完成訂單付款。'],
    ['Payment pending', 'Please complete payment for your order.'],
    ['Paiement en attente', 'Veuillez finaliser le paiement de votre commande.'],
    ['お支払い待ち', '注文のお支払いを完了してください。'],
    ['결제 대기 중', '주문 결제를 완료해 주세요.'],
  ),
  PaymentSucceeded: localeSet(
    ['支付成功', '订单支付已成功。'], ['付款成功', '訂單付款已成功。'],
    ['Payment successful', 'Your order payment was successful.'],
    ['Paiement réussi', 'Le paiement de votre commande a réussi.'],
    ['お支払い完了', '注文のお支払いが完了しました。'],
    ['결제 완료', '주문 결제가 완료되었습니다.'],
  ),
  PaymentRefundSucceeded: localeSet(
    ['退款成功', '订单退款已完成。'], ['退款成功', '訂單退款已完成。'],
    ['Refund completed', 'Your order refund was completed.'],
    ['Remboursement effectué', 'Le remboursement de votre commande est terminé.'],
    ['返金完了', '注文の返金が完了しました。'],
    ['환불 완료', '주문 환불이 완료되었습니다.'],
  ),
  PaymentRefundFailed: localeSet(
    ['退款未完成', '订单退款未完成，请查看订单详情。'], ['退款未完成', '訂單退款未完成，請查看訂單詳情。'],
    ['Refund not completed', 'Your refund was not completed. Check the order details.'],
    ['Remboursement non effectué', 'Le remboursement a échoué. Consultez la commande.'],
    ['返金未完了', '返金が完了しませんでした。注文詳細をご確認ください。'],
    ['환불 미완료', '환불이 완료되지 않았습니다. 주문 상세를 확인하세요.'],
  ),
  CustomerPasswordChanged: localeSet(
    ['密码已修改', '您的账号密码已修改。'], ['密碼已修改', '您的帳號密碼已修改。'],
    ['Password changed', 'Your account password was changed.'],
    ['Mot de passe modifié', 'Le mot de passe de votre compte a été modifié.'],
    ['パスワード変更', 'アカウントのパスワードが変更されました。'],
    ['비밀번호 변경', '계정 비밀번호가 변경되었습니다.'],
  ),
  CustomerPasswordReset: localeSet(
    ['密码已重置', '您的账号密码已重置。'], ['密碼已重設', '您的帳號密碼已重設。'],
    ['Password reset', 'Your account password was reset.'],
    ['Mot de passe réinitialisé', 'Le mot de passe de votre compte a été réinitialisé.'],
    ['パスワード再設定', 'アカウントのパスワードが再設定されました。'],
    ['비밀번호 재설정', '계정 비밀번호가 재설정되었습니다.'],
  ),
  CustomerDeviceRevoked: localeSet(
    ['设备已移除', '一个设备已从您的账号移除。'], ['裝置已移除', '一個裝置已從您的帳號移除。'],
    ['Device revoked', 'A device was removed from your account.'],
    ['Appareil révoqué', 'Un appareil a été retiré de votre compte.'],
    ['デバイス削除', 'アカウントからデバイスが削除されました。'],
    ['기기 해제', '계정에서 기기가 제거되었습니다.'],
  ),
};

function transactionalTemplate(eventType: EventType, locale: NotificationLocale) {
  const [title, body] = COPY[eventType][locale] ?? COPY[eventType]['en-US'];
  return { body, title };
}

function deepLink(eventType: EventType, orderId?: string): string {
  if (orderId && (eventType.startsWith('Payment') || eventType.startsWith('Order'))) {
    return `/account/orders/${orderId}`;
  }
  return eventType === 'CustomerDeviceRevoked' ? '/account/devices' : '/account/security';
}

function localeSet(
  zhCn: [string, string], zhTw: [string, string], en: [string, string],
  fr: [string, string], ja: [string, string], ko: [string, string],
): LocalizedCopy {
  return { 'zh-CN': zhCn, 'zh-TW': zhTw, 'en-US': en,
    'fr-FR': fr, 'ja-JP': ja, 'ko-KR': ko };
}
