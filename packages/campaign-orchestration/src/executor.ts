import {
  ORCHESTRATION_STAGES,
  type EvidenceAssessment,
  type OrchestrationFailureReason,
  type OrchestrationItemResult,
  type OrchestrationStage,
  type SocialPlatform,
  type StageResult,
  type StartOrchestrationInput,
  startOrchestrationInputSchema,
} from '@spectra/contracts';
import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';
import { reconcile, release, type UsageRecorder } from '@spectra/metering';

import { assessEvidence, cautionGuidance, type GateSource } from './evidence-gate';
import { buildPlan } from './plan';
import { buildStrategy, type EngineTrend } from './strategy-engine';

/**
 * Executing one orchestration run.
 *
 * The run walks eight stages and the row records each one. Three properties the
 * rest of the design hangs on:
 *
 *  1. **Partial is a real outcome.** A failed draft does not kill the run: the
 *     item is recorded with its reason and the rest continue. A run that built
 *     a plan but could not write drafts reports PARTIAL, not SUCCEEDED and not
 *     FAILED.
 *  2. **Evidence decides what is written.** Every planned item carries a
 *     verdict; blocked ones are kept in the plan as blocked, never dropped
 *     silently, and never generated.
 *  3. **Idempotent.** A retry of a run that already produced a campaign adopts
 *     it rather than building a second one.
 */

export interface OrchestrationDeps {
  prisma: SpectraPrismaClient;
  usage?: UsageRecorder;
  logger?: Logger;
  /**
   * Writes one draft for a content item. Omitted — or reporting unavailable —
   * means no text-generation provider is configured, which is a stated outcome
   * rather than a failure.
   */
  generation?: {
    available: boolean;
    /** Why not, when unavailable. Shown to the operator verbatim. */
    reason?: string;
    generateDraft(input: {
      contentItemId: string;
      evidencePackId: string | null;
      guidance: string | null;
    }): Promise<{ status: 'READY' | 'FAILED'; note?: string }>;
  };
  /** Platforms this workspace can actually publish to, by connected account. */
  publishablePlatforms?(tenant: Tenant): Promise<Set<SocialPlatform>>;
  now?: () => Date;
}

export interface OrchestrationContext {
  signal?: AbortSignal;
  reportProgress?: (percent: number) => Promise<void> | void;
  attempt?: number;
}

export interface OrchestrationResult {
  status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'CANCELLED' | 'SKIPPED';
  runId: string;
  campaignId?: string;
  failureReason?: OrchestrationFailureReason;
  itemsCreated?: number;
  itemsDrafted?: number;
  itemsBlocked?: number;
  skipped?: boolean;
}

interface Tenant {
  organizationId: string;
  workspaceId: string;
}

class StageError extends Error {
  readonly reason: OrchestrationFailureReason;
  constructor(reason: OrchestrationFailureReason, message: string) {
    super(message);
    this.name = 'StageError';
    this.reason = reason;
  }
}

function boundedDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return detail.replace(/\s+/g, ' ').trim().slice(0, 500) || null;
}

/** Tracks per-stage state so the run row always says where it got to. */
class StageLog {
  private readonly stages: StageResult[] = ORCHESTRATION_STAGES.map((stage) => ({
    stage,
    status: 'PENDING' as const,
    note: null,
    startedAt: null,
    finishedAt: null,
  }));

  constructor(private readonly now: () => Date) {}

  start(stage: OrchestrationStage): void {
    this.patch(stage, { status: 'RUNNING', startedAt: this.now().toISOString() });
  }

  succeed(stage: OrchestrationStage, note?: string): void {
    this.patch(stage, {
      status: 'SUCCEEDED',
      note: note ?? null,
      finishedAt: this.now().toISOString(),
    });
  }

  skip(stage: OrchestrationStage, note: string): void {
    this.patch(stage, { status: 'SKIPPED', note, finishedAt: this.now().toISOString() });
  }

