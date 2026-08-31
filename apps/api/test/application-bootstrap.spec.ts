import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { AppModule } from '../src/app.module';

describe('application dependency graph', () => {
  let app: NestFastifyApplication | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('initializes the real Nest application with all runtime dependencies', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(
      new FastifyAdapter(),
    );
    app.setGlobalPrefix('api/v1');

    await expect(app.init()).resolves.toBeDefined();

    const server = app.getHttpAdapter().getInstance();
    const liveness = await server.inject({
      method: 'GET',
      url: '/api/v1/health',
    });
    expect(liveness.statusCode).toBe(200);
    expect(liveness.json()).toMatchObject({
      service: 'drama-saas-api',
      status: 'ok',
    });

    const readiness = await server.inject({
      method: 'GET',
      url: '/api/v1/health/ready',
    });
    expect(readiness.statusCode).toBe(503);
    expect(readiness.json()).toMatchObject({
      checks: { database: 'unavailable', redis: 'unavailable' },
      code: 'SERVICE_NOT_READY',
    });
  });
});
