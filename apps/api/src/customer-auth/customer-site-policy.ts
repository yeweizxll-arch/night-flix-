import { ForbiddenException } from '@nestjs/common';

import type { DatabaseTransaction } from '../database/database.service';

/** Database-authoritative gate for every customer-facing operation. */
export async function assertCustomerSiteAvailable(
  transaction: DatabaseTransaction,
  tenantId: string,
): Promise<void> {
  return assertCustomerTenantAvailable(transaction, tenantId, true);
}

export async function assertCustomerTenantAvailable(
  transaction: DatabaseTransaction,
  tenantId: string,
  requireUserSiteEnabled: boolean,
): Promise<void> {
  const rows = await transaction<{ available: boolean }[]>`
    select exists (
      select 1
      from tenants
      where id = ${tenantId}
        and status = 'active'
        and expires_at > statement_timestamp()
        and platform_site_enabled = true
        and (${requireUserSiteEnabled} = false or user_site_enabled = true)
    ) as available
  `;
  if (!rows[0]?.available) {
    throw new ForbiddenException('Customer site is unavailable');
  }
}

/** Security recovery/closure remains available while either customer site flag is off. */
export async function assertCustomerTenantActive(
  transaction: DatabaseTransaction,
  tenantId: string,
): Promise<void> {
  const rows = await transaction<{ available: boolean }[]>`
    select exists (
      select 1
      from tenants
      where id = ${tenantId}
        and status = 'active'
        and expires_at > statement_timestamp()
    ) as available
  `;
  if (!rows[0]?.available) {
    throw new ForbiddenException('Customer tenant is unavailable');
  }
}
