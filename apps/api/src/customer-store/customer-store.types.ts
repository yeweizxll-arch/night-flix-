import type { CustomerContentLocale } from '../customer-content/customer-content-catalog.types';

export type CustomerStoreLocale = CustomerContentLocale;
export type CustomerStoreCurrency = 'CNY' | 'EUR' | 'JPY' | 'KRW' | 'USD';

export interface CustomerStoreQuery {
  currency?: unknown;
  locale?: unknown;
}

export interface CustomerPageQuery {
  cursor?: unknown;
  pageSize?: unknown;
}

export interface CustomerEntitlementQuery extends CustomerPageQuery {
  locale?: unknown;
  status?: unknown;
}

export type CustomerEntitlementFilter = 'active' | 'expired';

