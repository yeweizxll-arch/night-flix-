import { Button, Result, Skeleton } from 'antd';

import { useAuth } from '../auth/AuthProvider';
import { ADMIN_SCOPE } from '../config/admin-scope';
import { ScopedAdminShell } from '@admin-scope-shell';
import { LoginPage } from './LoginPage';

export function AdminApp() {
  const { loading, logout, principal } = useAuth();

  if (loading) {
    return <Skeleton active className="app-loading" paragraph={{ rows: 8 }} />;
  }
  if (!principal) {
    return <LoginPage />;
  }
  if (principal.scope !== ADMIN_SCOPE) {
    return (
      <Result
        status="403"
        title={ADMIN_SCOPE === 'platform'
          ? '当前账号不能进入总后台'
          : '当前账号不能进入代理商后台'}
        extra={<Button onClick={() => void logout()}>退出登录</Button>}
      />
    );
  }
  return <ScopedAdminShell principal={principal} />;
}
