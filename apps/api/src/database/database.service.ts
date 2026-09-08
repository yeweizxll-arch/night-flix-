import {
  Injectable,
  OnApplicationShutdown,
  ServiceUnavailableException,
} from '@nestjs/common';
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { currentRequestCountry } from '../tenancy/tenant-context.service';

export type DatabaseTransaction = TransactionSql;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class DatabaseService implements OnApplicationShutdown {
  private readonly client: Sql | undefined;
  private readonly platformClient: Sql | undefined;
  private readonly resolverClient: Sql | undefined;

  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('DATABASE_URL is required in production');
      }
      return;
    }

    this.client = this.createClient(databaseUrl);

    const platformUrl = process.env.PLATFORM_DATABASE_URL;
    const resolverUrl = process.env.TENANT_RESOLVER_DATABASE_URL;
    if (process.env.NODE_ENV === 'production' && (!platformUrl || !resolverUrl)) {
      throw new Error(
        'PLATFORM_DATABASE_URL and TENANT_RESOLVER_DATABASE_URL are required in production',
      );
    }

    this.platformClient = !platformUrl || platformUrl === databaseUrl
      ? this.client
      : this.createClient(platformUrl);
    if (!resolverUrl || resolverUrl === databaseUrl) {
      this.resolverClient = this.client;
    } else if (resolverUrl === platformUrl) {
      this.resolverClient = this.platformClient;
    } else {
      this.resolverClient = this.createClient(resolverUrl);
    }
  }

  private createClient(databaseUrl: string): Sql {
    return postgres(databaseUrl, {
      connect_timeout: 10,
      idle_timeout: 20,
      max: databaseInteger('DATABASE_POOL_MAX', 10, 1000),
      prepare: true,
      ssl: resolveDatabaseSsl(databaseUrl),
      connection: {
        statement_timeout: databaseInteger('DATABASE_STATEMENT_TIMEOUT_MS', 30_000, 300_000),
        lock_timeout: databaseInteger('DATABASE_LOCK_TIMEOUT_MS', 5_000, 60_000),
      },
    });
  }

  get sql(): Sql {
    if (!this.client) {
      throw new ServiceUnavailableException('Database is not configured');
    }

    return this.client;
  }

  get configured(): boolean {
    return Boolean(this.client);
  }

  get resolverConfigured(): boolean {
    return Boolean(this.resolverClient);
  }

  get resolverSql(): Sql {
    if (!this.resolverClient) {
      throw new ServiceUnavailableException('Tenant resolver database is not configured');
    }

    return this.resolverClient;
  }

  async ping(): Promise<boolean> {
    if (!this.client) {
      return false;
    }

    const clients = [...new Set(
      [this.client, this.platformClient, this.resolverClient].filter(
        (client): client is Sql => Boolean(client),
      ),
    )];
    const checks = await Promise.all(
      clients.map(async (client) => {
        const rows = await client<{ ok: number }[]>`select 1 as ok`;
        return rows[0]?.ok === 1;
      }),
    );
    return checks.every(Boolean);
  }

  async inPlatformContext<T>(
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    if (!this.platformClient) {
      throw new ServiceUnavailableException('Platform database is not configured');
    }

    const result = await this.platformClient.begin(async (transaction) => {
      await transaction`select set_config('app.request_country', ${currentRequestCountry() ?? ''}, true)`;
      return callback(transaction);
    });
    return result as T;
  }

  async validateProductionSecurity(): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      return;
    }
    if (!this.client || !this.platformClient || !this.resolverClient) {
      throw new Error('All production database connections must be configured');
    }

    const [tenant, platform, resolver] = await Promise.all([
      inspectDatabaseRole(this.client),
      inspectDatabaseRole(this.platformClient),
      inspectDatabaseRole(this.resolverClient),
    ]);
    if (new Set([tenant.roleName, platform.roleName, resolver.roleName]).size !== 3) {
      throw new Error('Tenant, platform, and resolver database roles must be different');
    }
    for (const role of [tenant, platform, resolver]) {
      if (role.superuser || role.bypassRls || role.ownsApplicationTables) {
        throw new Error(`Database role ${role.roleName} has unsafe production privileges`);
      }
    }
    if (tenant.platformAccess || resolver.platformAccess || !platform.platformAccess) {
      throw new Error('Database platform access role registration is invalid');
    }
    if (resolver.canSelectTenantDomains || !resolver.canResolveTenantHost) {
      throw new Error('Tenant resolver database role is not least-privileged');
    }
  }

  async inTenantContext<T>(
    tenantId: string,
    callback: (transaction: DatabaseTransaction) => Promise<T>,
  ): Promise<T> {
    if (!UUID_PATTERN.test(tenantId)) {
      throw new TypeError('tenantId must be a UUID');
    }

    const result = await this.sql.begin(async (transaction) => {
      await transaction`
        select
          set_config('app.access_scope', 'tenant', true),
          set_config('app.request_country', ${currentRequestCountry() ?? ''}, true),
          set_config('app.tenant_id', ${tenantId}, true)
      `;
      return callback(transaction);
    });
    return result as T;
  }

  async onApplicationShutdown(): Promise<void> {
    const clients = [...new Set(
      [this.client, this.platformClient, this.resolverClient].filter(
        (client): client is Sql => Boolean(client),
      ),
    )];
    await Promise.all(clients.map((client) => client.end({ timeout: 5 })));
  }
}

