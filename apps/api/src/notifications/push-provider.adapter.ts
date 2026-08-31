import type {
  PushProvider,
  PushProviderCredentials,
} from './notification-secret-cipher';

export interface PushSendInput {
  body: string;
  credentials: PushProviderCredentials;
  deepLink?: string;
  deliveryId: string;
  deviceToken: string;
  provider: PushProvider;
  title: string;
}

export interface PushSendResult {
  providerMessageId: string;
}

export interface PushProviderAdapter {
  readonly provider: PushProvider;
  readonly testOnly?: boolean;
  send(input: PushSendInput): Promise<PushSendResult>;
  test(credentials: PushProviderCredentials): Promise<void>;
}

export class InvalidPushTokenError extends Error {
  constructor() {
    super('Push provider rejected the device token');
    this.name = 'InvalidPushTokenError';
  }
}

export class PushAdapterRegistry {
  private readonly adapters: ReadonlyMap<PushProvider, PushProviderAdapter>;

  constructor(adapters: readonly PushProviderAdapter[]) {
    if (process.env.NODE_ENV === 'production' && adapters.some((adapter) => adapter.testOnly)) {
      throw new Error('Fake push adapters are forbidden in production');
    }
    const indexed = new Map<PushProvider, PushProviderAdapter>();
    for (const adapter of adapters) {
      if (indexed.has(adapter.provider)) throw new Error(`Duplicate ${adapter.provider} adapter`);
      indexed.set(adapter.provider, adapter);
    }
    this.adapters = indexed;
  }

  require(provider: PushProvider): PushProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new Error(
        `${provider.toUpperCase()} adapter is not installed; no push was sent`,
      );
    }
    return adapter;
  }
}

export class FakePushProviderAdapter implements PushProviderAdapter {
  readonly calls: PushSendInput[] = [];
  readonly testOnly = true;

  constructor(
    readonly provider: PushProvider,
    private readonly failure?: Error,
  ) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Fake push adapters are forbidden in production');
    }
  }

  async send(input: PushSendInput): Promise<PushSendResult> {
    if (this.failure) throw this.failure;
    this.calls.push(input);
    return { providerMessageId: `fake_${input.deliveryId.replaceAll('-', '')}` };
  }

  async test(credentials: PushProviderCredentials): Promise<void> {
    if (credentials.type !== this.provider) throw new Error('Provider credential type mismatch');
    if (this.failure) throw this.failure;
  }
}
