import { Alert, Button, Result, Skeleton } from 'antd';
import { useState } from 'react';

import { useAuth } from '../auth/AuthProvider';
import { ADMIN_SCOPE } from '../config/admin-scope';
import { ScopedAdminShell } from '@admin-scope-shell';
import { LoginPage } from './LoginPage';

export function AdminApp() {
  const { loading, logout, principal } = useAuth();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState<string>();

  async function signOut() {
    setLoggingOut(true); setLogoutError(undefined);
    try { await logout(); }
    catch { setLogoutError('退出未完成，请检查网络后重试'); }
    finally { setLoggingOut(false); }
  }

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
        subTitle={logoutError ? <Alert message={logoutError} type="error" showIcon /> : undefined}
        extra={<Button loading={loggingOut} onClick={() => void signOut()}>退出登录</Button>}
      />
    );
  }
  return <ScopedAdminShell principal={principal} />;
}
