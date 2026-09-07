import 'antd/dist/reset.css';
import './styles.css';

import { createRoot } from 'react-dom/client';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import 'dayjs/locale/zh-cn';

import { AuthProvider } from './auth/AuthProvider';
import { AdminApp } from './pages/AdminApp';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing root element');
}

createRoot(rootElement).render(
  <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }}>
    <AuthProvider>
      <AdminApp />
    </AuthProvider>
  </ConfigProvider>,
);
