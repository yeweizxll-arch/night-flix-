export type AppRoute =
  | { name: 'account' }
  | { name: 'drama'; dramaId: string }
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'legal' }
  | { name: 'login'; returnTo?: string }
  | { name: 'payment'; cancelled: boolean; orderId?: string }
  | { name: 'register' }
  | { name: 'watch'; autoplay: boolean; dramaId: string; episodeId: string };

export function parseLocationRoute(
  pathname: string,
  search: string,
  hash: string,
): AppRoute {
  if (pathname === '/payment/result' || pathname === '/payment/cancel') {
    const candidate = new URLSearchParams(search).get('orderId') ?? undefined;
    return {
      cancelled: pathname === '/payment/cancel',
      name: 'payment',
      orderId: candidate && isUuid(candidate) ? candidate : undefined,
    };
  }
  return parseHashRoute(hash);
}

export function parseHashRoute(hash: string): AppRoute {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, queryString = ''] = raw.split('?');
  const parts = (path ?? '/').split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'drama' && parts[1]) return { name: 'drama', dramaId: parts[1] };
  if (parts[0] === 'watch' && parts[1] && parts[2]) {
    return { name: 'watch', dramaId: parts[1], episodeId: parts[2], autoplay: new URLSearchParams(queryString).get('autoplay') === '1' };
  }
  if (parts[0] === 'library') return { name: 'library' };
  if (parts[0] === 'legal') return { name: 'legal' };
  if (parts[0] === 'account') return { name: 'account' };
  if (parts[0] === 'register') return { name: 'register' };
  if (parts[0] === 'login') return { name: 'login', returnTo: safeReturnTo(new URLSearchParams(queryString).get('returnTo')) };
  return { name: 'home' };
}

export function routeHash(route: AppRoute): string {
  if (route.name === 'home') return '#/';
  if (route.name === 'account' || route.name === 'library' || route.name === 'legal' || route.name === 'register') return `#/${route.name}`;
  if (route.name === 'drama') return `#/drama/${encodeURIComponent(route.dramaId)}`;
  if (route.name === 'watch') return `#/watch/${encodeURIComponent(route.dramaId)}/${encodeURIComponent(route.episodeId)}${route.autoplay ? '?autoplay=1' : ''}`;
  if (route.name === 'payment') return '#/';
  return `#/login${route.returnTo ? `?returnTo=${encodeURIComponent(route.returnTo)}` : ''}`;
}

export function navigate(route: AppRoute): void {
  window.location.hash = routeHash(route);
}

function safeReturnTo(value: string | null): string | undefined {
  if (!value || !value.startsWith('#/') || value.startsWith('#//')) return undefined;
  return value.slice(0, 500);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