  fail(stage: OrchestrationStage, note: string): void {
    this.patch(stage, { status: 'FAILED', note, finishedAt: this.now().toISOString() });
  }

  snapshot(): StageResult[] {
    return this.stages.map((stage) => ({ ...stage }));
  }

  /** 0–100 from the stages that have finished. */
  percent(): number {
    const done = this.stages.filter(
      (stage) => stage.status === 'SUCCEEDED' || stage.status === 'SKIPPED',
    ).length;
    return Math.round((done / this.stages.length) * 100);
  }

  private patch(stage: OrchestrationStage, patch: Partial<StageResult>): void {
    const index = this.stages.findIndex((candidate) => candidate.stage === stage);
    if (index >= 0) this.stages[index] = { ...this.stages[index]!, ...patch };
  }
}

export async function executeOrchestration(
  deps: OrchestrationDeps,
  runId: string,
  context: OrchestrationContext = {},
): Promise<OrchestrationResult> {
  const now = deps.now ?? (() => new Date());
  const { prisma } = deps;

  const run = await prisma.campaignOrchestrationRun.findUnique({ where: { id: runId } });
  if (!run) return { status: 'SKIPPED', runId, skipped: true };

  const tenant: Tenant = {
    organizationId: run.organizationId,
    workspaceId: run.workspaceId,
  };

  if (run.status !== 'QUEUED' && run.status !== 'RUNNING') {
    return { status: 'SKIPPED', runId, skipped: true };
  }
  if (run.cancelRequestedAt) {
    await finishFailed(deps, tenant, run.id, 'CANCELLED', null, now());
    return { status: 'CANCELLED', runId, failureReason: 'CANCELLED' };
  }

  const stages = new StageLog(now);
  const reservationKey = `orchestration-${run.id}`;
  let reservationSettled = false;

  await prisma.campaignOrchestrationRun.updateMany({
    where: { ...tenant, id: run.id },
    data: {
      status: 'RUNNING',
      startedAt: run.startedAt ?? now(),
      attempt: context.attempt ?? run.attempt + 1,
      stages: stages.snapshot() as unknown as object,
    },
  });

  const save = async (patch: Record<string, unknown>) => {
    await prisma.campaignOrchestrationRun
      .updateMany({
        where: { ...tenant, id: run.id },
        data: {
          ...patch,
          stages: stages.snapshot() as unknown as object,
          progressPercent: stages.percent(),
        },
      })
      .catch(() => undefined);
    void context.reportProgress?.(stages.percent());
  };

  const abortIfCancelled = async () => {
    if (context.signal?.aborted) throw new StageError('CANCELLED', 'The run was cancelled.');
    const fresh = await prisma.campaignOrchestrationRun.findFirst({
      where: { ...tenant, id: run.id },
      select: { cancelRequestedAt: true },
    });
    if (fresh?.cancelRequestedAt) {
      throw new StageError('CANCELLED', 'The run was cancelled.');
    }
  };

  try {
    const input = startOrchestrationInputSchema.parse(run.input);

    // ---- 1. inputs -------------------------------------------------------
    stages.start('RESOLVE_INPUTS');
    const resolved = await resolveInputs(deps, tenant, input);
    stages.succeed(
      'RESOLVE_INPUTS',
      `Starting from ${resolved.vertical ? `vertical “${resolved.vertical.name}”` : `research project “${resolved.researchProjectName}”`}.`,
    );
    await save({});

    // ---- 2. trends -------------------------------------------------------
    await abortIfCancelled();
    stages.start('SELECT_TRENDS');
    const { trends, projectByTrend } = await selectTrends(
      deps,
      tenant,
      input,
      resolved.researchProjectId,
    );
    if (trends.length === 0) {
      throw new StageError(
        'NO_TRENDS_SELECTED',
        `No trend scored at or above ${input.minTrendScore} for this ${input.verticalId ? 'vertical' : 'project'}.`,
      );
    }
    stages.succeed('SELECT_TRENDS', `${trends.length} trend(s) selected.`);
    await save({ trendCandidateIds: trends.map((trend) => trend.id) });

    // ---- 3. strategy -----------------------------------------------------
    await abortIfCancelled();
    stages.start('BUILD_STRATEGY');
    const publishable = (await deps.publishablePlatforms?.(tenant)) ?? new Set<SocialPlatform>();
    const strategy = buildStrategy({
      vertical: resolved.vertical,
      researchProjectName: resolved.researchProjectName,
      trends,
      personas: resolved.personas,
      platforms: input.platforms,
      itemsPerTrend: input.itemsPerTrend,
      publishablePlatforms: publishable,
      brandName: resolved.brandName,
    });
    const writable = strategy.topicIdeas.filter((idea) => idea.evidence.action !== 'BLOCK');
    if (writable.length === 0) {
      await save({ strategy: strategy as unknown as object });
      throw new StageError(
        'ALL_ITEMS_BLOCKED',
        'Every topic was blocked by the evidence gate; no campaign was built.',
      );
    }
    stages.succeed(
      'BUILD_STRATEGY',
      `${strategy.objectives.length} objective(s), ${strategy.pillars.length} pillar(s), ${writable.length} writable topic(s).`,
    );
    await save({ strategy: strategy as unknown as object });

    // ---- 4. plan ---------------------------------------------------------
    await abortIfCancelled();
    stages.start('BUILD_PLAN');
    const plan = buildPlan({
      strategy,
      platforms: input.platforms,
      startAt: new Date(input.startAt),
      durationDays: input.durationDays,
      timezone: input.timezone,
    });
    stages.succeed(
      'BUILD_PLAN',
      `${plan.items.length} item(s) planned, ${plan.blocked.length} blocked.`,
    );
    await save({
      plan: plan as unknown as object,
      itemsPlanned: plan.items.length,
      itemsBlocked: plan.blocked.length,
    });

    // ---- 5. calendar + campaign -----------------------------------------
    await abortIfCancelled();
    stages.start('BUILD_CALENDAR');
    const campaignId = await ensureCampaign(deps, tenant, run, input, plan.startAt, plan.endAt);
    stages.succeed('BUILD_CALENDAR', `Campaign window ${plan.startAt} → ${plan.endAt}.`);
    await save({ campaignId });

    // ---- 6. content items ------------------------------------------------
    await abortIfCancelled();
    stages.start('CREATE_ITEMS');
    const results: OrchestrationItemResult[] = [];
    for (const blockedItem of plan.blocked) {
      results.push({
        key: `blocked-${results.length + 1}`,
        title: blockedItem.title,
        outcome: 'BLOCKED',
        contentItemId: null,
        scheduleEntryId: null,
        platform: input.platforms[0]!,
        evidence: blockedItem.evidence,
        note: blockedItem.evidence.reason,
      });
    }

    for (const item of plan.items) {
      const contentItemId = await createContentItem(
        deps,
        tenant,
        run,
        campaignId,
        item,
        resolved,
        projectByTrend,
      );
      results.push({
        key: item.key,
        title: item.title,
        outcome: 'CREATED',
        contentItemId,
        scheduleEntryId: null,
        platform: item.platform,
        evidence: item.evidence,
        note: null,
      });
    }
    stages.succeed('CREATE_ITEMS', `${plan.items.length} content item(s) created.`);
    await save({ items: results as unknown as object, itemsCreated: plan.items.length });

    // ---- 7. drafts -------------------------------------------------------
    let drafted = 0;
    let generationFailed = 0;
    if (!input.generateDrafts) {
      stages.skip('GENERATE_DRAFTS', 'Drafting was not requested for this run.');
    } else if (!deps.generation?.available) {
      // Honest, and not a failure: the plan, calendar, items and evidence links
      // are all real. Only the prose is missing, and the reason is recorded.
      const reason =
        deps.generation?.reason ?? 'No text-generation provider is configured in this deployment.';
      for (const result of results) {
        if (result.outcome !== 'CREATED') continue;
        result.outcome = 'GENERATION_UNAVAILABLE';
        result.note = reason;
      }
      stages.skip('GENERATE_DRAFTS', reason);
    } else {
      stages.start('GENERATE_DRAFTS');
      for (const result of results) {
        if (result.outcome !== 'CREATED' || !result.contentItemId) continue;
        await abortIfCancelled();
        try {
          const outcome = await deps.generation.generateDraft({
            contentItemId: result.contentItemId,
            evidencePackId: result.evidence.evidencePackId ?? null,
            guidance: cautionGuidance(result.evidence),
          });
          if (outcome.status === 'READY') {
            result.outcome = 'DRAFTED';
            drafted += 1;
          } else {
            // A failed draft is recorded and the run continues: one provider
            // hiccup must not discard a whole campaign.
            result.outcome = 'GENERATION_FAILED';
            result.note = boundedDetail(outcome.note) ?? 'The provider did not return a draft.';
            generationFailed += 1;
          }
        } catch (error: unknown) {
          if (error instanceof StageError) throw error;
          result.outcome = 'GENERATION_FAILED';
          result.note = boundedDetail(error instanceof Error ? error.message : String(error));
          generationFailed += 1;
        }
        await save({
          items: results as unknown as object,
          itemsDrafted: drafted,
          itemsFailed: generationFailed,
        });
      }
      if (drafted === 0 && generationFailed > 0) {
        stages.fail('GENERATE_DRAFTS', `All ${generationFailed} draft(s) failed.`);
      } else {
        stages.succeed('GENERATE_DRAFTS', `${drafted} drafted, ${generationFailed} failed.`);
      }
    }
    await save({
      items: results as unknown as object,
      itemsDrafted: drafted,
      itemsFailed: generationFailed,
    });

    // ---- 8. review -------------------------------------------------------
    stages.start('ROUTE_FOR_REVIEW');
    // Items go to review, never straight to scheduled: a human approves before
    // anything is queued to publish (ADR-0043).
    const reviewable = results.filter((result) => result.outcome === 'DRAFTED');
    if (reviewable.length > 0) {
      await prisma.contentItem.updateMany({
        where: {
          ...tenant,
          id: { in: reviewable.map((result) => result.contentItemId!).filter(Boolean) },
        },
        data: { lifecycleState: 'REVIEW' },
      });
    }
    stages.succeed(
      'ROUTE_FOR_REVIEW',
      `${reviewable.length} item(s) routed for review. Approved items are scheduled separately.`,
    );

    reservationSettled = true;
    await reconcile(prisma, tenant, reservationKey).catch(() => undefined);
    await deps.usage?.record(tenant, {
      kind: 'CONTENT_DRAFT',
      provider: 'spectra-orchestration',
      requests: Math.max(1, drafted),
      resourceType: 'ORCHESTRATION_RUN',
      resourceId: run.id,
      metadata: { planned: plan.items.length, drafted, blocked: plan.blocked.length },
    });

    // A run that produced everything it set out to is SUCCEEDED; one that
    // produced some of it is PARTIAL. The distinction is the point.
    const partial =
      plan.blocked.length > 0 ||
      generationFailed > 0 ||
      results.some((result) => result.outcome === 'GENERATION_UNAVAILABLE');
    const status = partial ? 'PARTIAL' : 'SUCCEEDED';

    await prisma.campaignOrchestrationRun.updateMany({
      where: { ...tenant, id: run.id },
      data: {
        status,
        progressPercent: 100,
        finishedAt: now(),
        failureReason: null,
        failureDetail: null,
        stages: stages.snapshot() as unknown as object,
        items: results as unknown as object,
        itemsCreated: plan.items.length,
        itemsDrafted: drafted,
        itemsBlocked: plan.blocked.length,
        itemsFailed: generationFailed,
        campaignId,
      },
    });

    return {
      status,
      runId,
      campaignId,
      itemsCreated: plan.items.length,
      itemsDrafted: drafted,
      itemsBlocked: plan.blocked.length,
    };
  } catch (error: unknown) {
    const reason =
      error instanceof StageError
        ? error.reason
        : context.signal?.aborted
          ? 'CANCELLED'
          : 'INTERNAL_ERROR';
    const detail = boundedDetail(error instanceof Error ? error.message : String(error));

    // Mark whichever stage was running as failed, so the row says where it stopped.
    const running = stages.snapshot().find((stage) => stage.status === 'RUNNING');
    if (running) stages.fail(running.stage, detail ?? 'Failed.');

    deps.logger?.warn(
      { runId, reason, organizationId: tenant.organizationId },
      'Campaign orchestration did not complete',
    );
    await finishFailed(deps, tenant, run.id, reason, detail, now(), stages.snapshot());
    return {
      status: reason === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
      runId,
      failureReason: reason,
    };
  } finally {
    if (!reservationSettled) {
      await release(prisma, tenant, reservationKey).catch(() => undefined);
    }
  }
}

