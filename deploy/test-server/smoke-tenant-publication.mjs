// Dedicated test fixture only; no existing drama is published or edited.
// Usage: node deploy/test-server/smoke-tenant-publication.mjs <private credentials>
// --candidate uses SSH-forwarded loopback ports 13291/13292. --browser verifies live UI.
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const credentials = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const candidate = process.argv.includes('--candidate');
const ip = '47.110.245.29';
const tokens = {};
let checks = 0;
async function request(scope, path, { body, method, key = randomUUID() } = {}) {
  const data = body === undefined ? undefined : JSON.stringify(body);
  const port = scope === 'platform' ? 9441 : 9442;
  const origin = candidate && scope === 'platform' ? 'https://admin.nightflix.test' : `https://${ip}:${port}`;
  return new Promise((resolve, reject) => {
    const req = (candidate ? http : https).request({
      hostname: candidate ? '127.0.0.1' : ip,
      port: candidate ? (scope === 'platform' ? 13291 : 13292) : port,
      path, method: method ?? (data ? 'POST' : 'GET'),
      headers: {
        host: candidate && scope === 'platform' ? 'admin.nightflix.test' : `${ip}:${port}`,
        origin, 'idempotency-key': key,
        ...(tokens[scope] ? { authorization: `Bearer ${tokens[scope]}` } : {}),
        ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => { let json; try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json }); });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('Timed out')));
    req.end(data);
  });
}
function check(result, status, name) {
  assert.equal(result.status, status, `${name}: ${JSON.stringify(result.json?.message)}`);
  checks++; console.log(`PASS ${name} (${status})`); return result.json;
}
const api = '/api/v1/tenant/content/dramas';
for (const scope of ['platform', 'tenant']) {
  const auth = check(await request(scope, `/api/v1/${scope}/auth/login`,
    { body: credentials[scope === 'platform' ? 'admin' : 'agent'] }), 200, `${scope} login`);
  tokens[scope] = auth.accessToken;
}
check(await request('platform', '/api/v1/platform/content/reviews'), 404, 'HQ review route removed');
check(await request('platform', '/api/v1/platform/interactions/moderation'), 404, 'HQ community route removed');
check(await request('platform', '/api/v1/platform/interactions/sensitive-words'), 404, 'HQ word management removed');
async function inventory() {
  const items = [];
  for (let page = 1; ; page++) {
    const data = check(await request('tenant', `${api}?page=${page}&pageSize=100`), 200, 'tenant inventory');
    items.push(...data.items.map(({ id, status, version }) => ({ id, status, version })));
    if (items.length >= data.total) break;
  }
  return items.sort((a, b) => a.id.localeCompare(b.id));
}
const before = await inventory();
const coverSource = check(await request('tenant', `${api}/01a07762-0f98-787c-a50c-195a64c00f4b`), 200, 'read existing cover reference');
const synthetic = check(await request('tenant', `${api}/01a07782-9c67-751e-99c3-d8f8688719b0`), 200, 'read synthetic video references');
assert.ok(coverSource.coverFileId && synthetic.episodes.length >= 2);
const code = `autonomy-smoke-${randomUUID().slice(0, 8)}`;
let drama = check(await request('tenant', api, { body: {
  code, coverFileId: coverSource.coverFileId,
  translations: [{ locale: 'zh-CN', title: `自主上架测试 ${code}` }],
} }), 201, 'create dedicated fixture');
const path = `${api}/${drama.id}`;
const detail = async () => check(await request('tenant', path), 200, 'fixture readback');
async function action(name, version, key) {
  return request('tenant', `${path}/${name}`, { body: { expectedVersion: version }, key });
}
try {
  check(await action('publish', drama.version), 400, 'empty drama cannot publish');
  const video = synthetic.episodes[0];
  check(await request('tenant', `${path}/episodes`, { body: {
    expectedDramaVersion: drama.version, episodeNo: 1, durationSeconds: video.durationSeconds,
    mediaAssetId: video.mediaAssetId, translations: [{ locale: 'zh-CN', title: '合成测试第一集' }],
  } }), 201, 'add synthetic episode');
  drama = await detail();
  const command = randomUUID();
  const published = check(await action('publish', drama.version, command), 201, 'tenant publishes without HQ');
  assert.equal(published.status, 'published');
  assert.deepEqual(check(await action('publish', drama.version, command), 201, 'repeat publication is idempotent'), published);
  check(await action('publish', drama.version), 409, 'stale publication rejected');
  check(await request('tenant', `${path}/submit-review`, { body: {} }), 404, 'old submit route removed');
  check(await request('platform', `/api/v1/platform/public-drama-pool/${drama.id}/emergency-takedown`,
    { body: { expectedVersion: published.version, reason: 'tenant scope negative probe' } }), 409, 'HQ emergency action cannot target private content');
  assert.equal((await detail()).status, 'published');
  const down = check(await action('unpublish', published.version), 201, 'tenant unpublishes');
  assert.equal(down.status, 'unpublished');
  drama = await detail();
  const alternate = synthetic.episodes[1];
  check(await request('tenant', `${path}/episodes/${drama.episodes[0].id}`, { method: 'PATCH', body: {
    expectedVersion: drama.episodes[0].version, mediaAssetId: alternate.mediaAssetId,
    durationSeconds: alternate.durationSeconds,
  } }), 200, 'replace private episode media after unpublishing');
  drama = await detail();
  assert.equal(drama.episodes[0].mediaAssetId, alternate.mediaAssetId);
  drama = check(await request('tenant', path, { method: 'PATCH', body: {
    version: drama.version,
    releaseAt: new Date(Date.now() + 86400000).toISOString(),
    unpublishAt: new Date(Date.now() + 172800000).toISOString(),
  } }), 200, 'edit unpublished schedule');
  const scheduled = check(await action('publish', drama.version), 201, 'tenant schedules publication');
  assert.equal(scheduled.status, 'approved');
  const cancelled = check(await action('unpublish', scheduled.version), 201, 'tenant cancels scheduled publication');
  drama = check(await request('tenant', path, { method: 'PATCH',
    body: { version: cancelled.version, releaseAt: null, unpublishAt: null } }), 200, 'clear fixture schedule');

  if (process.argv.includes('--browser')) {
    assert.ok(!candidate);
    const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
    const browser = await chromium.launch({
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true, args: ['--disable-renderer-accessibility'],
    });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
      const origin = `https://${ip}:9442`;
      const login = await context.request.post(`${origin}/api/v1/tenant/auth/login`,
        { headers: { origin }, data: credentials.agent });
      assert.equal(login.status(), 200);
      const page = await context.newPage();
      page.setDefaultTimeout(60000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`${origin}/?page=content`, { waitUntil: 'networkidle' });
      const row = page.getByRole('row').filter({ hasText: code });
      await row.getByRole('button', { name: '确认上架', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '提交审核', exact: true }).count(), 0);
      for (const [label, name] of [['确认上架', 'publish'], ['下架', 'unpublish']]) {
        await row.getByRole('button', { name: label === '下架' ? /^下\s*架$/ : label, exact: true }).click();
        const response = page.waitForResponse(r => r.url().endsWith(`${path}/${name}`) && r.request().method() === 'POST');
        await page.locator('.ant-popconfirm-buttons .ant-btn-primary').click();
        assert.equal((await response).status(), 201);
        await row.getByRole('button', { name: name === 'publish' ? /^下\s*架$/ : '确认上架', exact: true }).waitFor();
      }
      assert.deepEqual(errors, []);
      console.log('PASS real browser confirms publication and unpublication');
    } finally { await browser.close(); }
  }
} finally {
  drama = await detail();
  if (['approved', 'published'].includes(drama.status)) {
    check(await action('unpublish', drama.version), 201, 'cleanup fixture publication');
    drama = await detail();
  }
  check(await request('tenant', path, { method: 'DELETE',
    body: { expectedVersion: drama.version, reason: 'Dedicated autonomy smoke fixture completed' } }),
  200, 'soft-delete fixture (recoverable)');
}
assert.deepEqual(await inventory(), before, 'Existing drama statuses and versions must remain unchanged');
console.log(`Autonomy smoke complete: ${checks} HTTP checks; existing ${before.length} dramas unchanged.`);
