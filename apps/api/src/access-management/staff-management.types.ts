import type { AccessScope } from '../access-control';

export interface StaffActorContext {
  actorId: string;
  scope: AccessScope;
  tenantId?: string;
}

export interface StaffMutationMetadata {
  idempotencyKey?: string;
  ip?: string;
  requestId: string;
}

export interface StaffRoleSummary {
  id: string;
  isSystem: boolean;
  name: string;
  status: 'active' | 'disabled';
}

export interface StaffRecord {
  createdAt: string;
  email?: string;
  id: string;
  phone?: string;
  roles: StaffRoleSummary[];
  status: 'active' | 'disabled' | 'locked';
  updatedAt: string;
  username: string;
  version: number;
}

export interface StaffListResponse {
  items: StaffRecord[];
  page: number;
  pageSize: number;
  total: number;
}

