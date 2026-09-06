import { type AppLocale } from '@drama/contracts';
export type CommunicationChannel = 'email' | 'sms';
export type CommunicationProvider = 'resend' | 'qq_smtp' | 'twilio';
export type CommunicationLocale = AppLocale;

export type CommunicationCredentials =
  | { apiKey: string; fromEmail: string; type: 'resend' }
  | { authCode: string; fromEmail: string; type: 'qq_smtp' }
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
