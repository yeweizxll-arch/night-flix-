import { Drawer } from 'antd';

import type { AuthPrincipal } from '../auth/AuthProvider';
import { SiteSettingsPanel } from './SiteSettingsPanel';

interface PlatformMerchantSettingsDrawerProps {
  merchant?: { id: string; name: string };
  onClose(): void;
  principal?: AuthPrincipal;
}

export function PlatformMerchantSettingsDrawer({
  merchant,
  onClose,
  principal,
}: PlatformMerchantSettingsDrawerProps) {
  const permissions = principal?.permissions ?? [];
  const base = merchant
    ? `/api/v1/platform/merchants/${encodeURIComponent(merchant.id)}`
    : '';
  return (
    <Drawer destroyOnHidden onClose={onClose} open={Boolean(merchant)} width={960}>
      {merchant ? (
        <SiteSettingsPanel
          canManageDomains={permissions.includes('platform.domain.manage')}
          canManageSettings={false}
          canManageSiteStatus={permissions.includes('platform.merchant.status')}
          canReadDomains={permissions.includes('platform.merchant.read')}
          canReadSettings={permissions.includes('platform.merchant.read')}
          createDomainKind="subdomain"
          description={`查看 ${merchant.name} 的品牌配置，管理技术接入。品牌由代理商自行设置。`}
          domainsEndpoint={`${base}/domains`}
          settingsEndpoint={`${base}/site-settings`}
          siteStatusEndpoint={`${base}/site-status`}
          siteStatusMode="platform"
          tlsStatusEndpoint={(domainId) => `${base}/domains/${encodeURIComponent(domainId)}/tls-status`}
          title="代理商站点配置"
        />
      ) : null}
    </Drawer>
  );
}
