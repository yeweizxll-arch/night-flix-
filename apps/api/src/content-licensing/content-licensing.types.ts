export interface LicensingMutationMetadata {
  actorId: string;
  idempotencyKey?: string;
  ip?: string;
  requestId: string;
}

export interface CreateLicensePackageInput {
  code: string;
  name: string;
}

export interface ReplaceLicensePackageItemsInput {
  dramaIds: string[];
  version: number;
}

export interface GrantContentLicenseInput {
  dramaId?: string;
  expiresAt: string;
  licenseType: 'drama' | 'package';
  packageId?: string;
  startsAt: string;
  tenantId: string;
}

export interface RevokeContentLicenseInput {
  reason: string;
  version: number;
}

export interface LicensePackageRecord {
  code: string;
  createdAt: string;
  dramaIds: string[];
  id: string;
  name: string;
  status: 'active' | 'disabled';
  updatedAt: string;
  version: number;
}

export interface ContentLicenseRecord {
  createdAt: string;
  dramaId?: string;
  dramaIds: string[];
  expiresAt: string;
  id: string;
  licenseType: 'drama' | 'package';
  packageId?: string;
  revokeReason?: string;
  revokedAt?: string;
  startsAt: string;
  status: 'active' | 'expired' | 'revoked' | 'scheduled';
  tenantId: string;
  tenantName: string;
  version: number;
}

export interface LicensedPublicDramaRecord {
  code: string;
  coverFileId?: string;
  id: string;
  licensedUntil: string;
  status: 'published';
  totalEpisodes: number;
  translations: Array<{
    locale: string;
    searchKeywords: string[];
    summary: string;
    title: string;
  }>;
}
