'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

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

export type BudgetStatus = 'NOT_CONFIGURED' | 'OK' | 'WARN' | 'EXCEEDED';
export type BudgetEnforcement = 'OFF' | 'WARN' | 'ENFORCE';

export interface BudgetDecision {
  status: BudgetStatus;
  enforcement: BudgetEnforcement;
  blocked: boolean;
  periodStart: string;
  periodEnd: string;
  limitMicros: number | null;
  usedMicros: number;
  remainingMicros: number | null;
  usedPercent: number | null;
  unpricedEvents: number;
  currency: string;
  reason: string;
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
  budget: BudgetDecision;
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

export function useBudget(workspaceId: string) {
  return useQuery<BudgetDecision, ApiError>({
    queryKey: ['budget', workspaceId],
    queryFn: () => api.get<BudgetDecision>(`/v1/workspaces/${workspaceId}/budget`),
    staleTime: 60_000,
  });
}

export interface UpdateBudgetInput {
  monthlyLimitMicros: number | null;
  enforcement: BudgetEnforcement;
  warnAtPercent: number;
}

export function useUpdateBudget(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<BudgetDecision, ApiError, UpdateBudgetInput>({
    mutationFn: (input) => api.put<BudgetDecision>(`/v1/workspaces/${workspaceId}/budget`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['budget', workspaceId] });
      void qc.invalidateQueries({ queryKey: ['usage', workspaceId] });
    },
  });
}

// --- Phase 5E.1: per-kind limits, org ceiling, unpriced report -------------

export interface OperationKindRow {
  kind: string;
  requests: number;
  measuredTokens: number;
  /** Events whose token counts the provider never reported. NOT counted as 0. */
  unknownQuantityEvents: number;
  workspaceMaxRequests: number | null;
  workspaceMaxTokens: number | null;
  organizationMaxRequests: number | null;
  organizationMaxTokens: number | null;
  remainingRequests: number | null;
  remainingTokens: number | null;
}

export interface OperationLimits {
  periodStart: string;
  periodEnd: string;
  kinds: OperationKindRow[];
  note: string;
}

export function useOperationLimits(workspaceId: string) {
  return useQuery<OperationLimits, ApiError>({
    queryKey: ['budget-operations', workspaceId],
    queryFn: () => api.get<OperationLimits>(`/v1/workspaces/${workspaceId}/budget/operations`),
    staleTime: 60_000,
  });
}

export interface UnpricedReport {
  periodStart: string;
  byReason: Array<{ reason: string | null; events: number; explanation: string }>;
  operations: Array<{
    kind: string;
    provider: string;
    model: string | null;
    reason: string | null;
    events: number;
    requests: number;
  }>;
  conservativelyPricedEvents: number;
  note: string;
}

export function useUnpricedReport(workspaceId: string) {
  return useQuery<UnpricedReport, ApiError>({
    queryKey: ['budget-unpriced', workspaceId],
    queryFn: () => api.get<UnpricedReport>(`/v1/workspaces/${workspaceId}/budget/unpriced`),
    staleTime: 60_000,
  });
}

export interface OrganizationBudget {
  configured: boolean;
  enforcement: string;
  limitMicros: number | null;
  usedMicros: number;
  remainingMicros: number | null;
  usedPercent: number | null;
  totalEvents: number;
  unpricedEvents: number;
  currency: string;
  workspaces: Array<{ workspaceId: string | null; estimatedCostMicros: number; events: number }>;
  note: string;
}

export function useOrganizationBudget(organizationId: string) {
  return useQuery<OrganizationBudget, ApiError>({
    queryKey: ['org-budget', organizationId],
    queryFn: () => api.get<OrganizationBudget>(`/v1/organizations/${organizationId}/budget`),
    staleTime: 60_000,
    retry: false,
  });
}
