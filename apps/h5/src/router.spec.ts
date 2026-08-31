import { describe, expect, it } from 'vitest';

import { parseHashRoute, parseLocationRoute, routeHash } from './router';

describe('hash router', () => {
  it('round trips drama and watch routes', () => {
    expect(parseHashRoute(routeHash({ name: 'drama', dramaId: 'drama id' }))).toEqual({ name: 'drama', dramaId: 'drama id' });
    expect(parseHashRoute(routeHash({ name: 'watch', autoplay: true, dramaId: 'd', episodeId: 'e' }))).toEqual({ name: 'watch', autoplay: true, dramaId: 'd', episodeId: 'e' });
    expect(parseHashRoute(routeHash({ name: 'register' }))).toEqual({ name: 'register' });
    expect(parseHashRoute(routeHash({ name: 'legal' }))).toEqual({ name: 'legal' });
  });

  it('rejects unsafe login return paths', () => {
    expect(parseHashRoute('#/login?returnTo=https%3A%2F%2Fevil.test')).toEqual({ name: 'login', returnTo: undefined });
    expect(parseHashRoute('#/login?returnTo=%23%2Faccount')).toEqual({ name: 'login', returnTo: '#/account' });
  });

  it('accepts only exact clean payment callback paths with a UUID order', () => {
    const orderId = '018f2f45-7f5e-7e70-b17f-f6e77357d001';
    expect(parseLocationRoute('/payment/result', `?orderId=${orderId}&session_id=untrusted`, '#/'))
      .toEqual({ cancelled: false, name: 'payment', orderId });
    expect(parseLocationRoute('/payment/cancel', `?orderId=${orderId}`, ''))
      .toEqual({ cancelled: true, name: 'payment', orderId });
    expect(parseLocationRoute('/payment/result/evil', `?orderId=${orderId}`, '#/account'))
      .toEqual({ name: 'account' });
    expect(parseLocationRoute('/payment/result', '?orderId=not-a-uuid', ''))
      .toEqual({ cancelled: false, name: 'payment', orderId: undefined });
  });
});
