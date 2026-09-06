import 'reflect-metadata';

import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { resolveTrustProxy } from './runtime/trusted-proxy';

import { AppModule } from './app.module';
import { DatabaseService } from './database/database.service';
import {
  isRouteAllowed,
  resolveApiServiceRole,
} from './runtime/api-service-role';

async function bootstrap(): Promise<void> {
  const serviceRole = resolveApiServiceRole();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: 2 * 1024 * 1024,
      trustProxy: resolveTrustProxy(),
    }),
    { rawBody: true },
  );

  await app.register(fastifyCookie);
  app.getHttpAdapter().getInstance().addHook(
    'onRequest',
    (request, reply, done) => {
      if (!isRouteAllowed(serviceRole, request.url)) {
        void reply.code(404).send({
          code: 'ROUTE_NOT_AVAILABLE_ON_SERVICE',
          message: 'Route is not available on this service',
          statusCode: 404,
        });
        return;
      }
      done();
    },
  );
  await app.get(DatabaseService).validateProductionSecurity();
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(resolvePort(serviceRole), '0.0.0.0');
}

void bootstrap();

function resolvePort(serviceRole: ReturnType<typeof resolveApiServiceRole>): number {
  const defaultPorts = { admin: 3201, agent: 3202, all: 3000, web: 3200 } as const;
  const rawValue = process.env.PORT ?? String(defaultPorts[serviceRole]);
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}
