import { useCallback, useEffect, useRef, useState } from 'react';

import type { CommerceOrderSummary, ContentLocale, PaymentAttempt } from '../api/types';
import {
  clearPendingCheckout,
  formatMinorAmount,
  readPendingCheckout,
} from '../checkout';
import { translate } from '../i18n';
import { navigate } from '../router';
import { useSession } from '../session';
import { Loading } from '../ui';

export function PaymentResultPage({
  cancelled,
  locale,
  orderId,
}: {
  cancelled: boolean;
  locale: ContentLocale;
  orderId: string;
}) {
  const { api, initializing, principal } = useSession();
  const [order, setOrder] = useState<CommerceOrderSummary>();
  const [attempt, setAttempt] = useState<PaymentAttempt>();
  const [state, setState] = useState<'error' | 'loading' | 'ready'>('loading');
  const [poll, setPoll] = useState(0);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setState('loading');
    try {
      const pending = readPendingCheckout(window.sessionStorage, orderId);
      const [nextOrder, nextAttempt] = await Promise.all([
        api.request<CommerceOrderSummary>(
          `/api/v1/customer/commerce/orders/${encodeURIComponent(orderId)}`,
          { cache: 'no-store' },
        ),
        pending
          ? api.request<PaymentAttempt>(
              `/api/v1/customer/commerce/payments/${encodeURIComponent(pending.attemptId)}`,
              { cache: 'no-store' },
            )
          : Promise.resolve(undefined),
      ]);
      if (current !== sequence.current) return;
      if (nextAttempt && nextAttempt.orderId !== nextOrder.id) throw new Error('Payment order mismatch');
      setOrder(nextOrder);
      setAttempt(nextAttempt);
      setState('ready');
      if (cancelled || isOrderTerminal(nextOrder.status)) {
        clearPendingCheckout(window.sessionStorage);
      }
    } catch {
      if (current === sequence.current) setState('error');
    }
  }, [api, cancelled, orderId]);

  useEffect(() => {
    if (!principal) return;
    void load();
    return () => { sequence.current += 1; };
  }, [load, poll, principal]);

  useEffect(() => {
    if (
      cancelled
      || state !== 'ready'
      || !order
      || isOrderTerminal(order.status)
      || poll >= 30
    ) return;
    const timer = window.setTimeout(() => setPoll((value) => value + 1), 2_000);
    return () => window.clearTimeout(timer);
  }, [cancelled, order, poll, state]);

  if (initializing) return <Loading locale={locale} />;
  if (!principal) {
    return (
      <main className="page state">
        <p>{translate(locale, 'paymentSignIn')}</p>
        <button onClick={() => navigate({ name: 'login', returnTo: window.location.hash })}>
          {translate(locale, 'login')}
        </button>
      </main>
    );
  }
  if (state === 'loading' && !order) return <Loading locale={locale} />;

  const paid = order?.status === 'paid';
  return (
    <main className="page narrow payment-result">
      <section className="panel">
        <p className="eyebrow">Stripe Hosted Checkout</p>
        <h1>{cancelled
          ? translate(locale, 'paymentCancelled')
          : paid ? translate(locale, 'paymentPaid') : translate(locale, 'paymentChecking')}</h1>
        {state === 'error' ? (
          <p className="error">{translate(locale, 'paymentCheckError')}</p>
        ) : null}
        {order ? (
          <dl className="result-details">
            <div><dt>{translate(locale, 'orderNumber')}</dt><dd>{order.orderNo}</dd></div>
            <div><dt>{translate(locale, 'amount')}</dt><dd>{formatMinorAmount(order.totalMinor, order.currency)}</dd></div>
            <div><dt>{translate(locale, 'status')}</dt><dd>{order.status}</dd></div>
          </dl>
        ) : null}
        {!cancelled && !paid && state !== 'error' ? (
          <p className="muted">{translate(locale, 'webhookPending')}</p>
        ) : null}
        {attempt?.status === 'failed' ? (
          <p className="error">{translate(locale, 'paymentFailed')}</p>
        ) : null}
        <div className="result-actions">
          <button className="secondary" onClick={() => navigate({ name: 'home' })} type="button">
            {translate(locale, 'home')}
          </button>
          {!cancelled && !paid ? (
            <button onClick={() => setPoll((value) => value + 1)} type="button">
              {translate(locale, 'refresh')}
            </button>
          ) : null}
        </div>
        <small>{translate(locale, 'sessionIdIgnored')}</small>
      </section>
    </main>
  );
}

function isOrderTerminal(status: CommerceOrderSummary['status']): boolean {
  return ['cancelled', 'expired', 'paid', 'refunded'].includes(status);
}
