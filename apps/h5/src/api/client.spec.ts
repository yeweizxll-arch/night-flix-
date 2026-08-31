import { describe, expect, it, vi } from 'vitest';

import { CustomerApiClient, type StorageLike } from './client';
import type { CustomerSession } from './types';

class MemoryStorage implements StorageLike {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  removeItem(key: string) { this.values.delete(key); }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function session(suffix: string): CustomerSession {
  return {
    accessExpiresAt: '2030-01-01T00:00:00.000Z',
    accessToken: `atk_${suffix}`,
    deviceToken: `device-${suffix}`,
    principal: { accountId: 'account', deviceId: 'device', sessionId: `session-${suffix}`, tenantId: 'tenant', username: 'tester' },
    refreshExpiresAt: '2030-02-01T00:00:00.000Z',
    refreshToken: `rtk_${suffix}`,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, status });
}

describe('CustomerApiClient', () => {
  it('keeps access in memory, refresh in session storage, and device identity separately', async () => {
    const auth = new MemoryStorage(); const devices = new MemoryStorage();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith('/logout') ? new Response(null, { status: 204 }) : json(session('one')));
    const client = new CustomerApiClient(auth, fetcher as typeof fetch, devices);
    await client.login('user', 'secret');
    expect([...auth.values.entries()]).toEqual([['drama_h5_refresh', 'rtk_one']]);
    expect([...devices.values.entries()]).toEqual([['drama_h5_device', 'device-one']]);
    expect(JSON.stringify([...auth.values, ...devices.values])).not.toContain('atk_one');
    await client.logout();
    expect(auth.getItem('drama_h5_refresh')).toBeNull();
    expect(devices.getItem('drama_h5_device')).toBe('device-one');
  });

  it('retries one 401 with a refreshed token and the same idempotency key', async () => {
    const auth = new MemoryStorage(); const devices = new MemoryStorage();
    const calls: Array<{ path: string; authorization: string | null; key: string | null }> = [];
    let mutationCount = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input); const headers = new Headers(init?.headers);
      calls.push({ path, authorization: headers.get('authorization'), key: headers.get('idempotency-key') });
      if (path.endsWith('/login')) return json(session('old'));
      if (path.endsWith('/refresh')) return json(session('new'));
      mutationCount += 1;
      return mutationCount === 1 ? json({ message: 'expired' }, 401) : json({ saved: true });
    });
    const client = new CustomerApiClient(auth, fetcher as typeof fetch, devices);
    await client.login('user', 'secret');
    await expect(client.request('/api/v1/customer/playback/progress', { json: { positionSeconds: 1 }, method: 'PUT' })).resolves.toEqual({ saved: true });
    const mutationCalls = calls.filter((call) => call.path.endsWith('/progress'));
    expect(mutationCalls).toHaveLength(2);
    expect(mutationCalls[0]?.key).toMatch(/^[0-9a-f-]{36}$/i);
    expect(mutationCalls[1]?.key).toBe(mutationCalls[0]?.key);
    expect(mutationCalls[0]?.authorization).toBe('Bearer atk_old');
    expect(mutationCalls[1]?.authorization).toBe('Bearer atk_new');
  });

  it('merges concurrent refreshes after two protected requests receive 401', async () => {
    const auth = new MemoryStorage(); const devices = new MemoryStorage();
    let refreshCount = 0; let protectedCount = 0; let releaseRefresh!: () => void;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith('/login')) return json(session('old'));
      if (path.endsWith('/refresh')) { refreshCount += 1; await refreshGate; return json(session('new')); }
      protectedCount += 1;
      return protectedCount <= 2 ? json({ message: 'expired' }, 401) : json({ ok: true });
    });
    const client = new CustomerApiClient(auth, fetcher as typeof fetch, devices);
    await client.login('user', 'secret');
    const first = client.request('/protected/a'); const second = client.request('/protected/b');
    await vi.waitFor(() => expect(refreshCount).toBe(1)); releaseRefresh();
    await expect(Promise.all([first, second])).resolves.toEqual([{ ok: true }, { ok: true }]);
    expect(refreshCount).toBe(1);
  });

  it('preserves refresh and device identity on a transient refresh failure', async () => {
    const auth = new MemoryStorage(); const devices = new MemoryStorage();
    auth.setItem('drama_h5_refresh', 'rtk_existing'); devices.setItem('drama_h5_device', 'device-existing');
    const client = new CustomerApiClient(auth, vi.fn(async () => json({ message: 'unavailable' }, 503)) as typeof fetch, devices);
    await expect(client.request('/protected')).rejects.toMatchObject({ status: 503 });
    expect(auth.getItem('drama_h5_refresh')).toBe('rtk_existing');
    expect(devices.getItem('drama_h5_device')).toBe('device-existing');
  });

  it('clears invalid authentication but retains device identity on refresh 401', async () => {
    const auth = new MemoryStorage(); const devices = new MemoryStorage();
    auth.setItem('drama_h5_refresh', 'rtk_invalid'); devices.setItem('drama_h5_device', 'device-existing');
    const client = new CustomerApiClient(auth, vi.fn(async () => json({ message: 'invalid' }, 401)) as typeof fetch, devices);
    await expect(client.request('/protected')).rejects.toMatchObject({ status: 401 });
    expect(auth.getItem('drama_h5_refresh')).toBeNull();
    expect(devices.getItem('drama_h5_device')).toBe('device-existing');
  });

  it('clears authentication and device identity immediately after an erasure request', async () => {
    const auth = new MemoryStorage(); const devices = new MemoryStorage();
    const client = new CustomerApiClient(
      auth,
      vi.fn(async () => json(session('erase'))) as typeof fetch,
      devices,
    );
    await client.login('user', 'secret');
    client.clearForAccountErasure();
    expect(auth.getItem('drama_h5_refresh')).toBeNull();
    expect(devices.getItem('drama_h5_device')).toBeNull();
    expect(client.currentPrincipal()).toBeUndefined();
  });
});
