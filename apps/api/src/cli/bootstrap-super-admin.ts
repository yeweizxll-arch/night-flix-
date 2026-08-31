import { permissionCatalog } from '@drama/contracts';

import { hashPassword } from '../auth/password';
import { uuidV7 } from '../common/uuid-v7';
import { DatabaseService } from '../database/database.service';

const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{2,63}$/;

async function main(): Promise<void> {
  const username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD;
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase() || null;
  if (!username || !USERNAME_PATTERN.test(username)) {
    throw new Error('BOOTSTRAP_ADMIN_USERNAME must be a valid lowercase username');
  }
  if (!password || Buffer.byteLength(password, 'utf8') < 12) {
    throw new Error('BOOTSTRAP_ADMIN_PASSWORD must contain at least 12 UTF-8 bytes');
  }

  const database = new DatabaseService();
  try {
    const passwordHash = await hashPassword(password);
    await database.inPlatformContext(async (transaction) => {
      const existing = await transaction<{ id: string }[]>`
        select id from platform_staff
        where username = ${username} or (${email}::text is not null and email = ${email})
        limit 1
      `;
      if (existing[0]) {
        throw new Error('A platform administrator with this username or email already exists');
      }

      const staffId = uuidV7();
      await transaction`
        insert into platform_staff (id, username, email, password_hash)
        values (${staffId}, ${username}, ${email}, ${passwordHash})
      `;

      await transaction`
        insert into roles (id, scope_type, name, is_system, created_by)
        values (${uuidV7()}, 'platform', 'platform_super_admin', true, ${staffId})
        on conflict do nothing
      `;
      const roleRows = await transaction<{ id: string }[]>`
        select id from roles
        where scope_type = 'platform' and name = 'platform_super_admin'
        limit 1
      `;
      const roleId = roleRows[0]?.id;
      if (!roleId) {
        throw new Error('Super administrator role could not be created');
      }

      for (const permission of permissionCatalog) {
        await transaction`
          insert into permissions (id, code, module, action, description, created_by)
          values (
            ${uuidV7()},
            ${permission.code},
            ${permission.module},
            ${permission.action},
            '',
            ${staffId}
          )
          on conflict (code) do update
          set module = excluded.module, action = excluded.action
        `;
        if (permission.scope !== 'platform') continue;
        await transaction`
          insert into role_permissions (
            role_id,
            permission_id,
            scope_type,
            data_scope,
            created_by
          )
          select ${roleId}, id, 'platform', 'all', ${staffId}
          from permissions where code = ${permission.code}
          on conflict (role_id, permission_id) do nothing
        `;
      }

      await transaction`
        insert into subject_roles (
          id,
          scope_type,
          subject_type,
          subject_id,
          role_id,
          created_by
        ) values (
          ${uuidV7()},
          'platform',
          'platform_staff',
          ${staffId},
          ${roleId},
          ${staffId}
        )
      `;
    });
    process.stdout.write(`created platform administrator ${username}\n`);
  } finally {
    await database.onApplicationShutdown();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
