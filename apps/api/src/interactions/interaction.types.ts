import type { CustomerPrincipal } from '../customer-auth/customer-auth.types';

export type InteractionTargetType = 'bullet_comment' | 'comment';
export type InteractionStatus = 'deleted' | 'hidden' | 'pending' | 'visible';

export interface InteractionCommandMetadata {
  actorId: string;
  actorType: 'platform_staff' | 'tenant_staff' | 'user';
  idempotencyKey: unknown;
  ip?: string;
  requestId: string;
  scope: 'platform' | 'tenant';
}

export interface CreateCommentInput {
  body?: unknown;
  dramaId?: unknown;
  episodeId?: unknown;
  parentId?: unknown;
}

export interface CreateBulletCommentInput {
  body?: unknown;
  dramaId?: unknown;
  episodeId?: unknown;
  positionMs?: unknown;
}

export interface CreateInteractionReportInput {
  details?: unknown;
  reasonCategory?: unknown;
  targetId?: unknown;
  targetType?: unknown;
}

export interface CreateSensitiveWordInput {
  term?: unknown;
}

export interface ModerateInteractionInput {
  action?: unknown;
  reason?: unknown;
  tenantId?: unknown;
}

export interface CustomerInteractionContext {
  principal: CustomerPrincipal;
  tenantId: string;
}

export interface InteractionItemResponse {
  body: string;
  createdAt: string;
  dramaId: string;
  episodeId?: string;
  id: string;
  parentId?: string;
  positionMs?: number;
  status: InteractionStatus;
  username?: string;
}

export interface InteractionReportResponse {
  createdAt: string;
  id: string;
  reasonCategory: string;
  status: 'open' | 'rejected' | 'resolved' | 'reviewing';
  targetId: string;
  targetType: InteractionTargetType;
}

export interface SensitiveWordResponse {
  createdAt: string;
  id: string;
  scope: 'platform' | 'tenant';
  status: 'active' | 'disabled';
  tenantId?: string;
  term: string;
}
