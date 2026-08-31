import { Inject, Injectable, Optional } from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

export interface TenantResolution {
  id: string;
  status: 'active' | 'expired' | 'suspended';
}

interface CachedTenantResolution {
  expiresAt: number;
  value: TenantResolution | undefined;
}

const MAX_CACHE_ENTRIES = 2_000;
const HOST_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeHost(value: string): string | undefined {
  const host = value.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (!host || host.length > 253 || !HOST_PATTERN.test(host)) {
    return undefined;
  }
  return host;
}

@Injectable()
export class TenantDirectoryService {
  private readonly domainMap = this.loadDomainMap();
  private readonly cache = new Map<string, CachedTenantResolution>();

  constructor(
    @Optional()
    @Inject(DatabaseService)
    private readonly database?: DatabaseService,
  ) {}

  async resolveVerifiedHost(
    hostHeader: string | undefined,
  ): Promise<TenantResolution | undefined> {
    if (!hostHeader) {
      return undefined;
    }

    const host = normalizeHost(hostHeader);
    if (!host) {
      return undefined;
    }
    const cached = this.cache.get(host);
    if (cached && cached.expiresAt > Date.now()) {
      this.cache.delete(host);
      this.cache.set(host, cached);
      return cached.value;
    }
    this.cache.delete(host);

    const value = this.database?.resolverConfigured
      ? await this.resolveFromDatabase(host)
      : this.resolveDevelopmentDomain(host);

    this.setCache(host, {
      expiresAt: Date.now() + (value ? 30_000 : 5_000),
      value,
    });
    return value;
  }

  invalidate(hostHeader: string): void {
    const host = normalizeHost(hostHeader);
    if (host) {
      this.cache.delete(host);
    }
  }

  private setCache(host: string, value: CachedTenantResolution): void {
    while (this.cache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = this.cache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      this.cache.delete(oldestKey);
    }
    this.cache.set(host, value);
  }

  private async resolveFromDatabase(
    host: string,
  ): Promise<TenantResolution | undefined> {
    if (!this.database) {
      return undefined;
    }

    const rows = await this.database.resolverSql<
      { id: string; status: 'active' | 'expired' | 'suspended' }[]
    >`
      select id, status
      from app.resolve_tenant_by_host(${host})
    `;

    return rows[0];
  }

  private resolveDevelopmentDomain(host: string): TenantResolution | undefined {
    const id = this.domainMap.get(host);
    if (!id) {
      return undefined;
    }

    return { id, status: 'active' };
  }

  private loadDomainMap(): Map<string, string> {
    const rawMap = process.env.TENANT_DOMAIN_MAP;
    if (!rawMap) {
      return new Map();
    }

    if (process.env.NODE_ENV === 'production') {
      throw new Error('TENANT_DOMAIN_MAP is not allowed in production');
    }

    const value: unknown = JSON.parse(rawMap);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('TENANT_DOMAIN_MAP must be a JSON object');
    }

    return new Map(
      Object.entries(value).map(([domain, tenantId]) => {
        if (typeof tenantId !== 'string' || tenantId.length === 0) {
          throw new Error(`Invalid tenant id configured for domain ${domain}`);
        }

        const normalizedDomain = normalizeHost(domain);
        if (!normalizedDomain) {
          throw new Error(`Invalid tenant domain configured: ${domain}`);
        }
        return [normalizedDomain, tenantId];
      }),
    );
  }
}
