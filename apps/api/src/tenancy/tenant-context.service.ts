import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantRequestContext {
  country?: string;
  host: string;
  tenantId?: string;
  tenantStatus?: 'active' | 'expired' | 'suspended';
}

const requestStorage = new AsyncLocalStorage<TenantRequestContext>();
export const currentRequestCountry = () => requestStorage.getStore()?.country;

@Injectable()
export class TenantContextService {
  private readonly storage = requestStorage;

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
