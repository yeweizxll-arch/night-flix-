export type CommunicationChannel = 'email' | 'sms';
export type CommunicationProvider = 'resend' | 'twilio';
export type CommunicationLocale = 'zh-CN' | 'zh-TW' | 'en-US' | 'fr-FR' | 'ja-JP' | 'ko-KR';

export type CommunicationCredentials =
  | { apiKey: string; fromEmail: string; type: 'resend' }
  | { accountSid: string; authToken: string; fromPhone: string; type: 'twilio' };

export interface CommunicationMutationMetadata {
  actorId: string;
  idempotencyKey?: unknown;
  ip?: string;
  requestId: string;
}

export interface UpsertCommunicationConfigInput {
  credentials?: unknown;
  expectedVersion?: unknown;
}

export interface TestCommunicationConfigInput {
  destination?: unknown;
  expectedVersion?: unknown;
}

