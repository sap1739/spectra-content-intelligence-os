import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/** Phase 5D: the usage ledger reports measured spend and honest unknowns. */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `usage-owner-${runId}@itest.local`;
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

interface SummaryBody {
  totals: { events: number; requests: number; estimatedCostMicros: number; unpricedEvents: number };
  byKind: Array<{ kind: string; events: number; estimatedCostMicros: number | null }>;
  recent: Array<{ kind: string }>;
  rateVersion: string;
  note: string;
}

describe('API integration: usage ledger', () => {
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
      payload: { email: ownerEmail, password: PASSWORD, name: 'Usage Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    workspaceId = me.workspaces[0]?.id as string;

    // A priced generation event, a priced search event, and an unpriced fetch.
    await prisma.client.usageEvent.createMany({
      data: [
        {
          organizationId: orgId,
          workspaceId,
          kind: 'AI_GENERATION',
          provider: 'anthropic',
          model: 'claude-opus-4-8',
          inputTokens: 1000,
          outputTokens: 100,
          estimatedCostMicros: 7500,
          rateVersion: 'rates-2026-08-31',
        },
        {
          organizationId: orgId,
          workspaceId,
          kind: 'WEB_SEARCH',
          provider: 'brave',
          model: 'web-search',
          requests: 2,
          estimatedCostMicros: 10_000,
          rateVersion: 'rates-2026-08-31',
        },
        {
          organizationId: orgId,
          workspaceId,
          kind: 'PAGE_FETCH',
          provider: 'first-party',
          bytes: 4096,
          estimatedCostMicros: null,
        },
      ],
    });
  });

  afterAll(async () => {
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  it('reports measured totals and counts unpriced events separately', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/usage/summary`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as SummaryBody;

    expect(body.totals.events).toBe(3);
    expect(body.totals.estimatedCostMicros).toBe(17_500);
    // The unpriced fetch is surfaced, not folded into the estimate as zero.
    expect(body.totals.unpricedEvents).toBe(1);
    expect(body.byKind).toHaveLength(3);
    expect(body.rateVersion).toMatch(/^rates-/);
    // The response says plainly that these are estimates.
    expect(body.note).toMatch(/ESTIMATES/);
    expect(body.note).toMatch(/not vendor invoices/i);
  });

  it('scopes usage to the tenant — a fresh workspace reports nothing', async () => {
    const other = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `usage-other-${runId}@itest.local`, password: PASSWORD, name: 'Other' },
    });
    const otherCookie = cookieOf(other.headers['set-cookie']);
    const otherBody = other.json() as MeBody;
    const otherWs = otherBody.workspaces[0]?.id as string;
    const otherOrg = otherBody.memberships[0]?.organizationId as string;

    const res = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${otherWs}/usage/summary`,
      headers: { cookie: otherCookie },
    });
    const body = res.json() as SummaryBody;
    expect(body.totals.events).toBe(0);
    expect(body.totals.estimatedCostMicros).toBe(0);

    await prisma.client.organization.delete({ where: { id: otherOrg } }).catch(() => undefined);
    await prisma.client.user
      .delete({ where: { email: `usage-other-${runId}@itest.local` } })
      .catch(() => undefined);
  });

  it('clamps the window rather than trusting the query string', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${workspaceId}/usage/summary?days=99999`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { windowDays: number }).windowDays).toBe(365);
  });
});
