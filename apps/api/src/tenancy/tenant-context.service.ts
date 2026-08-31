import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantRequestContext {
  host: string;
  tenantId?: string;
  tenantStatus?: 'active' | 'expired' | 'suspended';
}

@Injectable()
export class TenantContextService {
  private readonly storage = new AsyncLocalStorage<TenantRequestContext>();

  run<T>(context: TenantRequestContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  current(): TenantRequestContext | undefined {
    return this.storage.getStore();
  }

  requireTenantId(): string {
    const tenantId = this.current()?.tenantId;
    if (!tenantId) {
      throw new Error('Tenant context is required for this operation');
    }

    return tenantId;
  }
}
