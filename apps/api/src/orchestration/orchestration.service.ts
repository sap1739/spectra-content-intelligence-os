import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  ORCHESTRATION_FAILURE_REASON_TEXT,
  EVIDENCE_VERDICT_TEXT,
  type StartOrchestrationInput,
} from '@spectra/contracts';
import { STRATEGY_ENGINE_VERSION, orchestrationRunKey } from '@spectra/campaign-orchestration';
import { Prisma } from '@spectra/database';
import { preflight } from '@spectra/metering';
import { TenantIsolationError } from '@spectra/security';
import { JOB_NAMES } from '@spectra/workflow-core';

import { getApiEnv } from '../config/env';
import { AuditService } from '../infra/audit.service';
import { QueueService } from '../infra/queue.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

type Scope = { organizationId: string; workspaceId: string };

const RUN_SELECT = {
  id: true,
  name: true,
  status: true,
  input: true,
  runKey: true,
  verticalId: true,
  researchProjectId: true,
  brandId: true,
  campaignId: true,
  trendCandidateIds: true,
  strategy: true,
  plan: true,
  stages: true,
  items: true,
  progressPercent: true,
  itemsPlanned: true,
  itemsCreated: true,
  itemsDrafted: true,
  itemsBlocked: true,
  itemsFailed: true,
  attempt: true,
  maxAttempts: true,
  startedAt: true,
  finishedAt: true,
  failureReason: true,
  failureDetail: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CampaignOrchestrationRunSelect;

@Injectable()
export class OrchestrationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  /**
   * What an orchestration run can and cannot do here. The generation half is
   * env-gated: without a provider the run still builds a strategy, a plan, a
   * calendar and evidence-linked items — it just cannot write the prose, and
   * says so up front rather than at the end.
   */
  capabilities() {
    const env = getApiEnv();
    const generationConfigured = Boolean(env.ANTHROPIC_API_KEY);
    return {
      strategyEngine: {
        version: STRATEGY_ENGINE_VERSION,
        deterministic: true,
        note: 'Objectives, pillars, personas, topics, platform strategy and CTAs are derived from the vertical, the scored trends, the evidence packs behind them and the declared platform capability matrix. No model invents them.',
      },
      generation: {
        available: generationConfigured,
        reason: generationConfigured
          ? 'A text-generation provider is configured; drafts will be written and grounded on each item’s evidence.'
          : 'No text-generation provider is configured (ANTHROPIC_API_KEY). Runs still produce the strategy, plan, calendar and evidence-linked items; the drafts are left unwritten and each item says so.',
      },
      evidenceVerdicts: EVIDENCE_VERDICT_TEXT,
      failureReasons: ORCHESTRATION_FAILURE_REASON_TEXT,
      /** Approved items are scheduled by a person; a run never publishes. */
      publishesAutomatically: false,
    };
  }

  async listRuns(tenant: TenantContext) {
    const runs = await this.prisma.client.campaignOrchestrationRun.findMany({
      where: this.scope(tenant),
      select: {
        id: true,
        name: true,
        status: true,
        campaignId: true,
        progressPercent: true,
        itemsPlanned: true,
        itemsCreated: true,
        itemsDrafted: true,
        itemsBlocked: true,
        failureReason: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
    return { runs };
  }

  async getRun(tenant: TenantContext, runId: string) {
    const run = await this.prisma.client.campaignOrchestrationRun.findFirst({
      where: { ...this.scope(tenant), id: runId },
      select: RUN_SELECT,
    });
    if (!run) throw new TenantIsolationError('Orchestration run not found');
    return {
      run,
      failureText: run.failureReason ? ORCHESTRATION_FAILURE_REASON_TEXT[run.failureReason] : null,
    };
  }

  /**
   * Queues a run. The budget pre-flight happens here, before any work: a
   * campaign the workspace cannot afford is refused rather than half-built.
   */
  async startRun(tenant: TenantContext, principal: Principal, input: StartOrchestrationInput) {
    const scope = this.scope(tenant);

    // Inputs are resolved here too, so a bad reference is a 404 now rather than
    // a failed run in a minute's time.
    if (input.verticalId) {
      const vertical = await this.prisma.client.customVertical.findFirst({
        where: { ...scope, id: input.verticalId, deletedAt: null },
        select: { id: true },
      });
      if (!vertical) throw new TenantIsolationError('Vertical not found');
    }
    if (input.researchProjectId) {
      const project = await this.prisma.client.researchProject.findFirst({
        where: { ...scope, id: input.researchProjectId },
        select: { id: true },
      });
      if (!project) throw new TenantIsolationError('Research project not found');
    }
    if (input.brandId) {
      const brand = await this.prisma.client.brand.findFirst({
        where: { ...scope, id: input.brandId },
        select: { id: true },
      });
      if (!brand) throw new TenantIsolationError('Brand not found');
    }
    if (input.trendCandidateIds.length > 0) {
      const found = await this.prisma.client.trendCandidate.count({
        where: { ...scope, id: { in: input.trendCandidateIds }, deletedAt: null },
      });
      if (found !== input.trendCandidateIds.length) {
        throw new TenantIsolationError('Trend not found');
      }
    }

    const runKey = orchestrationRunKey({
      verticalId: input.verticalId ?? null,
      researchProjectId: input.researchProjectId ?? null,
      trendCandidateIds: input.trendCandidateIds,
      platforms: input.platforms,
      startAt: input.startAt,
      durationDays: input.durationDays,
      itemsPerTrend: input.itemsPerTrend,
      generateDrafts: input.generateDrafts,
    });

    const existing = await this.prisma.client.campaignOrchestrationRun.findFirst({
      where: { ...scope, runKey },
      select: RUN_SELECT,
    });
    if (existing && existing.status !== 'FAILED' && existing.status !== 'CANCELLED') {
      // Same inputs: adopt the run rather than build a second campaign.
      return { created: false, run: existing };
    }

    // How many drafts this run would write, so the pre-flight reflects the real
    // shape of the work rather than a flat "one campaign".
    const estimatedItems =
      Math.max(1, Math.min(input.maxTrends, input.trendCandidateIds.length || input.maxTrends)) *
      input.itemsPerTrend;
    const decision = await preflight(this.prisma.client, {
      ...scope,
      kind: 'CONTENT_DRAFT',
      provider: 'anthropic',
      requests: input.generateDrafts ? estimatedItems : 1,
    });
    if (decision.blocked) {
      throw new (await import('@spectra/metering')).BudgetBlockedError(decision);
    }

    const run = await this.prisma.client.campaignOrchestrationRun.create({
      data: {
        ...scope,
        name: input.name,
        status: 'QUEUED',
        input: input as unknown as Prisma.InputJsonValue,
        runKey,
        verticalId: input.verticalId ?? null,
        researchProjectId: input.researchProjectId ?? null,
        brandId: input.brandId ?? null,
        maxAttempts: 3,
        createdById: principal.userId,
      },
      select: RUN_SELECT,
    });

    const jobId = await this.queue.enqueue(
      JOB_NAMES.campaignOrchestrate,
      { runId: run.id, organizationId: tenant.organizationId, workspaceId: tenant.workspaceId },
      {
        idempotencyKey: `orchestration-${run.id}`,
        tenant: scope,
        retry: {
          maxAttempts: 3,
          backoff: { type: 'exponential', delayMs: 10_000, maxDelayMs: 120_000 },
        },
      },
    );
    await this.prisma.client.campaignOrchestrationRun.updateMany({
      where: { ...scope, id: run.id },
      data: { queueJobId: jobId },
    });

    await this.audit.record({
      ...scope,
      actorUserId: principal.userId,
      action: 'campaign.orchestration.queued',
      resourceType: 'CampaignOrchestrationRun',
      resourceId: run.id,
      changes: {
        platforms: input.platforms,
        itemsPerTrend: input.itemsPerTrend,
        generateDrafts: input.generateDrafts,
      },
    });

    return { created: true, run: { ...run, queueJobId: jobId } };
  }

  async cancelRun(tenant: TenantContext, principal: Principal, runId: string) {
    const scope = this.scope(tenant);
    const run = await this.prisma.client.campaignOrchestrationRun.findFirst({
      where: { ...scope, id: runId },
      select: { id: true, status: true, queueJobId: true },
    });
    if (!run) throw new TenantIsolationError('Orchestration run not found');
    if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
      throw new UnprocessableEntityException(
        `This run is already ${run.status.toLowerCase()}; there is nothing to cancel.`,
      );
    }
    await this.prisma.client.campaignOrchestrationRun.updateMany({
      where: { ...scope, id: runId },
      data: { cancelRequestedAt: new Date() },
    });
    let removed = false;
    if (run.queueJobId) removed = await this.queue.cancel(run.queueJobId).catch(() => false);
    if (removed || run.status === 'QUEUED') {
      await this.prisma.client.campaignOrchestrationRun.updateMany({
        where: { ...scope, id: runId, status: { in: ['QUEUED'] } },
        data: { status: 'CANCELLED', failureReason: 'CANCELLED', finishedAt: new Date() },
      });
    }
    await this.audit.record({
      ...scope,
      actorUserId: principal.userId,
      action: 'campaign.orchestration.cancelled',
      resourceType: 'CampaignOrchestrationRun',
      resourceId: runId,
      changes: { removedFromQueue: removed },
    });
    return this.getRun(tenant, runId);
  }

  /**
   * The content a run produced, with each item's evidence lineage resolved.
   * This is the answer to "what is this post based on?".
   */
  async runItems(tenant: TenantContext, runId: string) {
    const { run } = await this.getRun(tenant, runId);
    const results = (run.items ?? []) as Array<{
      contentItemId: string | null;
      title: string;
      outcome: string;
      platform: string;
      evidence: { verdict: string; reason: string; findingIds: string[]; citationIds: string[] };
      note: string | null;
    }>;
    const ids = results.map((result) => result.contentItemId).filter(Boolean) as string[];
    const items = ids.length
      ? await this.prisma.client.contentItem.findMany({
          where: { ...this.scope(tenant), id: { in: ids } },
          select: {
            id: true,
            title: true,
            lifecycleState: true,
            funnelStage: true,
            body: true,
            evidencePackId: true,
            findingIds: true,
            citationIds: true,
            topicKey: true,
          },
        })
      : [];
    const byId = new Map(items.map((item) => [item.id, item]));
    return {
      items: results.map((result) => ({
        ...result,
        contentItem: result.contentItemId ? (byId.get(result.contentItemId) ?? null) : null,
      })),
    };
  }

  private scope(tenant: TenantContext): Scope {
    return { organizationId: tenant.organizationId, workspaceId: tenant.workspaceId as string };
  }
}
