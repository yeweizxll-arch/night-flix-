// Only the disposable localhost admin-browser fixture. Never takes production credentials.
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const events = [];
async function call(scope, method, path, body, token) {
  const result = await new Promise((resolve, reject) => {
    const host = `${scope}.localhost:${scope === 'admin' ? 4541 : 4542}`;
    const req = http.request({ hostname: '127.0.0.1', port: 3000, method, path, headers: {
      Host: host, Origin: `http://${host}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    } }, res => {
      let text = ''; res.on('data', part => { text += part; });
      res.on('end', () => { try { resolve({ status: res.statusCode, data: JSON.parse(text) }); } catch (error) { reject(error); } });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  if (!path.includes('/auth/')) events.push({ scope, method, path, status: result.status });
  return result;
}
const state = await call('admin', 'GET', '/__qa/state');
assert.equal(state.status, 200);
assert.equal(state.data.tenantIds.length, 2);
const [aId, bId] = state.data.tenantIds;
const aDrama = state.data.dramas.find(d => d.code === 'qa-drama-1' && d.owner_tenant_id === aId);
assert.ok(aDrama, 'Only a recognized disposable fixture may be tested');
async function login(scope) {
  const result = await call(scope, 'POST', `/api/v1/${scope === 'admin' ? 'platform' : 'tenant'}/auth/login`, {
    username: scope === 'admin' ? 'qa-admin' : 'qa-owner', password: 'Local-admin-test-123',
  });
  assert.equal(result.status, 200); assert.ok(result.data.accessToken); return result.data.accessToken;
}
const [hq, a, b] = await Promise.all(['admin', 'tenant-a', 'tenant-b'].map(login));
const customers = await call('tenant-a', 'GET', '/api/v1/tenant/customers', undefined, a);
assert.equal(customers.status, 200);
const customer = customers.data.items[0]; assert.ok(customer);
for (const [method, suffix, body] of [
  ['PATCH', 'status', { expectedVersion: customer.version, status: 'disabled', reason: 'HQ forbidden QA' }],
  ['POST', 'revoke-sessions', { reason: 'HQ forbidden QA' }],
]) {
  assert.equal((await call('admin', method, `/api/v1/platform/customers/${customer.id}/${suffix}?tenantId=${aId}`, body, hq)).status, 403);
}
assert.equal((await call('tenant-b', 'GET', `/api/v1/tenant/customers/${customer.id}`, undefined, b)).status, 404);
const settings = await call('tenant-a', 'GET', '/api/v1/tenant/site/settings', undefined, a);
assert.equal(settings.status, 200);
assert.equal((await call('admin', 'PATCH', `/api/v1/platform/merchants/${aId}/site-settings`, {
  version: settings.data.version, siteName: 'HQ must not overwrite',
}, hq)).status, 403);
const unchanged = await call('tenant-a', 'GET', '/api/v1/tenant/site/settings', undefined, a);
assert.equal(unchanged.data.siteName, settings.data.siteName);
const renamed = await call('tenant-a', 'PATCH', '/api/v1/tenant/site/settings', { version: settings.data.version, siteName: '星河自主品牌' }, a);
assert.equal(renamed.status, 200);
assert.equal((await call('tenant-b', 'GET', '/api/v1/tenant/site/settings', undefined, b)).data.siteName === '星河自主品牌', false);
const permissions = await call('admin', 'GET', '/api/v1/platform/access/permissions', undefined, hq);
assert.equal(permissions.status, 200);
assert.equal(permissions.data.some(p => ['platform.customer.manage', 'platform.customer.session_revoke'].includes(p.code)), false);
let detail = await call('tenant-a', 'GET', `/api/v1/tenant/content/dramas/${aDrama.id}`, undefined, a);
assert.equal(detail.status, 200);
if (detail.data.status === 'published') {
  assert.equal((await call('tenant-a', 'POST', `/api/v1/tenant/content/dramas/${aDrama.id}/unpublish`, { expectedVersion: detail.data.version }, a)).status, 201);
  detail = await call('tenant-a', 'GET', `/api/v1/tenant/content/dramas/${aDrama.id}`, undefined, a);
}
assert.equal((await call('tenant-b', 'GET', `/api/v1/tenant/content/dramas/${aDrama.id}`, undefined, b)).status, 404);
const episode = detail.data.episodes[0]; assert.ok(episode);
const foreignAsset = state.data.media.find(m => m.owner_tenant_id === bId && m.mime_type === 'text/vtt'); assert.ok(foreignAsset);
assert.equal((await call('tenant-a', 'POST', `/api/v1/tenant/content/dramas/${aDrama.id}/episodes/${episode.id}/tracks`, {
  expectedVersion: detail.data.version, type: 'subtitle', locale: 'en-US', label: 'Foreign asset test', isDefault: false, mediaAssetId: foreignAsset.id,
}, a)).status, 400);
assert.equal((await call('tenant-b', 'POST', `/api/v1/tenant/content/dramas/${aDrama.id}/episodes/${episode.id}/tracks`, {
  expectedVersion: detail.data.version, type: 'subtitle', locale: 'en-US', label: 'Foreign drama test', isDefault: false, mediaAssetId: foreignAsset.id,
}, b)).status, 404);
const after = await call('tenant-a', 'GET', `/api/v1/tenant/content/dramas/${aDrama.id}`, undefined, a);
assert.equal(after.data.version, detail.data.version);
assert.deepEqual(after.data.episodes[0].tracks, episode.tracks);
const exported = await call('tenant-a', 'GET', '/api/v1/tenant/content/export?format=json', undefined, a);
assert.equal(exported.status, 200); assert.ok(exported.data.rowCount >= 1);
const exportedItems = JSON.parse(exported.data.content);
assert.ok(Array.isArray(exportedItems));
assert.equal(exportedItems.some(item => item.code === 'qa-drama-2'), false);
const csv = await call('tenant-a', 'GET', '/api/v1/tenant/content/export?format=csv', undefined, a);
assert.equal(csv.status, 200); assert.ok(csv.data.content.includes('qa-drama-1'));
const imported = await call('tenant-a', 'POST', '/api/v1/tenant/content/imports', {
  format: 'json', payload: [{ ...exportedItems[0], code: `qa-roundtrip-${Date.now()}`, translations: [{ locale: 'zh-CN', title: '导出再导入测试' }] }],
}, a);
assert.equal(imported.status, 201);
const importWorker = await call('admin', 'POST', '/__qa/run-imports', {});
assert.equal(importWorker.status, 200); assert.ok(importWorker.data.completed >= 1);
assert.equal((await call('tenant-a', 'GET', `/api/v1/tenant/content/imports/${imported.data.id}`, undefined, a)).data.status, 'completed');
assert.equal((await call('tenant-b', 'GET', `/api/v1/tenant/content/imports/${imported.data.id}`, undefined, b)).status, 404);
const domain = await call('tenant-a', 'POST', '/api/v1/tenant/site/domains', { host: 'approved.qa.example.test' }, a);
assert.equal(domain.status, 201);
assert.equal((await call('tenant-b', 'POST', `/api/v1/tenant/site/domains/${domain.data.id}/verify`, { version: domain.data.version }, b)).status, 404);
const verified = await call('tenant-a', 'POST', `/api/v1/tenant/site/domains/${domain.data.id}/verify`, { version: domain.data.version }, a);
assert.equal(verified.status, 201); assert.equal(verified.data.verification.status, 'verified');
console.log(JSON.stringify({ passed: true, boundaryChecks: 11, importJob: imported.data.id,
  exportRows: exported.data.rowCount, domain: domain.data.id, dnsAdapter: 'local controlled fixture, not real DNS', events }, null, 2));
