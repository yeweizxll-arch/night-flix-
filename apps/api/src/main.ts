import 'reflect-metadata';

import fastifyCookie from '@fastify/cookie';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyServerOptions } from 'fastify';

import { AppModule } from './app.module';
import { DatabaseService } from './database/database.service';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: 2 * 1024 * 1024,
      trustProxy: resolveTrustProxy(),
    }),
    { rawBody: true },
  );

  await app.register(fastifyCookie);
  await app.get(DatabaseService).validateProductionSecurity();
  app.setGlobalPrefix('api/v1');
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3000), '0.0.0.0');
}

void bootstrap();

function resolveTrustProxy(): FastifyServerOptions['trustProxy'] {
  const rawValue = process.env.TRUST_PROXY?.trim();
  if (!rawValue || rawValue === 'false') {
    return false;
  }
  if (rawValue === 'true') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('TRUST_PROXY=true is not allowed in production; configure trusted hops or CIDRs');
    }
    return true;
  }
  if (/^[1-9]\d?$/.test(rawValue)) {
    return Number(rawValue);
  }
  return rawValue.split(',').map((value) => value.trim()).filter(Boolean);
}
