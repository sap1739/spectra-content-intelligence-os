import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 4A publishing foundation. The test env has no SOCIAL_TOKEN_ENCRYPTION_KEY,
 * so storing a credential is honestly unavailable (503). No platform is wired,
 * so every target stays PENDING and no post is ever claimed to go out.
 */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `social-owner-${runId}@itest.local`;
const PASSWORD = 'integration-test-password-1';

interface MeBody {
  memberships: Array<{ organizationId: string }>;
  workspaces: Array<{ id: string }>;
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('expected a set-cookie header');
  return raw.split(';')[0] as string;
}

describe('API integration: social accounts, capabilities, honest publishing foundation', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';
  let workspaceId = '';

  const inject = () => app.getHttpAdapter().getInstance();

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Social Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    workspaceId = me.workspaces[0]?.id as string;
  });

  afterAll(async () => {
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  it('reports declared capabilities: only WordPress is wired, no credential storage', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social/platforms`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      credentialStorageConfigured: boolean;
      platforms: Array<{ capability: { platform: string }; publisherWired: boolean }>;
    };
    expect(body.credentialStorageConfigured).toBe(false);
    expect(body.platforms.length).toBe(10);
    // WordPress is the one live adapter; every other platform is honestly unwired.
    const wired = body.platforms.filter((p) => p.publisherWired).map((p) => p.capability.platform);
    expect(wired).toEqual(['WORDPRESS']);
  });

  it('validates content against a platform’s declared limits', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/social/validate`,
      headers: { cookie },
      payload: { platform: 'X', text: 'a'.repeat(300) },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { ok: boolean; issues: Array<{ code: string }> };
    expect(body.ok).toBe(false);
    expect(body.issues.map((i) => i.code)).toContain('MAX_CHARACTERS');
  });

  it('registers a target as PENDING and never returns a sealed credential', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
      payload: {
        platform: 'LINKEDIN',
        displayName: 'Acme on LinkedIn',
        externalAccountId: 'acme',
        kind: 'PAGE',
      },
    });
    expect(res.statusCode).toBe(201);
    const acct = res.json() as Record<string, unknown>;
    expect(acct.status).toBe('PENDING');
    expect(acct).not.toHaveProperty('encryptedToken');

    const list = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
    });
    const rows = list.json() as Array<Record<string, unknown>>;
    expect(rows.length).toBe(1);
    expect(rows.every((r) => !('encryptedToken' in r))).toBe(true);
  });

  it('refuses to store a credential when the encryption key is not configured (503)', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
      payload: {
        platform: 'X',
        displayName: 'Acme on X',
        externalAccountId: '@acme',
        accessToken: 'super-secret-token',
      },
    });
    expect(res.statusCode).toBe(503);
  });

  it('never leaks a sealed credential even when one exists in the row', async () => {
    // Seed a row that DOES carry a sealed credential, bypassing the API.
    const seeded = await prisma.client.socialAccount.create({
      data: {
        organizationId: orgId,
        workspaceId,
        platform: 'WORDPRESS',
        externalAccountId: 'https://blog.example.com',
        displayName: 'Blog',
        encryptedToken: 'v1.social-v1.aaaa.bbbb.cccc',
        tokenRef: 'ref-123',
      },
    });
    const list = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
    });
    const rows = list.json() as Array<Record<string, unknown>>;
    const wp = rows.find((r) => r.id === seeded.id);
    expect(wp).toBeDefined();
    expect(wp).not.toHaveProperty('encryptedToken');
    expect(JSON.stringify(rows)).not.toContain('v1.social-v1');
  });

  it('disconnects a target and does not leak foreign accounts', async () => {
    const created = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${workspaceId}/social-accounts`,
      headers: { cookie },
      payload: { platform: 'THREADS', displayName: 'Threads', externalAccountId: '@t' },
    });
    const id = (created.json() as { id: string }).id;

    const removed = await inject().inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/social-accounts/${id}`,
      headers: { cookie },
    });
    expect(removed.statusCode).toBe(204);

    // Missing/foreign → identical 404 (no existence leak).
    const foreign = await inject().inject({
      method: 'DELETE',
      url: `/v1/workspaces/${workspaceId}/social-accounts/00000000-0000-0000-0000-000000000000`,
      headers: { cookie },
    });
    expect(foreign.statusCode).toBe(404);
  });
});
