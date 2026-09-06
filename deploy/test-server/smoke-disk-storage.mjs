// Public HTTPS checks; never logs credentials or presigned URLs.
// node deploy/test-server/smoke-disk-storage.mjs /private/providers.private.json
import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const providers = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const clients = providers.map(p => new S3Client({ endpoint: p.endpoint, region: p.region,
  forcePathStyle: true, credentials: { accessKeyId: p.accessKeyId, secretAccessKey: p.secretAccessKey },
  maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED' }));
const origins = ['https://47.110.245.29:9441', 'https://47.110.245.29:9442'];
async function signPut(client, Bucket, Key, bytes, hash) {
  const uploadId = randomUUID();
  const headers = { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
    'if-none-match': '*', 'x-amz-checksum-sha256': hash, 'x-amz-meta-upload-id': uploadId };
  const url = await getSignedUrl(client, new PutObjectCommand({ Bucket, Key, ContentType: headers['content-type'],
    ContentLength: bytes.length, IfNoneMatch: '*', ChecksumSHA256: hash, Metadata: { 'upload-id': uploadId } }),
  { expiresIn: 180, unhoistableHeaders: new Set(['if-none-match', 'x-amz-checksum-sha256', 'x-amz-meta-upload-id']),
    signableHeaders: new Set(['content-type']) });
  return { url, headers, uploadId };
}
try {
  for (const [index, p] of providers.entries()) {
    assert.equal(p.endpoint, 'https://47.110.245.29');
    const client = clients[index], Key = `diagnostics/${randomUUID()}.bin`;
    const bytes = Buffer.from('Night Flix private disk upload integrity test');
    const hash = createHash('sha256').update(bytes).digest('base64');
    const signed = await signPut(client, p.bucket, Key, bytes, hash);
    for (const origin of origins) {
      const preflight = await fetch(signed.url, { method: 'OPTIONS', headers: { origin,
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'content-type,if-none-match,x-amz-checksum-sha256,x-amz-meta-upload-id' } });
      assert.ok(preflight.ok, `CORS preflight ${preflight.status}`);
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
      const allowed = preflight.headers.get('access-control-allow-headers')?.toLowerCase() ?? '';
      for (const name of ['content-type', 'if-none-match', 'x-amz-checksum-sha256', 'x-amz-meta-upload-id']) {
        assert.ok(allowed === '*' || allowed.includes(name), `CORS missing ${name}`);
      }
    }
    const put = await fetch(signed.url, { method: 'PUT', headers: { ...signed.headers, origin: origins[index] }, body: bytes });
    assert.equal(put.status, 200, `conditional upload ${p.scope}: ${put.status}`);
    assert.equal(put.headers.get('access-control-allow-origin'), origins[index]);
    const head = await client.send(new HeadObjectCommand({ Bucket: p.bucket, Key, ChecksumMode: 'ENABLED' }));
    assert.equal(head.ContentLength, bytes.length); assert.equal(head.ChecksumSHA256, hash);
    assert.equal(head.Metadata['upload-id'], signed.uploadId);
    const overwrite = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body: bytes });
    assert.equal(overwrite.status, 412, 'existing object must not be overwritten');
    const getUrl = await getSignedUrl(client, new GetObjectCommand({ Bucket: p.bucket, Key }), { expiresIn: 60 });
    const range = await fetch(getUrl, { headers: { range: 'bytes=0-9' } });
    assert.equal(range.status, 206); assert.equal(await range.text(), bytes.subarray(0, 10).toString());
    assert.equal((await fetch(`${p.endpoint}/${p.bucket}/${Key}`)).status, 403);
    await assert.rejects(clients[1 - index].send(new HeadObjectCommand({ Bucket: p.bucket, Key })),
      e => e.$metadata?.httpStatusCode === 403);
    const bad = await signPut(client, p.bucket, `${Key}.bad`, bytes, Buffer.alloc(32).toString('base64'));
    assert.equal((await fetch(bad.url, { method: 'PUT', headers: bad.headers, body: bytes })).status, 400);
    await assert.rejects(client.send(new HeadObjectCommand({ Bucket: p.bucket, Key: `${Key}.bad` })),
      e => e.$metadata?.httpStatusCode === 404);
    await client.send(new DeleteObjectCommand({ Bucket: p.bucket, Key }));
    console.log(`PASS ${p.scope}: CORS, signed PUT, checksum/metadata HEAD, overwrite rejection, range GET, anonymous/cross-bucket denial, invalid checksum rejection; diagnostic object removed`);
  }
} catch (error) { console.error(`Storage check failed: ${error.name}: ${error.message}`); process.exitCode = 1; }
finally { clients.forEach(client => client.destroy()); }