interface ResolvedInputs {
  vertical: {
    id: string;
    name: string;
    description: string | null;
    keywords: string[];
    audiences: string[];
  } | null;
  researchProjectId: string | null;
  researchProjectName: string | null;
  brandName: string | null;
  personas: Array<{
    id: string;
    name: string;
    description: string | null;
    painPoints: string[];
    preferredPlatforms: SocialPlatform[];
  }>;
}

async function resolveInputs(
  deps: OrchestrationDeps,
  tenant: Tenant,
  input: StartOrchestrationInput,
): Promise<ResolvedInputs> {
  const vertical = input.verticalId
    ? await deps.prisma.customVertical.findFirst({
        where: { ...tenant, id: input.verticalId, deletedAt: null },
        select: { id: true, name: true, description: true, keywords: true },
      })
    : null;
  if (input.verticalId && !vertical) {
    throw new StageError('INPUTS_UNAVAILABLE', 'The vertical for this campaign is unavailable.');
  }

  const project = input.researchProjectId
    ? await deps.prisma.researchProject.findFirst({
        where: { ...tenant, id: input.researchProjectId },
        select: { id: true, name: true },
      })
    : null;
  if (input.researchProjectId && !project) {
    throw new StageError(
      'INPUTS_UNAVAILABLE',
      'The research project for this campaign is unavailable.',
    );
  }

  const brand = input.brandId
    ? await deps.prisma.brand.findFirst({
        where: { ...tenant, id: input.brandId },
        select: { name: true },
      })
    : null;

  return {
    vertical: vertical
      ? {
          id: vertical.id,
          name: vertical.name,
          description: vertical.description,
          keywords: vertical.keywords,
          audiences: [],
        }
      : null,
    researchProjectId: project?.id ?? null,
    researchProjectName: project?.name ?? null,
    brandName: brand?.name ?? null,
    personas: [],
  };
}

