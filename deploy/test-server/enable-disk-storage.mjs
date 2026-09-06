// Test server only. Register isolated providers and verify real UI upload APIs.
// Arguments: /private/access.private.json /private/providers.private.json /private/test.mp4
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const sharp = require('sharp');
const { S3Client, GetObjectCommand } = require('@aws-sdk/client-s3');
const credentials = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const providers = JSON.parse(readFileSync(process.argv[3], 'utf8'));
const tenantId = '01a076ee-40c2-7cfe-8fc9-ce03682a286e';
const video = readFileSync(process.argv[4]);
assert.equal(video.subarray(4, 8).toString(), 'ftyp', 'Use a real MP4 test fixture');
const png = await sharp({ create: { width: 180, height: 320, channels: 3,
  background: { r: 24, g: 36, b: 64 } } }).png().toBuffer();
const fixtures = [ { kind: 'image', extension: 'png', contentType: 'image/png', bytes: png },
  { kind: 'video', extension: 'mp4', contentType: 'video/mp4', bytes: video },
  { kind: 'file', extension: 'vtt', contentType: 'text/vtt', bytes: Buffer.from('WEBVTT\n\n00:00.000 --> 00:03.000\nNight Flix storage test\n') } ];
try {
  for (const p of providers) {
    assert.equal(p.endpoint, 'https://47.110.245.29');
    const scope = p.scope; assert.ok(['platform', 'tenant'].includes(scope));
    const base = `https://47.110.245.29:${scope === 'platform' ? 9441 : 9442}`;
    let token;
    async function api(path, { method = 'GET', body, key } = {}) {
      const response = await fetch(base + '/api/v1/' + path, { method,
        headers: { origin: base, ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(key ? { 'idempotency-key': key } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error(`${scope} ${path.split('?')[0]} returned ${response.status}; stopped`);
      return response.json();
    }
    const auth = await api(`${scope}/auth/login`, { method: 'POST', body: credentials[scope === 'platform' ? 'admin' : 'agent'] });
    if (scope === 'tenant') assert.equal(auth.principal.tenantId, tenantId);
    token = auth.accessToken;
    const path = `${scope}/storage/providers`;
    const records = (await api(`${path}?pageSize=100`)).items;
    let provider = records.find(r => r.bucket === p.bucket && r.ownerType === scope);
    if (provider) {
      assert.equal(provider.endpoint, p.endpoint); assert.equal(provider.label, p.label);
    } else {
      const { scope: _scope, ...body } = p;
      provider = await api(path, { method: 'POST', body, key: `disk-storage-20260906:${scope}:create` });
    }
    if (provider.status !== 'active') provider = await api(`${path}/${provider.id}/status`, {
      method: 'PATCH', body: { status: 'active', version: provider.version }, key: randomUUID() });
    assert.equal(provider.status, 'active');
    const uploadPath = scope === 'platform' ? 'platform/content-management/media/uploads' : 'tenant/content/media/uploads';
    const client = new S3Client({ endpoint: p.endpoint, region: p.region, forcePathStyle: true,
      credentials: { accessKeyId: p.accessKeyId, secretAccessKey: p.secretAccessKey }, maxAttempts: 1,
      responseChecksumValidation: 'WHEN_REQUIRED', requestChecksumCalculation: 'WHEN_REQUIRED' });
    try {
      for (const fixture of fixtures) {
        const { bytes, ...input } = fixture;
        const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
        const intent = await api(uploadPath, { method: 'POST', body: { ...input, providerId: provider.id,
          sizeBytes: bytes.length, checksumSha256 }, key: randomUUID() });
        assert.equal(new URL(intent.uploadUrl).origin, p.endpoint);
        assert.ok(new URL(intent.uploadUrl).pathname.startsWith(`/${p.bucket}/`));
        const put = await fetch(intent.uploadUrl, { method: 'PUT', headers: { ...intent.requiredHeaders, origin: base },
          body: bytes, signal: AbortSignal.timeout(60000) });
        assert.equal(put.status, 200, `${scope} ${fixture.kind} upload`);
        assert.equal(put.headers.get('access-control-allow-origin'), base);
        const completed = await api(`${uploadPath}/${intent.id}/complete`, { method: 'POST', key: randomUUID() });
        assert.equal(completed.status, 'ready');
        // Completion retries cannot create another asset or mutate verified bytes.
        const again = await api(`${uploadPath}/${intent.id}/complete`, { method: 'POST', key: randomUUID() });
        assert.equal(again.id, completed.id); assert.equal(again.status, 'ready');
        const object = await client.send(new GetObjectCommand({ Bucket: p.bucket, Key: intent.objectKey }));
        const saved = await object.Body.transformToByteArray();
        assert.equal(createHash('sha256').update(saved).digest('hex'), checksumSha256);
        console.log(JSON.stringify({ scope, kind: input.kind, mediaId: intent.id, status: completed.status,
          bytes: bytes.length, exactBytesVerified: true, providerId: provider.id }));
      }
    } finally { client.destroy(); }
  }
} catch (error) { console.error(`Storage activation/check failed: ${error.name}: ${error.message}`); process.exitCode = 1; }
