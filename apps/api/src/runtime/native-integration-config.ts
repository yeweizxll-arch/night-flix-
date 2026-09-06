import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';

/** Deployment-owned file, never accepted from customer requests or public bootstrap. */
export interface NativeIntegrationConfig {
  googleClientId?: string;
  googleIosClientId?: string;
  appleClientId?: string;
}

export function nativeIntegrationConfig(tenantId: string): NativeIntegrationConfig {
  const file = process.env.NATIVE_INTEGRATIONS_FILE;
  if (!file) return {};
  if (!isAbsolute(file) || statSync(file).size > 1024 * 1024) {
    throw new Error('Native integration configuration is invalid');
  }
  const all: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (!all || typeof all !== 'object' || Array.isArray(all)) {
    throw new Error('Native integration configuration is invalid');
  }
  const raw = (all as Record<string, unknown>)[tenantId];
  if (!raw) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid tenant native configuration');
  const config = raw as NativeIntegrationConfig;
  if ([config.googleClientId, config.googleIosClientId].some(value => value !== undefined && (typeof value !== 'string'
    || !/^[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com$/.test(value)))) {
    throw new Error('Invalid Google client identifier');
  }
  if (config.appleClientId !== undefined && (typeof config.appleClientId !== 'string'
    || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(config.appleClientId))) {
    throw new Error('Invalid Apple client identifier');
  }
  return { googleClientId: config.googleClientId, googleIosClientId: config.googleIosClientId, appleClientId: config.appleClientId };
}
