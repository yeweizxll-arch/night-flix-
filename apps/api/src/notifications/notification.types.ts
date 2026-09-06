import { SUPPORTED_APP_LOCALES } from '@drama/contracts';
export const NOTIFICATION_LOCALES = SUPPORTED_APP_LOCALES;
export type NotificationLocale = (typeof NOTIFICATION_LOCALES)[number];

export interface UpdateNotificationPreferencesInput {
  marketingInAppEnabled?: unknown;
  marketingPushEnabled?: unknown;
  preferredLocale?: unknown;
}

export interface RegisterPushTokenInput {
  deviceId?: unknown;
  platform?: unknown;
  token?: unknown;
}

export interface UpsertProviderConfigInput {
  credentials?: unknown;
  environment?: unknown;
  expectedVersion?: unknown;
}

export interface CreateCampaignInput {
  channels?: unknown;
  deepLink?: unknown;
  name?: unknown;
  target?: unknown;
  translations?: unknown;
}

export interface ScheduleCampaignInput {
  expectedVersion?: unknown;
  scheduledAt?: unknown;
}

export interface CancelCampaignInput {
  expectedVersion?: unknown;
  reason?: unknown;
}

export interface UpdateCampaignInput extends CreateCampaignInput {
  expectedVersion?: unknown;
}

export interface NotificationMutationMetadata {
  actorId: string;
  actorType: 'tenant_staff' | 'user';
  idempotencyKey?: unknown;
  ip?: string;
  requestId: string;
}
