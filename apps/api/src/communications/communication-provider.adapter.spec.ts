import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CommunicationProviderError,
  ResendCommunicationAdapter,
  TwilioCommunicationAdapter,
  otpTemplate,
} from './communication-provider.adapter';

describe('communication provider adapters', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

  it('uses only the fixed Resend endpoint and a stable provider idempotency key', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 'email_123' }), { status: 200 }));
    globalThis.fetch = fetchMock as typeof fetch;
    await expect(new ResendCommunicationAdapter().sendOtp({
      code: '123456', credentials: { apiKey: `re_${'a'.repeat(32)}`,
        fromEmail: 'security@example.com', type: 'resend' },
      destination: '+tag@example.com', expiresInMinutes: 10,
      jobId: '11111111-1111-4111-8111-111111111111', locale: 'en-US', siteName: 'Drama',
    })).resolves.toEqual({ providerMessageId: 'email_123' });
    expect(fetchMock).toHaveBeenCalledWith('https://api.resend.com/emails',
      expect.objectContaining({ headers: expect.objectContaining({
        'Idempotency-Key': '11111111-1111-4111-8111-111111111111',
      }), redirect: 'error' }));
  });

  it('uses only the validated Twilio account endpoint and rejects unsafe response IDs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ sid: 'unsafe id with spaces' }), { status: 201 }));
    globalThis.fetch = fetchMock as typeof fetch;
    await expect(new TwilioCommunicationAdapter().sendOtp({
      code: '654321', credentials: { accountSid: `AC${'a'.repeat(32)}`,
        authToken: 'b'.repeat(32), fromPhone: '+12025550100', type: 'twilio' },
      destination: '+12025550101', expiresInMinutes: 10,
      jobId: '22222222-2222-4222-8222-222222222222', locale: 'en-US', siteName: 'Drama',
    })).rejects.toMatchObject({ code: 'unexpected_provider_response' });
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(firstCall[0]).toBe(
      `https://api.twilio.com/2010-04-01/Accounts/AC${'a'.repeat(32)}/Messages.json`,
    );
  });

  it('has six fixed plain-text locale templates with safe fallback and no links/html', () => {
    for (const locale of ['zh-CN', 'zh-TW', 'en-US', 'fr-FR', 'ja-JP', 'ko-KR', 'unknown']) {
      const message = otpTemplate(locale, 'Safe\r\nInjected', '123456', 10);
      expect(message.body).toContain('123456');
      expect(message.body).not.toMatch(/https?:|<\/?[a-z]/i);
      expect(message.subject).not.toMatch(/[\r\n]/);
    }
  });

  it('maps arbitrary fetch failures to a fixed safe timeout error', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('secret api token raw-provider-error'); }) as typeof fetch;
    await expect(new ResendCommunicationAdapter().sendOtp({
      code: '123456', credentials: { apiKey: `re_${'a'.repeat(32)}`,
        fromEmail: 'security@example.com', type: 'resend' },
      destination: 'user@example.com', expiresInMinutes: 10,
      jobId: '11111111-1111-4111-8111-111111111111', locale: 'en-US', siteName: 'Drama',
    })).rejects.toEqual(expect.objectContaining<Partial<CommunicationProviderError>>({
      code: 'provider_timeout', retryable: true,
    }));
  });
});
