import { describe, expect, it } from 'vitest';
import { auditActionLabel, auditResourceLabel, snapshotRows } from './audit-snapshot-ui';
describe('readable audit snapshots', () => {
  it('uses operational labels for audit actions while keeping unknown types explicit', () => {
    expect(auditActionLabel('commerce.withdrawal.cancel', 'withdrawal')).toBe('提现申请 · 撤回');
    expect(auditActionLabel('unknown.code', 'unknown')).toBe('其他操作');
    expect(auditResourceLabel('auth_session')).toBe('登录会话');
    expect(snapshotRows({ statusChanged: true })[0]?.field).toBe('状态已变更');
  });
  it('renders named fields, states and lists without JSON syntax', () => {
    expect(snapshotRows({ status: 'active', enabled: false, translations: [{ title: '测试剧' }] }).map(row => [row.field, row.value])).toEqual([
      ['状态', '启用'], ['启用', '否'], ['多语言 / 第 1 项 / 标题', '测试剧'],
    ]);
  });
  it('handles absent values and already redacted data', () => {
    expect(snapshotRows(null)[0]?.value).toBe('未设置');
    expect(snapshotRows({ secret: '[REDACTED]' })[0]?.value).toBe('已隐藏敏感信息');
  });
  it('bounds large data', () => { expect(snapshotRows(Array(1000).fill('x'))).toHaveLength(201); });
});
