import { isIP } from 'node:net';
import type { FastifyServerOptions } from 'fastify';

/** Never trust a hop count: it accepts forged forwarding headers at a direct origin. */
export function resolveTrustProxy(environment: NodeJS.ProcessEnv = process.env): FastifyServerOptions['trustProxy'] {
  const raw = environment.TRUST_PROXY?.trim();
  if (!raw || raw === 'false') return false;
  const entries = raw.split(',').map((entry) => entry.trim());
  for (const entry of entries) {
    const [address, bits, extra] = entry.split('/');
    const family = isIP(address ?? '');
    if (!family || extra !== undefined || (bits !== undefined &&
      (!/^\d+$/.test(bits) || Number(bits) < 1 || Number(bits) > (family === 4 ? 32 : 128)))) {
      throw new Error('TRUST_PROXY must be false or explicit trusted proxy IP addresses/CIDRs (not true or a hop count)');
    }
  }
  return entries;
}
