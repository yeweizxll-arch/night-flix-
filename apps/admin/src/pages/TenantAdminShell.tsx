import {
  AppstoreOutlined,
  CloudServerOutlined,
  CreditCardOutlined,
  FileTextOutlined,
  FileProtectOutlined,
  OrderedListOutlined,
  SafetyOutlined,
  ShoppingOutlined,
  WalletOutlined,
  GlobalOutlined,
  CommentOutlined,
  BellOutlined,
  MailOutlined,
  ShareAltOutlined,
  UsergroupAddOutlined,
} from '@ant-design/icons';
import {
  Button,
  Layout,
  Menu,
  Result,
  Space,
  Tag,
  Typography,
  type MenuProps,
} from 'antd';
import { useMemo, useState } from 'react';

import type { AuthPrincipal } from '../auth/AuthProvider';
import { useAuth } from '../auth/AuthProvider';
import { TenantContentListPage } from './TenantContentListPage';
import { StorageProviderPage } from './StorageProviderPage';
import { CommerceCatalogPage } from './CommerceCatalogPage';
import { CommerceOrderPage } from './CommerceOrderPage';
import { AuditLogPage } from './AuditLogPage';
import { RoleManagementPage } from './RoleManagementPage';
import { PaymentSettingsPage } from './PaymentSettingsPage';
import { TenantFinancePage } from './TenantFinancePage';
import { TenantSiteSettingsPage } from './TenantSiteSettingsPage';
import { InteractionModerationPage } from './InteractionModerationPage';
import { TenantReferralPage } from './TenantReferralPage';
import { StaffManagementPage } from './StaffManagementPage';
import { TenantNotificationPage } from './TenantNotificationPage';
import { AnalyticsDashboardPage } from './AnalyticsDashboardPage';
import { CustomerManagementPage } from './CustomerManagementPage';
import { TenantCommunicationSettingsPage } from './TenantCommunicationSettingsPage';
import { TenantLegalPrivacyPage } from './TenantLegalPrivacyPage';

const { Content, Header, Sider } = Layout;

