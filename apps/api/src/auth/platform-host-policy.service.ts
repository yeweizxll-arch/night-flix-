import {
  ForbiddenException,
  Inject,
  Injectable,
  OnModuleInit,
} from '@nestjs/common';

import { DatabaseService } from '../database/database.service';

function normalizeHost(hostHeader: string | undefined): string {
  return (hostHeader ?? '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/\.$/, '');
}

@Injectable()
export class PlatformHostPolicyService implements OnModuleInit {
  private readonly allowedHosts = this.loadAllowedHosts();

  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (
      process.env.NODE_ENV !== 'production' ||
      !this.database.resolverConfigured
    ) {
      return;
    }

    for (const host of this.allowedHosts) {
      const rows = await this.database.resolverSql<{ id: string }[]>`
        select id
        from app.resolve_tenant_by_host(${host})
      `;
      if (rows[0]) {
        throw new Error(
          `Platform administration host conflicts with a tenant domain: ${host}`,
        );
      }
    }
  }

  assertAllowed(hostHeader: string | undefined): void {
    if (!this.allowedHosts.has(normalizeHost(hostHeader))) {
      throw new ForbiddenException('Platform administration is not available on this host');
    }
  }

  private loadAllowedHosts(): Set<string> {
    const configured = process.env.PLATFORM_ADMIN_HOSTS
      ?.split(',')
      .map(normalizeHost)
      .filter(Boolean);
    if (configured?.length) {
      return new Set(configured);
    }
    if (process.env.NODE_ENV === 'production') {
      throw new Error('PLATFORM_ADMIN_HOSTS is required in production');
    }
    return new Set(['127.0.0.1', 'localhost']);
  }
}
