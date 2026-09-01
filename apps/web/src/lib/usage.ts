'use client';

import { useQuery } from '@tanstack/react-query';

import { api, type ApiError } from './api';

export interface UsageKindRow {
  kind: string;
  events: number;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCostMicros: number | null;
}

export interface UsageEventRow {
  id: string;
  kind: string;
  provider: string;
  model: string | null;
  requests: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  estimatedCostMicros: number | null;
  resourceType: string | null;
  resourceId: string | null;
  occurredAt: string;
}

export interface UsageSummary {
  windowDays: number;
  since: string;
  rateVersion: string;
  totals: {
    events: number;
    requests: number;
    estimatedCostMicros: number;
    unpricedEvents: number;
  };
  byKind: UsageKindRow[];
  recent: UsageEventRow[];
  note: string;
}

export function useUsageSummary(workspaceId: string, days = 30) {
  return useQuery<UsageSummary, ApiError>({
    queryKey: ['usage', workspaceId, days],
    queryFn: () =>
      api.get<UsageSummary>(`/v1/workspaces/${workspaceId}/usage/summary?days=${days}`),
    staleTime: 60_000,
  });
}

/** Micros → display currency. Estimates only — never presented as billed. */
export function formatMicros(micros: number | null): string {
  if (micros === null) return '—';
  if (micros === 0) return '$0.00';
  const dollars = micros / 1_000_000;
  return dollars < 0.01 ? `$${dollars.toFixed(4)}` : `$${dollars.toFixed(2)}`;
}
