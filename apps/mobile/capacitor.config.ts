import type { CapacitorConfig } from '@capacitor/cli';

import { mobileTestConfiguration } from './src/mobile-config';

const mobile = mobileTestConfiguration(process.env);

const config: CapacitorConfig = {
  appId: mobile.appId,
  appName: mobile.appName,
  webDir: '../h5/dist',
  server: {
    allowNavigation: [new URL(mobile.serverUrl).hostname],
    cleartext: false,
    url: mobile.serverUrl,
  },
  android: {
    allowMixedContent: false,
    webContentsDebuggingEnabled: process.env.MOBILE_WEB_DEBUG === 'true',
  },
};

export default config;

