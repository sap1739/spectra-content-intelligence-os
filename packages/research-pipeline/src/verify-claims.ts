import {
  assessFreshness,
  claimClusterKey,
  corroborate,
  decideEligibility,
  detectContradictions,
  type ClaimInput,
  type ClaimSupport,
} from '@spectra/claim-verification';
import type { SpectraPrismaClient } from '@spectra/database';
import type { Logger } from '@spectra/logging';

/**
 * Claim verification stage (ADR-0032).
 *
 * Runs after claims are extracted and before evidence packs are assembled, so a
 * pack is built from claims whose support has actually been assessed rather than
 * from every claim-shaped sentence the pipeline happened to find.
 *
 * Everything here is deterministic and re-runnable: a later run that finds more
 * sources upgrades a claim's standing, and one that finds a conflict downgrades
 * it. Nothing is decided once and frozen.
 */

export interface VerifyClaimsInput {
  organizationId: string;
  workspaceId: string;
  projectId: string;
  now?: Date;
}

export interface VerifyClaimsOutcome {
  claimsAssessed: number;
  eligible: number;
  weak: number;
  requiresReview: number;
  blocked: number;
  contradictionsDetected: number;
}

export async function verifyProjectClaims(
  prisma: SpectraPrismaClient,
  input: VerifyClaimsInput,
  logger?: Logger,
): Promise<VerifyClaimsOutcome> {
  const { organizationId, workspaceId, projectId } = input;
  const now = input.now ?? new Date();

  const claims = await prisma.extractedClaim.findMany({
    where: { organizationId, workspaceId, projectId },
    select: {
      id: true,
      text: true,
      normalizedKey: true,
      claimType: true,
      supportingFindingIds: true,
      evergreen: true,
      reviewStatus: true,
    },
    take: 500,
  });
  if (claims.length === 0) {
    return {
      claimsAssessed: 0,
      eligible: 0,
      weak: 0,
      requiresReview: 0,
      blocked: 0,
      contradictionsDetected: 0,
    };
  }

  // Load the supporting findings' sources in one pass. `snippetOnly` and
  // `duplicateClusterKey` come from Phase 5F and are what make corroboration
  // honest: syndicated copies collapse, snippet support is marked weaker.
  const findingIds = [...new Set(claims.flatMap((c) => c.supportingFindingIds))];
  const findings = findingIds.length
    ? await prisma.researchFinding.findMany({
        where: { organizationId, workspaceId, id: { in: findingIds } },
        select: {
          id: true,
          source: {
            select: {
              id: true,
              publisher: true,
              snippetOnly: true,
              credibilityScore: true,
              publishedAt: true,
              duplicateClusterKey: true,
              duplicateOfSourceId: true,
              evidenceEligible: true,
            },
          },
          citations: { select: { id: true }, take: 1 },
        },
      })
    : [];
  const findingById = new Map(findings.map((f) => [f.id, f]));

  const inputs: ClaimInput[] = claims.map((claim) => ({
    id: claim.id,
    text: claim.text,
    normalizedKey: claim.normalizedKey,
    claimType: claim.claimType,
    evergreen: claim.evergreen,
    supports: claim.supportingFindingIds
      .map((id) => findingById.get(id))
      .filter((f): f is NonNullable<typeof f> => Boolean(f))
      // A source that is not evidence-eligible (blocked domain, injection
      // quarantine, duplicate) cannot support a claim either — otherwise the
      // domain block would be trivially bypassed one layer up.
      .filter((f) => f.source.evidenceEligible)
      .map<ClaimSupport>((f) => ({
        sourceId: f.source.id,
        syndicationKey: f.source.duplicateClusterKey ?? f.source.duplicateOfSourceId,
        publisher: f.source.publisher,
        snippetOnly: f.source.snippetOnly,
        credibilityScore: f.source.credibilityScore,
        publishedAt: f.source.publishedAt,
        ...(f.citations[0]?.id ? { citationId: f.citations[0].id } : {}),
      })),
  }));

  // ----- contradictions ---------------------------------------------------
  const contradictions = detectContradictions(inputs);
  const contradictionCounts = new Map<string, number>();
  for (const c of contradictions) {
    contradictionCounts.set(c.claimId, (contradictionCounts.get(c.claimId) ?? 0) + 1);
    contradictionCounts.set(
      c.conflictingClaimId,
      (contradictionCounts.get(c.conflictingClaimId) ?? 0) + 1,
    );
  }

  for (const contradiction of contradictions) {
    // Surfaced, never hidden. Upsert so a re-run does not duplicate an open
    // conflict, and a human's RESOLVED/DISMISSED decision is not overwritten.
    const existing = await prisma.claimContradiction.findFirst({
      where: {
        claimId: contradiction.claimId,
        conflictingClaimId: contradiction.conflictingClaimId,
      },
      select: { id: true },
    });
    if (existing) continue;
    await prisma.claimContradiction
      .create({
        data: {
          organizationId,
          workspaceId,
          projectId,
          claimId: contradiction.claimId,
          conflictingClaimId: contradiction.conflictingClaimId,
          kind: contradiction.kind,
          detail: contradiction.detail,
        },
      })
      .catch(() => undefined); // unique race on concurrent runs
  }

  // ----- per-claim assessment ---------------------------------------------
  const outcome: VerifyClaimsOutcome = {
    claimsAssessed: inputs.length,
    eligible: 0,
    weak: 0,
    requiresReview: 0,
    blocked: 0,
    contradictionsDetected: contradictions.length,
  };

  for (const claimInput of inputs) {
    const stored = claims.find((c) => c.id === claimInput.id);
    const corroboration = corroborate(claimInput);
    const freshness = assessFreshness(claimInput, now);
    const eligibility = decideEligibility({
      corroboration,
      freshness,
      contradictionCount: contradictionCounts.get(claimInput.id) ?? 0,
      ...(stored?.reviewStatus ? { reviewStatus: stored.reviewStatus } : {}),
    });

    switch (eligibility.decision) {
      case 'ELIGIBLE':
        outcome.eligible += 1;
        break;
      case 'WEAK':
        outcome.weak += 1;
        break;
      case 'REQUIRES_REVIEW':
        outcome.requiresReview += 1;
        break;
      case 'BLOCKED':
        outcome.blocked += 1;
        break;
    }

    await prisma.extractedClaim.update({
      where: { id: claimInput.id },
      data: {
        clusterKey: claimClusterKey(claimInput.text),
        sourceCount: corroboration.corroborationCount,
        independentSourceCount: corroboration.independentSourceCount,
        supportingCitationIds: corroboration.supportingCitationIds,
        confidenceLevel: corroboration.confidenceLevel,
        freshnessStatus: freshness.status,
        latestSupportAt: freshness.latestSupportAt,
        eligibility: eligibility.decision,
        eligibilityReason: eligibility.reason,
        // A claim needing review enters the queue; an existing human decision
        // is never reset by a re-run.
        ...(stored?.reviewStatus === 'NOT_REQUIRED' && eligibility.requiresReview
          ? { reviewStatus: 'PENDING' as const }
          : {}),
        verificationStatus:
          (contradictionCounts.get(claimInput.id) ?? 0)
            ? 'DISPUTED'
            : corroboration.verificationStatus,
      },
    });
  }

  logger?.info({ projectId, ...outcome }, 'Claim verification complete');
  return outcome;
}
