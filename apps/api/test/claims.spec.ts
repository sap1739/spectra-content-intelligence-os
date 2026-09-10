import './setup-env';

import { randomBytes } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { verifyProjectClaims } from '@spectra/research-pipeline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 5H claim verification (ADR-0032) against a real database: corroboration
 * that respects syndication, contradiction surfacing, staleness, evidence
 * eligibility, the human review workflow, and tenant isolation.
 */

const runId = randomBytes(4).toString('hex');
const ownerEmail = `claims-owner-${runId}@itest.local`;
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

describe('API integration: claim verification and review', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let cookie = '';
  let orgId = '';
  let workspaceId = '';
  let projectId = '';

  const inject = () => app.getHttpAdapter().getInstance();
  const ws = () => `/v1/workspaces/${workspaceId}`;

  /** Creates a source + finding pair, returning the finding id. */
  async function seedFinding(opts: {
    url: string;
    publisher: string;
    text: string;
    syndicationKey?: string;
    snippetOnly?: boolean;
    publishedAt?: Date;
    credibility?: number;
  }): Promise<string> {
    const source = await prisma.client.researchSource.create({
      data: {
        organizationId: orgId,
        workspaceId,
        projectId,
        url: opts.url,
        urlHash: randomBytes(16).toString('hex'),
        publisher: opts.publisher,
        retrievedAt: new Date(),
        publishedAt: opts.publishedAt ?? new Date(),
        snippetOnly: opts.snippetOnly ?? false,
        credibilityScore: opts.credibility ?? 0.5,
        duplicateClusterKey: opts.syndicationKey ?? null,
        evidenceEligible: true,
        provenance: {},
      },
    });
    const finding = await prisma.client.researchFinding.create({
      data: {
        organizationId: orgId,
        workspaceId,
        projectId,
        sourceId: source.id,
        summary: opts.text,
        excerpt: opts.text,
        topics: ['ai testing'],
        provenance: {},
      },
    });
    return finding.id;
  }

  async function seedClaim(text: string, findingIds: string[], claimType = 'STATISTIC') {
    return prisma.client.extractedClaim.create({
      data: {
        organizationId: orgId,
        workspaceId,
        projectId,
        text,
        normalizedKey: `${text.toLowerCase().slice(0, 40)}-${randomBytes(3).toString('hex')}`,
        claimType: claimType as never,
        supportingFindingIds: findingIds,
        sourceCount: findingIds.length,
      },
    });
  }

  const verify = () =>
    verifyProjectClaims(prisma.client, { organizationId: orgId, workspaceId, projectId });

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    const register = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: ownerEmail, password: PASSWORD, name: 'Claims Owner' },
    });
    cookie = cookieOf(register.headers['set-cookie']);
    const me = register.json() as MeBody;
    orgId = me.memberships[0]?.organizationId as string;
    workspaceId = me.workspaces[0]?.id as string;

    const project = await prisma.client.researchProject.create({
      data: { organizationId: orgId, workspaceId, name: 'Claims project', status: 'ACTIVE' },
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await prisma.client.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    await prisma.client.user.delete({ where: { email: ownerEmail } }).catch(() => undefined);
    await app.close();
  });

  it('marks a claim ELIGIBLE when independent sources corroborate it', async () => {
    const findings = await Promise.all([
      seedFinding({ url: `https://a-${runId}.test/1`, publisher: 'A', text: 'Adoption rose.' }),
      seedFinding({ url: `https://b-${runId}.test/1`, publisher: 'B', text: 'Adoption rose.' }),
      seedFinding({ url: `https://c-${runId}.test/1`, publisher: 'C', text: 'Adoption rose.' }),
    ]);
    const claim = await seedClaim('Enterprise AI testing adoption grew 40% in 2026.', findings);

    const outcome = await verify();
    expect(outcome.eligible).toBeGreaterThanOrEqual(1);

    const row = await prisma.client.extractedClaim.findUnique({ where: { id: claim.id } });
    expect(row?.independentSourceCount).toBe(3);
    expect(row?.eligibility).toBe('ELIGIBLE');
    expect(row?.confidenceLevel).toBe('HIGH');
    expect(row?.verificationStatus).toBe('CORROBORATED');
  });

  it('does NOT let syndicated copies over-corroborate a claim', async () => {
    const findings = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        seedFinding({
          url: `https://outlet${i}-${runId}.test/wire`,
          publisher: `Outlet ${i}`,
          text: 'Wire story.',
          // All five are the same syndicated story.
          syndicationKey: `wire-${runId}`,
        }),
      ),
    );
    const claim = await seedClaim(
      'A vendor announced a partnership with a cloud provider.',
      findings,
      'FACTUAL',
    );

    await verify();
    const row = await prisma.client.extractedClaim.findUnique({ where: { id: claim.id } });
    // Five supporting rows, one actual independent source.
    expect(row?.sourceCount).toBe(5);
    expect(row?.independentSourceCount).toBe(1);
    expect(row?.eligibility).toBe('WEAK');
    expect(row?.eligibilityReason).toMatch(/single source/i);
  });

  it('detects a contradiction and routes both claims to review', async () => {
    const f1 = await seedFinding({ url: `https://x-${runId}.test/1`, publisher: 'X', text: 'a' });
    const f2 = await seedFinding({ url: `https://y-${runId}.test/1`, publisher: 'Y', text: 'b' });
    const a = await seedClaim('Cloud security spending rose 30% among mid-market firms.', [f1]);
    const b = await seedClaim('Cloud security spending rose 12% among mid-market firms.', [f2]);

    const outcome = await verify();
    expect(outcome.contradictionsDetected).toBeGreaterThanOrEqual(1);

    const contradiction = await prisma.client.claimContradiction.findFirst({
      where: { organizationId: orgId, projectId, status: 'OPEN' },
    });
    expect(contradiction?.kind).toBe('NUMERIC_CONFLICT');
    // Conflicting evidence is surfaced, not silently resolved either way.
    expect(contradiction?.detail).toMatch(/30%|12%/);

    for (const id of [a.id, b.id]) {
      const row = await prisma.client.extractedClaim.findUnique({ where: { id } });
      expect(row?.eligibility).toBe('REQUIRES_REVIEW');
      expect(row?.reviewStatus).toBe('PENDING');
      expect(row?.verificationStatus).toBe('DISPUTED');
    }
  });

  it('marks a stale time-sensitive claim for review', async () => {
    const old = await seedFinding({
      url: `https://old-${runId}.test/1`,
      publisher: 'Old',
      text: 'old stat',
      publishedAt: new Date('2023-01-01T00:00:00.000Z'),
    });
    const claim = await seedClaim('Container adoption reached 88% of surveyed retailers.', [old]);

    await verify();
    const row = await prisma.client.extractedClaim.findUnique({ where: { id: claim.id } });
    expect(row?.freshnessStatus).toBe('STALE');
    expect(row?.eligibility).toBe('REQUIRES_REVIEW');
    expect(row?.eligibilityReason).toMatch(/days old/);
  });

  it('BLOCKS a claim with no supporting source rather than citing nothing', async () => {
    const claim = await seedClaim('An entirely unsupported assertion about market size.', []);
    await verify();
    const row = await prisma.client.extractedClaim.findUnique({ where: { id: claim.id } });
    expect(row?.eligibility).toBe('BLOCKED');
    expect(row?.eligibilityReason).toMatch(/No supporting source/i);
  });

  it('excludes BLOCKED and REQUIRES_REVIEW claims from the API listing filters', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `${ws()}/research-projects/${projectId}/claims?eligibility=ELIGIBLE`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { claims: Array<{ eligibility: string }> };
    expect(body.claims.every((c) => c.eligibility === 'ELIGIBLE')).toBe(true);
  });

  it('surfaces contradictions and a summary in the project claim listing', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `${ws()}/research-projects/${projectId}/claims`,
      headers: { cookie },
    });
    const body = res.json() as {
      claims: Array<{ contradictions: unknown[] }>;
      summary: { openContradictions: number; requiresReview: number };
    };
    expect(body.summary.openContradictions).toBeGreaterThanOrEqual(1);
    expect(body.summary.requiresReview).toBeGreaterThanOrEqual(2);
    expect(body.claims.some((c) => c.contradictions.length > 0)).toBe(true);
  });

  it('lists claims needing review in the queue', async () => {
    const res = await inject().inject({
      method: 'GET',
      url: `${ws()}/claims/review-queue`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: Array<{ claimId: string; reason: string }>; total: number };
    expect(body.total).toBeGreaterThanOrEqual(1);
    // Every queued item states why it is there.
    expect(body.items.every((i) => typeof i.reason === 'string' && i.reason.length > 0)).toBe(true);
  });

  it('lets a reviewer approve a claim, overriding the automated assessment', async () => {
    const queue = await inject().inject({
      method: 'GET',
      url: `${ws()}/claims/review-queue`,
      headers: { cookie },
    });
    const claimId = (queue.json() as { items: Array<{ claimId: string }> }).items[0]
      ?.claimId as string;

    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/claims/${claimId}/review`,
      headers: { cookie },
      payload: { action: 'APPROVE', note: 'Confirmed against the primary filing.' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { eligibility: string; reviewStatus: string };
    expect(body.eligibility).toBe('ELIGIBLE');
    expect(body.reviewStatus).toBe('APPROVED');

    // Re-verification must NOT reset a human decision.
    await verify();
    const row = await prisma.client.extractedClaim.findUnique({ where: { id: claimId } });
    expect(row?.eligibility).toBe('ELIGIBLE');
    expect(row?.reviewStatus).toBe('APPROVED');
  });

  it('records an append-only review history', async () => {
    const queue = await inject().inject({
      method: 'GET',
      url: `${ws()}/claims/review-queue`,
      headers: { cookie },
    });
    const claimId = (queue.json() as { items: Array<{ claimId: string }> }).items[0]
      ?.claimId as string;

    await inject().inject({
      method: 'POST',
      url: `${ws()}/claims/${claimId}/review`,
      headers: { cookie },
      payload: { action: 'REJECT', note: 'The underlying source retracted this figure.' },
    });

    const history = await inject().inject({
      method: 'GET',
      url: `${ws()}/claims/${claimId}/reviews`,
      headers: { cookie },
    });
    const rows = history.json() as Array<{ action: string; note: string }>;
    expect(rows[0]?.action).toBe('REJECT');
    expect(rows[0]?.note).toMatch(/retracted/);

    const row = await prisma.client.extractedClaim.findUnique({ where: { id: claimId } });
    expect(row?.eligibility).toBe('BLOCKED');
  });

  it('requires a note when rejecting (422)', async () => {
    const claim = await seedClaim('Another claim needing a note on rejection.', []);
    const res = await inject().inject({
      method: 'POST',
      url: `${ws()}/claims/${claim.id}/review`,
      headers: { cookie },
      payload: { action: 'REJECT' },
    });
    expect(res.statusCode).toBe(422);
  });

  it('does not leak another tenant’s claim (same response as not found)', async () => {
    const other = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `claims-other-${runId}@itest.local`, password: PASSWORD, name: 'Other' },
    });
    const otherCookie = cookieOf(other.headers['set-cookie']);
    const otherOrg = (other.json() as MeBody).memberships[0]?.organizationId as string;
    const otherWs = (other.json() as MeBody).workspaces[0]?.id as string;

    const mine = await seedClaim('A claim belonging to the first tenant.', []);
    const res = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${otherWs}/claims/${mine.id}/review`,
      headers: { cookie: otherCookie },
      payload: { action: 'APPROVE' },
    });
    // Foreign resource is indistinguishable from a missing one.
    expect(res.statusCode).toBe(404);

    await prisma.client.organization.delete({ where: { id: otherOrg } }).catch(() => undefined);
    await prisma.client.user
      .delete({ where: { email: `claims-other-${runId}@itest.local` } })
      .catch(() => undefined);
  });
});
