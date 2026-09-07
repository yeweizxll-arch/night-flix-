import { afterEach, describe, expect, it, vi } from 'vitest';
import { operatorError, requestJson } from './http';
afterEach(() => vi.unstubAllGlobals());
describe('operator API errors', () => {
  it.each(['null', '[]', '"upstream error"'])('preserves HTTP status when the error body is %s', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 401 })));
    await expect(requestJson('/test')).rejects.toMatchObject({ status: 401 });
  });
  it('keeps actionable Chinese validation but never exposes server internals', () => {
    expect(operatorError('请选择代理商', 400)).toBe('请选择代理商');
    expect(operatorError('数据库 password leaked', 500)).not.toContain('password');
    expect(operatorError('Internal server error', 500)).toContain('服务暂时不可用');
  });
  it.each([400, 401, 403, 404, 409, 413, 429])('provides a readable fallback for %s', status => {
    expect(operatorError(undefined, status)).toMatch(/[\u4e00-\u9fff]/);
  });
  it('handles network failure, invalid JSON and no-content success', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response('<html>', { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 })));
    await expect(requestJson('/test')).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    await expect(requestJson('/test')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(requestJson('/test')).resolves.toBeUndefined();
  });
  it('preserves structured status and business code for page-specific handling', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: 'VERSION_CONFLICT', message: 'Version conflict' }), { status: 409 })));
    await expect(requestJson('/test')).rejects.toMatchObject({ status: 409, code: 'VERSION_CONFLICT' });
  });
});
