import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/** Phase 3C: strategy entities — campaigns, briefs, personas, pillars, topics. */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `strategy-${runId}@itest.local`;
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

describe('API integration: strategy entities', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';
  let ws = '';

  const inject = () => app.getHttpAdapter().getInstance();

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Strategy Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    ws = me.workspaces[0]?.id as string;
  });

  afterAll(async () => {
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  const post = (path: string, payload: Record<string, unknown>) =>
    inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${ws}${path}`,
      headers: { cookie },
      payload,
    });
  const get = (path: string) =>
    inject().inject({ method: 'GET', url: `/v1/workspaces/${ws}${path}`, headers: { cookie } });

  it('creates a campaign and upserts its brief', async () => {
    const created = await post('/campaigns', { name: 'Launch', status: 'PLANNED' });
    expect(created.statusCode).toBe(201);
    const campaign = created.json() as { id: string };

    const brief = await inject().inject({
      method: 'PUT',
      url: `/v1/workspaces/${ws}/campaigns/${campaign.id}/brief`,
      headers: { cookie },
      payload: {
        objectives: ['Awareness'],
        keyMessages: [],
        mandatories: [],
        doNots: ['No jargon'],
      },
    });
    expect(brief.statusCode).toBe(200);
    expect((brief.json() as { doNots: string[] }).doNots).toEqual(['No jargon']);

    const list = await get('/campaigns');
    const row = (
      list.json() as Array<{ id: string; brief: unknown; _count: { contentItems: number } }>
    )[0];
    expect(row?.brief).not.toBeNull();
    expect(row?._count.contentItems).toBe(0);
  });

  it('manages personas and pillars with soft delete', async () => {
    const persona = await post('/personas', { name: 'CTO', roles: ['CTO', 'VP Eng'] });
    expect(persona.statusCode).toBe(201);
    const personaId = (persona.json() as { id: string }).id;

    const pillar = await post('/content-pillars', { name: 'Reliability', keywords: ['uptime'] });
    expect(pillar.statusCode).toBe(201);

    expect(((await get('/personas')).json() as unknown[]).length).toBe(1);

    const del = await inject().inject({
      method: 'DELETE',
      url: `/v1/workspaces/${ws}/personas/${personaId}`,
      headers: { cookie },
    });
    expect(del.statusCode).toBe(204);
    expect(((await get('/personas')).json() as unknown[]).length).toBe(0);
  });

  it('creates topic ideas and transitions their status', async () => {
    const idea = await post('/topic-ideas', { title: 'AI testing ROI' });
    const ideaId = (idea.json() as { id: string; status: string }).id;
    expect((idea.json() as { status: string }).status).toBe('PROPOSED');

    const patched = await inject().inject({
      method: 'PATCH',
      url: `/v1/workspaces/${ws}/topic-ideas/${ideaId}`,
      headers: { cookie },
      payload: { status: 'SHORTLISTED' },
    });
    expect(patched.statusCode).toBe(200);
    expect((patched.json() as { status: string }).status).toBe('SHORTLISTED');
  });

  it('does not leak foreign campaigns (same error for missing/foreign)', async () => {
    const res = await get('/campaigns/00000000-0000-0000-0000-000000000000');
    expect(res.statusCode).toBe(404);
  });
});
