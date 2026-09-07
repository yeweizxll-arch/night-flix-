const labels: Record<string, string> = {
  id: '编号', tenantId: '代理商', name: '名称', title: '标题', code: '业务编号', status: '状态',
  version: '版本', enabled: '启用', description: '说明', reason: '原因', note: '备注',
  createdAt: '创建时间', updatedAt: '更新时间', deletedAt: '删除时间', expiresAt: '到期时间',
  username: '账号', email: '邮箱', phone: '手机号', displayName: '显示名称', locale: '语言',
  permissions: '权限', roleIds: '角色', translations: '多语言', expectedVersion: '操作前版本',
  dramaId: '短剧', episodeId: '剧集', episodeNo: '集数', durationSeconds: '时长（秒）',
  amountMinor: '金额（最小货币单位）', currency: '币种', pointsAmount: '金币数量',
  releaseAt: '发布时间', unpublishAt: '下架时间', totalEpisodes: '总集数', sourceType: '来源',
  supportedLocales: '支持语言', allowedCountries: '允许国家', blockedCountries: '屏蔽国家',
  theme: '主题', primaryColor: '主色', accentColor: '强调色', colorMode: '色彩模式',
  statusChanged: '状态已变更', permissionsChanged: '权限已变更', credentialsChanged: '凭据已变更',
};

const resourceLabels: Record<string, string> = {
  withdrawal: '提现申请', storage_provider: '对象存储', auth_session: '登录会话',
  interaction_comment: '评论', interaction_report: '举报', interaction_bullet_comment: '弹幕',
  customer_feedback: '用户反馈', customer_account: '用户账号', customer_device: '登录设备',
  tenant: '代理商', role: '角色', platform_staff: '总部员工', tenant_staff: '代理商员工',
  drama: '短剧', episode: '剧集', order: '订单', refund: '退款', payment_config: '支付配置',
  category: '分类', tag: '标签', media_asset: '媒体文件', content_license: '内容授权',
};
const actionLabels: Record<string, string> = {
  create: '创建', update: '修改', delete: '删除', restore: '恢复', status: '变更状态',
  cancel: '撤回', submit: '提交', approve: '通过', reject: '拒绝', resolve: '处理完成',
  dismiss: '驳回', hide: '隐藏', publish: '发布', unpublish: '下架', reply: '回复',
  login: '登录', logout: '退出', refresh: '续期', revoke: '撤销', reset_password: '重置密码',
  replace_permissions: '修改权限', assign_roles: '分配角色', enable: '启用', disable: '停用',
};

export function auditResourceLabel(type: string): string { return resourceLabels[type] ?? '其他资源'; }
export function auditActionLabel(action: string, resourceType: string): string {
  const verb = actionLabels[action.split('.').at(-1) ?? ''];
  return verb ? `${auditResourceLabel(resourceType)} · ${verb}` : '其他操作';
}
const values: Record<string, string> = {
  active: '启用', disabled: '停用', draft: '草稿', published: '已发布', unpublished: '已下架',
  approved: '已通过', rejected: '已拒绝', pending: '待处理', pending_review: '待审核',
  '[REDACTED]': '已隐藏敏感信息', '[TRUNCATED]': '内容过长，已省略',
};

export function snapshotRows(value: unknown): { key: string; field: string; value: string }[] {
  const rows: { key: string; field: string; value: string }[] = [];
  function visit(child: unknown, path: string, depth: number): void {
    if (rows.length >= 200) return;
    if (depth > 10) { rows.push({ key: path, field: path, value: '内容层级过深，已省略' }); return; }
    if (child && typeof child === 'object' && Object.keys(child).length) {
      for (const [key, entry] of Object.entries(child)) {
        const label = Array.isArray(child) ? `第 ${Number(key) + 1} 项` : labels[key] ?? key;
        visit(entry, path ? `${path} / ${label}` : label, depth + 1);
      }
    } else {
      const text = child == null ? '未设置' : typeof child === 'boolean' ? (child ? '是' : '否')
        : typeof child === 'object' ? '无内容' : String(child);
      rows.push({ key: `${path}-${rows.length}`, field: path || '内容', value: values[text] ?? text });
    }
  }
  visit(value, '', 0);
  if (rows.length >= 200) rows.push({ key: 'truncated', field: '提示', value: '仅显示前 200 项变更' });
  return rows;
}
