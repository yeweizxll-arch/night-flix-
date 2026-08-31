import 'antd/dist/reset.css';
import './styles.css';

import { createRoot } from 'react-dom/client';

import { AuthProvider } from './auth/AuthProvider';
import { AdminApp } from './pages/AdminApp';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Missing root element');
}

createRoot(rootElement).render(
  <AuthProvider>
    <AdminApp />
  </AuthProvider>,
);
