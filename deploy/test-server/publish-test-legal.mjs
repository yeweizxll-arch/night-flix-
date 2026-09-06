// One test tenant only. No production deployment and no secrets in output.
// --check validates local content without network access.
// --publish /absolute/private/access.private.json publishes through the tenant API.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const agentBase = 'https://47.110.245.29:9442';
const appBase = 'https://47.110.245.29';
const tenantId = '01a076ee-40c2-7cfe-8fc9-ce03682a286e';
const route = '/api/v1/tenant/legal/documents';
const documents = ['zh-CN', 'en-US'].flatMap(locale => ['terms', 'privacy'].map(documentType => {
  // Match the API's trim normalization before idempotency and equality checks.
  const bodyMarkdown = readFileSync(new URL(`./legal/${documentType}.${locale}.md`, import.meta.url), 'utf8').trim();
  const title = bodyMarkdown.split('\n')[0].replace(/^# /, '');
  assert.match(title, /Night Flix/);
  assert.match(title, /封闭测试版|Closed Test/);
  assert.ok(bodyMarkdown.length > 500 && bodyMarkdown.length < 100_000);
  assert.ok(!bodyMarkdown.includes('<script') && !bodyMarkdown.includes('TODO'));
  return { documentType, locale, title, bodyMarkdown, requiredForRegistration: true };
}));

if (process.argv[2] === '--check') {
  console.log('PASS four closed-test legal texts; Chinese and English terms/privacy; no network writes');
} else {
  assert.equal(process.argv[2], '--publish', 'Specify --check or --publish');
  assert.ok(process.argv[3]?.startsWith('/'), 'Provide an absolute private credentials path');
  const credentials = JSON.parse(readFileSync(process.argv[3], 'utf8'));
  let token;
  async function request(path, body, key, base = agentBase) {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', origin: base,
        ...(token && base === agentBase ? { authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'idempotency-key': key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} at ${path}; stopped without retry`);
    return response.json();
  }
  const login = await request('/api/v1/tenant/auth/login', credentials.agent);
  assert.equal(login.principal.tenantId, tenantId, 'Unexpected tenant: stop');
  token = login.accessToken;
  const existing = (await request(route + '?pageSize=100')).items;
  assert.ok(existing.length <= 4, 'Unexpected existing documents: stop for inspection');
  for (const old of existing) {
    const match = documents.find(d => d.locale === old.locale && d.documentType === old.documentType);
    assert.ok(match && match.title === old.title && match.bodyMarkdown === old.bodyMarkdown
      && old.requiredForRegistration === true && old.version === 1, 'Existing legal text differs; will not overwrite');
  }
  for (const document of documents) {
    const hash = createHash('sha256').update(JSON.stringify(document)).digest('hex').slice(0, 24);
    const key = `test-legal-20260906:${document.locale}:${document.documentType}:${hash}`;
    const draft = existing.find(d => d.locale === document.locale && d.documentType === document.documentType)
      ?? await request(route, document, key + ':create');
    const published = draft.status === 'published' ? draft
      : await request(`${route}/${draft.id}/publish`, {
        effectiveAt: draft.createdAt, expectedVersion: draft.rowVersion,
      }, key + ':publish');
    assert.equal(published.status, 'published');
    console.log(JSON.stringify({ id: published.id, type: published.documentType, locale: published.locale, version: published.version }));
  }
  for (const locale of ['zh-CN', 'en-US', 'zh-TW', 'ja-JP', 'ko-KR', 'es-ES', 'pt-BR', 'id-ID', 'th-TH', 'vi-VN', 'de-DE', 'ar-SA', 'hi-IN', 'tr-TR', 'fr-FR']) {
    const result = await request(`/api/v1/customer/legal/documents/current?locale=${locale}`, undefined, undefined, appBase);
    assert.equal(result.documents.length, 2);
    assert.deepEqual(result.documents.map(d => d.documentType).sort(), ['privacy', 'terms']);
    for (const doc of result.documents) {
      const expectedLocale = locale === 'en-US' ? 'en-US' : 'zh-CN';
      assert.equal(doc.locale, expectedLocale);
      assert.equal(doc.requiredForRegistration, true);
      assert.equal(doc.bodyMarkdown, documents.find(d => d.documentType === doc.documentType && d.locale === expectedLocale).bodyMarkdown);
      const detail = await request(`/api/v1/customer/legal/documents/${doc.id}`, undefined, undefined, appBase);
      assert.equal(detail.bodyMarkdown, doc.bodyMarkdown);
    }
    console.log(`PASS public legal list/detail/registration flags for ${locale}`);
  }
}
