// Uses a separate headless Chrome profile, actual test APIs/S3 and synthetic MP4s.
// Before deployment, fulfill ONLY this browser's static assets from the local
// release artifact. Cookies, upload signatures, CORS, writes and reads are real.
// PLAYWRIGHT_MODULE=/absolute/playwright/index.mjs node ... <artifact> <private credentials> <fixtures>
import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const [artifact, credentialPath, fixtureDirectory] = process.argv.slice(2);
const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: ['--disable-renderer-accessibility'] });
let activePage;
try {
  for (const scope of ['tenant', 'platform']) {
    const base = `https://47.110.245.29:${scope === 'platform' ? 9441 : 9442}`;
    const api = scope === 'platform' ? '/api/v1/platform/content-management' : '/api/v1/tenant/content';
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    activePage = page;
    page.setDefaultTimeout(60000);
    const pageErrors = [];
    page.on('pageerror', error => { pageErrors.push(error.message); console.error(`Browser error: ${error.message}`); });
    if (!process.argv.includes('--live')) await page.route(base + '/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path.startsWith('/api/')) return route.continue();
      const root = resolve(artifact, 'static', scope);
      const file = resolve(root, '.' + (path === '/' ? '/index.html' : path));
      assert.ok(file.startsWith(root + '/') && existsSync(file), 'Unexpected static resource');
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] ?? 'application/octet-stream';
      await route.fulfill({ body: readFileSync(file), contentType: type });
    });
    const login = await context.request.post(`${base}/api/v1/${scope}/auth/login`, {
      headers: { origin: base }, data: credentials[scope === 'platform' ? 'admin' : 'agent'],
    });
    assert.equal(login.status(), 200);
    const auth = await login.json();
    const headers = { origin: base, authorization: `Bearer ${auth.accessToken}`, 'idempotency-key': randomUUID() };
    const fixtureCode = `batch-test-${scope}-${randomUUID().slice(0, 8)}`;
    const reuseId = scope === 'tenant' ? process.env.BATCH_REUSE_TENANT : undefined;
    const created = reuseId
      ? await context.request.get(`${base}${api}/dramas/${reuseId}`, { headers })
      : await context.request.post(`${base}${api}/dramas`, { headers, data: {
        code: fixtureCode, translations: [{ locale: 'zh-CN', title: `批量上传测试 ${fixtureCode}`, summary: '合成测试视频，未上架' }],
      } });
    assert.equal(created.status(), reuseId ? 200 : 201, `prepare ${scope} fixture draft`);
    const drama = await created.json();
    const code = drama.code;
    assert.ok(code.startsWith(`batch-test-${scope}-`) && drama.status === 'draft' && !(drama.episodes?.length));
    console.log(`Testing ${scope} candidate with dedicated draft ${drama.id}`);
    await page.goto(`${base}/?page=${scope === 'tenant' ? 'content' : 'content-library'}`, { waitUntil: 'networkidle' });
    await page.getByRole('menuitem').filter({ hasText: scope === 'tenant' ? '内容管理' : '公共内容管理' }).waitFor();
    console.log(`Opened ${scope} content page`);
    const row = page.getByRole('row').filter({ hasText: code });
    // Ant Design inserts a visual space in two-character Chinese button names.
    await row.getByRole('button', { name: /^详\s*情$/ }).click();
    console.log(`Opened ${scope} fixture detail`);
    await page.getByRole('button', { name: '批量添加剧集', exact: true }).click();
    console.log(`Opened ${scope} batch modal`);
    const modal = page.getByRole('dialog', { name: '批量添加剧集', exact: true });
    await modal.getByLabel('选择多个剧集视频').setInputFiles(['EP_10.mp4', 'EP_02.mp4', 'EP_01.mp4'].map(name => resolve(fixtureDirectory, name)));
    await modal.getByText('11 秒', { exact: true }).waitFor();
    assert.equal(await modal.getByText('3 秒', { exact: true }).count(), 1);
    assert.equal(await modal.getByText('7 秒', { exact: true }).count(), 1);
    const names = await modal.locator('tbody tr').allTextContents();
    assert.ok(names[0].includes('EP_01.mp4') && names[1].includes('EP_02.mp4') && names[2].includes('EP_10.mp4'));
    await page.screenshot({ path: resolve(fixtureDirectory, `${scope}-batch-preview.png`), fullPage: true });
    let puts = 0;
    await page.route(`https://47.110.245.29/nightflix-${scope === 'tenant' ? 'demo' : 'public'}/**`, async route => {
      if (route.request().method() === 'PUT') {
        puts++;
        if (scope === 'tenant' && puts === 2) return route.fulfill({ status: 503,
          headers: { 'access-control-allow-origin': base }, body: 'Injected one-file upload failure' });
      }
      return route.continue();
    });
    await modal.getByRole('button', { name: '上传并添加 / 重试未完成' }).click();
    if (scope === 'tenant') {
      await modal.getByText('2 / 3 集已添加', { exact: true }).waitFor({ timeout: 180000 });
      await modal.getByRole('button', { name: '上传并添加 / 重试未完成' }).click();
    }
    await modal.getByText('3 / 3 集已添加', { exact: true }).waitFor({ timeout: 180000 });
    assert.equal(puts, scope === 'tenant' ? 4 : 3, 'successful files must not be uploaded again');
    const detail = await (await context.request.get(`${base}${api}/dramas/${drama.id}`, { headers })).json();
    assert.equal(detail.episodes.length, 3);
    assert.deepEqual(detail.episodes.sort((a, b) => a.episodeNo - b.episodeNo).map(e => [e.episodeNo, e.durationSeconds, e.previewSeconds]), [[1, 3, 0], [2, 7, 0], [3, 11, 0]]);
    assert.equal(detail.status, 'draft');
    await page.screenshot({ path: resolve(fixtureDirectory, `${scope}-batch-complete.png`), fullPage: true });
    await modal.getByRole('button', { name: '完成并返回' }).click();
    await page.getByRole('button', { name: '添加单集', exact: true }).click();
    const single = page.getByRole('dialog', { name: '添加剧集', exact: true });
    const duration = single.getByLabel('视频时长（自动读取）', { exact: true });
    assert.equal(await duration.inputValue(), '');
    assert.equal(await duration.getAttribute('readonly'), '');
    await single.getByRole('button', { name: '单独上传正片', exact: true }).click();
    const upload = page.getByRole('dialog', { name: '单独上传正片视频', exact: true });
    await upload.locator('input[type=file]').setInputFiles(resolve(fixtureDirectory, 'EP_02.mp4'));
    await upload.getByRole('button', { name: '开始安全上传' }).click();
    await upload.waitFor({ state: 'hidden', timeout: 120000 });
    assert.equal(await duration.inputValue(), '7');
    await single.getByLabel('标题', { exact: true }).fill('单集自动时长测试');
    await single.getByRole('button', { name: '保存剧集', exact: true }).click();
    await single.waitFor({ state: 'hidden' });
    const afterSingle = await (await context.request.get(`${base}${api}/dramas/${drama.id}`, { headers })).json();
    assert.equal(afterSingle.episodes.length, 4);
    assert.equal(afterSingle.episodes.find(e => e.episodeNo === 4).durationSeconds, 7);
    assert.deepEqual(pageErrors, []);
    console.log(JSON.stringify({ scope, dramaId: drama.id, code, episodes: 4, durations: [3, 7, 11, 7],
      realBrowser: true, staticSource: process.argv.includes('--live') ? 'deployed' : 'local candidate',
      retryOnlyFailedFile: scope === 'tenant', published: false }));
    await context.close();
  }
} catch (error) {
  console.error(`${error.name}: ${error.message}`);
  if (activePage && !activePage.isClosed()) {
    await activePage.screenshot({ path: resolve(fixtureDirectory, 'browser-failure.png'), fullPage: true });
    console.error((await activePage.locator('body').innerText()).slice(0, 12000));
  }
  process.exitCode = 1;
}
finally { await browser.close(); }
