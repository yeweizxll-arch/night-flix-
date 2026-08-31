import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { TenantContextService } from './tenant-context.service';
import { TenantDirectoryService } from './tenant-directory.service';

@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(
    @Inject(TenantContextService)
    private readonly context: TenantContextService,
    @Inject(TenantDirectoryService)
    private readonly directory: TenantDirectoryService,
  ) {}

  async use(
    request: FastifyRequest['raw'],
    _reply: FastifyReply['raw'],
    next: (error?: unknown) => void,
  ): Promise<void> {
    const host = request.headers.host ?? '';
    try {
      const tenant = await this.directory.resolveVerifiedHost(host);
      this.context.run(
        {
          host,
          tenantId: tenant?.id,
          tenantStatus: tenant?.status,
        },
        next,
      );
    } catch (error) {
      next(error);
    }
  }
}
