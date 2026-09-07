// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PublicDramaPoolPage } from './PublicDramaPoolPage';
import { BatchEpisodeUploadModal } from './BatchEpisodeUploadModal';
import { AuditLogPage } from './AuditLogPage';
import { StaffManagementPage } from './StaffManagementPage';
import { CommerceCatalogPage } from './CommerceCatalogPage';
import { TenantNotificationPage } from './TenantNotificationPage';
import { InteractionModerationPage } from './InteractionModerationPage';
import { TenantContentListPage, TenantEpisodeTracksModal, TenantMediaUploadModal } from './TenantContentListPage';
import { ApiError } from '../api/http';
import { CustomerManagementPage } from './CustomerManagementPage';
import { SiteSettingsPanel } from './SiteSettingsPanel';
import { TenantLegalPrivacyPage } from './TenantLegalPrivacyPage';
import { CustomerFeedbackPanel } from './CustomerFeedbackPanel';
import { TenantFinancePage } from './TenantFinancePage';
import { ContentRevenuePage } from './ContentRevenuePage';
import userEvent from '@testing-library/user-event';

const auth = vi.hoisted(() => ({ request: vi.fn(), permissions: [] as string[] }));
vi.mock('../auth/AuthProvider', () => ({ useAuth: () => ({ request: auth.request, principal: { id: 'qa', permissions: auth.permissions } }) }));
const runtime = { admob: {}, allowedCountries: [], featureFlags: { preserve: true }, storeProducts: {}, supportedLocales: ['zh-CN'], version: 4 };
const drama = { code: 'test', dramaId: 'test-drama', publicationStatus: 'pending_review', publicationVersion: 0, summary: '测试', title: '测试公共剧', totalEpisodes: 20 };
const emptyPool = { items: [drama], page: 1, pageSize: 20, total: 1 };
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', { value: () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
  const computedStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = element => computedStyle(element);
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollTo = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});
beforeEach(() => {
  auth.permissions = ['content.drama.read', 'content.drama.submit_review', 'content.drama.update', 'tenant.site.read', 'tenant.site.manage'];
  auth.request.mockReset().mockImplementation(async (path: string) => path.endsWith('app-runtime-config') ? runtime : emptyPool);
});
afterEach(cleanup);
function show(element: React.ReactNode) { return render(<ConfigProvider locale={zhCN} theme={{ token: { motion: false } }} button={{ autoInsertSpace: false }}>{element}</ConfigProvider>); }

