import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';

import {
  CommunicationProviderError, otpTemplate,
  type CommunicationProviderAdapter, type SendOtpMessageInput,
} from './communication-provider.adapter';

// QQ only: tenants cannot choose a host, port or TLS policy (SSRF boundary).
export class QqSmtpCommunicationAdapter implements CommunicationProviderAdapter {
  readonly channel = 'email' as const;
  readonly provider = 'qq_smtp' as const;

  async sendOtp(input: SendOtpMessageInput): Promise<{ providerMessageId: string }> {
    const credentials = input.credentials;
    if (credentials.type !== 'qq_smtp'
      || !/^[A-Za-z0-9._-]{1,64}@qq\.com$/i.test(credentials.fromEmail)
      || !/^[A-Za-z]{16}$/.test(credentials.authCode)
      || input.destination.length > 320
      || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/.test(input.destination)) {
      throw new CommunicationProviderError('provider_rejected', false);
    }
    const message = otpTemplate(input.locale, input.siteName, input.code, input.expiresInMinutes);
    const id = createHash('sha256').update(input.jobId).digest('hex');
    const transport = nodemailer.createTransport({
      host: 'smtp.qq.com', port: 465, secure: true,
      tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2', servername: 'smtp.qq.com' },
      auth: { user: credentials.fromEmail, pass: credentials.authCode },
      connectionTimeout: 8_000, greetingTimeout: 8_000, socketTimeout: 15_000,
      dnsTimeout: 8_000, logger: false, debug: false,
      disableFileAccess: true, disableUrlAccess: true,
    });
    try {
      const result = await transport.sendMail({
        from: { address: credentials.fromEmail, name: '' },
        to: { address: input.destination, name: '' },
        envelope: { from: credentials.fromEmail, to: [input.destination] },
        subject: message.subject, text: message.body,
        // SMTP is at-least-once; a stable Message-ID does not guarantee deduplication.
        messageId: `<${id}@qq.com>`,
      });
      if (!result.accepted?.length || result.rejected?.length) {
        throw new CommunicationProviderError('provider_rejected', false);
      }
      return { providerMessageId: `qq_smtp:${id}` };
    } catch (error) {
      if (error instanceof CommunicationProviderError) throw error;
      const failure = error as { code?: string; responseCode?: number };
      const timeout = ['ETIMEDOUT', 'ECONNECTION', 'ESOCKET', 'EDNS'].includes(failure?.code ?? '');
      const temporary = typeof failure?.responseCode === 'number'
        && failure.responseCode >= 400 && failure.responseCode < 500;
      // Never retain SMTP responses: they can contain credentials or recipients.
      throw new CommunicationProviderError(timeout ? 'provider_timeout' : 'provider_rejected', timeout || temporary);
    } finally { transport.close(); }
  }
}