function databaseInteger(name: string, fallback: number, maximum: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be an integer between 1 and ${maximum}`);
  }
  return value;
}

interface DatabaseRoleInspection {
  bypassRls: boolean;
  canResolveTenantHost: boolean;
  canSelectTenantDomains: boolean;
  ownsApplicationTables: boolean;
  platformAccess: boolean;
  roleName: string;
  superuser: boolean;
}

async function inspectDatabaseRole(client: Sql): Promise<DatabaseRoleInspection> {
  const rows = await client<
    {
      bypass_rls: boolean;
      can_resolve_tenant_host: boolean;
      can_select_tenant_domains: boolean;
      owns_application_tables: boolean;
      platform_access: boolean;
      role_name: string;
      superuser: boolean;
    }[]
  >`
    select
      current_user::text as role_name,
      role.rolsuper as superuser,
      role.rolbypassrls as bypass_rls,
      app.has_platform_access(current_user) as platform_access,
      has_function_privilege(
        current_user,
        'app.resolve_tenant_by_host(text)',
        'EXECUTE'
      ) as can_resolve_tenant_host,
      has_table_privilege(current_user, 'public.tenant_domains', 'SELECT')
        as can_select_tenant_domains,
      exists (
        select 1
        from pg_class as relation
        inner join pg_namespace as namespace on namespace.oid = relation.relnamespace
        where relation.relowner = role.oid
          and namespace.nspname in ('public', 'app')
          and relation.relkind in ('r', 'p')
      ) as owns_application_tables
    from pg_roles as role
    where role.rolname = current_user
  `;
  const row = rows[0];
  if (!row) {
    throw new Error('Current database role could not be inspected');
  }
  return {
    bypassRls: row.bypass_rls,
    canResolveTenantHost: row.can_resolve_tenant_host,
    canSelectTenantDomains: row.can_select_tenant_domains,
    ownsApplicationTables: row.owns_application_tables,
    platformAccess: row.platform_access,
    roleName: row.role_name,
    superuser: row.superuser,
  };
}

function resolveDatabaseSsl(databaseUrl: string): false | 'require' | {
  ca?: string;
  rejectUnauthorized: true;
  servername?: string;
} {
  const mode = process.env.DATABASE_SSL?.trim().toLowerCase() ?? 'disable';
  if (process.env.NODE_ENV === 'production' && mode !== 'verify-full') {
    throw new Error('DATABASE_SSL=verify-full is required in production');
  }
  if (mode === 'disable') {
    return false;
  }
  if (mode === 'require') {
    return 'require';
  }
  if (mode !== 'verify-full') {
    throw new Error('DATABASE_SSL must be disable, require, or verify-full');
  }

  const url = new URL(databaseUrl);
  const encodedCa = process.env.DATABASE_SSL_CA_BASE64;
  return {
    ca: encodedCa ? Buffer.from(encodedCa, 'base64').toString('utf8') : undefined,
    rejectUnauthorized: true,
    servername: url.hostname || undefined,
  };
}
