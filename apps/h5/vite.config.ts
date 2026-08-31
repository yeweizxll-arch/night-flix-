import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const environment = loadEnv(mode, '.', '');
  const target = environment.VITE_H5_API_TARGET || 'http://127.0.0.1:3000';
  const tenantHost = environment.VITE_H5_TENANT_HOST?.trim();
  const releaseChannel = environment.VITE_H5_RELEASE_CHANNEL || 'test';
  if (releaseChannel !== 'test' && releaseChannel !== 'production') {
    throw new Error('VITE_H5_RELEASE_CHANNEL must be test or production');
  }
  return {
    plugins: [react()],
    server: {
      host: '0.0.0.0',
      port: 5174,
      proxy: {
        '/api': {
          changeOrigin: false,
          headers: tenantHost ? { host: tenantHost } : undefined,
          target,
        },
      },
    },
  };
});
