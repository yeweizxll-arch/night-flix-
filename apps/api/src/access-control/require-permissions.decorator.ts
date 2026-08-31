import { applyDecorators, SetMetadata } from '@nestjs/common';

import { PUBLIC_ENDPOINT_METADATA } from '../auth/public-endpoint.decorator';
import {
  ACCESS_MODES,
  ACCESS_SCOPES,
  type AccessRequirement,
} from './access-control.types';

export const ACCESS_REQUIREMENT_METADATA = Symbol(
  'drama.access-control.requirement',
);

/**
 * Declares the complete access policy for a controller or handler.
 *
 * Every guarded handler must declare a non-empty permission list. Missing or
 * malformed metadata is denied by AccessControlGuard.
 */
export function RequirePermissions(
  requirement: AccessRequirement,
): ClassDecorator & MethodDecorator {
  if (!ACCESS_SCOPES.includes(requirement.scope)) {
    throw new TypeError('Access scope must be platform or tenant');
  }

  if (!ACCESS_MODES.includes(requirement.mode)) {
    throw new TypeError('Access mode must be read or write');
  }

  if (
    requirement.permissions.length === 0 ||
    requirement.permissions.some(
      (permission) =>
        typeof permission !== 'string' || permission.trim().length === 0,
    )
  ) {
    throw new TypeError('At least one non-empty permission is required');
  }

  const permissions = Object.freeze(
    [...new Set(requirement.permissions.map((permission) => permission.trim()))],
  );
  const metadata = Object.freeze({
    scope: requirement.scope,
    mode: requirement.mode,
    permissions,
  }) satisfies AccessRequirement;

  return applyDecorators(
    // A concrete access policy must always override inherited/class-level
    // public metadata. This prevents a protected handler from becoming public
    // merely because it is added to a public controller later.
    SetMetadata(PUBLIC_ENDPOINT_METADATA, false),
    SetMetadata(ACCESS_REQUIREMENT_METADATA, metadata),
  );
}
