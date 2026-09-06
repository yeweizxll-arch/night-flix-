import type {
  CommunicationChannel,
  CommunicationCredentials,
  CommunicationLocale,
  CommunicationProvider,
} from './communication.types';

export interface SendOtpMessageInput {
  code: string;
  credentials: CommunicationCredentials;
  destination: string;
  expiresInMinutes: number;
  jobId: string;
  locale: CommunicationLocale;
  siteName: string;
}

export interface CommunicationProviderAdapter {
  readonly channel: CommunicationChannel;
  readonly provider: CommunicationProvider;
  readonly testOnly?: boolean;
  sendOtp(input: SendOtpMessageInput): Promise<{ providerMessageId: string }>;
}

export class CommunicationProviderError extends Error {
  constructor(
    readonly code: 'provider_rejected' | 'provider_timeout' | 'unexpected_provider_response',
    readonly retryable: boolean,
  ) {
    super('Communication provider request failed');
    this.name = 'CommunicationProviderError';
  }
}

export class CommunicationAdapterRegistry {
  private readonly adapters: ReadonlyMap<CommunicationProvider, CommunicationProviderAdapter>;

  constructor(adapters: readonly CommunicationProviderAdapter[]) {
    if (process.env.NODE_ENV === 'production' && adapters.some((adapter) => adapter.testOnly)) {
      throw new Error('Test communication adapters are forbidden in production');
    }
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  get(provider: CommunicationProvider, channel: CommunicationChannel): CommunicationProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter || adapter.channel !== channel) {
      throw new CommunicationProviderError('provider_rejected', false);
    }
    return adapter;
  }
}

export class FakeCommunicationProviderAdapter implements CommunicationProviderAdapter {
  readonly testOnly = true;
  readonly calls: SendOtpMessageInput[] = [];
  failure?: Error;

  constructor(
    readonly provider: CommunicationProvider,
    readonly channel: CommunicationChannel,
  ) {}

  async sendOtp(input: SendOtpMessageInput): Promise<{ providerMessageId: string }> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return { providerMessageId: `fake:${input.jobId}` };
  }
}

export class ResendCommunicationAdapter implements CommunicationProviderAdapter {
  readonly channel = 'email' as const;
  readonly provider = 'resend' as const;

  async sendOtp(input: SendOtpMessageInput): Promise<{ providerMessageId: string }> {
    if (input.credentials.type !== 'resend') {
      throw new CommunicationProviderError('provider_rejected', false);
    }
    const message = otpTemplate(input.locale, input.siteName, input.code, input.expiresInMinutes);
    const response = await fixedFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${input.credentials.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.jobId,
      },
      body: JSON.stringify({
        from: input.credentials.fromEmail,
        to: [input.destination],
        subject: message.subject,
        text: message.body,
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw new CommunicationProviderError('provider_rejected', response.status === 429 || response.status >= 500);
    }
    const body = parseJson(response.body);
    const id = record(body) && typeof body.id === 'string' ? body.id : '';
    if (!safeMessageId(id)) throw new CommunicationProviderError('unexpected_provider_response', true);
    return { providerMessageId: id };
  }
}

export class TwilioCommunicationAdapter implements CommunicationProviderAdapter {
  readonly channel = 'sms' as const;
  readonly provider = 'twilio' as const;

  async sendOtp(input: SendOtpMessageInput): Promise<{ providerMessageId: string }> {
    if (input.credentials.type !== 'twilio') {
      throw new CommunicationProviderError('provider_rejected', false);
    }
    const message = otpTemplate(input.locale, input.siteName, input.code, input.expiresInMinutes);
    const form = new URLSearchParams({
      Body: message.body,
      From: input.credentials.fromPhone,
      To: input.destination,
    });
    const response = await fixedFetch(
      `https://api.twilio.com/2010-04-01/Accounts/${input.credentials.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${input.credentials.accountSid}:${input.credentials.authToken}`,
          ).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        },
        body: form.toString(),
      },
    );
    if (response.status < 200 || response.status >= 300) {
      throw new CommunicationProviderError('provider_rejected', response.status === 429 || response.status >= 500);
    }
    const body = parseJson(response.body);
    const id = record(body) && typeof body.sid === 'string' ? body.sid : '';
    if (!safeMessageId(id)) throw new CommunicationProviderError('unexpected_provider_response', true);
    return { providerMessageId: id };
  }
}

