import './setup-env';

import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { executeOrchestration } from '@spectra/campaign-orchestration';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv } from '../src/config/env';
import { QueueService } from '../src/infra/queue.service';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 7D: research-backed campaign orchestration (ADR-0043), end to end
 * against the real API and Postgres. The run is driven through
 * `executeOrchestration` — the same body the worker runs — with a stub
 * generator, because no text-generation provider is configured in tests and
 * inventing one would defeat the point.
 */

const runId = randomBytes(4).toString('hex');
const PASSWORD = 'integration-test-password-1';

interface Tenant {
  email: string;
  cookie: string;
  userId: string;
  orgId: string;
  workspaceId: string;
}

interface RunBody {
  id: string;
  status: string;
  campaignId: string | null;
  progressPercent: number;
  itemsPlanned: number;
  itemsCreated: number;
  itemsDrafted: number;
  itemsBlocked: number;
  itemsFailed: number;
  failureReason: string | null;
  strategy: Record<string, unknown> | null;
  plan: Record<string, unknown> | null;
  stages: Array<{ stage: string; status: string; note: string | null }>;
  items: Array<{
    title: string;
    outcome: string;
    contentItemId: string | null;
    evidence: { verdict: string; action: string; reason: string };
    note: string | null;
  }>;
}

function problemText(body: unknown): string {
  const problem = body as { title?: string; detail?: string };
  return `${problem.title ?? ''} ${problem.detail ?? ''}`;
}

