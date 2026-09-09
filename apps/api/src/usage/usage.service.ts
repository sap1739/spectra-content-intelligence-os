import { Injectable } from '@nestjs/common';
import { RATE_VERSION, evaluateBudget } from '@spectra/metering';

import { PrismaService } from '../prisma/prisma.service';
import type { TenantContext } from '../auth/types';

/**
 * Reports REAL metered usage from the ledger. Every number here is either a
 * measured quantity or an explicit estimate — nothing is modelled, projected or
 * filled in. Where a provider never reported tokens, the total stays null and
 * the response says how many events lacked pricing, rather than implying zero.
 */
@Injectable()
export class UsageReportService {
  constructor(private readonly prisma: PrismaService) {}

  async summary(tenant: TenantContext, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);
    const where = {
      organizationId: tenant.organizationId,
      workspaceId: tenant.workspaceId as string,
      occurredAt: { gte: since },
    };

    const [byKind, totals, unpriced, recent, budget] = await Promise.all([
      this.prisma.client.usageEvent.groupBy({
        by: ['kind'],
        where,
        _sum: {
          requests: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          estimatedCostMicros: true,
        },
        _count: { _all: true },
      }),
      this.prisma.client.usageEvent.aggregate({
        where,
        _sum: { estimatedCostMicros: true, requests: true },
        _count: { _all: true },
      }),
      // Events we could not price — reported so the estimate is never mistaken
      // for a complete bill.
      this.prisma.client.usageEvent.count({
        where: { ...where, estimatedCostMicros: null },
      }),
      this.prisma.client.usageEvent.findMany({
        where,
        orderBy: { occurredAt: 'desc' },
        take: 25,
        select: {
          id: true,
          kind: true,
          provider: true,
          model: true,
          requests: true,
          inputTokens: true,
          outputTokens: true,
          totalTokens: true,
          estimatedCostMicros: true,
          resourceType: true,
          resourceId: true,
          occurredAt: true,
        },
      }),
      // Budget status travels with usage so a client never has to infer whether
      // a ceiling exists (it may legitimately be NOT_CONFIGURED).
      evaluateBudget(this.prisma.client, {
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId as string,
      }),
    ]);

    return {
      windowDays: days,
      since: since.toISOString(),
      rateVersion: RATE_VERSION,
      totals: {
        events: totals._count._all,
        requests: totals._sum.requests ?? 0,
        estimatedCostMicros: totals._sum.estimatedCostMicros ?? 0,
        unpricedEvents: unpriced,
      },
      byKind: byKind.map((row) => ({
        kind: row.kind,
        events: row._count._all,
        requests: row._sum.requests ?? 0,
        inputTokens: row._sum.inputTokens,
        outputTokens: row._sum.outputTokens,
        totalTokens: row._sum.totalTokens,
        estimatedCostMicros: row._sum.estimatedCostMicros,
      })),
      recent,
      budget,
      note:
        'Costs are ESTIMATES from a local rate table (' +
        RATE_VERSION +
        '), not vendor invoices. Events with no known rate are counted separately and excluded from the estimate.',
    };
  }
}
