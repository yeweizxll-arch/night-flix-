import {
  AppstoreOutlined,
  BankOutlined,
  CloudServerOutlined,
  CreditCardOutlined,
  KeyOutlined,
  SafetyOutlined,
  WalletOutlined,
  UsergroupAddOutlined,
  BookOutlined,
  PercentageOutlined,
  LogoutOutlined,
  MenuOutlined,
} from '@ant-design/icons';
import {
  Avatar,
  message,
  Button,
  Drawer,
  Layout,
  Menu,
  Result,
  Space,
  Tag,
  Typography,
  type MenuProps,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';

import type { AuthPrincipal } from '../auth/AuthProvider';
import { useAuth } from '../auth/AuthProvider';
import { ContentLicensingPage } from './ContentLicensingPage';
import { MerchantListPage } from './MerchantListPage';
import { RoleManagementPage } from './RoleManagementPage';
import { StorageProviderPage } from './StorageProviderPage';
import { AuditLogPage } from './AuditLogPage';
import { PaymentSettingsPage } from './PaymentSettingsPage';
import { PlatformFinancePage } from './PlatformFinancePage';
import { StaffManagementPage } from './StaffManagementPage';
import { AnalyticsDashboardPage } from './AnalyticsDashboardPage';
import { CustomerManagementPage } from './CustomerManagementPage';
import { PlatformContentLibraryPage } from './PlatformContentLibraryPage';
import { ContentRevenuePage } from './ContentRevenuePage';

const { Header, Content, Sider } = Layout;

const pageTitles: Record<string, string> = {
  'audit-logs': '审计日志',
  'content-library': '公共内容管理',
  'content-revenue': '内容分成',
  customers: '用户查询',
  dashboard: '平台概览',
  finance: '财务与提现',
  licensing: '公共内容授权',
  merchants: '代理商管理',
  payments: '支付配置',
  roles: '角色管理',
  staff: '员工账号',
  storage: '公共对象存储',
};

const navigation = [
  { key: 'dashboard', icon: <AppstoreOutlined />, label: '平台概览', permission: 'platform.analytics.read' },
  { key: 'merchants', icon: <BankOutlined />, label: '代理商管理', permission: 'platform.merchant.read' },
  { key: 'content-library', icon: <BookOutlined />, label: '公共内容管理', permission: 'platform.content.read' },
  { key: 'licensing', icon: <KeyOutlined />, label: '公共内容授权', permission: 'content.license.read' },
  { key: 'storage', icon: <CloudServerOutlined />, label: '公共对象存储', permission: 'platform.storage.read' },
  { key: 'payments', icon: <CreditCardOutlined />, label: '支付配置', permission: 'platform.payment.read' },
  { key: 'customers', icon: <UsergroupAddOutlined />, label: '用户查询', permission: 'platform.customer.read' },
];

export function ScopedAdminShell({ principal }: { principal: AuthPrincipal }) {
  const { logout } = useAuth();
  const [messages, messageContext] = message.useMessage();
  const [loggingOut, setLoggingOut] = useState(false);
  async function signOut() {
    if (loggingOut) return;
    setLoggingOut(true);
    try { await logout(); }
    catch { messages.error('退出未完成，请检查网络后重试'); }
    finally { setLoggingOut(false); }
  }
  const [activePage, setActivePage] = useState(() => readInitialPage());
  const [mobileNavigationOpen, setMobileNavigationOpen] = useState(false);
  const canOpenFinance = [
    'finance.withdrawal.read',
    'finance.settlement.manage',
    'finance.refund.read',
  ].some((permission) => principal.permissions.includes(permission));
  const canOpenContentRevenue = [
    'finance.withdrawal.read',
    'finance.settlement.manage',
  ].some((permission) => principal.permissions.includes(permission));
  const allowedNavigation = useMemo<MenuProps['items']>(() => {
    const items: MenuProps['items'] = navigation
      .filter((item) => principal.permissions.includes(item.permission))
      .map(({ permission: _permission, ...item }) => item);
    if (canOpenFinance) {
      items.push({ icon: <WalletOutlined />, key: 'finance', label: '财务与提现' });
    }
    if (canOpenContentRevenue) {
      items.push({ icon: <PercentageOutlined />, key: 'content-revenue', label: '内容分成' });
    }
    const securityChildren = [
      principal.permissions.includes('platform.staff.read')
        ? { key: 'staff', label: '员工账号' }
        : null,
      principal.permissions.includes('platform.role.read')
        ? { key: 'roles', label: '角色管理' }
        : null,
      principal.permissions.includes('platform.audit.read')
        ? { key: 'audit-logs', label: '审计日志' }
        : null,
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
  }, [canOpenContentRevenue, canOpenFinance, principal.permissions]);
  const effectivePage = useMemo(() => {
    const directPage = navigation.find((item) => item.key === activePage);
    if (directPage && principal.permissions.includes(directPage.permission)) {
      return activePage;
    }
    if (activePage === 'roles' && principal.permissions.includes('platform.role.read')) {
      return activePage;
    }
    if (activePage === 'staff' && principal.permissions.includes('platform.staff.read')) {
      return activePage;
    }
    if (activePage === 'audit-logs' && principal.permissions.includes('platform.audit.read')) {
      return activePage;
    }
    if (activePage === 'finance' && canOpenFinance) {
      return activePage;
    }
    if (activePage === 'content-revenue' && canOpenContentRevenue) {
      return activePage;
    }
    return navigation.find((item) => principal.permissions.includes(item.permission))?.key
      ?? (canOpenFinance
        ? 'finance'
        : principal.permissions.includes('platform.staff.read')
        ? 'staff'
        : principal.permissions.includes('platform.role.read')
          ? 'roles'
        : principal.permissions.includes('platform.audit.read')
          ? 'audit-logs'
          : undefined);
  }, [activePage, canOpenContentRevenue, canOpenFinance, principal.permissions]);

  useEffect(() => {
    if (effectivePage && effectivePage !== activePage) {
      setActivePage(effectivePage);
    }
  }, [activePage, effectivePage]);

  function openPage(page: string): void {
    setActivePage(page);
    setMobileNavigationOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.set('page', page);
    window.history.replaceState(null, '', url);
  }

  const navigationMenu = (
    <Menu
      className="app-menu"
      defaultOpenKeys={['security']}
      items={allowedNavigation}
      mode="inline"
      onClick={({ key }) => openPage(key)}
      selectedKeys={effectivePage ? [effectivePage] : []}
      theme="dark"
    />
  );

  return (
    <Layout className="app-shell">
      {messageContext}
      <Sider width={248} className="app-sider">
        <div className="brand-block">
          <div className="brand-mark">NF</div>
          <div>
            <div className="brand-name">Night Flix</div>
            <div className="brand-caption">总部管理中心</div>
          </div>
        </div>
        <div className="navigation-caption">平台管理</div>
        {navigationMenu}
      </Sider>
      <Layout>
        <Header className="app-header">
          <div className="app-header-context">
            <Button
              aria-label="打开导航"
              className="mobile-menu-button"
              icon={<MenuOutlined />}
              onClick={() => setMobileNavigationOpen(true)}
              type="text"
            />
            <div>
              <div className="header-eyebrow">总部管理中心</div>
              <div className="header-page-title">{pageTitles[effectivePage ?? ''] ?? '管理后台'}</div>
            </div>
          </div>
          <Space className="app-header-account" size={12}>
            <Tag className="environment-tag" color="green">总部空间</Tag>
            <Avatar className="account-avatar" size={30}>{principal.displayName.slice(0, 1)}</Avatar>
            <Typography.Text className="account-name">{principal.displayName}</Typography.Text>
            <Button icon={<LogoutOutlined />} size="small" loading={loggingOut} onClick={() => void signOut()}>退出</Button>
          </Space>
        </Header>
        <Drawer
          className="mobile-navigation-drawer"
          closable={false}
          onClose={() => setMobileNavigationOpen(false)}
          open={mobileNavigationOpen}
          placement="left"
          styles={{ body: { padding: 0 } }}
          width={280}
        >
          <div className="brand-block">
            <div className="brand-mark">NF</div>
            <div>
              <div className="brand-name">Night Flix</div>
              <div className="brand-caption">总部管理中心</div>
            </div>
          </div>
          <div className="navigation-caption">平台管理</div>
          {navigationMenu}
        </Drawer>
        <Content className="app-content">
          {!effectivePage ? (
            <Result status="403" title="当前账号没有可用的后台功能" />
          ) : effectivePage === 'dashboard' ? (
            <AnalyticsDashboardPage
              apiBase="/api/v1/platform/analytics"
              readPermission="platform.analytics.read"
              scope="platform"
            />
          ) : effectivePage === 'merchants' ? <MerchantListPage /> : effectivePage === 'content-library' ? (
            <PlatformContentLibraryPage />
          ) : effectivePage === 'staff' ? (
            <StaffManagementPage
              accessApiBase="/api/v1/platform/access"
              apiBase="/api/v1/platform/staff"
              managePermission="platform.staff.manage"
              passwordResetPermission="platform.staff.password_reset"
              readPermission="platform.staff.read"
              roleReadPermission="platform.role.read"
              sessionRevokePermission="platform.staff.session_revoke"
              title="平台员工账号"
            />
          ) : effectivePage === 'roles' ? (
            <RoleManagementPage
              apiBase="/api/v1/platform/access"
              description="为总部员工分配工作权限。系统预设角色不可修改。"
              managePermission="platform.role.manage"
              title="平台角色权限"
            />
          ) : effectivePage === 'audit-logs' ? (
            <AuditLogPage
              allowTenantFilter
              apiBase="/api/v1/platform/audit-logs"
              description="查询平台与代理商管理动作，定位责任主体和资源变更。"
              title="平台审计日志"
            />
          ) : effectivePage === 'licensing' ? (
            <ContentLicensingPage />
          ) : effectivePage === 'storage' ? (
            <StorageProviderPage
              apiBase="/api/v1/platform/storage/providers"
              description="管理可供所有代理商使用的公共 S3 兼容存储。"
              managePermission="platform.storage.manage"
              title="公共对象存储"
            />
          ) : effectivePage === 'payments' ? (
            <PaymentSettingsPage
              apiBase="/api/v1/platform/payments/configs"
              description="管理平台公共收款渠道。"
              managePermission="platform.payment.manage"
              scope="platform"
              title="平台支付配置"
            />
          ) : effectivePage === 'finance' ? (
            <PlatformFinancePage />
          ) : effectivePage === 'content-revenue' ? (
            <ContentRevenuePage />
          ) : effectivePage === 'customers' ? (
            <CustomerManagementPage
              apiBase="/api/v1/platform/customers"
              managePermission="platform.customer.manage"
              readPermission="platform.customer.read"
              scope="platform"
              sessionRevokePermission="platform.customer.session_revoke"
              title="用户查询"
            />
          ) : <Result status="403" title="当前账号没有可用的后台功能" />}
        </Content>
      </Layout>
    </Layout>
  );
}

function readInitialPage(): string {
  return new URLSearchParams(window.location.search).get('page')?.trim() || 'dashboard';
}
