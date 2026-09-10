import type { TextGenerationProvider } from '@spectra/ai-core';
import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';
import { preflight, reconcile, release, type UsageRecorder } from '@spectra/metering';

import { validateCitations } from './citations';
import { generateDraft } from './generator';
import type { DraftEvidence, GroundingCitation, GroundingClaim, GroundingFinding } from './types';

export interface ContentDraftDeps {
  prisma: SpectraPrismaClient;
  provider: TextGenerationProvider;
  logger?: Logger;
  /** Records real provider spend; omitted means no ledger. */
  usage?: UsageRecorder;
}

export interface ExecuteContentDraftInput {
  draftId: string;
}

export interface ContentDraftOutcome {
  status: 'READY' | 'FAILED' | 'SKIPPED';
  draftId: string;
}

interface Tenant {
  organizationId: string;
  workspaceId: string;
}

/** Assembles grounding evidence for a draft from its evidence pack. */
async function loadEvidence(
  prisma: SpectraPrismaClient,
  tenant: Tenant,
  packId: string,
): Promise<DraftEvidence | null> {
  const pack = await prisma.evidencePack.findFirst({
    where: { id: packId, organizationId: tenant.organizationId, workspaceId: tenant.workspaceId },
  });
  if (!pack) return null;

  const findingRows = pack.findingIds.length
    ? await prisma.researchFinding.findMany({
        where: {
          id: { in: pack.findingIds },
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          // Never ground generated content on a source that is ineligible as
          // evidence — a blocked domain, an injection-quarantined page, or a
          // duplicate whose original already carries the evidence (ADR-0030).
          source: { evidenceEligible: true },
        },
        select: {
          id: true,
          summary: true,
          excerpt: true,
          source: {
            select: {
              url: true,
              title: true,
              publisher: true,
              snippetOnly: true,
              credibilityScore: true,
            },
          },
        },
        // Over-fetch so the ranking below has something to choose from.
        take: 40,
      })
    : [];

  // Prefer fully-retrieved, more credible evidence. Snippet-only findings are
  // real but weaker, so they fill remaining slots rather than displacing an
  // article we actually read.
  const rankedFindings = [...findingRows]
    .sort((a, b) => {
      if (a.source.snippetOnly !== b.source.snippetOnly) return a.source.snippetOnly ? 1 : -1;
      return (b.source.credibilityScore ?? 0.5) - (a.source.credibilityScore ?? 0.5);
    })
    .slice(0, 12);

  // Claims, strongest first. A pack only ever carries ELIGIBLE/WEAK claims
  // (ADR-0032), but generation still prefers corroborated ones and marks the
  // rest so the draft can say when a statement rests on limited evidence.
  const claimRows = pack.claimIds.length
    ? await prisma.extractedClaim.findMany({
        where: {
          id: { in: pack.claimIds },
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
          // Belt and braces: even if a pack went stale, a claim the system has
          // since judged unusable must never reach the model.
          eligibility: { in: ['ELIGIBLE', 'WEAK'] },
        },
        select: {
          id: true,
          text: true,
          eligibility: true,
          confidenceLevel: true,
          independentSourceCount: true,
          supportingCitationIds: true,
        },
        orderBy: [{ eligibility: 'asc' }, { independentSourceCount: 'desc' }],
        take: 12,
      })
    : [];

  const citationRows = pack.citationIds.length
    ? await prisma.citation.findMany({
        where: {
          id: { in: pack.citationIds },
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId,
        },
        select: {
          id: true,
          excerpt: true,
          url: true,
          title: true,
          publisher: true,
          findingId: true,
        },
        take: 12,
      })
    : [];

  const findings: GroundingFinding[] = rankedFindings.map((f) => ({
    id: f.id,
    summary: f.summary,
    excerpt: f.excerpt,
    sourceTitle: f.source.title ?? f.source.publisher,
    sourceUrl: f.source.url,
  }));
  const citations: GroundingCitation[] = citationRows
    .filter((c) => c.excerpt)
    .map((c) => ({
      id: c.id,
      quote: c.excerpt as string,
      sourceTitle: c.title ?? c.publisher,
      sourceUrl: c.url,
      findingId: c.findingId,
    }));

  const claims: GroundingClaim[] = claimRows.map((c) => ({
    id: c.id,
    text: c.text,
    // Surfaced to the prompt so a statement resting on one source can be
    // written as such rather than asserted flatly.
    corroborated: c.eligibility === 'ELIGIBLE',
    independentSourceCount: c.independentSourceCount,
    confidenceLevel: c.confidenceLevel,
  }));

  return {
    packId: pack.id,
    packTitle: pack.title,
    packSummary: pack.summary,
    findings,
    citations,
    claims,
    limitedEvidence: claims.length > 0 && claims.every((c) => !c.corroborated),
  };
}

/**
 * Executes one content draft: loads the GENERATING draft + its item + evidence,
 * generates a grounded draft, validates its citation markers against the
 * supplied sources, and persists everything. Idempotent — a draft that is no
 * longer GENERATING is skipped on re-delivery. Failures are recorded, not
 * swallowed, so a stuck GENERATING row never happens.
 */
