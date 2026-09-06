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
    plugins: [react()],
    build: {
      commonjsOptions: { include: [/node_modules/, /packages\/contracts\/dist/] },
    },
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
