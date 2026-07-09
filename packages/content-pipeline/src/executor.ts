import type { TextGenerationProvider } from '@spectra/ai-core';
import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';

import { validateCitations } from './citations';
import { generateDraft } from './generator';
import type { DraftEvidence, GroundingCitation, GroundingFinding } from './types';

export interface ContentDraftDeps {
  prisma: SpectraPrismaClient;
  provider: TextGenerationProvider;
  logger?: Logger;
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
        },
        select: {
          id: true,
          summary: true,
          excerpt: true,
          source: { select: { url: true, title: true, publisher: true } },
        },
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

  const findings: GroundingFinding[] = findingRows.map((f) => ({
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

  return { packId: pack.id, packTitle: pack.title, packSummary: pack.summary, findings, citations };
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
