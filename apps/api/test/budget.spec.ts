import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 5E: per-workspace budgets with pre-flight enforcement.
 * ENFORCE must refuse new paid work with a clear reason; WARN must not.
 */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `budget-owner-${runId}@itest.local`;
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

interface BudgetBody {
  status: string;
  enforcement: string;
  blocked: boolean;
  limitMicros: number | null;
  usedMicros: number;
  unpricedEvents: number;
  reason: string;
}

describe('API integration: workspace budgets', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';
  let workspaceId = '';
  let projectId = '';

  const inject = () => app.getHttpAdapter().getInstance();
  const budgetUrl = () => `/v1/workspaces/${workspaceId}/budget`;
  const runsUrl = () => `/v1/workspaces/${workspaceId}/research-projects/${projectId}/runs`;

  const setBudget = (body: Record<string, unknown>) =>
    inject().inject({ method: 'PUT', url: budgetUrl(), headers: { cookie }, payload: body });

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Budget Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    workspaceId = me.workspaces[0]?.id as string;

    const project = await prisma.client.researchProject.create({
      data: { organizationId: orgId, workspaceId, name: 'Budget project', status: 'ACTIVE' },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  it('reports NOT_CONFIGURED before any budget is set — never a bare OK', async () => {
    const res = await inject().inject({ method: 'GET', url: budgetUrl(), headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BudgetBody;
    // OK would assert a real ceiling was checked; none exists yet.
    expect(body.status).toBe('NOT_CONFIGURED');
    expect(body.blocked).toBe(false);
    expect(body.limitMicros).toBeNull();
    expect(body.reason).toMatch(/No monthly spend limit is configured/);
  });

  it('stores a limit and reports it back', async () => {
    const res = await setBudget({
      monthlyLimitMicros: 1_000_000,
      enforcement: 'ENFORCE',
      warnAtPercent: 80,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as BudgetBody;
    expect(body.limitMicros).toBe(1_000_000);
    expect(body.enforcement).toBe('ENFORCE');
    expect(body.status).toBe('OK');
  });

  it('allows a research run while under the ceiling', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: runsUrl(),
      headers: { cookie },
      payload: { feedUrls: ['https://example.com/feed.xml'] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('refuses a research run with 403 budget-exceeded once over the ceiling', async () => {
    // Real ledger spend beyond the configured limit.
    await prisma.client.usageEvent.create({
      data: {
        organizationId: orgId,
        workspaceId,
        kind: 'WEB_SEARCH',
        provider: 'brave',
        model: 'web-search',
        requests: 1,
        estimatedCostMicros: 5_000_000,
        rateVersion: 'rates-2026-08-31',
      },
    });

    const res = await inject().inject({
      method: 'POST',
      url: runsUrl(),
      headers: { cookie },
      payload: { feedUrls: ['https://example.com/feed.xml'] },
    });
    expect(res.statusCode).toBe(403);
    const problem = res.json() as {
      type: string;
      detail: string;
      // 5E.1: the attached decision is now a PreflightDecision (outcome +
      // exceededReason), which also says WHICH ceiling or limit was hit.
      budget: { outcome: string; blocked: boolean; exceededReason: string };
    };
    // A distinct problem type — not confusable with a permissions failure.
    expect(problem.type).toContain('budget-exceeded');
    expect(problem.detail).toMatch(/reached its monthly limit/);
    expect(problem.budget.outcome).toBe('BLOCK');
    expect(problem.budget.blocked).toBe(true);
    expect(problem.budget.exceededReason).toBe('WORKSPACE_COST_CEILING');
  });

  it('does not create the run row when it refuses (pre-flight, not post-hoc)', async () => {
    const before = await prisma.client.researchRun.count({
      where: { organizationId: orgId, workspaceId },
    });
    await inject().inject({
      method: 'POST',
      url: runsUrl(),
      headers: { cookie },
      payload: { feedUrls: ['https://example.com/feed.xml'] },
    });
    const after = await prisma.client.researchRun.count({
      where: { organizationId: orgId, workspaceId },
    });
    expect(after).toBe(before);
  });

  it('WARN reports the breach but still allows work', async () => {
    await setBudget({ monthlyLimitMicros: 1_000_000, enforcement: 'WARN', warnAtPercent: 80 });
    const status = await inject().inject({
      method: 'GET',
      url: budgetUrl(),
      headers: { cookie },
    });
    const body = status.json() as BudgetBody;
    expect(body.status).toBe('EXCEEDED');
    expect(body.blocked).toBe(false);
    expect(body.reason).toMatch(/enforcement is WARN/);

    const res = await inject().inject({
      method: 'POST',
      url: runsUrl(),
      headers: { cookie },
      payload: { feedUrls: ['https://example.com/feed.xml'] },
    });
    expect(res.statusCode).toBe(201);
  });

  it('clearing the limit returns to NOT_CONFIGURED and unblocks', async () => {
    await setBudget({ monthlyLimitMicros: null, enforcement: 'ENFORCE', warnAtPercent: 80 });
    const res = await inject().inject({ method: 'GET', url: budgetUrl(), headers: { cookie } });
    const body = res.json() as BudgetBody;
    expect(body.status).toBe('NOT_CONFIGURED');
    expect(body.blocked).toBe(false);
  });

  it('rejects an invalid enforcement mode with 422', async () => {
    const res = await setBudget({ monthlyLimitMicros: 1000, enforcement: 'NOPE' });
    expect(res.statusCode).toBe(422);
  });

  it('scopes budgets to the tenant', async () => {
    const other = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `budget-other-${runId}@itest.local`, password: PASSWORD, name: 'Other' },
    });
    const otherCookie = cookieOf(other.headers['set-cookie']);
    const otherBody = other.json() as MeBody;
    const otherWs = otherBody.workspaces[0]?.id as string;
    const otherOrg = otherBody.memberships[0]?.organizationId as string;

    // This workspace has its own (absent) budget, unaffected by the first org.
    const res = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${otherWs}/budget`,
      headers: { cookie: otherCookie },
    });
    expect((res.json() as BudgetBody).status).toBe('NOT_CONFIGURED');

    // And a foreign workspace id is not readable with our cookie.
    const foreign = await inject().inject({
      method: 'GET',
      url: `/v1/workspaces/${otherWs}/budget`,
      headers: { cookie },
    });
    expect([403, 404]).toContain(foreign.statusCode);

    await prisma.client.organization.delete({ where: { id: otherOrg } }).catch(() => undefined);
    await prisma.client.user
      .delete({ where: { email: `budget-other-${runId}@itest.local` } })
      .catch(() => undefined);
  });
});