/**
 * Selects trends, then judges each one's evidence. A trend with nothing behind
 * it is still selected — and still appears in the plan as blocked, so the
 * operator sees that it was considered and why it was refused.
 */
async function selectTrends(
  deps: OrchestrationDeps,
  tenant: Tenant,
  input: StartOrchestrationInput,
  researchProjectId: string | null,
): Promise<{ trends: EngineTrend[]; projectByTrend: Map<string, string> }> {
  const where = {
    ...tenant,
    deletedAt: null,
    ...(input.trendCandidateIds.length > 0
      ? { id: { in: [...input.trendCandidateIds] } }
      : {
          normalizedScore: { gte: input.minTrendScore },
          ...(input.verticalId ? { verticalId: input.verticalId } : {}),
          ...(researchProjectId ? { projectId: researchProjectId } : {}),
        }),
  };

  const candidates = await deps.prisma.trendCandidate.findMany({
    where,
    orderBy: { normalizedScore: 'desc' },
    take: input.maxTrends,
    select: {
      id: true,
      title: true,
      summary: true,
      topicKey: true,
      normalizedScore: true,
      projectId: true,
      findingIds: true,
    },
  });

  const trends: EngineTrend[] = [];
  const projectByTrend = new Map<string, string>();
  for (const candidate of candidates) {
    // A run started from a vertical still records the project its evidence
    // came from, so every item's lineage reaches back to the research.
    if (candidate.projectId) projectByTrend.set(candidate.id, candidate.projectId);
    trends.push({
      id: candidate.id,
      title: candidate.title,
      summary: candidate.summary,
      topicKey: candidate.topicKey,
      normalizedScore: candidate.normalizedScore,
      evidence: await assessTrendEvidence(deps, tenant, candidate),
    });
  }
  return { trends, projectByTrend };
}

