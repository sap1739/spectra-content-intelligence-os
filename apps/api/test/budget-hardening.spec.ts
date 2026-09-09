import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 5E.1 budget hardening (ADR-0028): per-kind limits, organization
 * ceilings, pre-flight simulation, the unpriced report, and the embedding
 * guards that previously did not exist.
 */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `harden-owner-${runId}@itest.local`;
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

describe('API integration: budget hardening', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';
  let workspaceId = '';

  const inject = () => app.getHttpAdapter().getInstance();
  const ws = () => `/v1/workspaces/${workspaceId}`;
  const org = () => `/v1/organizations/${orgId}`;

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Harden Owner' },
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

  // ---- pre-flight simulation ---------------------------------------------

  it('simulates ALLOW when nothing is configured', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/budget/preflight`,
      headers: { cookie },
      payload: { kind: 'AI_GENERATION', provider: 'anthropic', model: 'claude-opus-4-8' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { outcome: string; blocked: boolean };
    expect(body.outcome).toBe('ALLOW');
    expect(body.blocked).toBe(false);
  });

  it('simulates UNKNOWN_COST_ALLOW_WITH_NOTICE for an unpriceable provider', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/budget/preflight`,
      headers: { cookie },
      payload: { kind: 'AI_GENERATION', provider: 'mystery-vendor', model: 'm1' },
    });
    const body = res.json() as { outcome: string; unpricedReason: string; unpricedNotice: string };
    // Never silently treated as free.
    expect(body.outcome).toBe('UNKNOWN_COST_ALLOW_WITH_NOTICE');
    expect(body.unpricedReason).toBe('NO_RATE_FOR_MODEL');
    expect(body.unpricedNotice).toBeTruthy();
  });

  // ---- per-kind limits ----------------------------------------------------

  it('stores and reports per-operation limits', async () => {
    const put = await inject().inject({
      method: 'PUT',
      url: `${ws()}/budget/operations`,
      headers: { cookie },
      payload: { limits: [{ kind: 'WEB_SEARCH', maxRequests: 3, maxTokens: null }] },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as {
      kinds: Array<{ kind: string; workspaceMaxRequests: number | null }>;
    };
    const web = body.kinds.find((k) => k.kind === 'WEB_SEARCH');
    expect(web?.workspaceMaxRequests).toBe(3);
    // Every kind is reported, not just the configured one.
    expect(body.kinds.length).toBeGreaterThanOrEqual(10);
  });

  it('BLOCKs an operation once its per-kind request limit is reached', async () => {
    await prisma.client.usageEvent.createMany({
      data: Array.from({ length: 3 }, () => ({
        organizationId: orgId,
        workspaceId,
        kind: 'WEB_SEARCH' as const,
        provider: 'brave',
        model: 'web-search',
        requests: 1,
        estimatedCostMicros: 5000,
        rateVersion: 'rates-2026-09-09',
        rateSource: 'EXACT' as const,
      })),
    });

    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/budget/preflight`,
      headers: { cookie },
      payload: { kind: 'WEB_SEARCH', provider: 'brave', model: 'web-search' },
    });
    const body = res.json() as { outcome: string; exceededReason: string };
    expect(body.outcome).toBe('BLOCK');
    expect(body.exceededReason).toBe('WORKSPACE_OPERATION_LIMIT');
  });

  it('reports unmeasured token quantities separately from measured zero', async () => {
    await prisma.client.usageEvent.create({
      data: {
        organizationId: orgId,
        workspaceId,
        kind: 'AI_GENERATION',
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        requests: 1,
        // No tokens reported at all.
        quantityUnknown: true,
        estimatedCostMicros: null,
        unpricedReason: 'NO_MEASURED_QUANTITY',
      },
    });
    const res = await inject().inject({
      method: 'GET',
      url: `${ws()}/budget/operations`,
      headers: { cookie },
    });
    const body = res.json() as {
      kinds: Array<{ kind: string; unknownQuantityEvents: number; measuredTokens: number }>;
    };
    const gen = body.kinds.find((k) => k.kind === 'AI_GENERATION');
    expect(gen?.unknownQuantityEvents).toBe(1);
    expect(gen?.measuredTokens).toBe(0);
  });

  // ---- unpriced report ----------------------------------------------------

  it('groups unpriced operations by reason', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `${ws()}/budget/unpriced`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      byReason: Array<{ reason: string; events: number; explanation: string }>;
      note: string;
    };
    const noQty = body.byReason.find((r) => r.reason === 'NO_MEASURED_QUANTITY');
    expect(noQty?.events).toBe(1);
    expect(noQty?.explanation).toBeTruthy();
    expect(body.note).toMatch(/NO_RATE_FOR_MODEL/);
  });

  // ---- organization ceiling ----------------------------------------------

  it('reports an unconfigured organization ceiling honestly', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `${org()}/budget`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { configured: boolean; note: string };
    expect(body.configured).toBe(false);
    expect(body.note).toMatch(/No organization-wide limit is configured/);
  });

  it('aggregates organization spend with a per-workspace breakdown', async () => {
    const put = await inject().inject({
      method: 'PUT',
      url: `${org()}/budget`,
      headers: { cookie },
      payload: { monthlyLimitMicros: 1_000_000, enforcement: 'ENFORCE', warnAtPercent: 80 },
    });
    expect(put.statusCode).toBe(200);
    const body = put.json() as {
      configured: boolean;
      usedMicros: number;
      workspaces: Array<{ workspaceId: string | null }>;
    };
    expect(body.configured).toBe(true);
    expect(body.usedMicros).toBeGreaterThan(0);
    expect(body.workspaces.some((w) => w.workspaceId === workspaceId)).toBe(true);
  });

  it('BLOCKs via the ORGANIZATION ceiling when the workspace alone would pass', async () => {
    // Workspace ceiling generous, org ceiling tiny.
    await inject().inject({
      method: 'PUT',
      url: `${ws()}/budget`,
      headers: { cookie },
      payload: { monthlyLimitMicros: 100_000_000, enforcement: 'ENFORCE', warnAtPercent: 80 },
    });
    await inject().inject({
      method: 'PUT',
      url: `${org()}/budget`,
      headers: { cookie },
      payload: { monthlyLimitMicros: 1, enforcement: 'ENFORCE', warnAtPercent: 80 },
    });

    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/budget/preflight`,
      headers: { cookie },
      payload: { kind: 'AI_GENERATION', provider: 'anthropic', model: 'claude-opus-4-8' },
    });
    const body = res.json() as { outcome: string; exceededReason: string };
    expect(body.outcome).toBe('BLOCK');
    expect(body.exceededReason).toBe('ORGANIZATION_COST_CEILING');
  });

  // ---- embedding guards (the 5E gap) --------------------------------------

  it('refuses knowledge search with 403 when the budget blocks it', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `${ws()}/knowledge/search?q=anything`,
      headers: { cookie },
    });
    // Org ceiling from the previous test is still exhausted.
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({
      type: 'https://spectra.dev/problems/budget-exceeded',
    });
  });

  it('refuses a reembed enqueue with 403 when the budget blocks it', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/knowledge/reembed`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(403);
    const before = await prisma.client.usageEvent.count({
      where: { organizationId: orgId, kind: 'AI_EMBEDDING' },
    });
    // Refused before queuing: no paid work was created.
    expect(before).toBe(0);
  });

  // ---- tenant isolation ---------------------------------------------------

  it('does not leak another organization’s budget', async () => {
    const other = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `harden-other-${runId}@itest.local`, password: PASSWORD, name: 'Other' },
    });
    const otherOrg = (other.json() as MeBody).memberships[0]?.organizationId as string;

    const res = await inject().inject({
      method: 'GET',
      url: `/v1/organizations/${otherOrg}/budget`,
      headers: { cookie },
    });
    // Foreign org: refused, and indistinguishable from "does not exist".
    expect([403, 404]).toContain(res.statusCode);

    await prisma.client.organization.delete({ where: { id: otherOrg } }).catch(() => undefined);
    await prisma.client.user
      .delete({ where: { email: `harden-other-${runId}@itest.local` } })
      .catch(() => undefined);
  });

  it('concurrent research-run starts cannot all pass the last allowance', async () => {
    // Reset this workspace and leave room for exactly one run.
    await prisma.client.usageEvent.deleteMany({ where: { organizationId: orgId } });
    await prisma.client.budgetReservation.deleteMany({ where: { organizationId: orgId } });
    await prisma.client.budgetOperationLimit.deleteMany({ where: { organizationId: orgId } });
    await inject().inject({
      method: 'PUT',
      url: `${org()}/budget`,
      headers: { cookie },
      payload: { monthlyLimitMicros: null, enforcement: 'OFF', warnAtPercent: 80 },
    });
    await inject().inject({
      method: 'PUT',
      url: `${ws()}/budget`,
      headers: { cookie },
      // A research run reserves 0 estimated cost (unpriced), so bound it with a
      // per-kind limit instead — the case that matters for unpriceable work.
      payload: { monthlyLimitMicros: null, enforcement: 'ENFORCE', warnAtPercent: 80 },
    });
    await inject().inject({
      method: 'PUT',
      url: `${ws()}/budget/operations`,
      headers: { cookie },
      payload: { limits: [{ kind: 'RESEARCH_RUN', maxRequests: 1, maxTokens: null }] },
    });

    const project = await prisma.client.researchProject.create({
      data: { organizationId: orgId, workspaceId, name: 'Concurrency project', status: 'ACTIVE' },
    });

    const attempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        inject().inject({
          method: 'POST',
          url: `${ws()}/research-projects/${project.id}/runs`,
          headers: { cookie },
          payload: { feedUrls: ['https://example.com/feed.xml'] },
        }),
      ),
    );

    const created = attempts.filter((r) => r.statusCode === 201);
    const refused = attempts.filter((r) => r.statusCode === 403);
    expect(created).toHaveLength(1);
    expect(refused).toHaveLength(5);

    // And only one run row exists — the refusals are pre-flight, not post-hoc.
    const runs = await prisma.client.researchRun.count({
      where: { organizationId: orgId, workspaceId, projectId: project.id },
    });
    expect(runs).toBe(1);
  });

  it('rejects an unknown usage kind with 422', async () => {
    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/budget/preflight`,
      headers: { cookie },
      payload: { kind: 'NOT_A_KIND' },
    });
    expect(res.statusCode).toBe(422);
  });
});
