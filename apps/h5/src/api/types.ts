export const CONTENT_LOCALES = [
  'zh-CN',
  'zh-TW',
  'en-US',
  'fr-FR',
  'ja-JP',
  'ko-KR',
] as const;

export type ContentLocale = (typeof CONTENT_LOCALES)[number];

export interface CustomerPrincipal {
  accountId: string;
  deviceId: string;
  sessionId: string;
  tenantId: string;
  username: string;
}

export interface CustomerSession {
  accessExpiresAt: string;
  accessToken: string;
  deviceToken?: string;
  principal: CustomerPrincipal;
  refreshExpiresAt: string;
  refreshToken: string;
}

export interface BootstrapResponse {
  capabilities: {
    commerceCatalog: boolean;
    customerAuthentication: boolean;
    entitlements: boolean;
    pointsWallet: boolean;
  };
  defaultLocale: ContentLocale;
  iconMediaAssetId?: string;
  logoMediaAssetId?: string;
  onlineOnly: true;
  siteName: string;
  supportedLocales: ContentLocale[];
  theme: {
    accentColor: string;
    colorMode: 'dark' | 'light' | 'system';
    primaryColor: string;
  };
}

export interface AssetUrlResponse {
  expiresAt: string;
  mediaAssetId: string;
  url: string;
}

export interface TaxonomyItem {
  code: string;
  id: string;
  locale: ContentLocale;
  name: string;
}

export interface TaxonomyResponse {
  hasMore: boolean;
  items: TaxonomyItem[];
  locale: ContentLocale;
}

export interface DramaListItem {
  code: string;
  coverMediaId?: string;
  id: string;
  locale: ContentLocale;
  pointsAmount?: number;
  summary: string;
  title: string;
  totalEpisodes: number;
}

export interface DramaEpisode {
  durationSeconds: number;
  episodeNo: number;
  id: string;
  locale: ContentLocale;
  mediaAssetId: string;
  pointsAmount?: number;
  previewMediaAssetId?: string;
  previewSeconds: number;
  title: string;
}

export interface DramaDetail extends DramaListItem {
  episodes: DramaEpisode[];
}

export interface PageResponse<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PlaybackAccess {
  access: 'full' | 'locked' | 'preview';
  dramaId: string;
  durationSeconds: number;
  episodeId: string;
  mediaAssetId: string;
  previewMediaAssetId?: string;
  previewSeconds: number;
}

export interface PlaybackUrl {
  access: 'full' | 'preview';
  expiresAt: string;
  mediaAssetId: string;
  offlineSupported: false;
  url: string;
}

export interface WatchProgress {
  completed: boolean;
  dramaId: string;
  episodeId: string;
  positionSeconds: number;
  updatedAt: string;
  version: number;
}

export interface FavoriteRecord {
  code: string;
  coverFileId?: string;
  createdAt: string;
  dramaId: string;
  title?: string;
}

export interface AccountSummary {
  accountId: string;
  email?: { masked: string; verified: boolean };
  phone?: { masked: string; verified: boolean };
  username: string;
}

export interface CustomerDevice {
  current: boolean;
  id: string;
  label?: string | null;
  lastSeenAt: string;
  platform: 'android' | 'h5' | 'ios' | 'web';
  status: 'active';
}

export interface DeviceListResponse {
  items: CustomerDevice[];
}

export const COMMERCE_CURRENCIES = ['CNY', 'USD', 'EUR', 'JPY', 'KRW'] as const;
export type CommerceCurrency = (typeof COMMERCE_CURRENCIES)[number];
export type CommerceProductType = 'membership' | 'drama' | 'episode' | 'points_topup';

export interface CommerceOrderInput {
  currency: CommerceCurrency;
  locale: ContentLocale;
  productId: string;
  productType: CommerceProductType;
}

export interface CommerceQuote {
  currency: CommerceCurrency;
  locale: ContentLocale;
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
  locale: ContentLocale;
  orderNo: string;
  orderType: CommerceProductType;
  status: 'cancelled' | 'expired' | 'paid' | 'pending_payment' | 'refunded';
  totalMinor: number;
}

export interface RedirectCheckoutAction {
  expiresAt: string;
  type: 'redirect';
  url: string;
}

export interface PaymentAttempt {
  amountMinor: number;
  checkoutAction: RedirectCheckoutAction | null;
  collectionMode: 'platform_collect' | 'tenant_direct';
  createdAt: string;
  currency: CommerceCurrency;
  externalPaymentId: string | null;
  id: string;
  orderId: string;
  status: string;
  succeededAt?: string;
}

export type LegalDocumentType = 'community' | 'privacy' | 'refund' | 'terms';

export interface LegalDocument {
  bodyMarkdown: string;
  documentType: LegalDocumentType;
  effectiveAt?: string;
  id: string;
  locale: ContentLocale;
  requiredForRegistration: boolean;
  title: string;
  version: number;
}

export interface CurrentLegalDocumentsResponse {
  documents: LegalDocument[];
  requestedLocale: ContentLocale;
}

export interface OtpChallengeResponse {
  challengeId: string;
  deliveryRequired: boolean;
  expiresAt: string;
}

export interface OtpVerificationResponse {
  verificationExpiresAt?: string;
  verificationToken?: string;
  verified: true;
}

export interface LegalConsentRecord {
  consentSource: string;
  consentedAt: string;
  documentId: string;
  documentType: LegalDocumentType;
  id: string;
  locale: ContentLocale;
  title: string;
  version: number;
}

export type PrivacyExportSection =
  | 'profile'
  | 'consents'
  | 'orders'
  | 'comments'
  | 'bulletComments'
  | 'watchProgress'
  | 'favorites'
  | 'notifications';

export interface PrivacyExportPage {
  exportedAt: string;
  items: unknown[];
  nextCursor?: string;
  notice: string;
  section: PrivacyExportSection;
}

export interface PrivacyRetentionSummary {
  category: string;
  reason: string;
  retainedUntil: string;
}

export interface PrivacyErasureResponse {
  dataErasurePerformed: boolean;
  estimatedCompletionBy?: string;
  message: string;
  requestId: string;
  retentionSummary: PrivacyRetentionSummary[];
  status: 'completed' | 'failed' | 'processing' | 'submitted';
  submittedAt: string;
  subprocessorStatus: Array<{
    boundary: string;
    provider: string;
    status: 'operator_follow_up_required';
  }>;
}
