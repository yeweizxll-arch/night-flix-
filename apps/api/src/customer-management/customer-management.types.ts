import type { AccessScope } from '../access-control';

export interface CustomerActorContext {
  actorId: string;
  scope: AccessScope;
  tenantId?: string;
}

export interface CustomerMutationMetadata {
  idempotencyKey?: unknown;
  ip?: string;
  requestId: string;
}

export interface CustomerDeviceSummary {
  activeSessions: number;
  id: string;
  label?: string;
  lastSeenAt: string;
  platform: 'android' | 'h5' | 'ios' | 'web';
  status: 'active' | 'revoked';
}

export interface ManagedCustomerRecord {
  activeEntitlements: {
    drama: number;
    episode: number;
    membership: number;
    total: number;
  };
  createdAt: string;
  devices: CustomerDeviceSummary[];
  email?: string;
  emailVerified: boolean;
  id: string;
  orders: {
    paid: number;
    refunded: number;
    total: number;
  };
  phone?: string;
  phoneVerified: boolean;
  pointsBalance: string;
  status: 'active' | 'disabled';
  tenantId: string;
  updatedAt: string;
  username: string;
  version: number;
}

export interface CustomerListResponse {
  items: ManagedCustomerRecord[];
  nextCursor: string | null;
  pageSize: number;
}
