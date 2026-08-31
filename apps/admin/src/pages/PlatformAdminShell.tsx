import {
  AppstoreOutlined,
  AuditOutlined,
  BankOutlined,
  CloudServerOutlined,
  CreditCardOutlined,
  KeyOutlined,
  SafetyOutlined,
  WalletOutlined,
  CommentOutlined,
  UsergroupAddOutlined,
  BookOutlined,
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
import { ContentReviewPage } from './ContentReviewPage';
import { ContentLicensingPage } from './ContentLicensingPage';
import { MerchantListPage } from './MerchantListPage';
import { RoleManagementPage } from './RoleManagementPage';
import { StorageProviderPage } from './StorageProviderPage';
import { AuditLogPage } from './AuditLogPage';
import { PaymentSettingsPage } from './PaymentSettingsPage';
import { PlatformFinancePage } from './PlatformFinancePage';
import { InteractionModerationPage } from './InteractionModerationPage';
import { StaffManagementPage } from './StaffManagementPage';
import { AnalyticsDashboardPage } from './AnalyticsDashboardPage';
import { CustomerManagementPage } from './CustomerManagementPage';
import { PlatformContentLibraryPage } from './PlatformContentLibraryPage';

const { Header, Content, Sider } = Layout;

const navigation = [
  { key: 'dashboard', icon: <AppstoreOutlined />, label: '经营概览', permission: 'platform.analytics.read' },
  { key: 'merchants', icon: <BankOutlined />, label: '商家管理', permission: 'platform.merchant.read' },
  { key: 'review', icon: <AuditOutlined />, label: '内容审核', permission: 'content.review.read' },
  { key: 'content-library', icon: <BookOutlined />, label: '公共内容管理', permission: 'platform.content.read' },
  { key: 'licensing', icon: <KeyOutlined />, label: '公共内容授权', permission: 'content.license.read' },
  { key: 'storage', icon: <CloudServerOutlined />, label: '公共对象存储', permission: 'platform.storage.read' },
  { key: 'payments', icon: <CreditCardOutlined />, label: '支付配置', permission: 'platform.payment.read' },
  { key: 'customers', icon: <UsergroupAddOutlined />, label: '用户监管', permission: 'platform.customer.read' },
  { key: 'community', icon: <CommentOutlined />, label: '社区治理', permission: 'platform.interaction.read' },
];

export function ScopedAdminShell({ principal }: { principal: AuthPrincipal }) {
  const { logout } = useAuth();
  const [activePage, setActivePage] = useState('dashboard');
  const canOpenFinance = [
    'finance.withdrawal.read',
    'finance.settlement.manage',
    'finance.refund.read',
  ].some((permission) => principal.permissions.includes(permission));
  const allowedNavigation = useMemo<MenuProps['items']>(() => {
    const items: MenuProps['items'] = navigation
      .filter((item) => principal.permissions.includes(item.permission))
      .map(({ permission: _permission, ...item }) => item);
    if (canOpenFinance) {
      items.push({ icon: <WalletOutlined />, key: 'finance', label: '财务与提现' });
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
  }, [canOpenFinance, principal.permissions]);
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
  }, [activePage, canOpenFinance, principal.permissions]);

  return (
    <Layout className="app-shell">
      <Sider width={240} className="app-sider">
        <div className="brand-block">
          <div className="brand-mark">D</div>
          <div>
            <div className="brand-name">Drama Cloud</div>
            <div className="brand-caption">平台总后台</div>
          </div>
        </div>
        <Menu
          className="app-menu"
          defaultOpenKeys={['security']}
          items={allowedNavigation}
          mode="inline"
          onClick={({ key }) => setActivePage(key)}
          selectedKeys={effectivePage ? [effectivePage] : []}
          theme="dark"
        />
      </Sider>
      <Layout>
        <Header className="app-header">
          <Space size={12}>
            <Tag color="green">开发环境</Tag>
            <Typography.Text type="secondary">{principal.displayName}</Typography.Text>
            <Button size="small" onClick={() => void logout()}>退出</Button>
          </Space>
        </Header>
        <Content className="app-content">
          {!effectivePage ? (
            <Result status="403" title="当前账号没有可用的后台功能" />
          ) : effectivePage === 'dashboard' ? (
            <AnalyticsDashboardPage
              apiBase="/api/v1/platform/analytics"
              readPermission="platform.analytics.read"
              scope="platform"
            />
          ) : effectivePage === 'merchants' ? <MerchantListPage /> : effectivePage === 'review' ? (
            <ContentReviewPage />
          ) : effectivePage === 'content-library' ? (
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
              description="按角色分配总后台功能；当前数据范围仅支持 all。"
              managePermission="platform.role.manage"
              title="平台角色权限"
            />
          ) : effectivePage === 'audit-logs' ? (
            <AuditLogPage
              allowTenantFilter
              apiBase="/api/v1/platform/audit-logs"
              description="查询平台与商家管理动作，定位责任主体和资源变更。"
              title="平台审计日志"
            />
          ) : effectivePage === 'licensing' ? (
            <ContentLicensingPage />
          ) : effectivePage === 'storage' ? (
            <StorageProviderPage
              apiBase="/api/v1/platform/storage/providers"
              description="管理可供所有商家使用的公共 S3 兼容存储。"
              managePermission="platform.storage.manage"
              title="公共对象存储"
            />
          ) : effectivePage === 'payments' ? (
            <PaymentSettingsPage
              apiBase="/api/v1/platform/payments/configs"
              description="查看平台公共支付配置；真实渠道需先在服务端安装对应适配器。"
              managePermission="platform.payment.manage"
              scope="platform"
              title="平台支付配置"
            />
          ) : effectivePage === 'finance' ? (
            <PlatformFinancePage />
          ) : effectivePage === 'customers' ? (
            <CustomerManagementPage
              apiBase="/api/v1/platform/customers"
              managePermission="platform.customer.manage"
              readPermission="platform.customer.read"
              scope="platform"
              sessionRevokePermission="platform.customer.session_revoke"
              title="平台用户监管"
            />
          ) : effectivePage === 'community' ? (
            <InteractionModerationPage
              apiBase="/api/v1/platform/interactions"
              managePermission="platform.interaction.manage"
              platformScope
              readPermission="platform.interaction.read"
              sensitiveWordPermission="platform.sensitive_word.manage"
              title="平台社区治理"
            />
          ) : <Result status="403" title="当前账号没有可用的后台功能" />}
        </Content>
      </Layout>
    </Layout>
  );
}
