import { createHash, createPrivateKey, createSign, type KeyObject } from 'node:crypto';
import { connect, constants, type ClientHttp2Session, type IncomingHttpHeaders } from 'node:http2';

import type { PushProviderCredentials } from './notification-secret-cipher';
import {
  InvalidPushTokenError,
  type PushProviderAdapter,
  type PushSendInput,
  type PushSendResult,
} from './push-provider.adapter';

const APNS_ORIGIN = 'https://api.push.apple.com';
const APNS_SANDBOX_ORIGIN = 'https://api.sandbox.push.apple.com';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const MAX_RESPONSE_BYTES = 64 * 1024;

export type PushProviderErrorCode =
  | 'provider_authentication_failed'
  | 'provider_rejected'
  | 'provider_temporarily_unavailable'
  | 'provider_timeout'
  | 'unexpected_provider_response';

export class PushProviderError extends Error {
  constructor(readonly code: PushProviderErrorCode, readonly retryable: boolean) {
    super('Push provider request failed');
    this.name = 'PushProviderError';
  }
}

class ApnsInvalidDeviceTokenError extends InvalidPushTokenError {
  constructor(readonly reason: 'BadDeviceToken' | 'DeviceTokenNotForTopic' | 'Unregistered') {
    super();
  }
}

export class ApnsPushProviderAdapter implements PushProviderAdapter {
  readonly provider = 'apns' as const;
  private readonly tokenCache = new Map<string, { expiresAt: number; token: string }>();
  private readonly connectFn: typeof connect;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: { connectFn?: typeof connect; now?: () => number; timeoutMs?: number } = {}) {
    this.connectFn = options.connectFn ?? connect;
    this.now = options.now ?? Date.now;
    this.timeoutMs = boundedTimeout(options.timeoutMs);
  }

  async send(input: PushSendInput): Promise<PushSendResult> {
    if (input.provider !== 'apns' || input.credentials.type !== 'apns') {
      throw new PushProviderError('provider_authentication_failed', false);
    }
    const credentials = validateApnsCredentials(input.credentials);
    const deviceToken = validateApnsDeviceToken(input.deviceToken);
    const apnsId = uuid(input.deliveryId);
    const payload = Buffer.from(JSON.stringify({
      aps: { alert: { body: input.body, title: input.title }, sound: 'default' },
      ...(input.deepLink ? { deepLink: input.deepLink } : {}),
    }), 'utf8');
    if (payload.length > 4096) throw new PushProviderError('provider_rejected', false);
    const response = await this.request({
      body: payload,
      headers: {
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `bearer ${this.providerToken(credentials)}`,
        'apns-id': apnsId,
        'apns-priority': '10',
        'apns-push-type': 'alert',
        'apns-topic': credentials.bundleId,
        'content-type': 'application/json',
      },
    }, credentials.environment === 'sandbox' ? APNS_SANDBOX_ORIGIN : APNS_ORIGIN);
    if (response.status === 200) {
      const responseId = headerText(response.headers['apns-id']) || apnsId;
      if (!uuidPattern(responseId)) throw new PushProviderError('unexpected_provider_response', false);
      return { providerMessageId: responseId };
    }
    throw classifyApnsFailure(response.status, apnsReason(response.body));
  }

  async test(credentialsValue: PushProviderCredentials): Promise<void> {
    if (credentialsValue.type !== 'apns') {
      throw new PushProviderError('provider_authentication_failed', false);
    }
    try {
      await this.send({
        body: 'Credential validation probe',
        credentials: credentialsValue,
        deliveryId: '00000000-0000-4000-8000-000000000001',
        deviceToken: '0'.repeat(64),
        provider: 'apns',
        title: 'Credential validation',
      });
      throw new PushProviderError('unexpected_provider_response', false);
    } catch (error) {
      // Only BadDeviceToken is the expected result for the fixed invalid token.
      // A topic mismatch must never make a wrong bundle ID appear tested.
      if (error instanceof ApnsInvalidDeviceTokenError && error.reason === 'BadDeviceToken') return;
      throw error;
    }
  }

  private providerToken(credentials: ReturnType<typeof validateApnsCredentials>): string {
    const fingerprint = createHash('sha256').update([
      credentials.teamId, credentials.keyId, credentials.privateKey,
    ].join('\0')).digest('base64url');
    const cached = this.tokenCache.get(fingerprint);
    if (cached && cached.expiresAt > this.now() + 60_000) return cached.token;
    const issuedAt = Math.floor(this.now() / 1000);
    const token = signedJwt(
      { alg: 'ES256', kid: credentials.keyId, typ: 'JWT' },
      { iat: issuedAt, iss: credentials.teamId },
      credentials.key,
      'ES256',
    );
    this.tokenCache.clear();
    this.tokenCache.set(fingerprint, { expiresAt: (issuedAt + 50 * 60) * 1000, token });
    return token;
  }

  private request(
    input: { body: Buffer; headers: Record<string, string> },
    origin: typeof APNS_ORIGIN | typeof APNS_SANDBOX_ORIGIN,
  ): Promise<{
    body: string; headers: IncomingHttpHeaders; status: number;
  }> {
    return new Promise((resolve, reject) => {
      let session: ClientHttp2Session | undefined;
      let settled = false;
      const finish = (error?: Error, result?: { body: string; headers: IncomingHttpHeaders; status: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session?.destroy();
        if (error) reject(error); else resolve(result!);
      };
      const timer = setTimeout(() => finish(new PushProviderError('provider_timeout', true)), this.timeoutMs);
      try {
        session = this.connectFn(origin);
        session.once('error', () => finish(new PushProviderError('provider_timeout', true)));
        const request = session.request(input.headers);
        let headers: IncomingHttpHeaders = {};
        let status = 0;
        const chunks: Buffer[] = [];
        let size = 0;
        request.once('response', (value) => {
          headers = value;
          status = Number(value[':status'] ?? 0);
        });
        request.on('data', (chunk: Buffer | string) => {
          const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += value.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.close(constants.NGHTTP2_CANCEL);
            finish(new PushProviderError('unexpected_provider_response', true));
          } else chunks.push(value);
        });
        request.once('error', () => finish(new PushProviderError('provider_timeout', true)));
        request.once('end', () => {
          if (!status) finish(new PushProviderError('unexpected_provider_response', true));
          else finish(undefined, { body: Buffer.concat(chunks).toString('utf8'), headers, status });
        });
        request.end(input.body);
      } catch {
        finish(new PushProviderError('provider_temporarily_unavailable', true));
      }
    });
  }
}