export async function executeContentDraft(
  deps: ContentDraftDeps,
  input: ExecuteContentDraftInput,
): Promise<ContentDraftOutcome> {
  const { prisma } = deps;
  const logger = deps.logger?.child({ draftId: input.draftId });

  const draft = await prisma.contentDraft.findUnique({
    where: { id: input.draftId },
    include: { contentItem: true },
  });
  if (!draft) throw new Error(`Content draft ${input.draftId} not found`);
  if (draft.status !== 'GENERATING') {
    logger?.info({ status: draft.status }, 'Draft already finalized — skipping re-delivery');
    return { status: 'SKIPPED', draftId: draft.id };
  }

  const tenant: Tenant = {
    organizationId: draft.organizationId,
    workspaceId: draft.workspaceId,
  };
  // Re-check at execution time: this job may have been queued before the
  // workspace hit its ceiling. Recorded as FAILED without throwing — retrying
  // cannot help until the limit is raised or the period rolls over.
  const budget = await preflight(prisma, {
    organizationId: tenant.organizationId,
    workspaceId: tenant.workspaceId,
    kind: 'CONTENT_DRAFT',
    provider: deps.provider.modelRef.provider,
    model: deps.provider.modelRef.model,
    requests: 1,
  });
  if (budget.blocked) {
    await release(prisma, tenant, `content-draft-${draft.id}`, logger);
    await prisma.contentDraft.update({
      where: { id: draft.id },
      data: { status: 'FAILED', failureReason: budget.reason },
    });
    logger?.warn(
      { outcome: budget.outcome, exceededReason: budget.exceededReason },
      'Draft generation refused — workspace budget exceeded',
    );
    return { status: 'FAILED', draftId: draft.id };
  }

  const item = draft.contentItem;

  try {
    if (!item.evidencePackId) {
      throw new Error('Content item is not grounded on an evidence pack');
    }
    const evidence = await loadEvidence(prisma, tenant, item.evidencePackId);
    if (!evidence) {
      throw new Error('Evidence pack not found for this tenant');
    }

    const result = await generateDraft(deps.provider, {
      tenant,
      contentType: item.contentType,
      title: item.title,
      objective: item.objective,
      funnelStage: item.funnelStage,
      evidence,
    });

    const validation = validateCitations(result.body, result.groundedSourceOrder);
    const status = result.finishReason === 'content_filter' ? 'FAILED' : 'READY';

    const updated = await prisma.contentDraft.update({
      where: { id: draft.id },
      data: {
        status,
        body: result.body,
        citationIds: result.groundedCitationIds,
        findingIds: result.groundedFindingIds,
        modelProvider: result.modelRef.provider,
        modelName: result.modelRef.model,
        modelVersion: result.modelRef.version ?? null,
        promptTemplateId: result.promptTemplateId,
        promptVersion: result.promptVersion,
        usageInputTokens: result.usage?.inputTokens ?? null,
        usageOutputTokens: result.usage?.outputTokens ?? null,
        finishReason: result.finishReason,
        citationValidation: validation as unknown as object,
        ...(status === 'FAILED'
          ? { failureReason: 'The model declined to generate this content.' }
          : {}),
      },
    });

    // Meter the generation from exactly what the provider reported — the same
    // numbers persisted on the draft above, so ledger and draft never disagree.
    if (result.usage) {
      await deps.usage?.record(
        { organizationId: draft.organizationId, workspaceId: draft.workspaceId },
        {
          kind: 'AI_GENERATION',
          provider: result.modelRef.provider,
          model: result.modelRef.model,
          inputTokens: result.usage.inputTokens ?? null,
          outputTokens: result.usage.outputTokens ?? null,
          resourceType: 'CONTENT_DRAFT',
          resourceId: draft.id,
        },
      );
    }

    // Real token usage is in the ledger now; stop the hold counting on top.
    await reconcile(prisma, tenant, `content-draft-${draft.id}`, logger);

    if (updated.status === 'READY') {
      await prisma.contentItem.update({
        where: { id: item.id },
        data: { body: result.body, lifecycleState: 'GENERATED' },
      });
      await prisma.evidencePack.update({
        where: { id: item.evidencePackId },
        data: { usedByContentItemIds: { push: item.id } },
      });
    }

    logger?.info(
      {
        status,
        citations: validation.supportedMarkers.length,
        unsupported: validation.unsupportedMarkers.length,
      },
      'Content draft generated',
    );
    return { status: updated.status as 'READY' | 'FAILED', draftId: draft.id };
  } catch (error) {
    const failureReason = error instanceof Error ? error.message : 'Generation failed';
    await prisma.contentDraft.update({
      where: { id: draft.id },
      data: { status: 'FAILED', failureReason },
    });
    logger?.warn({ err: failureReason }, 'Content draft generation failed');
    return { status: 'FAILED', draftId: draft.id };
  }
}
