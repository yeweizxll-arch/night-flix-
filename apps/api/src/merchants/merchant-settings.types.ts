export interface MerchantSettingsMutationMetadata {
  actorId: string;
  idempotencyKey?: string;
  ip?: string;
  requestId: string;
}

export interface SiteTheme {
  accentColor: string;
  colorMode: 'dark' | 'light' | 'system';
  primaryColor: string;
}

export interface TenantSiteSettingsRecord {
  defaultLocale: string;
  effectiveSiteEnabled: boolean;
  iconMediaAssetId?: string;
  logoMediaAssetId?: string;
  merchantName: string;
  platformSiteEnabled: boolean;
  siteName: string;
  tenantId: string;
  theme: SiteTheme;
  userSiteEnabled: boolean;
  version: number;
}

export interface TenantDomainRecord {
  createdAt: string;
  enabled: boolean;
  host: string;
  id: string;
  isPrimary: boolean;
  readOnly: boolean;
  tlsStatus: 'pending' | 'provisioning' | 'active' | 'failed' | 'disabled';
  type: 'custom' | 'subdomain';
  updatedAt: string;
  verification:
    | { status: 'verified'; verifiedAt: string }
    | {
        recordName: string;
        recordType: 'TXT';
        recordValue: string;
        status: 'pending';
      };
  version: number;
}