describe('API integration: campaign orchestration (ADR-0043)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let queueService: QueueService;
  let enqueueSpy: { mockRestore: () => void } | null = null;
  const tenants: Tenant[] = [];
  let owner: Tenant;
  let other: Tenant;
  let verticalId = '';
  let projectId = '';

  const inject = () => app.getHttpAdapter().getInstance();
  const base = (t: Tenant = owner) => `/v1/workspaces/${t.workspaceId}/campaign-orchestration`;
  const get = (t: Tenant, url: string) =>
    inject().inject({ method: 'GET', url, headers: { cookie: t.cookie } });
  const send = (t: Tenant, method: 'POST', url: string, payload?: unknown) =>
    inject().inject({
      method,
      url,
      headers: { cookie: t.cookie },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  /** Runs the orchestration exactly as the worker does, with a stub generator. */
  async function runOrchestration(
    id: string,
    options: {
      generation?: { available: boolean; reason?: string; fail?: boolean | number };
      signal?: AbortSignal;
      publishable?: string[];
    } = {},
  ) {
    let calls = 0;
    const generation = options.generation ?? { available: true };
    return executeOrchestration(
      {
        prisma: prisma.client,
        generation: {
          available: generation.available,
          ...(generation.reason ? { reason: generation.reason } : {}),
          async generateDraft({ contentItemId }) {
            calls += 1;
            const shouldFail =
              generation.fail === true ||
              (typeof generation.fail === 'number' && calls <= generation.fail);
            if (shouldFail) return { status: 'FAILED' as const, note: 'provider refused' };
            // A real draft row, so "drafted" means something was written.
            await prisma.client.contentItem.updateMany({
              where: { organizationId: owner.orgId, id: contentItemId },
              data: { body: 'A grounded draft body. [1]' },
            });
            return { status: 'READY' as const };
          },
        },
        async publishablePlatforms() {
          return new Set((options.publishable ?? ['LINKEDIN']) as never);
        },
      },
      id,
      options.signal ? { signal: options.signal } : {},
    );
  }

  async function registerTenant(label: string): Promise<Tenant> {
    const email = `orch-${label}-${runId}@itest.local`;
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, name: `Orch ${label}` },
    });
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] as string;
    const me = res.json() as {
      user: { id: string };
      memberships: Array<{ organizationId: string }>;
      workspaces: Array<{ id: string }>;
    };
    const tenant = {
      email,
      cookie,
      userId: me.user.id,
      orgId: me.memberships[0]?.organizationId as string,
      workspaceId: me.workspaces[0]?.id as string,
    };
    tenants.push(tenant);
    return tenant;
  }

  /**
   * Seeds a trend with real evidence behind it: sources, findings and an
   * evidence pack. `publishers` decides how independent the evidence is.
   */
  async function seedTrend(
    t: Tenant,
    options: {
      title: string;
      topicKey: string;
      score?: number;
      publishers?: string[];
      snippetOnly?: boolean;
      publishedAt?: Date;
      evidenceEligible?: boolean;
      withPack?: boolean;
      withFindings?: boolean;
    },
  ) {
    const publishers = options.publishers ?? ['alpha.example', 'beta.example'];
    const findingIds: string[] = [];
    if (options.withFindings !== false) {
      for (const publisher of publishers) {
        const url = `https://${publisher}/${options.topicKey}-${randomUUID().slice(0, 8)}`;
        const source = await prisma.client.researchSource.create({
          data: {
            organizationId: t.orgId,
            workspaceId: t.workspaceId,
            projectId,
            url,
            urlHash: createHash('sha256').update(url).digest('hex'),
            title: `${options.title} — ${publisher}`,
            publisher,
            publishedAt: options.publishedAt ?? new Date('2026-09-15T00:00:00.000Z'),
            retrievedAt: new Date(),
            snippetOnly: options.snippetOnly ?? false,
            evidenceEligible: options.evidenceEligible ?? true,
            provenance: {},
          },
          select: { id: true },
        });
        const finding = await prisma.client.researchFinding.create({
          data: {
            organizationId: t.orgId,
            workspaceId: t.workspaceId,
            projectId,
            sourceId: source.id,
            summary: `${options.title}, reported by ${publisher}.`,
            provenance: {},
          },
          select: { id: true },
        });
        findingIds.push(finding.id);
      }
    }

    if (options.withPack !== false) {
      await prisma.client.evidencePack.create({
        data: {
          organizationId: t.orgId,
          workspaceId: t.workspaceId,
          projectId,
          topicKey: options.topicKey,
          title: options.title,
          status: 'READY',
          findingIds,
          citationIds: [],
          claimIds: [],
        },
      });
    }

    const trend = await prisma.client.trendCandidate.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        projectId,
        verticalId,
        topicKey: options.topicKey,
        title: options.title,
        summary: `${options.title} summary.`,
        state: 'ACCELERATING',
        normalizedScore: options.score ?? 0.8,
        findingIds,
      },
      select: { id: true },
    });
    return trend.id;
  }

  function startInput(overrides: Record<string, unknown> = {}) {
    return {
      name: `Campaign ${randomUUID().slice(0, 8)}`,
      verticalId,
      platforms: ['LINKEDIN', 'X'],
      startAt: new Date(Date.now() + 86_400_000).toISOString(),
      durationDays: 14,
      itemsPerTrend: 2,
      minTrendScore: 0.5,
      maxTrends: 5,
      generateDrafts: true,
      ...overrides,
    };
  }

  beforeAll(async () => {
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);
    queueService = app.get(QueueService);
    enqueueSpy = vi
      .spyOn(queueService, 'enqueue')
      .mockImplementation(async () => `stub-${randomUUID()}`);
    owner = await registerTenant('owner');
    other = await registerTenant('other');

    const vertical = await prisma.client.customVertical.create({
      data: {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        name: 'Enterprise storage',
        slug: `storage-${runId}`,
        keywords: ['storage', 'latency'],
      },
      select: { id: true },
    });
    verticalId = vertical.id;

    const project = await prisma.client.researchProject.create({
      data: {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        verticalId,
        name: 'Storage market watch',
      },
      select: { id: true },
    });
    projectId = project.id;
  }, 120_000);

  afterAll(async () => {
    enqueueSpy?.mockRestore();
    for (const tenant of tenants) {
      await prisma.client.organization
        .deleteMany({ where: { id: tenant.orgId } })
        .catch(() => undefined);
      await prisma.client.user
        .deleteMany({ where: { email: tenant.email } })
        .catch(() => undefined);
    }
    await app.close();
  });

  describe('capabilities', () => {
    it('states the strategy engine is deterministic, and whether drafts can be written', async () => {
      const res = await get(owner, `${base()}/capabilities`);

      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        strategyEngine: { deterministic: boolean; version: string; note: string };
        generation: { available: boolean; reason: string };
        publishesAutomatically: boolean;
      };
      expect(body.strategyEngine.deterministic).toBe(true);
      expect(body.strategyEngine.note).toContain('No model invents them');
      // No key in tests, so generation is honestly unavailable.
      expect(body.generation.available).toBe(false);
      expect(body.generation.reason).toContain('ANTHROPIC_API_KEY');
      // A run never publishes; a person approves and schedules.
      expect(body.publishesAutomatically).toBe(false);
    });
  });

  describe('research to campaign', () => {
    it('builds a strategy, plan, calendar and evidence-linked items end to end', async () => {
      await seedTrend(owner, {
        title: 'Composable storage replaces monoliths',
        topicKey: `t1-${runId}`,
      });
      await seedTrend(owner, {
        title: 'Latency budgets shrink again',
        topicKey: `t2-${runId}`,
        score: 0.7,
      });

      const queued = await send(owner, 'POST', `${base()}/runs`, startInput());
      expect(queued.statusCode).toBe(202);
      const run = (queued.json() as { created: boolean; run: RunBody }).run;
      expect(run.status).toBe('QUEUED');
      expect(run.campaignId).toBeNull();

      const outcome = await runOrchestration(run.id);
      expect(outcome.status).toBe('SUCCEEDED');

      const after = ((await get(owner, `${base()}/runs/${run.id}`)).json() as { run: RunBody }).run;
      expect(after.status).toBe('SUCCEEDED');
      expect(after.progressPercent).toBe(100);
      expect(after.campaignId).toBeTruthy();
      // 2 trends × 2 items.
      expect(after.itemsPlanned).toBe(4);
      expect(after.itemsCreated).toBe(4);
      expect(after.itemsDrafted).toBe(4);
      expect(after.itemsBlocked).toBe(0);

      // Every stage ran and is recorded.
      expect(after.stages.filter((stage) => stage.status === 'SUCCEEDED')).toHaveLength(8);

      // The strategy is derived, not invented.
      const strategy = after.strategy as {
        engineVersion: string;
        objectives: unknown[];
        pillars: unknown[];
        personas: Array<{ source: string }>;
        ctaSuggestions: unknown[];
        platforms: Array<{ platform: string; publishingAvailable: boolean }>;
      };
      expect(strategy.engineVersion).toContain('spectra-strategy@');
      expect(strategy.objectives.length).toBeGreaterThan(0);
      expect(strategy.pillars.length).toBeGreaterThan(0);
      expect(strategy.ctaSuggestions.length).toBeGreaterThan(0);
      // X has no connected account, and the strategy says so.
      expect(strategy.platforms.find((p) => p.platform === 'X')!.publishingAvailable).toBe(false);

      // The campaign is real, and the items hang off it.
      const campaign = await prisma.client.campaign.findFirstOrThrow({
        where: { organizationId: owner.orgId, id: after.campaignId! },
      });
      expect(campaign.status).toBe('PLANNED');
      const items = await prisma.client.contentItem.findMany({
        where: { organizationId: owner.orgId, campaignId: campaign.id },
      });
      expect(items).toHaveLength(4);

      // Every item links to the evidence it was built from — the acceptance
      // criterion, checked against the database rather than the response.
      for (const item of items) {
        expect(item.evidencePackId).toBeTruthy();
        expect(item.findingIds.length).toBeGreaterThan(0);
        expect(item.researchProjectId).toBe(projectId);
        expect(item.lifecycleState).toBe('REVIEW');
      }

      // And the packs know what consumed them.
      const packs = await prisma.client.evidencePack.findMany({
        where: { organizationId: owner.orgId, projectId },
      });
      expect(packs.every((pack) => pack.usedByContentItemIds.length > 0)).toBe(true);
    }, 180_000);

    it('resolves each item’s evidence lineage through the items endpoint', async () => {
      const trendId = await seedTrend(owner, {
        title: 'Lineage check',
        topicKey: `lineage-${runId}`,
      });
      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [trendId], itemsPerTrend: 1 }),
      );
      const run = (queued.json() as { run: RunBody }).run;
      await runOrchestration(run.id);

      const res = await get(owner, `${base()}/runs/${run.id}/items`);
      const body = res.json() as {
        items: Array<{
          outcome: string;
          evidence: { verdict: string; reason: string };
          contentItem: { findingIds: string[]; evidencePackId: string | null } | null;
        }>;
      };

      expect(body.items).toHaveLength(1);
      expect(body.items[0]!.outcome).toBe('DRAFTED');
      // Two independent sources, but no claim has been verified into the pack
      // — real evidence, not settled evidence, and the reason says which.
      expect(body.items[0]!.evidence.verdict).toBe('LIMITED');
      expect(body.items[0]!.evidence.reason).toContain('none of its claims has been verified');
      expect(body.items[0]!.contentItem!.findingIds.length).toBeGreaterThan(0);
      expect(body.items[0]!.contentItem!.evidencePackId).toBeTruthy();
    }, 180_000);
  });

  describe('weak evidence', () => {
    it('blocks a topic with nothing behind it, and keeps it in the plan with the reason', async () => {
      const supported = await seedTrend(owner, {
        title: 'Well-sourced topic',
        topicKey: `ok-${runId}`,
      });
      const unsupported = await seedTrend(owner, {
        title: 'Topic with no evidence',
        topicKey: `none-${runId}`,
        withFindings: false,
        withPack: false,
      });

      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [supported, unsupported], itemsPerTrend: 1 }),
      );
      const run = (queued.json() as { run: RunBody }).run;
      const outcome = await runOrchestration(run.id);

      // Some built, some refused — that is PARTIAL, not SUCCEEDED.
      expect(outcome.status).toBe('PARTIAL');
      const after = ((await get(owner, `${base()}/runs/${run.id}`)).json() as { run: RunBody }).run;
      expect(after.itemsCreated).toBe(1);
      expect(after.itemsBlocked).toBe(1);

      const blocked = after.items.find((item) => item.outcome === 'BLOCKED')!;
      expect(blocked.evidence.verdict).toBe('UNSUPPORTED');
      expect(blocked.evidence.action).toBe('BLOCK');
      expect(blocked.contentItemId).toBeNull();
      // The blocked topic is visible in the plan, not quietly dropped.
      const plan = after.plan as { blocked: Array<{ title: string }> };
      expect(plan.blocked).toHaveLength(1);
    }, 180_000);

    it('allows a thinly-sourced topic but marks it as limited', async () => {
      const thin = await seedTrend(owner, {
        title: 'Single-source claim',
        topicKey: `thin-${runId}`,
        publishers: ['only.example'],
      });

      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [thin], itemsPerTrend: 1 }),
      );
      const run = (queued.json() as { run: RunBody }).run;
      await runOrchestration(run.id);

      const after = ((await get(owner, `${base()}/runs/${run.id}`)).json() as { run: RunBody }).run;
      const item = after.items[0]!;
      expect(item.outcome).toBe('DRAFTED');
      expect(item.evidence.verdict).toBe('LIMITED');
      expect(item.evidence.action).toBe('ALLOW_WITH_CAUTION');
      expect(item.evidence.reason).toContain('1 independent source');
    }, 180_000);

    it('marks a snippet-only topic, and a stale one, rather than treating them as solid', async () => {
      const snippet = await seedTrend(owner, {
        title: 'Snippet-only topic',
        topicKey: `snip-${runId}`,
        snippetOnly: true,
      });
      const stale = await seedTrend(owner, {
        title: 'Old news',
        topicKey: `stale-${runId}`,
        publishedAt: new Date('2024-01-01T00:00:00.000Z'),
      });

      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [snippet, stale], itemsPerTrend: 1 }),
      );
      const run = (queued.json() as { run: RunBody }).run;
      await runOrchestration(run.id);

      const after = ((await get(owner, `${base()}/runs/${run.id}`)).json() as { run: RunBody }).run;
      const verdicts = after.items.map((item) => item.evidence.verdict).sort();
      expect(verdicts).toEqual(['SNIPPET_ONLY', 'STALE']);
      expect(after.items.every((item) => item.evidence.action === 'ALLOW_WITH_CAUTION')).toBe(true);
    }, 180_000);

    it('fails the whole run when every topic is blocked, rather than building an empty campaign', async () => {
      const empty = await seedTrend(owner, {
        title: 'Nothing at all',
        topicKey: `empty-${runId}`,
        withFindings: false,
        withPack: false,
      });

      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [empty], itemsPerTrend: 1 }),
      );
      const run = (queued.json() as { run: RunBody }).run;
      const outcome = await runOrchestration(run.id);

      expect(outcome.status).toBe('FAILED');
      expect(outcome.failureReason).toBe('ALL_ITEMS_BLOCKED');
      const after = (await get(owner, `${base()}/runs/${run.id}`)).json() as {
        run: RunBody;
        failureText: string;
      };
      expect(after.run.campaignId).toBeNull();
      expect(after.failureText).toContain('does not yet support a campaign');
    }, 180_000);
  });

  describe('partial failure and unavailability', () => {
    it('keeps the plan when no generator is configured, and says so per item', async () => {
      const trendId = await seedTrend(owner, {
        title: 'Plan without prose',
        topicKey: `noprose-${runId}`,
      });
      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [trendId], itemsPerTrend: 2 }),
      );
      const run = (queued.json() as { run: RunBody }).run;

      const outcome = await runOrchestration(run.id, {
        generation: { available: false, reason: 'No provider configured in this deployment.' },
      });

      // Everything but the prose was produced — PARTIAL, with a reason.
      expect(outcome.status).toBe('PARTIAL');
      const after = ((await get(owner, `${base()}/runs/${run.id}`)).json() as { run: RunBody }).run;
      expect(after.itemsCreated).toBe(2);
      expect(after.itemsDrafted).toBe(0);
      expect(after.campaignId).toBeTruthy();
      for (const item of after.items) {
        expect(item.outcome).toBe('GENERATION_UNAVAILABLE');
        expect(item.note).toContain('No provider configured');
      }
      const stage = after.stages.find((s) => s.stage === 'GENERATE_DRAFTS')!;
      expect(stage.status).toBe('SKIPPED');
    }, 180_000);

    it('records a failed draft and keeps going, rather than discarding the campaign', async () => {
      const trendId = await seedTrend(owner, {
        title: 'Flaky provider',
        topicKey: `flaky-${runId}`,
      });
      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [trendId], itemsPerTrend: 3 }),
      );
      const run = (queued.json() as { run: RunBody }).run;

      // The first draft fails; the rest succeed.
      const outcome = await runOrchestration(run.id, { generation: { available: true, fail: 1 } });

      expect(outcome.status).toBe('PARTIAL');
      const after = ((await get(owner, `${base()}/runs/${run.id}`)).json() as { run: RunBody }).run;
      expect(after.itemsCreated).toBe(3);
      expect(after.itemsDrafted).toBe(2);
      expect(after.itemsFailed).toBe(1);
      const failed = after.items.find((item) => item.outcome === 'GENERATION_FAILED')!;
      expect(failed.note).toContain('provider refused');
      expect(failed.contentItemId).toBeTruthy();
    }, 180_000);

    it('cancels a running orchestration and stops creating items', async () => {
      const trendId = await seedTrend(owner, { title: 'Cancelled', topicKey: `cancel-${runId}` });
      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [trendId], itemsPerTrend: 1 }),
      );
      const run = (queued.json() as { run: RunBody }).run;

      const controller = new AbortController();
      controller.abort();
      const outcome = await runOrchestration(run.id, { signal: controller.signal });

      expect(outcome.status).toBe('CANCELLED');
      const after = ((await get(owner, `${base()}/runs/${run.id}`)).json() as { run: RunBody }).run;
      expect(after.status).toBe('CANCELLED');
      expect(after.failureReason).toBe('CANCELLED');
    }, 180_000);

    it('cancels a queued run through the API without ever starting it', async () => {
      const trendId = await seedTrend(owner, { title: 'Queued only', topicKey: `queued-${runId}` });
      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [trendId] }),
      );
      const run = (queued.json() as { run: RunBody }).run;

      const cancelled = await send(owner, 'POST', `${base()}/runs/${run.id}/cancel`);
      expect(cancelled.statusCode).toBe(201);
      expect((cancelled.json() as { run: RunBody }).run.status).toBe('CANCELLED');

      const outcome = await runOrchestration(run.id);
      expect(outcome.status).toBe('SKIPPED');
    }, 120_000);
  });

  describe('idempotency, budget and isolation', () => {
    it('reuses a run for identical inputs rather than building a second campaign', async () => {
      const trendId = await seedTrend(owner, { title: 'Idempotent', topicKey: `idem-${runId}` });
      const input = startInput({ trendCandidateIds: [trendId], itemsPerTrend: 1 });

      const first = await send(owner, 'POST', `${base()}/runs`, input);
      const second = await send(owner, 'POST', `${base()}/runs`, input);

      expect((first.json() as { created: boolean }).created).toBe(true);
      expect((second.json() as { created: boolean }).created).toBe(false);
      expect((second.json() as { run: RunBody }).run.id).toBe(
        (first.json() as { run: RunBody }).run.id,
      );
    }, 120_000);

    it('skips a completed run on retry, keeping its campaign and items', async () => {
      const trendId = await seedTrend(owner, { title: 'Retry safe', topicKey: `retry-${runId}` });
      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [trendId], itemsPerTrend: 1 }),
      );
      const run = (queued.json() as { run: RunBody }).run;
      await runOrchestration(run.id);
      const before = await prisma.client.campaignOrchestrationRun.findUniqueOrThrow({
        where: { id: run.id },
      });

      const retry = await runOrchestration(run.id);
      const after = await prisma.client.campaignOrchestrationRun.findUniqueOrThrow({
        where: { id: run.id },
      });

      expect(retry.status).toBe('SKIPPED');
      expect(after.campaignId).toBe(before.campaignId);
      expect(after.finishedAt?.getTime()).toBe(before.finishedAt?.getTime());
      const items = await prisma.client.contentItem.findMany({
        where: { organizationId: owner.orgId, campaignId: after.campaignId! },
      });
      expect(items).toHaveLength(1);
    }, 180_000);

    it('refuses a run the workspace budget will not allow, before anything is created', async () => {
      const trendId = await seedTrend(owner, { title: 'Too costly', topicKey: `budget-${runId}` });
      await prisma.client.budgetOperationLimit.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          kind: 'CONTENT_DRAFT',
          maxRequests: 0,
        },
      });

      try {
        const res = await send(
          owner,
          'POST',
          `${base()}/runs`,
          startInput({ trendCandidateIds: [trendId] }),
        );

        expect(res.statusCode).toBe(403);
        expect((res.json() as { type: string }).type).toContain('budget-exceeded');
        const runs = await prisma.client.campaignOrchestrationRun.count({
          where: { organizationId: owner.orgId, name: startInput().name as string },
        });
        expect(runs).toBe(0);
      } finally {
        await prisma.client.budgetOperationLimit.deleteMany({
          where: { organizationId: owner.orgId, kind: 'CONTENT_DRAFT' },
        });
      }
    }, 120_000);

    it('refuses a run starting from another tenant’s vertical or trend', async () => {
      const foreignVertical = await prisma.client.customVertical.create({
        data: {
          organizationId: other.orgId,
          workspaceId: other.workspaceId,
          name: 'Foreign',
          slug: `foreign-${runId}`,
        },
        select: { id: true },
      });

      const byVertical = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ verticalId: foreignVertical.id }),
      );
      const byTrend = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [randomUUID()] }),
      );

      expect(byVertical.statusCode).toBe(404);
      expect(byTrend.statusCode).toBe(404);
    }, 120_000);

    it('gives another tenant the same 404 for a run as for one that does not exist', async () => {
      const trendId = await seedTrend(owner, { title: 'Private', topicKey: `private-${runId}` });
      const queued = await send(
        owner,
        'POST',
        `${base()}/runs`,
        startInput({ trendCandidateIds: [trendId] }),
      );
      const run = (queued.json() as { run: RunBody }).run;

      const foreign = await get(other, `${base(other)}/runs/${run.id}`);
      const missing = await get(other, `${base(other)}/runs/${randomUUID()}`);

      expect(foreign.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(problemText(foreign.json())).toBe(problemText(missing.json()));
    }, 120_000);

    it('needs campaign:orchestrate to start a run — campaign:read only looks', async () => {
      const reader = await registerTenant('reader');
      await prisma.client.membership.create({
        data: {
          organizationId: owner.orgId,
          userId: reader.userId,
          role: 'READ_ONLY',
          workspaceIds: [owner.workspaceId],
        },
      });
      const asReader = { ...reader, workspaceId: owner.workspaceId };

      const canRead = await get(asReader, `${base(owner)}/runs`);
      const cannotStart = await send(asReader, 'POST', `${base(owner)}/runs`, startInput());

      expect(canRead.statusCode).toBe(200);
      expect(cannotStart.statusCode).toBe(403);
      expect(problemText(cannotStart.json())).toContain('campaign:orchestrate');
    }, 120_000);
  });
});
