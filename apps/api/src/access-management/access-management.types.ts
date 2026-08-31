import type { AccessScope } from '../access-control';

export interface AccessActorContext {
  actorId: string;
  scope: AccessScope;
  tenantId?: string;
}

export interface PermissionDirectoryItem {
  action: string;
  code: string;
  module: string;
  scope: AccessScope;
}

export interface RolePermissionGrant {
  code: string;
  dataScope: 'all';
}

export interface RoleRecord {
  id: string;
  isSystem: boolean;
  name: string;
  permissions: RolePermissionGrant[];
  status: 'active' | 'disabled';
  version: number;
}

export interface StaffRoleAssignmentResult {
  assigned: boolean;
  roleId: string;
  staffId: string;
}
