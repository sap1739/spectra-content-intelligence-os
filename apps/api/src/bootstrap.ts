import 'reflect-metadata';

import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CORRELATION_HEADER, generateCorrelationId } from '@spectra/observability';
import type { ApiEnv } from '@spectra/config';

import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/http-exception.filter';

/**
 * Builds the fully configured Nest application. Shared between main.ts and
 * integration tests so tests exercise the real middleware stack.
 */
export async function createApp(env: ApiEnv): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: false, trustProxy: true }),
    { logger: ['error', 'warn', 'log'] },
  );

  const fastify = app.getHttpAdapter().getInstance();

  // Correlation IDs: accept inbound header or generate; always echo back.
  fastify.addHook('onRequest', async (request, reply) => {
    const inbound = request.headers[CORRELATION_HEADER];
    const correlationId =
      typeof inbound === 'string' && inbound.length > 0 && inbound.length <= 128
        ? inbound
        : generateCorrelationId();
    request.headers[CORRELATION_HEADER] = correlationId;
    reply.header(CORRELATION_HEADER, correlationId);
  });

  await fastify.register(helmet, {
    contentSecurityPolicy: false, // API serves JSON; CSP applies to the web app.
  });

  // Rate-limit integration point: per-IP defaults now, per-tenant keys later.
  await fastify.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
  });

  app.enableCors({
    origin: env.API_CORS_ORIGIN,
    credentials: true,
    exposedHeaders: [CORRELATION_HEADER],
  });

  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalFilters(new GlobalExceptionFilter());
  app.enableShutdownHooks();

  const openApiConfig = new DocumentBuilder()
    .setTitle('SpectraContent Intelligence OS API')
    .setDescription(
      'Phase 1 foundation API. Domain endpoints (research, trends, content) arrive in Phase 2.',
    )
    .setVersion('0.1.0')
    .build();
  const document = SwaggerModule.createDocument(app, openApiConfig);
  SwaggerModule.setup('docs', app, document);

  return app;
}
