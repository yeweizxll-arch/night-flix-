// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from './AuthProvider';
import { ApiError, requestJson } from '../api/http';
vi.mock('../config/admin-scope', () => ({ ADMIN_SCOPE: 'tenant', AUTH_API_BASE: '/auth' }));
vi.mock('../api/http', async original => ({ ...await original<typeof import('../api/http')>(), requestJson: vi.fn() }));
const session = (token: string) => ({ accessToken: token, accessExpiresAt: '2099-01-01', principal: { id: 'qa', displayName: '测试员', scope: 'tenant', tenantId: 'a', permissions: [] } });
const outcomes: unknown[] = [];
function Probe() {
  const auth = useAuth();
  return <><span>{auth.loading ? '读取中' : auth.principal?.displayName ?? '未登录'}</span>
    <button onClick={() => { void auth.request('/business', { method: 'POST' }).catch(error => outcomes.push(error)); }}>请求</button>
    <button onClick={() => { void auth.logout().catch(error => outcomes.push(error)); }}>退出</button></>;
}
afterEach(() => { cleanup(); vi.mocked(requestJson).mockReset(); outcomes.length = 0; });
describe('admin session renewal', () => {
  it('does not pretend logout succeeded on network failure and allows a successful retry', async () => {
    const error = new ApiError('network', 0);
    vi.mocked(requestJson).mockResolvedValueOnce(session('current')).mockRejectedValueOnce(error).mockResolvedValueOnce(undefined);
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText('测试员'); fireEvent.click(screen.getByText('退出'));
    await waitFor(() => expect(outcomes).toEqual([error]));
    expect(screen.getByText('测试员')).toBeTruthy();
    fireEvent.click(screen.getByText('退出')); await screen.findByText('未登录');
  });
  it.each([403, 409, 500])('keeps the renewed login after a business %i and reuses the mutation key', async status => {
    const error = new ApiError('业务失败', status);
    vi.mocked(requestJson).mockResolvedValueOnce(session('old')).mockRejectedValueOnce(new ApiError('expired', 401))
      .mockResolvedValueOnce(session('renewed')).mockRejectedValueOnce(error);
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText('测试员'); fireEvent.click(screen.getByText('请求'));
    await waitFor(() => expect(outcomes).toEqual([error]));
    expect(screen.getByText('测试员')).toBeTruthy();
    const calls = vi.mocked(requestJson).mock.calls;
    expect(calls[1]![2]).toBe('old'); expect(calls[3]![2]).toBe('renewed');
    const first = new Headers(calls[1]![1]?.headers).get('Idempotency-Key');
    expect(first).toBeTruthy(); expect(new Headers(calls[3]![1]?.headers).get('Idempotency-Key')).toBe(first);
  });
  it('clears the login when the refresh token is invalid', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(session('old')).mockRejectedValueOnce(new ApiError('expired', 401))
      .mockRejectedValueOnce(new ApiError('expired refresh', 401));
    render(<AuthProvider><Probe /></AuthProvider>);
    await screen.findByText('测试员'); fireEvent.click(screen.getByText('请求'));
    await screen.findByText('未登录'); expect(vi.mocked(requestJson)).toHaveBeenCalledTimes(3);
  });
});
