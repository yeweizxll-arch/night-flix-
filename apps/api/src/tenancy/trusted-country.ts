import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

/**
 * Only the ingress can assert geolocation. Client country, locale, X-Forwarded-*
 * and CF-IPCountry headers by themselves never grant regional access.
 * Canonical bytes: timestamp + LF + country + LF + method + LF + host + LF + URL.
 */
export function verifiedRequestCountry(
  request: Pick<IncomingMessage, 'headers' | 'method' | 'url'>,
  key = process.env.GEO_EDGE_HMAC_KEY,
  now = Date.now(),
): string | undefined {
  if (!key || Buffer.byteLength(key) < 32) return undefined;
  const country = request.headers['x-nightflix-country'];
  const timestamp = request.headers['x-nightflix-geo-time'];
  const signature = request.headers['x-nightflix-geo-signature'];
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)
    || typeof timestamp !== 'string' || !/^\d{10}$/.test(timestamp)
    || typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) {
    return undefined;
  }
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > 30) return undefined;
  const canonical = [timestamp, country, request.method ?? '', request.headers.host ?? '', request.url ?? ''].join('\n');
  const expected = createHmac('sha256', key).update(canonical).digest();
  return timingSafeEqual(expected, Buffer.from(signature, 'hex')) ? country : undefined;
}
