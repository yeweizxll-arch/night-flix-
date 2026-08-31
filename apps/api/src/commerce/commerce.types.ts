import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';

export const COMMERCE_CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'KRW'] as const;
export const COMMERCE_LOCALES = [
  'zh-CN',
  'zh-TW',
  'en-US',
  'fr-FR',
  'ja-JP',
  'ko-KR',
] as const;

export type CommerceCurrency = (typeof COMMERCE_CURRENCIES)[number];
export type CommerceLocale = (typeof COMMERCE_LOCALES)[number];
export type CommerceProductType = 'membership' | 'drama' | 'episode' | 'points_topup';

export interface CommerceTranslationInput {
  description?: string;
  locale: CommerceLocale;
  name: string;
}

export interface CreateMembershipPlanInput {
  code: string;
  durationDays: number;
  status?: 'active' | 'disabled';
  translations: CommerceTranslationInput[];
}

export interface CreatePointsTopupPackageInput {
  bonusPoints?: number;
  code: string;
  pointsAmount: number;
  status?: 'active' | 'disabled';
  translations: CommerceTranslationInput[];
}

export interface UpsertPriceInput {
  amountMinor: number;
  currency: CommerceCurrency;
  status?: 'active' | 'disabled';
}

export interface UpdateCatalogStatusInput {
  status: 'active' | 'disabled';
  version: number;
}

export interface ReplaceCatalogTranslationsInput {
  translations: CommerceTranslationInput[];
  version: number;
}

export interface UpsertContentPriceInput extends UpsertPriceInput {
  targetId: string;
  targetType: 'drama' | 'episode';
}

export interface UpsertContentPointPriceInput {
  pointsAmount: number;
  status?: 'active' | 'disabled';
  targetId: string;
  targetType: 'drama' | 'episode';
  version: number;
}

export interface CatalogMutationMetadata {
  actorId: string;
  requestId: string;
}

export interface CommerceOrderInput {
  currency: CommerceCurrency;
  locale: CommerceLocale;
  productId: string;
  productType: CommerceProductType;
}

export interface CommerceQuote {
  currency: CommerceCurrency;
  locale: CommerceLocale;
  product: Record<string, unknown> & {
    id: string;
    name: string;
    type: CommerceProductType;
  };
  totalMinor: number;
}

export interface CommerceOrderSummary {
  createdAt: string;
  currency: CommerceCurrency;
  expiresAt: string;
  id: string;
  item: CommerceQuote['product'] & { unitAmountMinor: number };
  locale: CommerceLocale;
  orderNo: string;
  orderType: CommerceProductType;
  status: 'cancelled' | 'expired' | 'paid' | 'pending_payment' | 'refunded';
  totalMinor: number;
}

export interface CustomerOrderMetadata {
  idempotencyKey?: string;
  ip?: string;
  requestId: string;
}

export type CommerceCustomerPrincipal = CustomerPrincipal;
