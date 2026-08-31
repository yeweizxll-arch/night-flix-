import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';

import type { AccessControlledRequest, AccessPrincipal } from './access-control.types';

export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AccessPrincipal => {
    const request = context.switchToHttp().getRequest<AccessControlledRequest>();
    if (!request.principal || typeof request.principal !== 'object') {
      throw new UnauthorizedException('Authentication is required');
    }
    return request.principal as AccessPrincipal;
  },
);

