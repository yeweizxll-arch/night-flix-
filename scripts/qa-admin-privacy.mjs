// Disposable localhost admin-browser fixture only. No production credentials or endpoints.
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const events = [];
async function call(scope, method, path, body, token) {
  const result = await new Promise((resolve, reject) => {
    const host = `${scope}.localhost:4542`;
    const request = http.request({ hostname: '127.0.0.1', port: 3000, method, path, headers: {
      Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, response => {
      let text = ''; response.on('data', part => { text += part; });
      response.on('end', () => { try { resolve({ status: response.statusCode, data: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    request.on('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body));
  });
  if (!path.includes('/auth/')) events.push({ scope, method, path, status: result.status });
  return result;
}
const fixture = await call('tenant-b', 'GET', '/__qa/state');
assert.equal(fixture.status, 200); assert.equal(fixture.data.tenantIds.length, 2);
assert.ok(fixture.data.dramas.some(drama => drama.code === 'qa-drama-2'));
async function login(scope) {
  const result = await call(scope, 'POST', '/api/v1/tenant/auth/login', { username: 'qa-owner', password: 'Local-admin-test-123' });
  assert.equal(result.status, 200); return result.data.accessToken;
}
const [a, b] = await Promise.all(['tenant-a', 'tenant-b'].map(login));
const customer = await call('tenant-b', 'POST', '/api/v1/customer/auth/login', {
  identifier: 'viewer-1', password: 'Local-admin-test-123', devicePlatform: 'android', deviceLabel: 'Disposable privacy QA',
});
assert.equal(customer.status, 200);
const erasure = await call('tenant-b', 'POST', '/api/v1/customer/privacy/erasure-requests', {
  currentPassword: 'Local-admin-test-123', acknowledgeRetention: true,
}, customer.data.accessToken);
assert.equal(erasure.status, 202);
const id = erasure.data.requestId; assert.ok(id);
assert.equal((await call('tenant-a', 'GET', `/api/v1/tenant/privacy/requests/${id}`, undefined, a)).status, 404);
const pending = await call('tenant-b', 'GET', `/api/v1/tenant/privacy/requests/${id}`, undefined, b);
assert.equal(pending.status, 200); assert.equal(pending.data.status, 'submitted');
const worker = await call('tenant-b', 'POST', '/__qa/run-erasure', {});
assert.equal(worker.status, 200);
const completed = await call('tenant-b', 'GET', `/api/v1/tenant/privacy/requests/${id}`, undefined, b);
assert.equal(completed.status, 200); assert.equal(completed.data.status, 'completed');
assert.equal(completed.data.dataErasurePerformed, true);
assert.equal((await call('tenant-b', 'POST', '/api/v1/customer/auth/login', {
  identifier: 'viewer-1', password: 'Local-admin-test-123', devicePlatform: 'android',
})).status, 401);
console.log(JSON.stringify({ passed: true, requestId: id, completed: completed.data.status, events }, null, 2));
