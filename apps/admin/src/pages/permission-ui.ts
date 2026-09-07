const resources: Record<string, string> = {
  dashboard: '工作台', analytics: '经营统计', merchant: '代理商', domain: '域名', staff: '员工',
  customer: '用户', role: '角色', audit: '审计日志', storage: '对象存储', app_build: '应用构建',
  content: '公共内容', payment: '支付配置', license: '内容授权', withdrawal: '提现',
  payout_account: '收款账户', settlement: '结算', refund: '退款', site: '站点与 App',
  interaction: '社区内容', sensitive_word: '敏感词', drama: '短剧', catalog: '商品', order: '订单',
  balance: '余额', referral: '分销', legal: '法律文档', privacy_request: '隐私请求',
  communication: '邮件短信', push: '推送', notification: '通知', config: '推送渠道', campaign: '群发活动',
};
export const permissionActions: Record<string, string> = {
  approve: '通过', confirm_transfer: '确认打款', create: '创建', export: '导出', manage: '管理',
  payout_account_read: '查看收款账户', read: '查看', reject: '驳回', review: '审核', status: '启停',
  submit: '提交', update: '修改', password_reset: '重置密码', session_revoke: '强制下线',
  download: '下载', publish: '发布', sensitive_word_manage: '管理敏感词', submit_review: '上架与审核',
  privacy_request_read: '查看隐私请求', send: '发送', config_manage: '管理渠道', campaign_manage: '管理活动',
};
export function permissionName(code: string): string {
  const parts = code.split('.');
  const action = parts.pop() ?? '';
  const resource = parts.pop() ?? '';
  return `${resources[resource] ?? resource} · ${permissionActions[action] ?? action}`;
}
export function roleName(name: string): string {
  return ({ platform_super_admin: '总部超级管理员', platform_admin: '总部管理员', tenant_owner: '代理商负责人',
    tenant_admin: '代理商管理员', tenant_operator: '运营人员' } as Record<string, string>)[name] ?? name;
}
