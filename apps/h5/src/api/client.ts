import type { CustomerPrincipal, CustomerSession } from './types';

const REFRESH_KEY = 'drama_h5_refresh';
const DEVICE_KEY = 'drama_h5_device';

export interface StorageLike {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

export interface CustomerRequestInit extends Omit<RequestInit, 'body' | 'headers'> {
  headers?: HeadersInit;
  json?: unknown;
  requiresAuth?: boolean;
}

export class CustomerApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

type SessionListener = (principal: CustomerPrincipal | undefined) => void;

export class CustomerApiClient {
  private accessToken?: string;
  private principal?: CustomerPrincipal;
  private refreshPromise?: Promise<CustomerSession>;
  private readonly listeners = new Set<SessionListener>();

  constructor(
    private readonly storage: StorageLike,
    private readonly fetcher: typeof fetch = fetch,
    private readonly deviceStorage: StorageLike = storage,
  ) {}

  currentPrincipal(): CustomerPrincipal | undefined {
    return this.principal;
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async restore(): Promise<CustomerPrincipal | undefined> {
    if (!this.storage.getItem(REFRESH_KEY)) return undefined;
    try {
      return (await this.refresh()).principal;
    } catch {
      return undefined;
    }
  }

  async login(identifier: string, password: string): Promise<CustomerPrincipal> {
    const session = await this.raw<CustomerSession>('/api/v1/customer/auth/login', {
      body: JSON.stringify({
        deviceLabel: 'H5 Browser',
        devicePlatform: 'h5',
        deviceToken: this.deviceStorage.getItem(DEVICE_KEY) ?? undefined,
        identifier,
        password,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    this.applySession(session);
    return session.principal;
  }

  async logout(): Promise<void> {
    const refreshToken = this.storage.getItem(REFRESH_KEY);
    try {
      await this.raw<void>('/api/v1/customer/auth/logout', {
        body: JSON.stringify(refreshToken ? { refreshToken } : {}),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      });
    } finally {
      this.clearAuthentication();
    }
  }

  clearForAccountErasure(): void {
    this.clearAuthentication();
    this.deviceStorage.removeItem(DEVICE_KEY);
  }

  async request<T>(path: string, init: CustomerRequestInit = {}): Promise<T> {
    const requiresAuth = init.requiresAuth ?? true;
    const { json, requiresAuth: _requiresAuth, ...requestInit } = init;
    if (requiresAuth && !this.accessToken) await this.refresh();
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    const method = (init.method ?? 'GET').toUpperCase();
    if (json !== undefined) headers.set('Content-Type', 'application/json');
    if (requiresAuth && this.accessToken) headers.set('Authorization', `Bearer ${this.accessToken}`);
    if (requiresAuth && isMutation(method) && !headers.has('Idempotency-Key')) {
      headers.set('Idempotency-Key', crypto.randomUUID());
    }
    const prepared: RequestInit = {
      ...requestInit,
      body: json === undefined ? undefined : JSON.stringify(json),
      credentials: 'same-origin',
      headers,
      method,
    };
    const response = await this.fetcher(path, prepared);
    if (response.status !== 401 || !requiresAuth) return parseResponse<T>(response);
    await this.refresh();
    const retryHeaders = new Headers(headers);
    retryHeaders.set('Authorization', `Bearer ${this.accessToken}`);
    const retry = await this.fetcher(path, { ...prepared, headers: retryHeaders });
    if (retry.status === 401) this.clearAuthentication();
    return parseResponse<T>(retry);
  }

  private refresh(): Promise<CustomerSession> {
    if (this.refreshPromise) return this.refreshPromise;
    const refreshToken = this.storage.getItem(REFRESH_KEY);
    if (!refreshToken) {
      this.clearAuthentication();
      return Promise.reject(new CustomerApiError('Authentication is required', 401));
    }
    const operation = this.raw<CustomerSession>('/api/v1/customer/auth/refresh', {
      body: JSON.stringify({ refreshToken }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    }).then((session) => {
      this.applySession(session);
      return session;
    }).catch((error: unknown) => {
      if (error instanceof CustomerApiError && error.status === 401) this.clearAuthentication();
      throw error;
    }).finally(() => {
      this.refreshPromise = undefined;
    });
    this.refreshPromise = operation;
    return operation;
  }

  private async raw<T>(path: string, init: RequestInit): Promise<T> {
    return parseResponse<T>(await this.fetcher(path, {
      ...init,
      credentials: 'same-origin',
    }));
  }

  private applySession(session: CustomerSession): void {
    this.accessToken = session.accessToken;
    this.principal = session.principal;
    this.storage.setItem(REFRESH_KEY, session.refreshToken);
    if (session.deviceToken) this.deviceStorage.setItem(DEVICE_KEY, session.deviceToken);
    this.notify();
  }

  private clearAuthentication(): void {
    this.accessToken = undefined;
    this.principal = undefined;
    this.storage.removeItem(REFRESH_KEY);
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.principal);
  }
}

export function createBrowserCustomerApi(): CustomerApiClient {
  return new CustomerApiClient(window.sessionStorage, fetch, window.localStorage);
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as {
      code?: unknown;
      message?: unknown;
    };
    const message = Array.isArray(body.message)
      ? body.message.filter((item): item is string => typeof item === 'string').join('；')
      : typeof body.message === 'string' ? body.message : 'Request failed';
    throw new CustomerApiError(
      message.slice(0, 1000),
      response.status,
      typeof body.code === 'string' ? body.code : undefined,
    );
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

function isMutation(method: string): boolean {
  return ['DELETE', 'PATCH', 'POST', 'PUT'].includes(method);
}
