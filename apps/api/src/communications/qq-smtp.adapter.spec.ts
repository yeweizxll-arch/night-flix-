import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { QqSmtpCommunicationAdapter } from './qq-smtp.adapter';
import type { SendOtpMessageInput } from './communication-provider.adapter';
import { CommunicationSecretCipher } from './communication-secret-cipher';

const input: SendOtpMessageInput = {
  credentials: { type: 'qq_smtp', fromEmail: 'test@qq.com', authCode: 'a'.repeat(16) },
  destination: 'recipient@example.com', code: '123456', expiresInMinutes: 10,
  jobId: 'job-1', locale: 'zh-CN', siteName: 'Night Flix',
};
afterEach(() => vi.restoreAllMocks());
describe('QQ SMTP boundary', () => {
  it('uses verified TLS at a fixed endpoint and sends one envelope recipient without logs', async () => {
    const sendMail = vi.fn().mockResolvedValue({ accepted: [input.destination], rejected: [] });
    const close = vi.fn();
    const create = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close } as never);
    const adapter = new QqSmtpCommunicationAdapter();
    const first = await adapter.sendOtp(input);
    expect(await adapter.sendOtp(input)).toEqual(first);
    expect(first.providerMessageId).toMatch(/^qq_smtp:[a-f0-9]{64}$/);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      host: 'smtp.qq.com', port: 465, secure: true, logger: false, debug: false,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'smtp.qq.com' },
      disableFileAccess: true, disableUrlAccess: true,
    }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      envelope: { from: 'test@qq.com', to: [input.destination] },
      subject: 'Night Flix 验证码', text: expect.stringContaining(input.code),
    }));
    expect(close).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['EAUTH', 535, false, 'provider_rejected'],
    ['EENVELOPE', 450, true, 'provider_rejected'],
    ['ETIMEDOUT', undefined, true, 'provider_timeout'],
  ])('redacts %s errors and classifies retryability', async (code, responseCode, retryable, safeCode) => {
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(Object.assign(new Error('secret-auth-and-recipient'), { code, responseCode })),
      close: vi.fn(),
    } as never);
    await expect(new QqSmtpCommunicationAdapter().sendOtp(input)).rejects.toMatchObject({
      message: 'Communication provider request failed', code: safeCode, retryable,
    });
  });

  it.each(['a@example.com,b@example.com', 'a@example.com\r\nBcc: b@example.com', 'Display <a@example.com>'])(
    'rejects recipient injection before connecting: %s', async destination => {
      const create = vi.spyOn(nodemailer, 'createTransport');
      await expect(new QqSmtpCommunicationAdapter().sendOtp({ ...input, destination })).rejects.toMatchObject({ retryable: false });
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('encrypts QQ credentials, rejects arbitrary SMTP settings and binds the tenant', () => {
    const cipher = new CommunicationSecretCipher({ activeVersion: 1, keys: new Map([[1, Buffer.alloc(32, 1)]]) });
    const binding = { configId: 'config', tenantId: 'tenant', channel: 'email' as const, kind: 'provider' as const, provider: 'qq_smtp' as const };
    const sealed = cipher.encryptCredentials(input.credentials, binding);
    expect(sealed.ciphertext).not.toContain('a'.repeat(16));
    expect(cipher.decryptCredentials(sealed.ciphertext, { ...binding, keyVersion: 1 })).toEqual(input.credentials);
    expect(() => cipher.decryptCredentials(sealed.ciphertext, { ...binding, keyVersion: 1, tenantId: 'other' })).toThrow();
    for (const bad of [
      { ...input.credentials, host: '127.0.0.1' },
      { ...input.credentials, fromEmail: 'attacker@example.com' },
      { ...input.credentials, type: 'resend' },
      { ...input.credentials, authCode: 'not-a-valid-code' },
    ]) expect(() => cipher.encryptCredentials(bad, binding)).toThrow();
  });
});
