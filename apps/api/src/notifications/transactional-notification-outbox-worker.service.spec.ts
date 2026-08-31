import { describe, expect, it, vi } from 'vitest';

import type { DatabaseService, DatabaseTransaction } from '../database/database.service';
import type { NotificationWorkerService } from './notification-worker.service';
import { TransactionalNotificationOutboxWorkerService } from './transactional-notification-outbox-worker.service';

const tenantId = '01910000-0000-7000-8000-000000000201';
const accountId = '01910000-0000-7000-8000-000000000202';
const orderId = '01910000-0000-7000-8000-000000000203';

describe('TransactionalNotificationOutboxWorkerService', () => {
  it('maps every supported producer aggregate to a trusted database query and fixed copy', async () => {
    const events = [
      event('OrderPendingPaymentCreated', 'order', orderId, 1),
      event('PaymentSucceeded', 'payment_attempt', '01910000-0000-7000-8000-000000000204', 2),
      event('PaymentRefundSucceeded', 'payment_refund', '01910000-0000-7000-8000-000000000205', 3),
      event('PaymentRefundFailed', 'payment_refund', '01910000-0000-7000-8000-000000000206', 4),
      event('CustomerPasswordChanged', 'customer_account', accountId, 5),
      event('CustomerPasswordReset', 'customer_account', accountId, 6),
      event('CustomerDeviceRevoked', 'customer_account', accountId, 7),
    ];
    const queries: string[] = [];
    const transaction = tag((sql) => {
      queries.push(sql);
      if (sql.includes('from outbox_events as event')) return events;
      if (sql.includes('from orders inner join customer_accounts')) return [recipient('ja-JP')];
      if (sql.includes('from payment_attempts as attempt')) return [recipient('fr-FR')];
      if (sql.includes('from payment_refunds as refund')) return [recipient('ko-KR')];
      if (sql.includes('from customer_accounts as account')) return [recipient('zh-TW', null)];
      return [];
    });
    const database = {
      inPlatformContext: <T>(callback: (value: DatabaseTransaction) => Promise<T>) => callback(transaction),
    } as unknown as DatabaseService;
    type EnqueueInput = Parameters<NotificationWorkerService['enqueueTransactional']>[0];
    const enqueued: EnqueueInput[] = [];
    const enqueueTransactional = vi.fn(async (input: EnqueueInput) => { enqueued.push(input); });
    const worker = new TransactionalNotificationOutboxWorkerService(database, {
      enqueueTransactional,
    } as unknown as NotificationWorkerService);

    await expect(worker.processAvailable()).resolves.toEqual({ failed: 0, processed: 7 });
    expect(enqueueTransactional).toHaveBeenCalledTimes(7);
    expect(enqueued.map((input) => input.deepLink)).toEqual([
      `/account/orders/${orderId}`, `/account/orders/${orderId}`,
      `/account/orders/${orderId}`, `/account/orders/${orderId}`,
      '/account/security', '/account/security', '/account/devices',
    ]);
    expect(enqueued[1]).toMatchObject({
      accountId, locale: 'fr-FR', tenantId,
      title: 'Paiement réussi',
    });
    expect(queries.some((sql) => sql.includes("attempt.status = 'succeeded'")
      && sql.includes("payment.status = 'succeeded'"))).toBe(true);
    expect(queries.filter((sql) => sql.includes('from payment_refunds as refund'))).toHaveLength(2);
    expect(queries.join('\n')).not.toContain('payload_json');
  });

  it('atomically marks an unknown aggregate shape ignored instead of trusting it or retry-looping', async () => {
    let consumed = 0;
    const transaction = tag((sql) => {
      if (sql.includes('from outbox_events as event')) {
        return [event('PaymentSucceeded', 'order', orderId, 8)];
      }
      if (sql.includes('insert into notification_event_consumptions')) consumed += 1;
      return [];
    });
    const database = {
      inPlatformContext: <T>(callback: (value: DatabaseTransaction) => Promise<T>) => callback(transaction),
    } as unknown as DatabaseService;
    const enqueueTransactional = vi.fn(async (
      _input: Parameters<NotificationWorkerService['enqueueTransactional']>[0],
    ) => undefined);
    const worker = new TransactionalNotificationOutboxWorkerService(database, {
      enqueueTransactional,
    } as unknown as NotificationWorkerService);

    await expect(worker.processAvailable()).resolves.toEqual({ failed: 0, processed: 1 });
    expect(enqueueTransactional).not.toHaveBeenCalled();
    expect(consumed).toBe(1);
  });
});

function event(eventType: string, aggregateType: string, aggregateId: string, suffix: number) {
  return {
    aggregate_id: aggregateId,
    aggregate_type: aggregateType,
    event_type: eventType,
    id: `01910000-0000-7000-8000-${String(300 + suffix).padStart(12, '0')}`,
    tenant_id: tenantId,
  };
}

function recipient(locale: string, resolvedOrderId: string | null = orderId) {
  return { account_id: accountId, locale, order_id: resolvedOrderId, tenant_id: tenantId };
}

function tag(respond: (sql: string) => unknown[]): DatabaseTransaction {
  const query = ((strings: TemplateStringsArray | string, ...values: unknown[]) => {
    if (typeof strings === 'string') return { identifier: strings };
    const sql = strings.reduce((text, part, index) => `${text}${part}${index < values.length ? '?' : ''}`, '');
    return Promise.resolve(respond(sql));
  }) as DatabaseTransaction;
  query.json = (value: unknown) => value as never;
  return query;
}
