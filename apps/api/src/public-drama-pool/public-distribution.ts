import { NotFoundException } from '@nestjs/common';
import type { DatabaseTransaction } from '../database/database.service';

/** A publication decision overrides legacy licensing, including an explicit takedown. */
export async function lockPublicDistribution(
  transaction: DatabaseTransaction, tenantId: string, dramaId: string,
  allowedStatuses: readonly string[] = ['published'],
): Promise<string> {
  const publications = await transaction<{ status: string }[]>`
    select status from tenant_public_drama_publications
    where tenant_id = ${tenantId} and drama_id = ${dramaId}
    for share
  `;
  if (publications[0]) {
    if (!allowedStatuses.includes(publications[0].status)) {
      throw new NotFoundException('Published content is unavailable');
    }
    return publications[0].status;
  }
  const licenses = await transaction<{ id: string }[]>`
    select license.id from content_licenses license
    join content_license_items item
      on item.license_id = license.id and item.tenant_id = license.tenant_id
    where license.tenant_id = ${tenantId} and item.drama_id = ${dramaId}
      and license.status in ('active', 'scheduled')
      and license.starts_at <= statement_timestamp()
      and license.expires_at > statement_timestamp()
      and app.lock_customer_row('content_licenses', license.id, to_jsonb(license.*))
      and app.lock_customer_row('content_license_items', item.id, to_jsonb(item.*))
    order by license.id limit 1
  `;
  if (!licenses[0]) throw new NotFoundException('Published content is unavailable');
  return 'legacy_license';
}