/** Gathers one trend's evidence and runs it through the gate. */
async function assessTrendEvidence(
  deps: OrchestrationDeps,
  tenant: Tenant,
  candidate: {
    id: string;
    topicKey: string | null;
    projectId: string | null;
    findingIds: string[];
  },
): Promise<EvidenceAssessment> {
  const pack =
    candidate.projectId && candidate.topicKey
      ? await deps.prisma.evidencePack.findFirst({
          where: {
            ...tenant,
            projectId: candidate.projectId,
            topicKey: candidate.topicKey,
          },
          select: { id: true, findingIds: true, citationIds: true, claimIds: true },
        })
      : null;

  const findingIds = pack?.findingIds ?? candidate.findingIds;
  if (findingIds.length === 0) {
    return assessEvidence({
      evidencePackId: pack?.id ?? null,
      findingIds: [],
      citationIds: pack?.citationIds ?? [],
      claimIds: pack?.claimIds ?? [],
      sources: [],
      contradictionCount: 0,
      strongestConfidence: 'UNKNOWN',
    });
  }

  const findings = await deps.prisma.researchFinding.findMany({
    where: { ...tenant, id: { in: findingIds } },
    select: {
      id: true,
      source: {
        select: {
          snippetOnly: true,
          publishedAt: true,
          publisher: true,
          url: true,
          evidenceEligible: true,
        },
      },
    },
    take: 60,
  });

  const sources: GateSource[] = findings.map((finding) => ({
    snippetOnly: finding.source.snippetOnly,
    publishedAt: finding.source.publishedAt,
    // Fall back to the host when a publisher was never recorded, so two
    // articles from one site are not counted as independent sources.
    publisher: finding.source.publisher ?? hostOf(finding.source.url),
    evidenceEligible: finding.source.evidenceEligible,
  }));

  const claims = pack?.claimIds.length
    ? await deps.prisma.extractedClaim.findMany({
        where: { ...tenant, id: { in: pack.claimIds } },
        select: {
          confidenceLevel: true,
          independentSourceCount: true,
          _count: { select: { contradictions: true } },
        },
        take: 50,
      })
    : [];

  const order = ['UNKNOWN', 'LOW', 'MEDIUM', 'HIGH'] as const;
  let strongest: 'HIGH' | 'MEDIUM' | 'LOW' | 'CONTESTED' | 'UNKNOWN' = 'UNKNOWN';
  let contradictionCount = 0;
  for (const claim of claims) {
    contradictionCount += claim._count.contradictions;
    if (claim.confidenceLevel === 'CONTESTED') {
      strongest = 'CONTESTED';
      continue;
    }
    if (strongest === 'CONTESTED') continue;
    const current = order.indexOf(strongest as (typeof order)[number]);
    const next = order.indexOf(claim.confidenceLevel as (typeof order)[number]);
    if (next > current) strongest = claim.confidenceLevel as typeof strongest;
  }

  return assessEvidence({
    evidencePackId: pack?.id ?? null,
    findingIds: findings.map((finding) => finding.id),
    citationIds: pack?.citationIds ?? [],
    claimIds: pack?.claimIds ?? [],
    sources,
    contradictionCount,
    strongestConfidence: strongest,
  });
}

