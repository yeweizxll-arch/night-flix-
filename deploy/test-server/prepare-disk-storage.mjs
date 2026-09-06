// Local execution only; creates secrets in a NEW private directory, never stdout.
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const directory = process.argv[2];
assert.ok(directory?.startsWith('/'), 'Specify a new absolute private directory outside Git');
mkdirSync(directory, { mode: 0o700 });
const identities = ['platform', 'tenant'].map((scope) => {
  const bucket = scope === 'platform' ? 'nightflix-public' : 'nightflix-demo';
  return { name: `nightflix-${scope}`, credentials: [{ accessKey: randomBytes(16).toString('hex'),
    secretKey: randomBytes(32).toString('hex') }], actions: [`Read:${bucket}`, `Write:${bucket}`] };
});
writeFileSync(`${directory}/s3.private.json`, JSON.stringify({ identities }), { mode: 0o600, flag: 'wx' });
writeFileSync(`${directory}/providers.private.json`, JSON.stringify(identities.map((identity, index) => ({
  scope: index === 0 ? 'platform' : 'tenant', provider: 's3',
  label: index === 0 ? '服务器本地测试存储（总部公共）' : '服务器本地测试存储（代理商私有）',
  bucket: index === 0 ? 'nightflix-public' : 'nightflix-demo',
  endpoint: 'https://47.110.245.29', region: 'us-east-1', forcePathStyle: true,
  accessKeyId: identity.credentials[0].accessKey, secretAccessKey: identity.credentials[0].secretKey,
}))), { mode: 0o600, flag: 'wx' });
console.log('Prepared two bucket-scoped identities; credentials omitted');
