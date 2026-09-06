import { SUPPORTED_APP_LOCALES } from '@drama/contracts';
import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';

export const CUSTOMER_LEGAL_LOCALES = SUPPORTED_APP_LOCALES;

export const LEGAL_DOCUMENT_TYPES = [
  'privacy',
  'terms',
  'refund',
  'community',
] as const;

export type CustomerLegalLocale = (typeof CUSTOMER_LEGAL_LOCALES)[number];
export type LegalDocumentType = (typeof LEGAL_DOCUMENT_TYPES)[number];

export interface LegalActorContext {
  actorId: string;
  tenantId: string;
}

export interface LegalCommandMetadata {
  idempotencyKey: unknown;
  requestId: string;
}

export interface PrivacyRequestMetadata extends LegalCommandMetadata {
  ip?: string;
}

export interface CustomerPrivacyPrincipal extends CustomerPrincipal {}

export interface LegalConsentInput {
  documentId?: unknown;
  version?: unknown;
}

export interface RegisterLegalConsentInput {
  legalConsents?: unknown;
  legalLocale?: unknown;
}

export interface CustomerPrivacyExportInput {
  currentPassword?: unknown;
  cursor?: unknown;
  pageSize?: unknown;
  section?: unknown;
}

export interface CustomerErasureRequestInput {
  acknowledgeRetention?: unknown;
  currentPassword?: unknown;
}
