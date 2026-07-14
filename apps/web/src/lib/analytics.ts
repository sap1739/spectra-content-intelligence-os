'use client';

import { useQuery } from '@tanstack/react-query';

import { api, type ApiError } from './api';

export interface AnalyticsOverview {
  content: {
    total: number;
    byLifecycleState: Record<string, number>;
    published: number;
    awaitingReview: number;
  };
  drafts: { total: number; byStatus: Record<string, number> };
  publications: { total: number; byStatus: Record<string, number>; unsupported: number };
  research: {
    runs: number;
    runsByStatus: Record<string, number>;
    findings: number;
    evidencePacksReady: number;
  };
  trends: { total: number; byState: Record<string, number> };
  engagement: { externalAvailable: boolean; note: string };
  generatedAt: string;
}

export function useAnalyticsOverview(workspaceId: string) {
  return useQuery<AnalyticsOverview, ApiError>({
    queryKey: ['workspaces', workspaceId, 'analytics-overview'],
    queryFn: () => api.get<AnalyticsOverview>(`/v1/workspaces/${workspaceId}/analytics/overview`),
    staleTime: 15_000,
  });
}