interface AccessToken { expiresAt: number; token: string }

export class FcmPushProviderAdapter implements PushProviderAdapter {
  readonly provider = 'fcm' as const;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly tokenCache = new Map<string, AccessToken>();
  private readonly tokenInflight = new Map<string, Promise<AccessToken>>();

  constructor(options: { fetchFn?: typeof fetch; now?: () => number; timeoutMs?: number } = {}) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = boundedTimeout(options.timeoutMs);
  }

  async send(input: PushSendInput): Promise<PushSendResult> {
    if (input.provider !== 'fcm' || input.credentials.type !== 'fcm') {
      throw new PushProviderError('provider_authentication_failed', false);
    }
    const credentials = validateFcmCredentials(input.credentials);
    const accessToken = await this.accessToken(credentials, false);
    const response = await this.fixedFetch(
      `https://fcm.googleapis.com/v1/projects/${credentials.projectId}/messages:send`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: {
          token: validateFcmToken(input.deviceToken),
          notification: { body: input.body, title: input.title },
          ...(input.deepLink ? { data: { deepLink: input.deepLink } } : {}),
        } }),
      },
    );
    if (response.status >= 200 && response.status < 300) {
      const body = parseJson(response.body);
      const name = record(body) && typeof body.name === 'string' ? body.name : '';
      if (!/^projects\/[a-z][a-z0-9-]{2,62}\/messages\/[-A-Za-z0-9._~%+:]{1,300}$/.test(name)) {
        throw new PushProviderError('unexpected_provider_response', false);
      }
      return { providerMessageId: name };
    }
    throw classifyFcmFailure(response.status, response.body);
  }

  async test(credentialsValue: PushProviderCredentials): Promise<void> {
    if (credentialsValue.type !== 'fcm') {
      throw new PushProviderError('provider_authentication_failed', false);
    }
    await this.accessToken(validateFcmCredentials(credentialsValue), true);
  }

  private async accessToken(
    credentials: ReturnType<typeof validateFcmCredentials>,
    force: boolean,
  ): Promise<string> {
    const fingerprint = createHash('sha256').update([
      credentials.clientEmail, credentials.projectId, credentials.privateKey,
    ].join('\0')).digest('base64url');
    const cached = this.tokenCache.get(fingerprint);
    if (!force && cached && cached.expiresAt > this.now() + 5 * 60_000) return cached.token;
    const existing = this.tokenInflight.get(fingerprint);
    if (existing) return (await existing).token;
    const pending = this.exchangeToken(credentials);
    this.tokenInflight.set(fingerprint, pending);
    try {
      const token = await pending;
      if (!this.tokenCache.has(fingerprint) && this.tokenCache.size >= 256) {
        this.tokenCache.clear();
      }
      this.tokenCache.set(fingerprint, token);
      return token.token;
    } finally { this.tokenInflight.delete(fingerprint); }
  }

  private async exchangeToken(credentials: ReturnType<typeof validateFcmCredentials>): Promise<AccessToken> {
    const issuedAt = Math.floor(this.now() / 1000);
    const assertion = signedJwt(
      { alg: 'RS256', typ: 'JWT' },
      { aud: GOOGLE_TOKEN_ENDPOINT, exp: issuedAt + 3600, iat: issuedAt,
        iss: credentials.clientEmail, scope: FCM_SCOPE },
      credentials.key,
      'RS256',
    );
    const response = await this.fixedFetch(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams({ assertion,
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer' }).toString(),
    });
    if (response.status < 200 || response.status >= 300) {
      throw response.status === 429 || response.status >= 500
        ? new PushProviderError('provider_temporarily_unavailable', true)
        : new PushProviderError('provider_authentication_failed', false);
    }
    const body = parseJson(response.body);
    const token = record(body) && typeof body.access_token === 'string' ? body.access_token : '';
    const expiresIn = record(body) ? Number(body.expires_in) : 0;
    if (!/^[A-Za-z0-9._~-]{16,8192}$/.test(token)
      || !Number.isFinite(expiresIn) || expiresIn < 60 || expiresIn > 7200
      || (record(body) && body.token_type !== undefined && body.token_type !== 'Bearer')) {
      throw new PushProviderError('unexpected_provider_response', true);
    }
    return { expiresAt: this.now() + expiresIn * 1000, token };
  }

  private async fixedFetch(url: string, init: RequestInit): Promise<{ body: string; status: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchFn(url, { ...init, redirect: 'error', signal: controller.signal });
      return { body: await boundedBody(response), status: response.status };
    } catch (error) {
      if (error instanceof PushProviderError) throw error;
      throw new PushProviderError('provider_timeout', true);
    } finally { clearTimeout(timer); }
  }
}

