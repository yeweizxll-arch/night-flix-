export type AuditActorType = 'platform_staff' | 'system' | 'tenant_staff' | 'user';

export interface AuditLogQueryInput {
  action?: unknown;
  actor?: unknown;
  actorId?: unknown;
  actorType?: unknown;
  from?: unknown;
  page?: unknown;
  pageSize?: unknown;
  q?: unknown;
  requestId?: unknown;
  resource?: unknown;
  resourceId?: unknown;
  resourceType?: unknown;
  tenantId?: unknown;
  to?: unknown;
}

export interface AuditLogRecord {
  action: string;
  actor: {
    id: string | null;
    type: AuditActorType;
  };
  after: unknown;
  before: unknown;
  createdAt: string;
  id: string;
  ip: string | null;
  requestId: string;
  resource: {
    id: string | null;
    type: string;
  };
  scope: 'platform' | 'tenant';
  tenantId: string | null;
}

export interface AuditLogPage {
  items: AuditLogRecord[];
  page: number;
  pageSize: number;
  total: number;
}
