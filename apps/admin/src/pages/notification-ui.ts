export interface ProviderActivationState {
  lastTestStatus?: 'failed' | 'passed';
  status: 'active' | 'disabled';
}

export type PushProvider = 'apns' | 'fcm';
export type PushProviderEnvironment = 'production' | 'sandbox';

export interface ProviderCredentialFormValue {
  bundleId?: string;
  clientEmail?: string;
  environment?: PushProviderEnvironment;
  keyId?: string;
  privateKey?: string;
  projectId?: string;
  teamId?: string;
}

export function providerConfigPayload(
  provider: PushProvider,
  values: ProviderCredentialFormValue,
  expectedVersion: number,
): {
  credentials: Record<string, string>;
  environment: PushProviderEnvironment;
  expectedVersion: number;
} {
  const privateKey = values.privateKey ?? '';
  if (provider === 'apns') {
    const environment = values.environment;
    if (environment !== 'production' && environment !== 'sandbox') {
      throw new Error('APNs environment is required');
    }
    return {
      credentials: {
        bundleId: values.bundleId?.trim() ?? '',
        keyId: values.keyId?.trim() ?? '',
        privateKey,
        teamId: values.teamId?.trim() ?? '',
      },
      environment,
      expectedVersion,
    };
  }
  return {
    credentials: {
      clientEmail: values.clientEmail?.trim() ?? '',
      privateKey,
      projectId: values.projectId?.trim() ?? '',
    },
    environment: 'production',
    expectedVersion,
  };
}

export function providerEnvironmentLabel(
  provider: PushProvider,
  environment?: PushProviderEnvironment,
): string {
  if (!environment) return '—';
  if (provider === 'fcm') return 'Production（固定）';
  return environment === 'sandbox'
    ? 'Sandbox（测试安装包）'
    : 'Production（上架包）';
}

export function canEnableNotificationProvider(config?: ProviderActivationState): boolean {
  return config?.status === 'disabled' && config.lastTestStatus === 'passed';
}

export function safeNotificationTestError(code: string): string {
  if (code === 'provider_adapter_unavailable') return '未安装该推送适配器，不会发送推送。';
  if (code === 'secret_authentication_failed') return '凭据验证失败，请替换凭据后重试。';
  if (code === 'external_provider_failure') return '外部推送服务暂时失败，请稍后重试。';
  return '测试未通过，请检查适配器与凭据。';
}
