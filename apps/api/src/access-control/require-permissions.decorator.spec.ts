import { describe, expect, it } from 'vitest';

import type {
  AccessMode,
  AccessRequirement,
  AccessScope,
} from './access-control.types';
import {
  ACCESS_REQUIREMENT_METADATA,
  RequirePermissions,
} from './require-permissions.decorator';

describe('RequirePermissions', () => {
  it('stores immutable, normalized permission metadata', () => {
    const suppliedPermissions = [' drama.read ', 'drama.read', 'episode.read'];

    class Controller {
      @RequirePermissions({
        scope: 'tenant',
        mode: 'read',
        permissions: suppliedPermissions,
      })
      list(): void {}
    }

    suppliedPermissions.push('injected.permission');

    const metadata = Reflect.getMetadata(
      ACCESS_REQUIREMENT_METADATA,
      Controller.prototype.list,
    ) as AccessRequirement;

    expect(metadata).toEqual({
      scope: 'tenant',
      mode: 'read',
      permissions: ['drama.read', 'episode.read'],
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.permissions)).toBe(true);
  });

  it.each([
    {
      scope: 'invalid' as AccessScope,
      mode: 'read' as const,
      permissions: ['drama.read'],
    },
    {
      scope: 'tenant' as const,
      mode: 'invalid' as AccessMode,
      permissions: ['drama.read'],
    },
    { scope: 'tenant' as const, mode: 'read' as const, permissions: [] },
    { scope: 'tenant' as const, mode: 'read' as const, permissions: [' '] },
  ])('rejects invalid policy metadata %#', (requirement) => {
    expect(() => RequirePermissions(requirement)).toThrow(TypeError);
  });
});
