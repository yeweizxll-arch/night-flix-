import { createHmac, timingSafeEqual } from 'node:crypto';
import { posix } from 'node:path';
import type { PlaybackViewer } from './playback.types';

export interface HlsGrant extends PlaybackViewer {
  episodeId: string; mediaId: string; root: string; key: string; expires: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function hlsToken(grant: HlsGrant, secret = process.env.PLAYBACK_HLS_KEY): string {
  validate(grant);
  const body = Buffer.from(JSON.stringify(grant)).toString('base64url');
  return body + '.' + createHmac('sha256', requireKey(secret)).update(body).digest('base64url');
}
export function readHlsToken(token: unknown, secret = process.env.PLAYBACK_HLS_KEY, now = Date.now()): HlsGrant {
  if (typeof token !== 'string' || token.length > 7000) throw new Error('Invalid playback token');
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(parts[0]!)
    || !/^[A-Za-z0-9_-]{43}$/.test(parts[1]!)) throw new Error('Invalid playback token');
  const expected = createHmac('sha256', requireKey(secret)).update(parts[0]!).digest();
  const actual = Buffer.from(parts[1]!, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(expected, actual)) throw new Error('Invalid playback token');
  const grant = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as HlsGrant;
  validate(grant);
  if (grant.expires <= now || grant.expires > now + 300_000) throw new Error('Expired playback token');
  return grant;
}
function requireKey(secret?: string) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('PLAYBACK_HLS_KEY is not configured');
  return secret;
}
function validate(grant: HlsGrant) {
  if (!grant || !uuid.test(grant.tenantId) || !uuid.test(grant.episodeId) || !uuid.test(grant.mediaId)
    || (grant.accountId !== undefined && !uuid.test(grant.accountId))
    || !Number.isSafeInteger(grant.expires) || typeof grant.root !== 'string'
    || typeof grant.key !== 'string' || grant.root.length > 1024 || grant.key.length > 1024
    || grant.root.startsWith('/') || grant.key.startsWith('/')
    || posix.normalize(grant.root) !== grant.root || posix.normalize(grant.key) !== grant.key
    || posix.dirname(grant.root) === '.' || grant.root.startsWith('../')
    || !grant.key.startsWith(posix.dirname(grant.root) + '/')
    || /[\x00-\x20\\?#]/.test(grant.key + grant.root)) {
    throw new Error('Invalid playback grant');
  }
}

/** Rewrite every nested playlist, media, initialization and encryption-key URI. */
export function rewriteHlsPlaylist(text: string, grant: HlsGrant, url: (next: HlsGrant) => string): string {
  if (!text.startsWith('#EXTM3U') || Buffer.byteLength(text) > 1024 * 1024
    || text.includes('#EXT-X-DEFINE') || text.includes('{$')) throw new Error('Unsupported HLS manifest');
  const resource = (reference: string) => {
    const decoded = decodeURIComponent(reference);
    if (!decoded || /[\x00-\x20\\?#]/.test(decoded)
      || decoded.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(decoded)) {
      throw new Error('Only relative in-asset HLS references are allowed');
    }
    const key = posix.normalize(posix.join(posix.dirname(grant.key), decoded));
    const next = { ...grant, key };
    validate(next);
    return url(next);
  };
  return text.split(/\r?\n/).map((line) => {
    if (!line.trim()) return line;
    if (!line.startsWith('#')) return resource(line.trim());
    if (/\bURI\s*=/.test(line.replace(/\bURI="[^"]+"/g, ''))) throw new Error('Malformed HLS URI');
    return line.replace(/\bURI="([^"]+)"/g, (_, reference: string) => `URI="${resource(reference)}"`);
  }).join('\n');
}
