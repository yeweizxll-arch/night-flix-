import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createPrivateKey, X509Certificate } from 'node:crypto';

export type NativeStore = 'apple' | 'google';
export interface NativeStoreProduct { kind: 'points_topup' | 'membership'; productId: string }
export interface NativeStoreConfig {
  applicationId: string;
  environment: 'Sandbox' | 'Production';
  products: Record<string, NativeStoreProduct>;
  apple?: { issuerId: string; keyId: string; privateKeyPath: string; rootCertificatePaths: string[]; appAppleId?: number };
  google?: { serviceAccountPath: string; notificationAudience: string; notificationEmail: string };
}

export function nativeStoreConfig(tenantId: string, store: NativeStore): NativeStoreConfig | undefined {
  const file = process.env.NATIVE_STORES_FILE;
  if (!file) return undefined;
  const data = JSON.parse(privateFile(file, 1024 * 1024).toString('utf8')) as Record<string, Partial<Record<NativeStore, NativeStoreConfig>>>;
  const config = data?.[tenantId]?.[store];
  if (!config) return undefined;
  if (!/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(config.applicationId)
    || !['Sandbox', 'Production'].includes(config.environment)
    || !config.products || typeof config.products !== 'object' || Array.isArray(config.products)
    || Object.keys(config.products).length > 200) throw new Error('Invalid native store configuration');
  for (const [sku, product] of Object.entries(config.products)) {
    if (!/^[A-Za-z0-9_.-]{1,200}$/.test(sku) || !['membership', 'points_topup'].includes(product.kind)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(product.productId)) {
      throw new Error('Invalid native store product mapping');
    }
  }
  if (store === 'apple' && (!config.apple || !config.apple.rootCertificatePaths?.length
    || config.apple.rootCertificatePaths.length > 5 || !isAbsolute(config.apple.privateKeyPath)
    || (config.environment === 'Production' && !Number.isSafeInteger(config.apple.appAppleId)))) {
    throw new Error('Incomplete Apple store credentials');
  }
  if (store === 'apple') {
    const apple = config.apple!;
    if (!/^[0-9a-f-]{36}$/i.test(apple.issuerId) || !/^[A-Z0-9]{10}$/.test(apple.keyId)
      || createPrivateKey(privateFile(apple.privateKeyPath)).asymmetricKeyDetails?.namedCurve !== 'prime256v1'
      || apple.rootCertificatePaths.some(path => !new X509Certificate(privateFile(path)).ca)) {
      throw new Error('Invalid Apple store credentials');
    }
  }
  if (store === 'google' && (!config.google || !isAbsolute(config.google.serviceAccountPath)
    || !config.google.notificationAudience?.startsWith('https://') || !config.google.notificationEmail?.endsWith('.gserviceaccount.com'))) {
    throw new Error('Incomplete Google store credentials');
  }
  if (store === 'google') {
    const google = config.google!;
    const audience = new URL(google.notificationAudience);
    const account = JSON.parse(privateFile(google.serviceAccountPath).toString('utf8'));
    if (audience.protocol !== 'https:' || audience.username || audience.password || audience.hash
      || account.type !== 'service_account' || !account.client_email?.endsWith('.gserviceaccount.com')
      || createPrivateKey(account.private_key).asymmetricKeyType !== 'rsa') {
      throw new Error('Invalid Google store credentials');
    }
  }
  return config;
}

export function privateFile(path: string, maximum = 64 * 1024): Buffer {
  if (!isAbsolute(path) || !statSync(path).isFile() || statSync(path).size > maximum) throw new Error('Invalid native credential file');
  return readFileSync(path);
}

export function nativeStoreCatalog(tenantId: string) {
  return Object.fromEntries((['apple', 'google'] as const).map(store => {
    const config = nativeStoreConfig(tenantId, store);
    return [store, config ? Object.entries(config.products).map(([id, product]) => ({ id, kind: product.kind })) : []];
  }));
}
