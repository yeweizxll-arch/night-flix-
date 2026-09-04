import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';

import { DatabaseService } from '../database/database.service';
import { PublicEndpoint } from '../auth/public-endpoint.decorator';
import { RedisService } from '../redis/redis.service';
import { resolveApiServiceRole, serviceName } from '../runtime/api-service-role';

@Controller('health')
@PublicEndpoint()
export class HealthController {
  constructor(
    @Inject(DatabaseService)
    private readonly database: DatabaseService,
    @Inject(RedisService)
    private readonly redis: RedisService,
  ) {}

  @Get()
  getLiveness(): { service: string; status: 'ok'; timestamp: string } {
    return {
      service: serviceName(resolveApiServiceRole()),
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }

  @Get('ready')
  async getReadiness(): Promise<{
    checks: { database: 'ok'; redis: 'ok' };
    service: string;
    status: 'ready';
    timestamp: string;
  }> {
    const [databaseReady, redisReady] = await Promise.all([
      this.database.ping(),
      this.redis.ping(),
    ]);
    if (!databaseReady || !redisReady) {
      throw new ServiceUnavailableException({
        checks: {
          database: databaseReady ? 'ok' : 'unavailable',
          redis: redisReady ? 'ok' : 'unavailable',
        },
        code: 'SERVICE_NOT_READY',
        message: 'Database is not ready',
      });
    }

    return {
      checks: { database: 'ok', redis: 'ok' },
      service: serviceName(resolveApiServiceRole()),
      status: 'ready',
      timestamp: new Date().toISOString(),
    };
  }
}
