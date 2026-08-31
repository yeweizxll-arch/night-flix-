import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, '.', '');
  const adminScope = environment.VITE_ADMIN_SCOPE || 'platform';
  if (adminScope !== 'platform' && adminScope !== 'tenant') {
    throw new Error('VITE_ADMIN_SCOPE must be platform or tenant');
  }
  const scopeShell = decodeURIComponent(new URL(
    adminScope === 'platform'
      ? './src/pages/PlatformAdminShell.tsx'
      : './src/pages/TenantAdminShell.tsx',
    import.meta.url,
  ).pathname);

  return {
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (id.includes('/node_modules/@ant-design/icons')) {
              return 'vendor-icons';
            }
            if (id.includes('/node_modules/@rc-component/')) {
              return 'vendor-rc';
            }
            if (id.includes('/node_modules/antd/')) {
              return 'vendor-antd';
            }
            if (
              id.includes('/node_modules/react/') ||
              id.includes('/node_modules/react-dom/') ||
              id.includes('/node_modules/scheduler/')
            ) {
              return 'vendor-react';
            }
            return undefined;
          }
        },
      },
    },
    plugins: [react()],
    resolve: {
      alias: {
        '@admin-scope-shell': scopeShell,
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      proxy: {
        '/api': {
          changeOrigin: false,
          target: 'http://127.0.0.1:3000',
        },
      },
    },
  };
});
