import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import type { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders } from 'node:http2';
import { describe, expect, it, vi } from 'vitest';

import type { PushProviderCredentials } from './notification-secret-cipher';
import { InvalidPushTokenError } from './push-provider.adapter';
import {
  ApnsPushProviderAdapter,
  FcmPushProviderAdapter,
  PushProviderError,
} from './real-push-provider.adapters';

const ecPrivateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey
  .export({ format: 'pem', type: 'pkcs8' }).toString();
const rsaPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  .export({ format: 'pem', type: 'pkcs8' }).toString();

const apnsCredentials: PushProviderCredentials = {
  bundleId: 'com.example.drama', environment: 'production', keyId: 'KEY123ABC', privateKey: ecPrivateKey,
  teamId: 'TEAM123ABC', type: 'apns',
};
const fcmCredentials: PushProviderCredentials = {
  clientEmail: 'firebase@example.iam.gserviceaccount.com', environment: 'production', privateKey: rsaPrivateKey,
  projectId: 'drama-project', type: 'fcm',
};

describe('ApnsPushProviderAdapter', () => {
  it('uses the fixed Apple HTTP/2 origin and sends a valid ES256 provider JWT', async () => {
    const fake = fakeHttp2({ headers: { ':status': '200',
      'apns-id': '11111111-1111-4111-8111-111111111111' } });
    const adapter = new ApnsPushProviderAdapter({ connectFn: fake.connectFn });
    await expect(adapter.send(apnsInput())).resolves.toEqual({
      providerMessageId: '11111111-1111-4111-8111-111111111111',
    });
    expect(fake.origins).toEqual(['https://api.push.apple.com']);
    expect(fake.headers[':path']).toBe(`/3/device/${'a'.repeat(64)}`);
    const jwt = String(fake.headers.authorization).replace(/^bearer /, '').split('.');
    expect(JSON.parse(Buffer.from(jwt[0] ?? '', 'base64url').toString())).toMatchObject({
      alg: 'ES256', kid: 'KEY123ABC', typ: 'JWT',
    });
    expect(Buffer.from(jwt[2] ?? '', 'base64url')).toHaveLength(64);
    expect(JSON.parse(fake.requestBody)).toMatchObject({
      aps: { alert: { title: 'Title', body: 'Body' } }, deepLink: '/account/security',
    });
  });

  it('passes a provider test only when Apple authenticates then rejects the fixed device token', async () => {
    const acceptedAuth = fakeHttp2({ body: JSON.stringify({ reason: 'BadDeviceToken' }),
      headers: { ':status': '400' } });
    await expect(new ApnsPushProviderAdapter({ connectFn: acceptedAuth.connectFn })
      .test(apnsCredentials)).resolves.toBeUndefined();

    const rejectedAuth = fakeHttp2({ body: JSON.stringify({ reason: 'InvalidProviderToken' }),
      headers: { ':status': '403' } });
    await expect(new ApnsPushProviderAdapter({ connectFn: rejectedAuth.connectFn })
      .test(apnsCredentials)).rejects.toMatchObject({
      code: 'provider_authentication_failed', retryable: false,
    });

    const wrongTopic = fakeHttp2({ body: JSON.stringify({ reason: 'DeviceTokenNotForTopic' }),
      headers: { ':status': '400' } });
    await expect(new ApnsPushProviderAdapter({ connectFn: wrongTopic.connectFn })
      .test(apnsCredentials)).rejects.toBeInstanceOf(InvalidPushTokenError);
  });

  it('maps the explicit sandbox environment only to Apple fixed sandbox host', async () => {
    const fake = fakeHttp2({ headers: { ':status': '200',
      'apns-id': '11111111-1111-4111-8111-111111111111' } });
    const adapter = new ApnsPushProviderAdapter({ connectFn: fake.connectFn });
    await adapter.send({ ...apnsInput(), credentials: { ...apnsCredentials, environment: 'sandbox' } });
    expect(fake.origins).toEqual(['https://api.sandbox.push.apple.com']);
  });

  it('bounds timeouts and response bodies without exposing raw responses', async () => {
    const hanging = fakeHttp2({ hang: true });
    await expect(new ApnsPushProviderAdapter({ connectFn: hanging.connectFn, timeoutMs: 100 })
      .send(apnsInput())).rejects.toMatchObject({ code: 'provider_timeout', retryable: true });
    const oversized = fakeHttp2({ body: 'secret'.repeat(12_000), headers: { ':status': '500' } });
    await expect(new ApnsPushProviderAdapter({ connectFn: oversized.connectFn })
      .send(apnsInput())).rejects.toMatchObject({ code: 'unexpected_provider_response' });
  });
});