const TEMPLATES: Record<CommunicationLocale, {
  body: (site: string, code: string, minutes: number) => string;
  subject: (site: string) => string;
}> = {
  'zh-CN': { subject: (s) => `${s} 验证码`, body: (s, c, m) => `${s} 验证码：${c}。${m}分钟内有效，请勿转发。` },
  'zh-TW': { subject: (s) => `${s} 驗證碼`, body: (s, c, m) => `${s} 驗證碼：${c}。${m}分鐘內有效，請勿轉發。` },
  'en-US': { subject: (s) => `${s} verification code`, body: (s, c, m) => `${s} verification code: ${c}. It expires in ${m} minutes. Do not share it.` },
  'fr-FR': { subject: (s) => `Code de vérification ${s}`, body: (s, c, m) => `Code de vérification ${s} : ${c}. Valable ${m} minutes. Ne le partagez pas.` },
  'ja-JP': { subject: (s) => `${s} 認証コード`, body: (s, c, m) => `${s}の認証コード：${c}。有効期限は${m}分です。共有しないでください。` },
  'ko-KR': { subject: (s) => `${s} 인증 코드`, body: (s, c, m) => `${s} 인증 코드: ${c}. ${m}분 동안 유효합니다. 공유하지 마세요.` },
  'es-ES': { subject: s => `${s}: código de verificación`, body: (s,c,m) => `${s}: ${c}. Caduca en ${m} minutos. No compartas este código.` },
  'pt-BR': { subject: s => `${s}: código de verificação`, body: (s,c,m) => `${s}: ${c}. Expira em ${m} minutos. Não compartilhe este código.` },
  'id-ID': { subject: s => `${s}: kode verifikasi`, body: (s,c,m) => `${s}: ${c}. Berlaku ${m} menit. Jangan bagikan kode ini.` },
  'th-TH': { subject: s => `${s}: รหัสยืนยัน`, body: (s,c,m) => `${s}: ${c} รหัสมีอายุ ${m} นาที อย่าเปิดเผยรหัสนี้` },
  'vi-VN': { subject: s => `${s}: mã xác minh`, body: (s,c,m) => `${s}: ${c}. Hết hạn sau ${m} phút. Không chia sẻ mã này.` },
  'de-DE': { subject: s => `${s}: Bestätigungscode`, body: (s,c,m) => `${s}: ${c}. Gültig für ${m} Minuten. Teilen Sie diesen Code nicht.` },
  'ar-SA': { subject: s => `${s}: رمز التحقق`, body: (s,c,m) => `${s}: ${c}. تنتهي صلاحيته خلال ${m} دقائق. لا تشارك هذا الرمز.` },
  'hi-IN': { subject: s => `${s}: सत्यापन कोड`, body: (s,c,m) => `${s}: ${c}। ${m} मिनट तक मान्य। यह कोड साझा न करें।` },
  'tr-TR': { subject: s => `${s}: doğrulama kodu`, body: (s,c,m) => `${s}: ${c}. ${m} dakika geçerlidir. Bu kodu paylaşmayın.` },
};

export function otpTemplate(
  locale: string,
  rawSiteName: string,
  code: string,
  minutes: number,
): { body: string; subject: string } {
  const selected = locale in TEMPLATES ? locale as CommunicationLocale : 'en-US';
  const siteName = safeSiteName(rawSiteName);
  if (!/^[0-9]{6}$/.test(code) || !Number.isInteger(minutes) || minutes < 1 || minutes > 30) {
    throw new TypeError('OTP template input is invalid');
  }
  return { subject: TEMPLATES[selected].subject(siteName), body: TEMPLATES[selected].body(siteName, code, minutes) };
}

function safeSiteName(value: string): string {
  const normalized = value.normalize('NFKC').replace(/[\u0000-\u001f\u007f\r\n]/g, ' ').trim();
  return normalized.length >= 1 && normalized.length <= 100 ? normalized : 'Account Security';
}

async function fixedFetch(url: string, init: RequestInit): Promise<{ body: string; status: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    return { body: await boundedBody(response, 16_384), status: response.status };
  } catch (error) {
    if (error instanceof CommunicationProviderError) throw error;
    throw new CommunicationProviderError('provider_timeout', true);
  } finally { clearTimeout(timer); }
}

async function boundedBody(response: Response, maximum: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    length += result.value.length;
    if (length > maximum) {
      await reader.cancel();
      throw new CommunicationProviderError('unexpected_provider_response', true);
    }
    chunks.push(result.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseJson(value: string): unknown {
  try { return JSON.parse(value) as unknown; }
  catch { throw new CommunicationProviderError('unexpected_provider_response', true); }
}
function safeMessageId(value: string): boolean {
  return value.length >= 1 && value.length <= 500 && /^[-A-Za-z0-9._:@/+=]+$/.test(value);
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
