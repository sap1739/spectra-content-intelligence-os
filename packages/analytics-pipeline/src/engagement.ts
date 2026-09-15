import { measuredEngagementSignal, type MeasuredEngagementSignal } from '@spectra/trend-core';
import type { SpectraPrismaClient } from '@spectra/database';

import { toMetric } from './queries';

/**
 * Measured engagement for a research topic (ADR-0039): the latest platform
 * snapshot of each published post whose content item carries this topic key,
 * pooled into one signal. No posts, or no denominators, is UNAVAILABLE —
 * the trend score then ignores the signal instead of counting zero.
 */
export async function measuredEngagementForTopic(
  prisma: SpectraPrismaClient,
  scope: { organizationId: string; workspaceId: string },
  topicKey: string,
): Promise<MeasuredEngagementSignal> {
  const rows = await prisma.analyticsSnapshot.findMany({
    where: {
      ...scope,
      level: 'CONTENT',
      contentItem: { topicKey, deletedAt: null },
    },
    include: { metrics: true },
    orderBy: { retrievedAt: 'desc' },
    take: 500,
  });
  const seen = new Set<string>();
  const latest = rows.filter((row) => {
    const key = row.scheduleEntryId ?? row.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return measuredEngagementSignal(latest.map((row) => ({ metrics: row.metrics.map(toMetric) })));
}
