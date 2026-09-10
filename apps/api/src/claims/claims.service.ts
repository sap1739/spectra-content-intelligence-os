import { Injectable, NotFoundException } from '@nestjs/common';
import type { ResolveContradictionInput, ReviewClaimInput } from '@spectra/contracts';
import { TenantIsolationError } from '@spectra/security';

import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

/**
 * Claim verification review (ADR-0032).
 *
 * Every read and write is tenant-scoped; a claim from another workspace is
 * indistinguishable from one that does not exist.
 */

const CLAIM_SELECT = {
  id: true,
  text: true,
  claimType: true,
  verificationStatus: true,
  eligibility: true,
  eligibilityReason: true,
  confidenceLevel: true,
  freshnessStatus: true,
  latestSupportAt: true,
  sourceCount: true,
  independentSourceCount: true,
  supportingCitationIds: true,
  supportingFindingIds: true,
  clusterKey: true,
  evergreen: true,
  reviewStatus: true,
  reviewedAt: true,
  createdAt: true,
} as const;

@Injectable()
export class ClaimsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Claims for a project, strongest first. */
  async list(tenant: TenantContext, projectId: string, eligibility?: string) {
    const claims = await this.prisma.client.extractedClaim.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        projectId,
        ...(eligibility ? { eligibility: eligibility as never } : {}),
      },
      orderBy: [{ eligibility: 'asc' }, { independentSourceCount: 'desc' }],
      take: 200,
      select: CLAIM_SELECT,
    });

    const contradictions = await this.prisma.client.claimContradiction.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        projectId,
        status: 'OPEN',
      },
      select: { claimId: true, conflictingClaimId: true, kind: true, detail: true, id: true },
    });

    const byClaim = new Map<string, typeof contradictions>();
    for (const c of contradictions) {
      for (const id of [c.claimId, c.conflictingClaimId]) {
        byClaim.set(id, [...(byClaim.get(id) ?? []), c]);
      }
    }

    return {
      claims: claims.map((claim) => ({
        ...claim,
        contradictions: byClaim.get(claim.id) ?? [],
      })),
      summary: {
        total: claims.length,
        eligible: claims.filter((c) => c.eligibility === 'ELIGIBLE').length,
        weak: claims.filter((c) => c.eligibility === 'WEAK').length,
        requiresReview: claims.filter((c) => c.eligibility === 'REQUIRES_REVIEW').length,
        blocked: claims.filter((c) => c.eligibility === 'BLOCKED').length,
        openContradictions: contradictions.length,
      },
      note: 'Eligibility is computed from independent-source corroboration, contradictions and staleness. Syndicated copies of one story count once.',
    };
  }

  /** The review queue: claims a human must decide on before they can be used. */
  async reviewQueue(tenant: TenantContext) {
    const claims = await this.prisma.client.extractedClaim.findMany({
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        reviewStatus: 'PENDING',
      },
      orderBy: { createdAt: 'asc' },
      take: 100,
      select: { ...CLAIM_SELECT, projectId: true },
    });

    const contradictionCounts = await this.prisma.client.claimContradiction.groupBy({
      by: ['claimId'],
      where: {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
        status: 'OPEN',
      },
      _count: { _all: true },
    });
    const counts = new Map(contradictionCounts.map((c) => [c.claimId, c._count._all]));

    return {
      items: claims.map((claim) => ({
        claimId: claim.id,
        projectId: claim.projectId,
        text: claim.text,
        decision: claim.eligibility,
        reason: claim.eligibilityReason,
        confidenceLevel: claim.confidenceLevel,
        freshnessStatus: claim.freshnessStatus,
        independentSourceCount: claim.independentSourceCount,
        contradictionCount: counts.get(claim.id) ?? 0,
        reviewStatus: claim.reviewStatus,
      })),
      total: claims.length,
    };
  }

  /**
   * Records a human decision. The decision is authoritative — it overrides the
   * automated assessment — and is appended to an immutable review log.
   */
  async review(
    tenant: TenantContext,
    principal: Principal,
    claimId: string,
    input: ReviewClaimInput,
  ) {
    const claim = await this.prisma.client.extractedClaim.findFirst({
      where: {
        id: claimId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
      },
      select: { id: true },
    });
    // Missing and foreign resources are indistinguishable — no existence leak.
    if (!claim) throw new TenantIsolationError();

    const nextStatus =
      input.action === 'APPROVE'
        ? 'APPROVED'
        : input.action === 'REJECT'
          ? 'REJECTED'
          : 'MORE_RESEARCH_REQUESTED';
    const nextEligibility =
      input.action === 'APPROVE'
        ? 'ELIGIBLE'
        : input.action === 'REJECT'
          ? 'BLOCKED'
          : 'REQUIRES_REVIEW';
    const reason =
      input.action === 'APPROVE'
        ? 'A reviewer approved this claim despite its automated assessment.'
        : input.action === 'REJECT'
          ? 'A reviewer rejected this claim, so it cannot ground generated content.'
          : 'A reviewer asked for more research before this claim is used.';

    const [updated] = await this.prisma.client.$transaction([
      this.prisma.client.extractedClaim.update({
        where: { id: claimId },
        data: {
          reviewStatus: nextStatus,
          eligibility: nextEligibility,
          eligibilityReason: reason,
          reviewedById: principal.userId,
          reviewedAt: new Date(),
          ...(input.action === 'REJECT' ? { verificationStatus: 'REJECTED' as const } : {}),
        },
        select: CLAIM_SELECT,
      }),
      // Append-only: the log keeps every decision, including reversals.
      this.prisma.client.claimReview.create({
        data: {
          organizationId: tenant.organizationId,
          workspaceId: tenant.workspaceId as string,
          claimId,
          action: input.action,
          note: input.note ?? null,
          reviewerId: principal.userId,
        },
      }),
    ]);

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: `claim.${input.action.toLowerCase()}`,
      resourceType: 'ExtractedClaim',
      resourceId: claimId,
      changes: { action: input.action, eligibility: nextEligibility },
    });

    return updated;
  }

  /** Full decision history for one claim. */
  async reviewHistory(tenant: TenantContext, claimId: string) {
    const claim = await this.prisma.client.extractedClaim.findFirst({
      where: {
        id: claimId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
      },
      select: { id: true },
    });
    if (!claim) throw new TenantIsolationError();

    return this.prisma.client.claimReview.findMany({
      where: {
        claimId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: { id: true, action: true, note: true, reviewerId: true, createdAt: true },
    });
  }

  /** Marks a contradiction resolved or dismissed. Never deletes it. */
  async resolveContradiction(
    tenant: TenantContext,
    principal: Principal,
    contradictionId: string,
    input: ResolveContradictionInput,
  ) {
    const existing = await this.prisma.client.claimContradiction.findFirst({
      where: {
        id: contradictionId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
      },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Contradiction not found');

    const updated = await this.prisma.client.claimContradiction.update({
      where: { id: contradictionId },
      data: {
        status: input.status,
        resolvedById: principal.userId,
        resolvedAt: new Date(),
      },
    });

    await this.audit.record({
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId,
      actorUserId: principal.userId,
      action: `claim_contradiction.${input.status.toLowerCase()}`,
      resourceType: 'ClaimContradiction',
      resourceId: contradictionId,
      changes: { status: input.status, note: input.note ?? null },
    });
    return updated;
  }
}
