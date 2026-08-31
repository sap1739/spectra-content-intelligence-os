import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 5C: a run plan may carry feed URLs, search queries, or both — but never
 * neither. The plan is persisted verbatim so the worker discovers exactly what
 * the operator asked for.
 */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `disco-owner-${runId}@itest.local`;
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

describe('API integration: research discovery plans', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';
  let workspaceId = '';
  let projectId = '';

  const inject = () => app.getHttpAdapter().getInstance();
  const runsUrl = () => `/v1/workspaces/${workspaceId}/research-projects/${projectId}/runs`;

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Disco Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    workspaceId = me.workspaces[0]?.id as string;

    const project = await prisma.client.researchProject.create({
      data: { organizationId: orgId, workspaceId, name: 'Discovery project', status: 'ACTIVE' },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  it('accepts a search-only plan and persists the queries', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: runsUrl(),
      headers: { cookie },
      payload: { searchQueries: ['enterprise AI testing adoption'] },
    });
    expect(res.statusCode).toBe(201);

    const created = await prisma.client.researchRun.findUnique({
      where: { id: (res.json() as { id: string }).id },
    });
    const plan = created?.queryPlan as { feedUrls: string[]; searchQueries: string[] };
    expect(plan.searchQueries).toEqual(['enterprise AI testing adoption']);
    expect(plan.feedUrls).toEqual([]);
  });

  it('accepts feeds and queries together', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: runsUrl(),
      headers: { cookie },
      payload: {
        feedUrls: ['https://example.com/feed.xml'],
        searchQueries: ['LLM evaluation benchmarks'],
      },
    });
    expect(res.statusCode).toBe(201);
    const created = await prisma.client.researchRun.findUnique({
      where: { id: (res.json() as { id: string }).id },
    });
    const plan = created?.queryPlan as { feedUrls: string[]; searchQueries: string[] };
    expect(plan.feedUrls).toHaveLength(1);
    expect(plan.searchQueries).toHaveLength(1);
  });

  it('still accepts a feeds-only plan (unchanged behaviour)', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: runsUrl(),
      headers: { cookie },
      payload: { feedUrls: ['https://example.com/feed.xml'] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a plan with neither feeds nor queries', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: runsUrl(),
      headers: { cookie },
      payload: { feedUrls: [], searchQueries: [] },
    });
    // 422 is this API's validation convention (problem+json).
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('at least one feed URL or search query');
  });

  it('rejects an empty body outright', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: runsUrl(),
      headers: { cookie },
      payload: {},
    });
    expect(res.statusCode).toBe(422);
  });
});
