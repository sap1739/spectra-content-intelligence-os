'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

export interface KnowledgeHit {
  chunkId: string;
  documentId: string;
  score: number;
  text: string;
  metadata: {
    kind?: string;
    findingId?: string;
    projectId?: string;
    sourceUrl?: string;
    title?: string | null;
  };
}

export function useKnowledgeSearch(workspaceId: string, query: string) {
  return useQuery<KnowledgeHit[], ApiError>({
    queryKey: ['workspaces', workspaceId, 'knowledge', query],
    queryFn: () =>
      api.get<KnowledgeHit[]>(
        `/v1/workspaces/${workspaceId}/knowledge/search?q=${encodeURIComponent(query)}&topK=15`,
      ),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });
}

export interface AlertRow {
  id: string;
  alertType: string;
  message: string;
  triggeredAt: string;
  acknowledgedAt: string | null;
  trendCandidate: { title: string; state: string; projectId: string | null };
}

const alertsKey = (ws: string) => ['workspaces', ws, 'alerts'] as const;

export function useAlerts(workspaceId: string, unacknowledgedOnly = true) {
  return useQuery<AlertRow[], ApiError>({
    queryKey: [...alertsKey(workspaceId), unacknowledgedOnly],
    queryFn: () =>
      api.get<AlertRow[]>(
        `/v1/workspaces/${workspaceId}/alerts${unacknowledgedOnly ? '?unacknowledged=true' : ''}`,
      ),
    refetchInterval: 30_000,
  });
}

export function useAcknowledgeAlert(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<AlertRow, ApiError, string>({
    mutationFn: (alertId) =>
      api.patch<AlertRow>(`/v1/workspaces/${workspaceId}/alerts/${alertId}/acknowledge`, {}),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: alertsKey(workspaceId) }),
  });
}

export interface EvidencePackRow {
  id: string;
  topicKey: string;
  title: string;
  summary: string | null;
  status: string;
  findingIds: string[];
  claimIds: string[];
  citationIds: string[];
  trendCandidateId: string | null;
  updatedAt: string;
}

export function useEvidencePacks(workspaceId: string, projectId: string) {
  return useQuery<EvidencePackRow[], ApiError>({
    queryKey: ['workspaces', workspaceId, 'research-projects', projectId, 'evidence-packs'],
    queryFn: () =>
      api.get<EvidencePackRow[]>(
        `/v1/workspaces/${workspaceId}/research-projects/${projectId}/evidence-packs`,
      ),
  });
}

export interface ClaimRow {
  id: string;
  text: string;
  claimType: string;
  verificationStatus: string;
  sourceCount: number;
  supportingFindingIds: string[];
}

export function useClaims(workspaceId: string, projectId: string) {
  return useQuery<ClaimRow[], ApiError>({
    queryKey: ['workspaces', workspaceId, 'research-projects', projectId, 'claims'],
    queryFn: () =>
      api.get<ClaimRow[]>(`/v1/workspaces/${workspaceId}/research-projects/${projectId}/claims`),
  });
}
