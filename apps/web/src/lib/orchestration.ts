'use client';

import type {
  CampaignPlan,
  EvidenceVerdict,
  GeneratedCampaignStrategy,
  OrchestrationFailureReason,
  OrchestrationItemResult,
  OrchestrationStatus,
  SocialPlatform,
  StageResult,
  StartOrchestrationInput,
} from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

/** Campaign orchestration (Phase 7D, ADR-0043). */

const base = (workspaceId: string) => `/v1/workspaces/${workspaceId}/campaign-orchestration`;
const key = (workspaceId: string, ...rest: string[]) => [
  'workspaces',
  workspaceId,
  'orchestration',
  ...rest,
];

export interface OrchestrationCapabilities {
  strategyEngine: { version: string; deterministic: boolean; note: string };
  generation: { available: boolean; reason: string };
  evidenceVerdicts: Record<EvidenceVerdict, string>;
  failureReasons: Record<OrchestrationFailureReason, string>;
  publishesAutomatically: boolean;
}

export interface RunSummary {
  id: string;
  name: string;
  status: OrchestrationStatus;
  campaignId: string | null;
  progressPercent: number;
  itemsPlanned: number;
  itemsCreated: number;
  itemsDrafted: number;
  itemsBlocked: number;
  failureReason: OrchestrationFailureReason | null;
  createdAt: string;
}

export interface RunDetail {
  run: RunSummary & {
    strategy: GeneratedCampaignStrategy | null;
    plan: CampaignPlan | null;
    stages: StageResult[];
    items: OrchestrationItemResult[];
    itemsFailed: number;
    failureDetail: string | null;
  };
  failureText: string | null;
}

export function useOrchestrationCapabilities(workspaceId: string) {
  return useQuery<OrchestrationCapabilities, ApiError>({
    queryKey: key(workspaceId, 'capabilities'),
    queryFn: () => api.get(`${base(workspaceId)}/capabilities`),
    staleTime: 300_000,
  });
}

export function useOrchestrationRuns(workspaceId: string) {
  return useQuery<{ runs: RunSummary[] }, ApiError>({
    queryKey: key(workspaceId, 'runs'),
    queryFn: () => api.get(`${base(workspaceId)}/runs`),
  });
}

/** Polls only while a run is queued or running — building happens in the worker. */
export function useOrchestrationRun(workspaceId: string, runId: string) {
  return useQuery<RunDetail, ApiError>({
    queryKey: key(workspaceId, 'run', runId),
    queryFn: () => api.get(`${base(workspaceId)}/runs/${runId}`),
    enabled: Boolean(runId),
    refetchInterval: (query) => {
      const status = query.state.data?.run.status;
      return status === 'QUEUED' || status === 'RUNNING' ? 2000 : false;
    },
  });
}

export function useStartOrchestration(workspaceId: string) {
  const client = useQueryClient();
  return useMutation<{ created: boolean; run: RunSummary }, ApiError, StartOrchestrationInput>({
    mutationFn: (input) => api.post(`${base(workspaceId)}/runs`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useCancelOrchestration(workspaceId: string) {
  const client = useQueryClient();
  return useMutation<RunDetail, ApiError, string>({
    mutationFn: (runId) => api.post(`${base(workspaceId)}/runs/${runId}/cancel`),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export const RUN_STATUS_VARIANT: Record<
  OrchestrationStatus,
  'success' | 'warning' | 'destructive' | 'muted' | 'secondary'
> = {
  QUEUED: 'muted',
  RUNNING: 'warning',
  SUCCEEDED: 'success',
  PARTIAL: 'secondary',
  FAILED: 'destructive',
  CANCELLED: 'muted',
};

export const VERDICT_VARIANT: Record<
  EvidenceVerdict,
  'success' | 'warning' | 'destructive' | 'muted'
> = {
  SUPPORTED: 'success',
  LIMITED: 'warning',
  SNIPPET_ONLY: 'warning',
  STALE: 'warning',
  CONTRADICTED: 'warning',
  UNSUPPORTED: 'destructive',
};

export const DEFAULT_PLATFORMS: SocialPlatform[] = ['LINKEDIN', 'X', 'FACEBOOK', 'INSTAGRAM'];