describe('FcmPushProviderAdapter', () => {
  it('coalesces concurrent OAuth exchanges and sends only to fixed Google endpoints', async () => {
    let tokenCalls = 0;
    const urls: string[] = [];
    const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      expect(init?.redirect).toBe('error');
      if (url === 'https://oauth2.googleapis.com/token') {
        tokenCalls += 1;
        const assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? '';
        const payload = JSON.parse(Buffer.from(assertion.split('.')[1] ?? '', 'base64url').toString());
        expect(payload).toMatchObject({ aud: 'https://oauth2.googleapis.com/token',
          iss: fcmCredentials.type === 'fcm' ? fcmCredentials.clientEmail : '' });
        return response({ access_token: 'access_token_value_123456789', expires_in: 3600,
          token_type: 'Bearer' }, 200);
      }
      return response({ name: `projects/drama-project/messages/0:12345%message_${urls.length}` }, 200);
    });
    const adapter = new FcmPushProviderAdapter({ fetchFn: fetchFn as typeof fetch });
    await Promise.all([adapter.send(fcmInput('token_one_123456789')),
      adapter.send(fcmInput('token_two_123456789'))]);
    expect(tokenCalls).toBe(1);
    expect(urls.filter((url) => url ===
      'https://fcm.googleapis.com/v1/projects/drama-project/messages:send')).toHaveLength(2);
  });

  it('performs a real OAuth exchange for config tests and separates rotated credentials', async () => {
    let tokenCalls = 0;
    const fetchFn = vi.fn(async () => {
      tokenCalls += 1;
      return response({ access_token: `access_token_value_${tokenCalls}_123456789`,
        expires_in: 3600, token_type: 'Bearer' }, 200);
    });
    const adapter = new FcmPushProviderAdapter({ fetchFn: fetchFn as typeof fetch });
    await adapter.test(fcmCredentials);
    const rotatedKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      .export({ format: 'pem', type: 'pkcs8' }).toString();
    await adapter.test({ ...fcmCredentials, privateKey: rotatedKey });
    expect(tokenCalls).toBe(2);
  });

  it('revokes only explicit UNREGISTERED tokens and retries 429/5xx safely', async () => {
    const outcomes = [
      response({ access_token: 'access_token_value_123456789', expires_in: 3600 }, 200),
      response({ error: { code: 404, details: [{ errorCode: 'UNREGISTERED' }] } }, 404),
    ];
    const invalid = new FcmPushProviderAdapter({ fetchFn: vi.fn(async () => outcomes.shift()!) as typeof fetch });
    await expect(invalid.send(fcmInput('invalid_token_123456789')))
      .rejects.toBeInstanceOf(InvalidPushTokenError);

    const retryOutcomes = [
      response({ access_token: 'access_token_value_123456789', expires_in: 3600 }, 200),
      response({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429),
    ];
    const retry = new FcmPushProviderAdapter({
      fetchFn: vi.fn(async () => retryOutcomes.shift()!) as typeof fetch,
    });
    await expect(retry.send(fcmInput('retry_token_123456789'))).rejects.toEqual(
      expect.objectContaining<Partial<PushProviderError>>({
        code: 'provider_temporarily_unavailable', retryable: true,
      }),
    );
  });

  it('aborts a hanging fixed-endpoint request with a safe timeout code', async () => {
    const fetchFn = vi.fn((_: unknown, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('raw token secret timeout')));
    }));
    await expect(new FcmPushProviderAdapter({ fetchFn: fetchFn as typeof fetch, timeoutMs: 100 })
      .test(fcmCredentials)).rejects.toMatchObject({ code: 'provider_timeout', retryable: true });
  });

  it('does not retry an ambiguous successful response with no valid provider message id', async () => {
    const outcomes = [
      response({ access_token: 'access_token_value_123456789', expires_in: 3600 }, 200),
      response({ name: 'raw secret or malformed id' }, 200),
    ];
    const adapter = new FcmPushProviderAdapter({
      fetchFn: vi.fn(async () => outcomes.shift()!) as typeof fetch,
    });
    await expect(adapter.send(fcmInput('ambiguous_token_123456789'))).rejects.toMatchObject({
      code: 'unexpected_provider_response', retryable: false,
    });
  });
});

function apnsInput() {
  return { body: 'Body', credentials: apnsCredentials, deepLink: '/account/security',
    deliveryId: '11111111-1111-4111-8111-111111111111', deviceToken: 'a'.repeat(64),
    provider: 'apns' as const, title: 'Title' };
}
function fcmInput(deviceToken: string) {
  return { body: 'Body', credentials: fcmCredentials, deepLink: '/account/security',
    deliveryId: '22222222-2222-4222-8222-222222222222', deviceToken,
    provider: 'fcm' as const, title: 'Title' };
}
function response(body: object, status: number): Response {
  return new Response(JSON.stringify(body), { status,
    headers: { 'content-type': 'application/json' } });
}

function fakeHttp2(input: {
  body?: string; hang?: boolean; headers?: IncomingHttpHeaders;
}) {
  const origins: string[] = [];
  const state = { headers: {} as Record<string, string>, requestBody: '' };
  const connectFn = ((origin: string) => {
    origins.push(origin);
    const session = new EventEmitter() as ClientHttp2Session;
    Object.assign(session, {
      destroy: vi.fn(),
      request: (headers: Record<string, string>) => {
        state.headers = headers;
        const request = new EventEmitter() as ClientHttp2Stream;
        Object.assign(request, {
          close: vi.fn(),
          end: (body: Buffer) => {
            state.requestBody = body.toString('utf8');
            if (input.hang) return;
            queueMicrotask(() => {
              request.emit('response', input.headers ?? { ':status': '200' });
              if (input.body) request.emit('data', Buffer.from(input.body));
              request.emit('end');
            });
          },
        });
        return request;
      },
    });
    return session;
  }) as typeof import('node:http2').connect;
  return { connectFn, get headers() { return state.headers; }, origins,
    get requestBody() { return state.requestBody; } };
}