function validateApnsCredentials(credentials: Extract<PushProviderCredentials, { type: 'apns' }>) {
  if (!/^[A-Za-z0-9.-]{3,255}$/.test(credentials.bundleId)
    || !/^[A-Z0-9]{3,20}$/.test(credentials.keyId)
    || !/^[A-Z0-9]{3,20}$/.test(credentials.teamId)) {
    throw new PushProviderError('provider_authentication_failed', false);
  }
  try {
    const key = createPrivateKey(credentials.privateKey);
    if (key.asymmetricKeyType !== 'ec'
      || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('not P-256');
    return { ...credentials, key };
  } catch { throw new PushProviderError('provider_authentication_failed', false); }
}

function validateFcmCredentials(credentials: Extract<PushProviderCredentials, { type: 'fcm' }>) {
  if (!/^[a-z][a-z0-9-]{2,62}$/.test(credentials.projectId)
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(credentials.clientEmail)) {
    throw new PushProviderError('provider_authentication_failed', false);
  }
  try {
    const key = createPrivateKey(credentials.privateKey);
    if (key.asymmetricKeyType !== 'rsa'
      || !key.asymmetricKeyDetails?.modulusLength
      || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error('not secure RSA');
    return { ...credentials, key };
  } catch { throw new PushProviderError('provider_authentication_failed', false); }
}

function signedJwt(
  header: object,
  payload: object,
  key: KeyObject,
  algorithm: 'ES256' | 'RS256',
): string {
  const unsigned = `${base64Json(header)}.${base64Json(payload)}`;
  const signer = createSign('SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(algorithm === 'ES256'
    ? { key, dsaEncoding: 'ieee-p1363' }
    : key);
  return `${unsigned}.${signature.toString('base64url')}`;
}

function classifyApnsFailure(status: number, reason: string): Error {
  if (['BadDeviceToken', 'DeviceTokenNotForTopic', 'Unregistered'].includes(reason)) {
    return new ApnsInvalidDeviceTokenError(reason as ApnsInvalidDeviceTokenError['reason']);
  }
  if (status === 401 || status === 403 || [
    'BadCertificate', 'BadCertificateEnvironment', 'ExpiredProviderToken',
    'InvalidProviderToken', 'MissingProviderToken', 'TopicDisallowed',
  ].includes(reason)) return new PushProviderError('provider_authentication_failed', false);
  if (status === 429 || status >= 500) return new PushProviderError('provider_temporarily_unavailable', true);
  return new PushProviderError('provider_rejected', false);
}

function classifyFcmFailure(status: number, rawBody: string): Error {
  const body = safeParse(rawBody);
  const error = record(body) && record(body.error) ? body.error : undefined;
  const details = error && Array.isArray(error.details) ? error.details : [];
  if (details.some((detail) => record(detail) && detail.errorCode === 'UNREGISTERED')) {
    return new InvalidPushTokenError();
  }
  if (status === 401 || status === 403) return new PushProviderError('provider_authentication_failed', false);
  if (status === 429 || status >= 500) return new PushProviderError('provider_temporarily_unavailable', true);
  return new PushProviderError('provider_rejected', false);
}

async function boundedBody(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.length;
    if (length > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new PushProviderError('unexpected_provider_response', true);
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function apnsReason(body: string): string {
  const parsed = safeParse(body);
  return record(parsed) && typeof parsed.reason === 'string' && parsed.reason.length <= 100
    ? parsed.reason : '';
}
function parseJson(body: string): unknown {
  const parsed = safeParse(body);
  if (parsed === undefined) throw new PushProviderError('unexpected_provider_response', true);
  return parsed;
}
function safeParse(body: string): unknown {
  try { return JSON.parse(body) as unknown; } catch { return undefined; }
}
function base64Json(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}
function headerText(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}
function validateApnsDeviceToken(value: string): string {
  if (!/^[0-9a-fA-F]{64,200}$/.test(value)) throw new InvalidPushTokenError();
  return value.toLowerCase();
}
function validateFcmToken(value: string): string {
  if (!/^[A-Za-z0-9_:.~-]{16,4096}$/.test(value)) throw new InvalidPushTokenError();
  return value;
}
function uuid(value: string): string {
  if (!uuidPattern(value)) throw new PushProviderError('provider_rejected', false);
  return value.toLowerCase();
}
function uuidPattern(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
function boundedTimeout(value: number | undefined): number {
  return Number.isInteger(value) && value! >= 100 && value! <= 30_000 ? value! : 8_000;
}
function record(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
