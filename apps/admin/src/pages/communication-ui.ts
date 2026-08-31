export type CommunicationChannel = 'email' | 'sms';

export interface CommunicationConfigSummary {
  channel: CommunicationChannel;
  lastTestError?: string;
  lastTestStatus?: 'failed' | 'passed';
  lastTestedAt?: string;
  status: 'active' | 'disabled';
  version: number;
}

export interface PendingCommunicationTest {
  previousTestedAt?: string;
  version: number;
}

export function canEnableCommunication(
  config: CommunicationConfigSummary | undefined,
  pending: PendingCommunicationTest | undefined,
): boolean {
  return Boolean(
    config
    && config.status === 'disabled'
    && config.lastTestStatus === 'passed'
    && !pending,
  );
}

export function testHasSettled(
  config: CommunicationConfigSummary | undefined,
  pending: PendingCommunicationTest,
): boolean {
  return !config
    || config.version !== pending.version
    || (Boolean(config.lastTestedAt) && config.lastTestedAt !== pending.previousTestedAt);
}

export function communicationTestErrorLabel(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return {
    config_changed: '测试期间配置已变化，请重新发起测试',
    delivery_expired: '测试任务已过期，请重新发起',
    provider_rejected: '渠道拒绝了测试消息，请检查账号和发送方配置',
    provider_timeout: '渠道响应超时，请稍后重试',
    secret_authentication_failed: '渠道凭据验证失败，请重新录入凭据',
    unexpected_provider_response: '渠道返回了无法确认的结果，请检查渠道状态',
  }[code] ?? '测试失败，请检查渠道配置后重试';
}
