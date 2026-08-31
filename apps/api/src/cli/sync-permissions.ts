import { permissionCatalog } from '@drama/contracts';

import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService } from '../database/database.service';

async function main(): Promise<void> {
  const database = new DatabaseService();
  try {
    const result = await database.inPlatformContext(async (transaction) => {
      let synchronized = 0;
      let granted = 0;
      let removedInvalidGrants = 0;

      for (const permission of permissionCatalog) {
        const rows = await transaction<{ id: string }[]>`
          insert into permissions (id, code, module, action, description)
          values (
            ${uuidV7()}, ${permission.code}, ${permission.module},
            ${permission.action}, ''
          )
          on conflict (code) do update
          set
            module = excluded.module,
            action = excluded.action,
            version = permissions.version + 1
          where permissions.module is distinct from excluded.module
             or permissions.action is distinct from excluded.action
          returning id
        `;

        let permissionId = rows[0]?.id;
        if (!permissionId) {
          const existing = await transaction<{ id: string }[]>`
            select id from permissions where code = ${permission.code}
          `;
          permissionId = existing[0]?.id;
        }
        if (!permissionId) {
          throw new Error(`Permission ${permission.code} could not be synchronized`);
        }
        synchronized += 1;

        if (permission.scope === 'platform') {
          const removed = await transaction<{ role_id: string }[]>`
            delete from role_permissions as grant
            using roles as role
            where grant.role_id = role.id
              and grant.permission_id = ${permissionId}
              and role.scope_type = 'tenant'
              and role.is_system = true
              and role.name = 'tenant_owner'
            returning grant.role_id
          `;
          removedInvalidGrants += removed.length;
          const assignments = await transaction<{ role_id: string }[]>`
            insert into role_permissions (
              role_id, permission_id, scope_type, data_scope
            )
            select role.id, ${permissionId}, 'platform', 'all'
            from roles as role
            where role.scope_type = 'platform'
              and role.tenant_id is null
              and role.is_system = true
              and role.name = 'platform_super_admin'
            on conflict (role_id, permission_id) do nothing
            returning role_id
          `;
          granted += assignments.length;
          continue;
        }

        const removed = await transaction<{ role_id: string }[]>`
          delete from role_permissions as grant
          using roles as role
          where grant.role_id = role.id
            and grant.permission_id = ${permissionId}
            and role.scope_type = 'platform'
            and role.is_system = true
            and role.name = 'platform_super_admin'
          returning grant.role_id
        `;
        removedInvalidGrants += removed.length;
        const assignments = await transaction<{ role_id: string }[]>`
          insert into role_permissions (
            role_id, permission_id, scope_type, tenant_id, data_scope
          )
          select role.id, ${permissionId}, 'tenant', role.tenant_id, 'all'
          from roles as role
          where role.scope_type = 'tenant'
            and role.tenant_id is not null
            and role.is_system = true
            and role.name = 'tenant_owner'
          on conflict (role_id, permission_id) do nothing
          returning role_id
        `;
        granted += assignments.length;
      }

      return { granted, removedInvalidGrants, synchronized };
    });

    process.stdout.write(
      `synchronized ${result.synchronized} permissions, added ${result.granted} system-role grants, removed ${result.removedInvalidGrants} invalid grants\n`,
    );
  } finally {
    await database.onApplicationShutdown();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
