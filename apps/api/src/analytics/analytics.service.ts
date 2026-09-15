import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../auth/types';

/**
 * First-party workspace reporting. Every number here is REAL — counts of the
 * user's own content, drafts, publications, research and trends, labelled
 * FIRST_PARTY_MEASURED. External platform engagement lives in the external
 * analytics read models (ADR-0039); this overview only says whether any has
 * been retrieved, and never fills it in.
 */
@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(tenant: TenantContext) {
    const scope = {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
    };
    const p = this.prisma.client;

    const [
      itemsByState,
      draftsByStatus,
      pubsByStatus,
      runsByStatus,
      findings,
      evidencePacksReady,
      trendsByState,
      externalSnapshots,
    ] = await Promise.all([
      p.contentItem.groupBy({
        by: ['lifecycleState'],
        where: { ...scope, deletedAt: null },
        _count: { _all: true },
      }),
      p.contentDraft.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
      p.contentScheduleEntry.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
      p.researchRun.groupBy({ by: ['status'], where: scope, _count: { _all: true } }),
      p.researchFinding.count({ where: { ...scope, deletedAt: null } }),
      p.evidencePack.count({ where: { ...scope, status: 'READY' } }),
      p.trendCandidate.groupBy({
        by: ['state'],
        where: { ...scope, deletedAt: null },
        _count: { _all: true },
      }),
      p.analyticsMetricValue.count({ where: { ...scope, value: { not: null } } }),
    ]);

    const toMap = <T extends string>(
      rows: Array<{ _count: { _all: number } } & Record<string, unknown>>,
      key: string,
    ): Record<T, number> => {
      const out = {} as Record<T, number>;
      for (const row of rows) {
        out[row[key] as T] = row._count._all;
      }
      return out;
    };
    const sum = (m: Record<string, number>): number => Object.values(m).reduce((a, b) => a + b, 0);

    const funnel = toMap(itemsByState, 'lifecycleState');
    const drafts = toMap(draftsByStatus, 'status');
    const publications = toMap(pubsByStatus, 'status');
    const runs = toMap(runsByStatus, 'status');
    const trends = toMap(trendsByState, 'state');

    return {
      source: 'FIRST_PARTY_MEASURED' as const,
      content: {
        total: sum(funnel),
        byLifecycleState: funnel,
        published: funnel.PUBLISHED ?? 0,
        awaitingReview: (funnel.REVIEW ?? 0) + (funnel.CHANGES_REQUESTED ?? 0),
      },
      drafts: { total: sum(drafts), byStatus: drafts },
      publications: {
        total: sum(publications),
        byStatus: publications,
        // Honest: attempts that could not go out because no adapter is wired.
        unsupported: publications.UNSUPPORTED ?? 0,
      },
      research: {
        runs: sum(runs),
        runsByStatus: runs,
        findings,
        evidencePacksReady,
      },
      trends: { total: sum(trends), byState: trends },
      engagement: {
        externalAvailable: externalSnapshots > 0,
        note:
          externalSnapshots > 0
            ? 'External platform metrics have been retrieved for this workspace — see the external analytics summary, where each metric shows its source, freshness and what is unavailable.'
            : 'External platform engagement (impressions, clicks, likes) is unavailable: no analytics have been retrieved from a connected platform yet. No engagement metrics are fabricated.',
      },
      generatedAt: new Date().toISOString(),
    };
  }
}