describe('real admin component buttons with controlled API outcomes', { timeout: 30000 }, () => {
  it('domain activation is available only after certificate readiness and refresh retrieves new state', async () => {
    let tlsStatus = 'provisioning';
    auth.request.mockImplementation(async () => [{ id: 'domain', host: 'example.test', enabled: true, isPrimary: false,
      readOnly: false, type: 'custom', tlsStatus, verification: { status: 'verified' }, version: 1 }]);
    show(<SiteSettingsPanel canManageDomains canManageSettings={false} canReadDomains canReadSettings={false}
      createDomainKind="custom" description="" domainsEndpoint="/domains" settingsEndpoint="/settings" title="域名" />);
    await screen.findByText('证书生效后可设为主域名');
    expect(screen.queryByRole('button', { name: '设为主域名' })).toBeNull();
    tlsStatus = 'active';
    fireEvent.click(screen.getByRole('button', { name: '刷新域名' }));
    await screen.findByRole('button', { name: '设为主域名' });
    expect(auth.request).toHaveBeenCalledTimes(2);
  });
  it('privacy details explain retention and external follow-up without internal codes', async () => {
    auth.permissions = ['tenant.privacy_request.read'];
    const detail = { id: 'privacy', accountSubjectId: 'customer', status: 'completed', dataErasurePerformed: true,
      submittedAt: '2026-09-07T00:00:00Z', retainedItems: [{ category: 'commerce_finance', reason: 'accounting_and_tax',
        recordCount: 1, retainedUntil: '2033-09-07T00:00:00Z' }], subprocessorStatus: [{ provider: 'payment_provider', boundary: 'internal English code' }] };
    auth.request.mockImplementation(async path => path.endsWith('/privacy') ? detail : { items: [detail], page: 1, pageSize: 20 });
    show(<TenantLegalPrivacyPage />);
    fireEvent.click(await screen.findByRole('button', { name: '详情' }));
    await screen.findByText('交易与财务记录');
    expect(screen.getByText(/会计与税务留存/)).toBeTruthy();
    expect(screen.getByText('支付服务商 · 需运营跟进')).toBeTruthy();
    expect(screen.queryByText('commerce_finance')).toBeNull();
    expect(screen.queryByText('internal English code')).toBeNull();
  });
  it('missing DNS verification remains actionable after the transient toast', async () => {
    auth.request.mockImplementation(async path => {
      if (path.endsWith('/verify')) throw new ApiError('尚未检测到匹配的 DNS TXT 记录，请完成解析后重新验证。', 400);
      return [{ id: 'domain', host: 'pending.example.test', enabled: true, isPrimary: false, readOnly: false,
        type: 'custom', tlsStatus: 'pending', verification: { status: 'pending', recordName: '_check', recordValue: 'qa-only' }, version: 1 }];
    });
    show(<SiteSettingsPanel canManageDomains canManageSettings={false} canReadDomains canReadSettings={false}
      createDomainKind="custom" description="" domainsEndpoint="/domains" settingsEndpoint="/settings" title="域名"
      verifyEndpoint={id => `/domains/${id}/verify`} />);
    fireEvent.click(await screen.findByRole('button', { name: '验证 DNS' }));
    await screen.findByRole('button', { name: '重试' });
    expect(screen.getAllByText('尚未检测到匹配的 DNS TXT 记录，请完成解析后重新验证。').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '设为主域名' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(auth.request.mock.calls.filter(([path]) => path.endsWith('/verify'))).toHaveLength(2));
  });
  it('erasure accounts have accurate labels and no reactivation or session buttons', async () => {
    auth.permissions = ['tenant.customer.read', 'tenant.customer.manage', 'tenant.customer.session_revoke'];
    auth.request.mockResolvedValue({ items: ['erasure_pending', 'erased'].map((status, index) => ({
      id: String(index), username: `privacy-${index}`, status, pointsBalance: '0', orders: { total: 0 }, createdAt: '2026-09-07T00:00:00Z',
    })), nextCursor: null, pageSize: 20 });
    show(<CustomerManagementPage apiBase="/api/v1/tenant/customers" scope="tenant" title="用户管理"
      managePermission="tenant.customer.manage" readPermission="tenant.customer.read" sessionRevokePermission="tenant.customer.session_revoke" />);
    await screen.findByText('注销中');
    await screen.findByText('已注销');
    expect(screen.queryByRole('button', { name: '启用' })).toBeNull();
    expect(screen.queryByRole('button', { name: '停用' })).toBeNull();
    expect(screen.queryByRole('button', { name: '全部下线' })).toBeNull();
    expect(screen.getAllByRole('button', { name: '详情' })).toHaveLength(2);
  });
  it('export prerequisite errors stay visible with actionable instructions rather than a version-conflict toast', async () => {
    auth.request.mockImplementation(async path => {
      if (path.includes('/export?')) throw new ApiError('有 1 部短剧缺少封面或标题，请补齐后再导出。', 409, 'CONTENT_EXPORT_NOT_READY');
      return { items: [], total: 0, page: 1, pageSize: 20 };
    });
    show(<TenantContentListPage />);
    fireEvent.click(await screen.findByRole('tab', { name: '导入导出' }));
    fireEvent.click(screen.getByRole('button', { name: '导出 JSON' }));
    await screen.findByText('有 1 部短剧缺少封面或标题，请补齐后再导出。');
    expect(screen.queryByText('数据版本或状态已变化，页面将刷新，请重新操作')).toBeNull();
    expect(auth.request).toHaveBeenCalledWith('/api/v1/tenant/content/export?format=json');
  });
  it('headquarters legacy customer grants do not expose tenant operating controls', async () => {
    auth.permissions = ['platform.customer.read', 'platform.customer.manage', 'platform.customer.session_revoke'];
    auth.request.mockResolvedValue({ items: [{ id: 'customer', username: 'viewer', status: 'active', pointsBalance: '0', orders: { total: 0 }, createdAt: '2026-09-07T00:00:00Z' }], nextCursor: null, pageSize: 20 });
    show(<CustomerManagementPage apiBase="/api/v1/platform/customers" scope="platform" title="用户查询"
      managePermission="platform.customer.manage" readPermission="platform.customer.read" sessionRevokePermission="platform.customer.session_revoke" />);
    fireEvent.change(screen.getByPlaceholderText('代理商编号（需代理商查看权限才可搜索）'), { target: { value: '00000000-0000-4000-8000-000000000001' } });
    fireEvent.click(screen.getByRole('button', { name: '查询代理商用户' }));
    await screen.findByRole('button', { name: 'viewer' });
    expect(screen.queryByRole('button', { name: '停用' })).toBeNull();
    expect(screen.queryByRole('button', { name: '全部下线' })).toBeNull();
    expect(screen.getByRole('button', { name: '详情' })).toBeTruthy();
  });
  it('tenant tracks validate, retain failed input, save, stop and restore without headquarters', async () => {
    const media = '00000000-0000-4000-8000-000000000001';
    const record = { id: 'private-drama', code: 'private', status: 'draft' as const, version: 2, tagIds: [], totalEpisodes: 1, translations: [], createdAt: '', sourceType: 'upload' };
    const episode = { id: 'episode', dramaId: record.id, episodeNo: 1, durationSeconds: 60, mediaAssetId: media, previewSeconds: 0, status: 'draft' as const, version: 0, translations: [] };
    let track: Record<string, unknown> | undefined;
    let fails = true, version = 2;
    auth.request.mockImplementation(async (path: string, options?: { method?: string; body?: string }) => {
      if (options?.method === 'POST') {
        if (fails) throw new Error('测试保存失败');
        const { expectedVersion, ...input } = JSON.parse(options.body!);
        expect(expectedVersion).toBe(version++);
        track = { ...input, id: 'track', status: 'active' };
      } else if (options?.method === 'DELETE') { track = { ...track, status: 'disabled', isDefault: false }; version++; }
      return { ...record, version, episodes: [{ ...episode, tracks: track ? [track] : [] }] };
    });
    show(<TenantEpisodeTracksModal drama={record} episode={episode} canUpload onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '保存轨道' }));
    await screen.findByText('请上传文件或填写有效文件编号');
    expect(auth.request).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole('textbox', { name: '显示名称' }), { target: { value: '中文字幕' } });
    fireEvent.change(screen.getByRole('textbox', { name: '媒体文件编号' }), { target: { value: media } });
    fireEvent.click(screen.getByRole('button', { name: '保存轨道' }));
    await screen.findByText('轨道操作失败，请重试');
    expect((screen.getByRole('textbox', { name: '显示名称' }) as HTMLInputElement).value).toBe('中文字幕');
    fails = false;
    fireEvent.click(screen.getByRole('button', { name: '保存轨道' }));
    await screen.findByRole('cell', { name: '中文字幕' });
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    fireEvent.click(await screen.findByRole('button', { name: '取消' }));
    expect(auth.request.mock.calls.some(([, opts]) => opts?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: '停用' }));
    fireEvent.click(await screen.findByRole('button', { name: '确定' }));
    fireEvent.click(await screen.findByRole('button', { name: '恢复' }));
    expect((screen.getByRole('textbox', { name: '显示名称' }) as HTMLInputElement).value).toBe('中文字幕');
    fireEvent.click(screen.getByRole('button', { name: '保存轨道' }));
    await screen.findByRole('button', { name: '停用' });
    expect(auth.request.mock.calls.every(([path]) => !path.includes('/platform/'))).toBe(true);
  });
  it('published tenant tracks remain readable but cannot be edited or uploaded', async () => {
    auth.permissions = ['content.drama.read', 'content.drama.update'];
    show(<TenantEpisodeTracksModal drama={{ id: 'd', code: 'd', status: 'published', version: 0, translations: [], tagIds: [], totalEpisodes: 1, sourceType: 'upload', createdAt: '' }}
      episode={{ id: 'e', dramaId: 'd', episodeNo: 1, durationSeconds: 60, previewSeconds: 0, mediaAssetId: '', translations: [], version: 0, status: 'published' }} canUpload onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: '保存轨道' })).toBeNull();
    expect(screen.queryByRole('button', { name: '上传字幕或配音' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '刷新轨道' }));
    await waitFor(() => expect(auth.request).toHaveBeenCalledWith('/api/v1/tenant/content/dramas/d'));
  });
  it('a late revenue response cannot replace the newly selected tenant totals or cash status', async () => {
    auth.permissions = ['finance.settlement.manage'];
    const a = '00000000-0000-4000-8000-000000000001';
    const b = '00000000-0000-4000-8000-000000000002';
    let releaseA!: (value: unknown) => void;
    const pendingA = new Promise(resolve => { releaseA = resolve; });
    auth.request.mockImplementation(async (path: string) => {
      if (path.includes('/cash-status/')) return { basis: 'gross', unvalued: 0, legacyReview: null };
      if (path.includes('/policies')) return { items: [] };
      if (path.includes(a)) return pendingA;
      return { items: [], totals: [{ currency: 'USD', gross: path.includes(b) ? '2222' : '0', headquarters: '0', tenant: '0', creator: '0' }] };
    });
    show(<ContentRevenuePage />);
    const tenant = screen.getByPlaceholderText('代理商编号（需代理商查看权限才可搜索）');
    fireEvent.change(tenant, { target: { value: a } });
    await waitFor(() => expect(auth.request.mock.calls.some(([path]) => path.includes('/ledger?') && path.includes(a))).toBe(true));
    fireEvent.change(tenant, { target: { value: b } });
    await screen.findByText('USD 22.22');
    await waitFor(() => expect(auth.request).toHaveBeenCalledWith(`/api/v1/platform/content-revenue/cash-status/${b}`));
    await act(async () => { releaseA({ items: [], totals: [{ currency: 'USD', gross: '1111', headquarters: '0', tenant: '0', creator: '0' }] }); await pendingA; });
    expect(screen.getByText('USD 22.22')).toBeTruthy();
    expect(screen.queryByText('USD 11.11')).toBeNull();
    expect(auth.request).not.toHaveBeenCalledWith(`/api/v1/platform/content-revenue/cash-status/${a}`);
  });
  it('content revenue accepts human percentages and sends exact basis points only after totals validate', async () => {
    auth.permissions = ['finance.settlement.manage'];
    auth.request.mockImplementation(async path => path.includes('/ledger') ? { items: [], totals: [{ currency: 'USD', gross: '999', headquarters: '199', tenant: '600', creator: '200' }] } : { items: [] });
    show(<ContentRevenuePage />);
    await screen.findByText('USD 9.99');
    fireEvent.click(screen.getByRole('button', { name: '配置分成策略' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByPlaceholderText('代理商编号（需代理商查看权限才可搜索）'), { target: { value: '00000000-0000-4000-8000-000000000001' } });
    fireEvent.change(within(dialog).getByRole('textbox', { name: /总部比例/ }), { target: { value: '21' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存策略' }));
    await screen.findByText('总部、代理商、创作者分成比例合计必须等于 100%');
    expect(auth.request.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(false);
    fireEvent.change(within(dialog).getByRole('textbox', { name: /总部比例/ }), { target: { value: '20' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存策略' }));
    await waitFor(() => expect(auth.request.mock.calls.some(([, options]) => options?.method === 'PUT')).toBe(true));
    const submitted = auth.request.mock.calls.find(([, options]) => options?.method === 'PUT')!;
    expect(JSON.parse(submitted[1].body)).toEqual({ contentScope: 'public', incomeType: 'coin_unlock', status: 'active',
      headquartersBps: 2000, tenantBps: 6000, creatorBps: 2000, expectedVersion: 0 });
  });
  it('revenue cash status failure never enables month settlement', async () => {
    auth.permissions = ['finance.settlement.manage'];
    auth.request.mockImplementation(async (path: string) => {
      if (path.includes('/cash-status/')) throw new Error('核算状态读取失败，请重试');
      return path.includes('/ledger') ? { items: [], totals: [] } : { items: [] };
    });
    show(<ContentRevenuePage />);
    fireEvent.change(screen.getByPlaceholderText('代理商编号（需代理商查看权限才可搜索）'), { target: { value: '00000000-0000-4000-8000-000000000001' } });
    await screen.findByText('核算状态读取失败，请重试');
    expect((screen.getByRole('button', { name: '确认月度结算' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '确认月度结算' }));
    expect(auth.request.mock.calls.some(([path]) => path.includes('/settlements/'))).toBe(false);
  });
  it('finance refresh reloads permitted sections and ledger pagination sends the record ID cursor', { timeout: 60000 }, async () => {
    auth.permissions = ['commerce.balance.read', 'commerce.withdrawal.read'];
    const entries = Array.from({ length: 50 }, (_, index) => ({
      id: `ledger-${index}`, createdAt: '2026-09-07T00:00:00Z', currency: 'USD',
      bucket: 'available', entryType: 'freeze', deltaMinor: -1, balanceAfterMinor: 99,
      referenceType: 'withdrawal', referenceId: 'qa-withdrawal',
    }));
    auth.request.mockImplementation(async path => path.includes('/ledger?') && !path.includes('beforeId') ? entries : []);
    show(<TenantFinancePage />);
    const earlier = (await screen.findByText('加载更早记录')).closest('button')!;
    await waitFor(() => expect(earlier.classList.contains('ant-btn-loading')).toBe(false));
    fireEvent.click(earlier);
    await waitFor(() => expect(auth.request).toHaveBeenCalledWith('/api/v1/tenant/finance/ledger?limit=50&beforeId=ledger-49'));
    await waitFor(() => expect(screen.queryByText('加载更早记录')).toBeNull());
    auth.request.mockClear();
    // Wait for Ant Design's loading transition without scanning all 50 rows for roles.
    const refresh = screen.getByText('刷新').closest('button')!;
    await waitFor(() => expect(refresh.classList.contains('ant-btn-loading')).toBe(false));
    fireEvent.click(refresh);
    await waitFor(() => expect(auth.request).toHaveBeenCalledWith('/api/v1/tenant/finance/balances'));
    expect(auth.request).toHaveBeenCalledWith('/api/v1/tenant/finance/withdrawals?limit=100');
    expect(screen.queryByRole('button', { name: '申请提现' })).toBeNull();
  });
  it('feedback reply requires content, retains input on failure and closes only after success', async () => {
    const feedback = { id: 'feedback-1', body: '无法打开视频', createdAt: '2026-09-07T00:00:00Z' };
    let replied = false;
    let attempts = 0;
    auth.request.mockImplementation(async (path, options) => {
      if (options?.method === 'POST') {
        if (++attempts === 1) throw new Error('回复失败，请重试');
        expect(JSON.parse(options.body)).toEqual({ reply: '请更新应用后重试' });
        replied = true;
        return {};
      }
      return { items: [{ ...feedback, ...(replied ? { reply: '请更新应用后重试' } : {}) }] };
    });
    show(<CustomerFeedbackPanel canManage />);
    fireEvent.click(await screen.findByRole('button', { name: '回复' }));
    expect((screen.getByRole('button', { name: '确定' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox', { name: '回复内容' }), { target: { value: '请更新应用后重试' } });
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await screen.findByText('回复失败，请重试');
    expect((screen.getByRole('textbox', { name: '回复内容' }) as HTMLTextAreaElement).value).toBe('请更新应用后重试');
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await waitFor(() => expect(screen.queryByRole('textbox', { name: '回复内容' })).toBeNull());
    await screen.findByRole('cell', { name: '请更新应用后重试' });
    expect(screen.queryByRole('button', { name: '回复' })).toBeNull();
  });
  it('feedback read-only access does not expose a reply action', async () => {
    auth.request.mockResolvedValue({ items: [{ id: 'f', body: '只读反馈', createdAt: '2026-09-07T00:00:00Z' }] });
    show(<CustomerFeedbackPanel canManage={false} />);
    await screen.findByText('只读反馈');
    expect(screen.queryByRole('button', { name: '回复' })).toBeNull();
  });
  it('single cover upload recovers storage loading and includes enabled public storage', async () => {
    auth.permissions = ['tenant.storage.read', 'content.drama.create'];
    auth.request.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ items: [
      { id: '00000000-0000-4000-8000-000000000001', label: '公共上传存储', ownerType: 'platform', status: 'active' },
      { id: 'disabled', label: '停用上传存储', ownerType: 'tenant', status: 'disabled' },
    ] });
    show(<TenantMediaUploadModal open kind="image" onReady={() => {}} onCancel={() => {}} />);
    await screen.findByText('对象存储加载失败，请重试');
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await screen.findByText('公共上传存储 · 公共存储');
    expect(screen.queryByText('停用上传存储')).toBeNull();
    expect((screen.getByRole('button', { name: '开始安全上传' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('no storage gives an actionable explanation rather than a silent disabled upload', async () => {
    auth.permissions = ['tenant.storage.read'];
    auth.request.mockResolvedValue({ items: [] });
    show(<TenantMediaUploadModal open kind="image" onReady={() => {}} onCancel={() => {}} />);
    await screen.findByText('暂无可用存储，请先在“对象存储”中启用存储配置，或联系总部启用公共存储。');
    expect((screen.getByRole('button', { name: '开始安全上传' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('a notification list edit opens the populated editor in one click', async () => {
    auth.permissions = ['tenant.notification.read', 'tenant.notification.campaign.manage'];
    const record = { id: 'campaign', name: '通知测试', channels: ['in_app'], status: 'draft', version: 2, targetType: 'all' };
    auth.request.mockImplementation(async path => path.endsWith('provider-configs') ? [] : path.endsWith('/campaign')
      ? { ...record, target: { type: 'all' }, translations: [{ locale: 'zh-CN', title: '通知标题', body: '通知正文' }] }
      : { items: [record], page: 1, pageSize: 20 });
    show(<TenantNotificationPage />);
    fireEvent.click(screen.getByRole('tab', { name: '群发活动' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await waitFor(() => expect(auth.request).toHaveBeenCalledWith('/api/v1/tenant/notifications/campaigns/campaign'));
    const callIndex = auth.request.mock.calls.findIndex(([path]) => path.endsWith('/campaign'));
    expect(await auth.request.mock.results[callIndex]!.value).toHaveProperty('status', 'draft');
    const editorTitle = await screen.findByText('编辑群发草稿');
    const editor = editorTitle.closest('[role="dialog"]') as HTMLElement;
    expect(editor).toBeTruthy();
    expect(editor.closest('[aria-hidden="true"]')).toBeNull();
    expect((within(editor).getByRole('textbox', { name: '活动名称' }) as HTMLInputElement).value).toBe('通知测试');
    expect((within(editor).getByRole('textbox', { name: '正文' }) as HTMLInputElement).value).toBe('通知正文');
    expect(screen.queryByRole('dialog', { name: '活动详情' })).toBeNull();
    fireEvent.click(within(editor).getByRole('button', { name: '取消' }));
    expect(auth.request.mock.calls.some(([, init]) => init?.method)).toBe(false);
  });
  it('notification edit failure is visible, does not open an empty form, and permits retry', async () => {
    auth.permissions = ['tenant.notification.read', 'tenant.notification.campaign.manage'];
    auth.request.mockImplementation(async path => {
      if (path.endsWith('provider-configs')) return [];
      if (path.endsWith('/campaign')) throw new Error('断网');
      return { items: [{ id: 'campaign', name: '通知测试', channels: ['in_app'], status: 'draft', version: 0, targetType: 'all' }], page: 1, pageSize: 20 };
    });
    show(<TenantNotificationPage />);
    fireEvent.click(screen.getByRole('tab', { name: '群发活动' }));
    fireEvent.click(await screen.findByRole('button', { name: '编辑' }));
    await screen.findByText('活动加载失败，请重试');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((screen.getByRole('button', { name: '编辑' }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('tenant sensitive words can be re-enabled, public words stay readonly, and a partial page has no next page', async () => {
    auth.permissions = ['read', 'words'];
    const word = { id: 'word', term: '本地词', scope: 'tenant', status: 'disabled', createdAt: '2026-09-07T00:00:00Z' };
    auth.request.mockImplementation(async path => ({ items: path.includes('sensitive-words') ? [word, { ...word, id: 'public', term: '公共词', scope: 'platform', status: 'active' }] : [], page: 1, pageSize: 20 }));
    show(<InteractionModerationPage apiBase="/community" title="治理" platformScope={false} readPermission="read" managePermission="manage" sensitiveWordPermission="words" />);
    fireEvent.click(screen.getByRole('tab', { name: '敏感词' }));
    fireEvent.click(await screen.findByRole('button', { name: '启用' }));
    await waitFor(() => expect(auth.request).toHaveBeenCalledWith('/community/sensitive-words', expect.objectContaining({ method: 'POST', body: JSON.stringify({ term: '本地词' }) })));
    expect(screen.queryByRole('button', { name: '停用' })).toBeNull();
    const panel = screen.getByRole('tabpanel', { name: '敏感词' });
    expect((within(panel).getByRole('button', { name: 'right' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('content-only operators never request App settings and cannot rank an unlisted public drama', async () => {
    auth.permissions = ['content.drama.read', 'content.drama.update'];
    show(<PublicDramaPoolPage />);
    await screen.findByText('测试公共剧');
    expect(auth.request.mock.calls.every(([path]) => !path.includes('app-runtime-config'))).toBe(true);
    expect(screen.queryByRole('tab', { name: 'App 运行配置' })).toBeNull();
    expect(screen.queryByRole('button', { name: '权重排行' })).toBeNull();
    expect(screen.queryByRole('button', { name: '审核通过' })).toBeNull();
  });
  it('site-only staff can reach configuration without content permission; readonly staff cannot save', async () => {
    auth.permissions = ['tenant.site.read'];
    show(<PublicDramaPoolPage />);
    await screen.findByRole('button', { name: '保存运行配置' });
    await waitFor(() => expect(auth.request).toHaveBeenCalled());
    expect(auth.request.mock.calls.every(([path]) => !path.includes('public-drama-pool'))).toBe(true);
    expect((screen.getByRole('button', { name: '保存运行配置' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('runtime load failure disables saving and the retry button recovers', async () => {
    auth.permissions = ['tenant.site.read', 'tenant.site.manage'];
    auth.request.mockRejectedValueOnce(new Error('连接失败')).mockResolvedValue(runtime);
    show(<PublicDramaPoolPage />);
    await screen.findByText('连接失败');
    expect((screen.getByRole('button', { name: '保存运行配置' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '保存运行配置' }) as HTMLButtonElement).disabled).toBe(false));
    expect(auth.request).toHaveBeenCalledTimes(2);
  });
  it('reject requires a reason and sends the selected drama version', async () => {
    show(<PublicDramaPoolPage />);
    fireEvent.click(await screen.findByRole('button', { name: '拒绝' }));
    fireEvent.click(screen.getByRole('button', { name: '确认拒绝' }));
    await screen.findByText('请填写拒绝原因');
    expect(auth.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    fireEvent.change(screen.getByRole('textbox', { name: /拒绝原因/ }), { target: { value: '内容暂不采用' } });
    fireEvent.click(screen.getByRole('button', { name: '确认拒绝' }));
    await waitFor(() => expect(auth.request).toHaveBeenCalledWith('/api/v1/tenant/public-drama-pool/test-drama/review', expect.objectContaining({ method: 'POST', body: JSON.stringify({ decision: 'rejected', expectedVersion: 0, note: '内容暂不采用' }) })));
  });
  it('cancelling publication clears the abandoned price before opening again', async () => {
    auth.request.mockImplementation(async path => path.endsWith('app-runtime-config') ? runtime : { ...emptyPool, items: [{ ...drama, publicationStatus: 'approved' }] });
    show(<PublicDramaPoolPage />);
    fireEvent.click(await screen.findByRole('button', { name: '配置并上架' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '整剧金币价格' }), { target: { value: '500' } });
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    fireEvent.click(screen.getByRole('button', { name: '配置并上架' }));
    expect((screen.getByRole('spinbutton', { name: '整剧金币价格' }) as HTMLInputElement).value).toBe('');
  });
  it('republishing starts with the tenant saved price and regional restrictions', async () => {
    auth.request.mockResolvedValue({ ...emptyPool, items: [{ ...drama, publicationStatus: 'unpublished',
      dramaPoints: 30, allowedCountries: ['US', 'SG'], blockedCountries: ['CN'] }] });
    show(<PublicDramaPoolPage />);
    fireEvent.click(await screen.findByRole('button', { name: '配置并上架' }));
    expect((screen.getByRole('spinbutton', { name: '整剧金币价格' }) as HTMLInputElement).value).toBe('30');
    expect((screen.getByRole('textbox', { name: '允许国家' }) as HTMLInputElement).value).toBe('US,SG');
    expect((screen.getByRole('textbox', { name: '屏蔽国家' }) as HTMLInputElement).value).toBe('CN');
  });
  it('tenant batch upload offers active shared storage and does not enable upload with no files', async () => {
    auth.request.mockResolvedValue({ items: [{ id: 'shared', label: '公共测试存储', status: 'active', ownerType: 'platform' }, { id: 'disabled', label: '停用存储', status: 'disabled', ownerType: 'tenant' }] });
    show(<BatchEpisodeUploadModal dramaId="qa-drama" scope="tenant" onClose={() => {}} />);
    await screen.findByText('公共测试存储');
    expect(screen.queryByText('停用存储')).toBeNull();
    const upload = screen.getByRole('button', { name: '上传并添加 / 重试未完成' });
    expect((upload as HTMLButtonElement).disabled).toBe(true);
  });
  it('audit details display field values, redact secrets and never execute HTML', async () => {
    auth.request.mockResolvedValue({ page: 1, pageSize: 20, total: 1, items: [{ id: 'log', action: 'test.update', actor: { id: 'qa', type: 'tenant_staff' }, before: { status: 'draft' }, after: { title: '<img src=x onerror=alert(1)>', password: 'secret-canary' }, resource: { id: 'drama', type: 'drama' }, createdAt: '2026-09-07T00:00:00Z', requestId: 'qa-request', scope: 'tenant', tenantId: null }] });
    show(<AuditLogPage apiBase="/audit" allowTenantFilter={false} description="测试" title="审计" />);
    fireEvent.click(await screen.findByRole('button', { name: '详情' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('已隐藏敏感信息')).toBeTruthy();
    expect(within(dialog).queryByText('secret-canary')).toBeNull();
    expect(dialog.querySelector('pre')).toBeNull();
    expect(dialog.querySelector('img[src=x]')).toBeNull();
  });
  it('creating a staff account never preselects the owner role', async () => {
    auth.permissions = ['tenant.staff.read', 'tenant.staff.manage', 'tenant.role.read'];
    auth.request.mockImplementation(async path => path.endsWith('/roles') ? [{ id: 'owner', name: 'tenant_owner', isSystem: true, status: 'active' }] : { items: [], total: 0, page: 1, pageSize: 20 });
    show(<StaffManagementPage apiBase="/staff" accessApiBase="/access" title="员工" readPermission="tenant.staff.read"
      managePermission="tenant.staff.manage" roleReadPermission="tenant.role.read" passwordResetPermission="tenant.staff.password_reset" sessionRevokePermission="tenant.staff.session_revoke" />);
    const create = await screen.findByRole('button', { name: /创建员工$/ });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    await waitFor(() => expect(create.classList.contains('ant-btn-loading')).toBe(false));
    fireEvent.click(create);
    expect((await screen.findByRole('combobox', { name: /单一角色/ }) as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: '确定' }));
    await screen.findByText('请选择员工角色');
    expect(auth.request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });
  it('price currency changes load that currency price and clear an unsaved currency', async () => {
    auth.permissions = ['commerce.catalog.read', 'commerce.catalog.manage'];
    auth.request.mockResolvedValue({ membershipPlans: [{ id: 'plan', code: 'monthly', durationDays: 30, status: 'active', version: 0,
      translations: [{ locale: 'zh-CN', name: '月卡' }], prices: [{ currency: 'USD', amountMinor: 999, status: 'active' }, { currency: 'JPY', amountMinor: 1500, status: 'active' }] }], pointsTopupPackages: [], contentPrices: [], contentPointPrices: [] });
    show(<CommerceCatalogPage />);
    fireEvent.click(await screen.findByRole('button', { name: '设置价格' }));
    expect((screen.getByRole('textbox', { name: '售价' }) as HTMLInputElement).value).toBe('9.99');
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: '币种' }));
    await user.click(screen.getByText('JPY', { selector: '.ant-select-item-option-content' }));
    expect((screen.getByRole('textbox', { name: '售价' }) as HTMLInputElement).value).toBe('1500');
    await user.click(screen.getByRole('combobox', { name: '币种' }));
    await user.click(screen.getByText('EUR', { selector: '.ant-select-item-option-content' }));
    expect((screen.getByRole('textbox', { name: '售价' }) as HTMLInputElement).value).toBe('');
  });
});
