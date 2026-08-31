export interface CreateMerchantInput {
  code: string;
  defaultCurrency: string;
  defaultLocale: string;
  expiresAt: string;
  name: string;
  owner: {
    email?: string;
    password: string;
    phone?: string;
    username: string;
  };
  timezone: string;
}

export interface MerchantRecord {
  code: string;
  createdAt: string;
  defaultCurrency: string;
  defaultLocale: string;
  expiresAt: string;
  id: string;
  name: string;
  primaryDomain: string;
  status: 'active' | 'expired' | 'suspended';
  timezone: string;
  version: number;
}

export interface UpdateMerchantInput {
  expiresAt?: string;
  name?: string;
  reason: string;
  status?: 'active' | 'suspended';
  version: number;
}

export interface MerchantMutationMetadata {
  actorId: string;
  ip?: string;
  requestId: string;
}

