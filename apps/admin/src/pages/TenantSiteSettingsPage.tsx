import { useAuth } from '../auth/AuthProvider';
import { SiteSettingsPanel } from './SiteSettingsPanel';

export function TenantSiteSettingsPage() {
  const { principal } = useAuth();
  const permissions = principal?.permissions ?? [];
  return (
    <SiteSettingsPanel
      canManageDomains={permissions.includes('tenant.domain.manage')}
      canManageSettings={permissions.includes('tenant.site.manage')}
      canReadDomains={permissions.includes('tenant.domain.read')}
      canReadSettings={permissions.includes('tenant.site.read')}
      createDomainKind="custom"
      description="配置用户站白标、启停状态和独立域名。平台分配的子域名在商家后台只读。"
      domainsEndpoint="/api/v1/tenant/site/domains"
      settingsEndpoint="/api/v1/tenant/site/settings"
      title="站点与域名"
      verifyEndpoint={(domainId) => `/api/v1/tenant/site/domains/${encodeURIComponent(domainId)}/verify`}
    />
  );
}