/** The host of a URL, used only to count source independence. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return null;
  }
}

/** Creates the campaign once; a retry adopts the one the run already made. */
async function ensureCampaign(
  deps: OrchestrationDeps,
  tenant: Tenant,
  run: { id: string; campaignId: string | null; name: string; createdById: string | null },
  input: StartOrchestrationInput,
  startAt: string,
  endAt: string,
): Promise<string> {
  if (run.campaignId) {
    const existing = await deps.prisma.campaign.findFirst({
      where: { ...tenant, id: run.campaignId },
      select: { id: true },
    });
    if (existing) return existing.id;
  }
  const campaign = await deps.prisma.campaign.create({
    data: {
      ...tenant,
      name: run.name,
      description: `Built by a research-backed orchestration run on ${new Date().toISOString().slice(0, 10)}.`,
      status: 'PLANNED',
      timezone: input.timezone,
      startAt: new Date(startAt),
      endAt: new Date(endAt),
      brandId: input.brandId ?? null,
      verticalId: input.verticalId ?? null,
      createdById: run.createdById,
    },
    select: { id: true },
  });
  return campaign.id;
}

/** One content item, carrying its full lineage back to the evidence. */
async function createContentItem(
  deps: OrchestrationDeps,
  tenant: Tenant,
  run: { createdById: string | null },
  campaignId: string,
  item: {
    title: string;
    topicKey: string | null;
    platform: SocialPlatform;
    funnelStage: string;
    evidence: EvidenceAssessment;
    cta: string | null;
    trendCandidateId: string | null;
  },
  resolved: ResolvedInputs,
  projectByTrend: Map<string, string>,
): Promise<string> {
  const created = await deps.prisma.contentItem.create({
    data: {
      ...tenant,
      campaignId,
      title: item.title,
      contentType: 'POST',
      lifecycleState: 'IDEA',
      funnelStage: item.funnelStage as never,
      objective: item.cta,
      verticalId: resolved.vertical?.id ?? null,
      // Lineage: never fabricated, always the ids the gate actually saw.
      evidencePackId: item.evidence.evidencePackId ?? null,
      // The run's own project when it named one, else the project the trend's
      // evidence came from — lineage reaches the research either way.
      researchProjectId:
        resolved.researchProjectId ??
        (item.trendCandidateId ? (projectByTrend.get(item.trendCandidateId) ?? null) : null),
      topicKey: item.topicKey,
      findingIds: item.evidence.findingIds,
      citationIds: item.evidence.citationIds,
      createdById: run.createdById,
    },
    select: { id: true },
  });

  // Forward lineage, so a pack knows what consumed it.
  if (item.evidence.evidencePackId) {
    await deps.prisma.evidencePack
      .updateMany({
        where: { ...tenant, id: item.evidence.evidencePackId },
        data: { usedByContentItemIds: { push: created.id } },
      })
      .catch(() => undefined);
  }
  return created.id;
}

async function finishFailed(
  deps: OrchestrationDeps,
  tenant: Tenant,
  runId: string,
  reason: OrchestrationFailureReason,
  detail: string | null,
  at: Date,
  stages?: StageResult[],
): Promise<void> {
  await deps.prisma.campaignOrchestrationRun
    .updateMany({
      where: { ...tenant, id: runId },
      data: {
        status: reason === 'CANCELLED' ? 'CANCELLED' : 'FAILED',
        finishedAt: at,
        failureReason: reason,
        failureDetail: detail,
        ...(stages ? { stages: stages as unknown as object } : {}),
      },
    })
    .catch(() => undefined);
}
