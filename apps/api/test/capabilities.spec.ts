import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 5B: the deployment must report honestly which env-gated integrations
 * are live. The test env configures none of them, so every one must report
 * unavailable — and say so in words a human can act on.
 */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `caps-owner-${runId}@itest.local`;
const PASSWORD = 'integration-test-password-1';

interface MeBody {
  memberships: Array<{ organizationId: string }>;
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('expected a set-cookie header');
  return raw.split(';')[0] as string;
}

describe('API integration: honest capability reporting', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';

  const inject = () => app.getHttpAdapter().getInstance();

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Caps Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    orgId = (register.json() as MeBody).memberships[0]?.organizationId as string;
  });

  afterAll(async () => {
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  it('requires authentication — config state is not public', async () => {
    const res = await inject().inject({ method: 'GET', url: '/v1/meta/capabilities' });
    expect(res.statusCode).toBe(401);
  });

  it('reports every unconfigured integration as unavailable, with actionable notes', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: '/v1/meta/capabilities',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      generation: { configured: boolean };
      retrieval: { semantic: boolean; note: string; collection: string };
      discovery: { liveSearchConfigured: boolean; providers: unknown[]; note: string };
      credentialStorage: { configured: boolean; note: string };
    };

    // Nothing is configured in the test environment — and it says so.
    expect(body.generation.configured).toBe(false);
    expect(body.discovery.liveSearchConfigured).toBe(false);
    expect(body.credentialStorage.configured).toBe(false);

    // Retrieval falls back to lexical and states the real limitation.
    expect(body.retrieval.semantic).toBe(false);
    expect(body.retrieval.collection).toBe('lexical-hash-256-v1');
    expect(body.retrieval.note).toMatch(/not meaning/);

    // An unconfigured provider is not merely inactive — it is absent.
    expect(body.discovery.providers).toEqual([]);
    expect(body.discovery.note).toMatch(/no result is invented/i);
    expect(body.credentialStorage.note).toMatch(/UNSUPPORTED/);
  });

  it('never leaks a secret VALUE through the capability surface', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: '/v1/meta/capabilities',
      headers: { cookie },
    });
    const raw = res.body;
    // Naming an env var is actionable guidance, not a leak — but no VALUE may
    // appear: no assignment, no vendor-shaped token, no long opaque secret.
    expect(raw).not.toMatch(/[A-Z_]*(?:API_KEY|TOKEN|SECRET)[A-Z_]*\s*[=:]\s*['"]?[\w-]{8,}/);
    expect(raw).not.toMatch(/sk-ant-[\w-]+|Bearer\s+[\w-]{8,}/i);
    // Any real key from this process's env must be absent from the response.
    for (const name of [
      'ANTHROPIC_API_KEY',
      'VOYAGE_API_KEY',
      'BRAVE_SEARCH_API_KEY',
      'SOCIAL_TOKEN_ENCRYPTION_KEY',
    ]) {
      const value = process.env[name];
      if (value && value.length >= 8) expect(raw).not.toContain(value);
    }
  });

  it('still serves public version metadata without auth', async () => {
    const res = await inject().inject({ method: 'GET', url: '/v1/meta/version' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { phase: number }).phase).toBe(5);
  });
});
