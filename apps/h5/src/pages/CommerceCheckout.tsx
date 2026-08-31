import { useEffect, useRef, useState } from 'react';

import type {
  CommerceCurrency,
  CommerceOrderInput,
  CommerceProductType,
  CommerceQuote,
  ContentLocale,
} from '../api/types';
import { COMMERCE_CURRENCIES } from '../api/types';
import {
  beginHostedCheckout,
  createCheckoutIdempotencyKeys,
  formatMinorAmount,
} from '../checkout';
import { translate } from '../i18n';
import { navigate } from '../router';
import { useSession } from '../session';

export function CommerceCheckout({
  enabled,
  locale,
  productId,
  productType,
}: {
  enabled: boolean;
  locale: ContentLocale;
  productId: string;
  productType: Extract<CommerceProductType, 'drama' | 'episode'>;
}) {
  const { api, principal } = useSession();
  const [currency, setCurrency] = useState<CommerceCurrency>('USD');
  const [quote, setQuote] = useState<CommerceQuote>();
  const [status, setStatus] = useState<'idle' | 'loading' | 'price_changed' | 'redirecting' | 'unavailable'>('idle');
  const idempotencyKeys = useRef(createCheckoutIdempotencyKeys());

  useEffect(() => {
    setQuote(undefined);
    setStatus('idle');
    idempotencyKeys.current = createCheckoutIdempotencyKeys();
  }, [currency, locale, productId, productType]);

  if (!enabled) {
    return <div className="notice">{translate(locale, 'paymentUnavailable')}</div>;
  }
  if (!principal) {
    return (
      <section className="checkout-panel panel">
        <p>{translate(locale, 'paymentSignIn')}</p>
        <button
          type="button"
          onClick={() => navigate({ name: 'login', returnTo: window.location.hash })}
        >
          {translate(locale, 'login')}
        </button>
      </section>
    );
  }

  const orderInput: CommerceOrderInput = { currency, locale, productId, productType };

  async function loadQuote(): Promise<void> {
    setStatus('loading');
    setQuote(undefined);
    try {
      const response = await api.request<CommerceQuote>('/api/v1/customer/commerce/quote', {
        cache: 'no-store',
        json: orderInput,
        method: 'POST',
      });
      if (
        response.currency !== currency
        || response.locale !== locale
        || response.product.id !== productId
        || response.product.type !== productType
        || !Number.isSafeInteger(response.totalMinor)
        || response.totalMinor < 0
      ) throw new Error('Quote response mismatch');
      setQuote(response);
      setStatus('idle');
    } catch {
      setStatus('unavailable');
    }
  }

  async function checkout(): Promise<void> {
    if (!quote) return;
    setStatus('redirecting');
    try {
      const result = await beginHostedCheckout({
        api,
        idempotencyKeys: idempotencyKeys.current,
        orderInput,
        quote,
        redirect: (url) => window.location.assign(url),
        storage: window.sessionStorage,
      });
      if (result.status === 'price_changed') {
        setQuote({
          currency: result.order.currency,
          locale: result.order.locale,
          product: result.order.item,
          totalMinor: result.order.totalMinor,
        });
        idempotencyKeys.current = createCheckoutIdempotencyKeys();
        setStatus('price_changed');
      } else if (result.status === 'unavailable') {
        setStatus('unavailable');
      }
    } catch {
      setStatus('unavailable');
    }
  }

  return (
    <section className="checkout-panel panel">
      <div>
        <strong>{translate(locale, productType === 'drama' ? 'buyDrama' : 'buyEpisode')}</strong>
        <small>{translate(locale, 'stripeHosted')}</small>
      </div>
      <label>
        <span>{translate(locale, 'currency')}</span>
        <select
          disabled={status === 'loading' || status === 'redirecting'}
          onChange={(event) => setCurrency(event.target.value as CommerceCurrency)}
          value={currency}
        >
          {COMMERCE_CURRENCIES.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      {quote ? (
        <div className="checkout-quote">
          <span>{quote.product.name}</span>
          <strong>{formatMinorAmount(quote.totalMinor, quote.currency)}</strong>
        </div>
      ) : null}
      {status === 'price_changed' ? (
        <p className="checkout-warning">{translate(locale, 'priceChanged')}</p>
      ) : null}
      {status === 'unavailable' ? (
        <p className="error">{translate(locale, 'checkoutUnavailable')}</p>
      ) : null}
      {quote ? (
        <button
          disabled={status === 'redirecting'}
          onClick={() => void checkout()}
          type="button"
        >
          {status === 'redirecting' ? translate(locale, 'redirecting') : translate(locale, 'payWithStripe')}
        </button>
      ) : (
        <button
          disabled={status === 'loading'}
          onClick={() => void loadQuote()}
          type="button"
        >
          {status === 'loading' ? translate(locale, 'loading') : translate(locale, 'checkPrice')}
        </button>
      )}
      <small>{translate(locale, 'serverPriceNotice')}</small>
    </section>
  );
}