export function ScopedAdminShell({ principal }: { principal: AuthPrincipal }) {
  const { logout } = useAuth();
  const canReadContent = principal.permissions.includes('content.drama.read');
  const canReadStorage = principal.permissions.includes('tenant.storage.read');
  const canReadSite = [
    'tenant.site.read',
    'tenant.domain.read',
  ].some((permission) => principal.permissions.includes(permission));
  const canReadCatalog = principal.permissions.includes('commerce.catalog.read');
  const canReadOrders = [
    'commerce.order.read',
    'commerce.refund.read',
  ].some((permission) => principal.permissions.includes(permission));
  const canReadPayments = principal.permissions.includes('commerce.payment.read');
  const canOpenFinance = [
    'commerce.balance.read',
    'commerce.withdrawal.read',
    'commerce.withdrawal.submit',
  ].some((permission) => principal.permissions.includes(permission));
  const canReadRoles = principal.permissions.includes('tenant.role.read');
  const canReadStaff = principal.permissions.includes('tenant.staff.read');
  const canReadAudit = principal.permissions.includes('tenant.audit.read');
  const canReadInteractions = principal.permissions.includes('tenant.interaction.read');
  const canReadReferrals = principal.permissions.includes('commerce.referral.read');
  const canReadNotifications = principal.permissions.includes('tenant.notification.read');
  const canReadAnalytics = principal.permissions.includes('tenant.analytics.read');
  const canReadCustomers = principal.permissions.includes('tenant.customer.read');
  const canReadCommunications = principal.permissions.includes('tenant.communication.read');
  const canOpenLegalPrivacy = [
    'tenant.legal.read',
    'tenant.privacy_request.read',
  ].some((permission) => principal.permissions.includes(permission));
  const [activePage, setActivePage] = useState('dashboard');
  const navigation = useMemo<MenuProps['items']>(() => {
    const items: NonNullable<MenuProps['items']> = [
      canReadAnalytics
        ? { icon: <AppstoreOutlined />, key: 'dashboard', label: '经营概览' }
        : null,
      canReadContent
        ? { icon: <FileTextOutlined />, key: 'content', label: '内容管理' }
        : null,
      canReadStorage
        ? { icon: <CloudServerOutlined />, key: 'storage', label: '对象存储' }
        : null,
      canReadSite
        ? { icon: <GlobalOutlined />, key: 'site-settings', label: '站点与域名' }
        : null,
      canReadInteractions
        ? { icon: <CommentOutlined />, key: 'community', label: '社区治理' }
        : null,
      canReadNotifications
        ? { icon: <BellOutlined />, key: 'notifications', label: '通知运营' }
        : null,
      canReadCommunications
        ? { icon: <MailOutlined />, key: 'communications', label: '邮箱与短信' }
        : null,
      canOpenLegalPrivacy
        ? { icon: <FileProtectOutlined />, key: 'legal-privacy', label: '法律与隐私' }
        : null,
      canReadCustomers
        ? { icon: <UsergroupAddOutlined />, key: 'customers', label: '用户管理' }
        : null,
      canReadReferrals
        ? { icon: <ShareAltOutlined />, key: 'referrals', label: '一级分销' }
        : null,
      canReadCatalog
        ? { icon: <ShoppingOutlined />, key: 'catalog', label: '商品定价' }
        : null,
      canReadOrders
        ? { icon: <OrderedListOutlined />, key: 'orders', label: '订单管理' }
        : null,
      canReadPayments
        ? { icon: <CreditCardOutlined />, key: 'payments', label: '支付设置' }
        : null,
      canOpenFinance
        ? { icon: <WalletOutlined />, key: 'finance', label: '余额与提现' }
        : null,
    ].filter(Boolean) as NonNullable<MenuProps['items']>;
    const securityChildren = [
      canReadStaff ? { key: 'staff', label: '员工账号' } : null,
      canReadRoles ? { key: 'roles', label: '角色管理' } : null,
      canReadAudit ? { key: 'audit-logs', label: '审计日志' } : null,
    ].filter(Boolean) as NonNullable<MenuProps['items']>;
    if (securityChildren.length) {
      items.push({
        children: securityChildren,
        icon: <SafetyOutlined />,
        key: 'security',
        label: '权限与审计',
      });
    }
    return items;
  }, [
    canReadAudit,
    canReadCatalog,
    canReadContent,
    canReadOrders,
    canReadPayments,
    canOpenFinance,
    canReadRoles,
    canReadStorage,
    canReadSite,
    canReadStaff,
    canReadInteractions,
    canReadReferrals,
    canReadNotifications,
    canReadAnalytics,
    canReadCustomers,
    canReadCommunications,
    canOpenLegalPrivacy,
  ]);
  const effectivePage = useMemo(() => {
    const allowedPages = new Map<string, boolean>([
      ['dashboard', canReadAnalytics],
      ['content', canReadContent],
      ['storage', canReadStorage],
      ['site-settings', canReadSite],
      ['community', canReadInteractions],
      ['notifications', canReadNotifications],
      ['communications', canReadCommunications],
      ['legal-privacy', canOpenLegalPrivacy],
      ['customers', canReadCustomers],
      ['referrals', canReadReferrals],
      ['catalog', canReadCatalog],
      ['orders', canReadOrders],
      ['payments', canReadPayments],
      ['finance', canOpenFinance],
      ['staff', canReadStaff],
      ['roles', canReadRoles],
      ['audit-logs', canReadAudit],
    ]);
    if (allowedPages.get(activePage)) {
      return activePage;
    }
    return [...allowedPages].find(([, allowed]) => allowed)?.[0];
  }, [
    activePage,
    canReadAudit,
    canReadCatalog,
    canReadContent,
    canReadOrders,
    canReadPayments,
    canOpenFinance,
    canReadRoles,
    canReadStorage,
    canReadSite,
    canReadStaff,
    canReadInteractions,
    canReadReferrals,
    canReadNotifications,
    canReadAnalytics,
    canReadCustomers,
    canReadCommunications,
    canOpenLegalPrivacy,
  ]);

  return (
    <Layout className="app-shell tenant-admin-shell">
      <Sider className="app-sider" width={240}>
        <div className="brand-block">
          <div className="brand-mark">D</div>
          <div>
            <div className="brand-name">Drama Cloud</div>
            <div className="brand-caption">商家管理后台</div>
          </div>
        </div>
        <Menu
          className="app-menu"
          defaultOpenKeys={['security']}
          items={navigation}
          mode="inline"
          onClick={({ key }) => setActivePage(key)}
          selectedKeys={effectivePage ? [effectivePage] : []}
          theme="dark"
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <Space size={12}>
            <Tag color="blue">商家空间</Tag>
            <Typography.Text type="secondary">{principal.displayName}</Typography.Text>
            <Button size="small" onClick={() => void logout()}>退出</Button>
          </Space>
        </Header>
        <Content className="app-content">
          {effectivePage === 'dashboard' ? (
            <AnalyticsDashboardPage
              apiBase="/api/v1/tenant/analytics"
              readPermission="tenant.analytics.read"
              scope="tenant"
            />
          ) : effectivePage === 'content' ? (
            <TenantContentListPage />
          ) : effectivePage === 'storage' ? (
            <StorageProviderPage
              apiBase="/api/v1/tenant/storage/providers"
              description="管理当前商家的私有存储，并查看总后台启用的公共存储。"
              managePermission="tenant.storage.manage"
              title="对象存储"
            />
          ) : effectivePage === 'site-settings' ? (
            <TenantSiteSettingsPage />
          ) : effectivePage === 'community' ? (
            <InteractionModerationPage
              apiBase="/api/v1/tenant/interactions"
              managePermission="tenant.interaction.manage"
              platformScope={false}
              readPermission="tenant.interaction.read"
              sensitiveWordPermission="tenant.sensitive_word.manage"
              title="商家社区治理"
            />
          ) : effectivePage === 'notifications' ? (
            <TenantNotificationPage />
          ) : effectivePage === 'communications' ? (
            <TenantCommunicationSettingsPage />
          ) : effectivePage === 'legal-privacy' ? (
            <TenantLegalPrivacyPage />
          ) : effectivePage === 'customers' ? (
            <CustomerManagementPage
              apiBase="/api/v1/tenant/customers"
              managePermission="tenant.customer.manage"
              readPermission="tenant.customer.read"
              scope="tenant"
              sessionRevokePermission="tenant.customer.session_revoke"
              title="商家用户管理"
            />
          ) : effectivePage === 'referrals' ? (
            <TenantReferralPage />
          ) : effectivePage === 'catalog' ? (
            <CommerceCatalogPage />
          ) : effectivePage === 'orders' ? (
            <CommerceOrderPage />
          ) : effectivePage === 'payments' ? (
            <PaymentSettingsPage
              apiBase="/api/v1/tenant/commerce/payments"
              description="选择平台公共代收或商家独立直收；真实渠道需先安装对应支付适配器。"
              managePermission="commerce.payment.manage"
              scope="tenant"
              title="支付与收款路由"
            />
          ) : effectivePage === 'finance' ? (
            <TenantFinancePage />
          ) : effectivePage === 'staff' ? (
            <StaffManagementPage
              accessApiBase="/api/v1/tenant/access"
              apiBase="/api/v1/tenant/staff"
              managePermission="tenant.staff.manage"
              passwordResetPermission="tenant.staff.password_reset"
              readPermission="tenant.staff.read"
              roleReadPermission="tenant.role.read"
              sessionRevokePermission="tenant.staff.session_revoke"
              title="商家员工账号"
            />
          ) : effectivePage === 'roles' ? (
            <RoleManagementPage
              apiBase="/api/v1/tenant/access"
              description="管理当前商家的自定义角色；系统角色只读，当前数据范围仅支持 all。"
              managePermission="tenant.role.manage"
              title="商家角色权限"
            />
          ) : effectivePage === 'audit-logs' ? (
            <AuditLogPage
              allowTenantFilter={false}
              apiBase="/api/v1/tenant/audit-logs"
              description="查询当前商家的管理动作和资源变更。"
              title="商家审计日志"
            />
          ) : (
            <Result status="403" title="当前账号没有可用的商家后台功能" />
          )}
        </Content>
      </Layout>
    </Layout>
  );
}
