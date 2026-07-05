import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';

/**
 * Integration tests boot the real application (middleware, filters, routing)
 * and exercise it via fastify inject — no network socket required.
 * They pass with or without live Postgres/Redis: readiness reflects reality.
 */
describe('API integration: health & platform behaviour', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('GET /health returns liveness without touching dependencies', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/health',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.timestamp).toMatch(/Z$/);
  });

  it('GET /health/ready reports component statuses consistently', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/health/ready',
    });
    const body = response.json();
    const names = (body.components as Array<{ name: string }>).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(['postgres', 'redis', 'worker-heartbeat']));
    if (body.status === 'down') {
      expect(response.statusCode).toBe(503);
    } else {
      expect(response.statusCode).toBe(200);
      expect(['up', 'degraded']).toContain(body.status);
    }
  });

  it('echoes inbound correlation ids and generates one when absent', async () => {
    const fastify = app.getHttpAdapter().getInstance();

    const withHeader = await fastify.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-correlation-id': 'test-corr-123' },
    });
    expect(withHeader.headers['x-correlation-id']).toBe('test-corr-123');

    const withoutHeader = await fastify.inject({ method: 'GET', url: '/health' });
    expect(withoutHeader.headers['x-correlation-id']).toBeTruthy();
    expect(withoutHeader.headers['x-correlation-id']).not.toBe('test-corr-123');
  });

  it('GET /v1/meta/version exposes versioned metadata', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/v1/meta/version',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ name: 'spectra-api', phase: 1 });
  });

  it('returns problem+json for unknown routes', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/v1/does-not-exist',
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = response.json();
    expect(body.status).toBe(404);
    expect(body.title).toBeTruthy();
  });

  it('serves OpenAPI documentation', async () => {
    const response = await app.getHttpAdapter().getInstance().inject({
      method: 'GET',
      url: '/docs',
    });
    expect([200, 302]).toContain(response.statusCode);
  });
});
