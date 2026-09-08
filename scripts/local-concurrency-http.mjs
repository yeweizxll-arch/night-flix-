// Run only against settings-emulator.integration.spec.ts; never accepts a remote URL.
import assert from 'node:assert/strict';
const base = 'http://127.0.0.1:4326';
const timings = [];
async function request(path, token, payload) {
  const started = performance.now();
  const response = await fetch(`${base}/api/v1/customer/${path}`, {
    method: payload ? 'POST' : 'GET',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `${path}: HTTP ${response.status}`);
  if (!payload) timings.push(performance.now() - started);
  return response.json();
}
try {
  const users = [];
  for (const name of ['viewer', 'records', 'notifications', 'password', 'reset', 'export', 'erase']) {
    const session = await request('auth/login', null, {
      identifier: `${name}@example.test`, password: 'Local-password-123', devicePlatform: 'android', deviceLabel: 'Local concurrency QA',
    });
    users.push({ name, token: session.accessToken, id: session.principal.accountId });
  }
  const started = performance.now();
  await Promise.all(Array.from({ length: 28 }, async (_, worker) => {
    const user = users[worker % users.length];
    for (let round = 0; round < 10; round++) {
      const me = await request('account/me', user.token);
      assert.equal(me.accountId, user.id, 'Cross-account response');
      const wallet = await request('wallet/points', user.token);
      assert.equal(String(wallet.balancePoints), user.name === 'records' ? '250' : '0', 'Cross-account balance');
    }
  }));
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ users: users.length, concurrency: 28, requests: timings.length,
    elapsedMs: Math.round(performance.now() - started), p50Ms: Math.round(timings[Math.floor(timings.length * .5)]),
    p95Ms: Math.round(timings[Math.floor(timings.length * .95)]), maxMs: Math.round(timings.at(-1)),
    errors: 0, scope: 'localhost HTTP + real PostgreSQL; no production capacity claim; Redis fallback fixture' }, null, 2));
} finally {
  await fetch(`${base}/__qa/finish`, { method: 'POST', signal: AbortSignal.timeout(5000) });
}
