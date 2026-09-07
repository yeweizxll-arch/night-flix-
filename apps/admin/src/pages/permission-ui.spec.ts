import { permissionCatalog } from '@drama/contracts';
import { describe, expect, it } from 'vitest';
import { permissionName, roleName } from './permission-ui';
describe('operator permission names', () => {
  it('covers every shipped permission without showing internal identifiers', () => {
    for (const permission of permissionCatalog) {
      expect(permissionName(permission.code).replace('App', '')).not.toMatch(/[a-z_]/i);
    }
  });
  it('retains custom names and translates system roles', () => {
    expect(roleName('tenant_owner')).toBe('代理商负责人');
    expect(roleName('客服主管')).toBe('客服主管');
  });
});
