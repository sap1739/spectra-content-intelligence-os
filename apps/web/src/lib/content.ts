'use client';

import type { CreateContentItemInput, GenerateDraftInput } from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

// ---------------------------------------------------------------------------
// Row shapes (dates arrive as ISO strings)
// ---------------------------------------------------------------------------

export interface AiStatus {
  configured: boolean;
  provider: string;
  model: string;
}

export interface ContentDraftRow {
  id: string;
  status: 'GENERATING' | 'READY' | 'FAILED';
  body: string | null;
  citationIds: string[];
  findingIds: string[];
  modelProvider: string | null;
  modelName: string | null;
  modelVersion: string | null;
  promptVersion: string | null;
  usageInputTokens: number | null;
  usageOutputTokens: number | null;
  finishReason: string | null;
  failureReason: string | null;
  createdAt: string;
}

export interface ContentItemRow {
  id: string;
  title: string;
  contentType: string;
  lifecycleState: string;
  funnelStage: string | null;
  objective: string | null;
  body: string | null;
  evidencePackId: string | null;
  topicKey: string | null;
  findingIds: string[];
  citationIds: string[];
  createdAt: string;
  drafts?: ContentDraftRow[];
}

export interface WorkspaceEvidencePackRow {
  id: string;
  title: string;
  summary: string | null;
  topicKey: string;
  status: string;
  findingIds: string[];
  citationIds: string[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// AI capability status
// ---------------------------------------------------------------------------

export function useAiStatus(workspaceId: string) {
  return useQuery<AiStatus, ApiError>({
    queryKey: ['workspaces', workspaceId, 'ai-status'],
    queryFn: () => api.get<AiStatus>(`/v1/workspaces/${workspaceId}/ai/status`),
    staleTime: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Evidence packs available to ground on
// ---------------------------------------------------------------------------

export function useWorkspaceEvidencePacks(workspaceId: string) {
  return useQuery<WorkspaceEvidencePackRow[], ApiError>({
    queryKey: ['workspaces', workspaceId, 'evidence-packs'],
    queryFn: () =>
      api.get<WorkspaceEvidencePackRow[]>(`/v1/workspaces/${workspaceId}/evidence-packs`),
  });
}

// ---------------------------------------------------------------------------
// Content items & drafts
// ---------------------------------------------------------------------------

const itemsKey = (ws: string) => ['workspaces', ws, 'content-items'] as const;

export function useContentItems(workspaceId: string) {
  return useQuery<ContentItemRow[], ApiError>({
    queryKey: itemsKey(workspaceId),
    queryFn: () => api.get<ContentItemRow[]>(`/v1/workspaces/${workspaceId}/content-items`),
  });
}

export function useContentItem(workspaceId: string, contentItemId: string | null) {
  return useQuery<ContentItemRow, ApiError>({
    queryKey: [...itemsKey(workspaceId), contentItemId],
    queryFn: () =>
      api.get<ContentItemRow>(`/v1/workspaces/${workspaceId}/content-items/${contentItemId}`),
    enabled: Boolean(contentItemId),
  });
}

export function useCreateContentItem(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<ContentItemRow, ApiError, CreateContentItemInput>({
    mutationFn: (input) =>
      api.post<ContentItemRow>(`/v1/workspaces/${workspaceId}/content-items`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: itemsKey(workspaceId) }),
  });
}

export function useGenerateDraft(workspaceId: string, contentItemId: string) {
  const queryClient = useQueryClient();
  return useMutation<ContentDraftRow, ApiError, GenerateDraftInput>({
    mutationFn: (input) =>
      api.post<ContentDraftRow>(
        `/v1/workspaces/${workspaceId}/content-items/${contentItemId}/drafts`,
        input,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: [...itemsKey(workspaceId), contentItemId],
      });
      void queryClient.invalidateQueries({ queryKey: itemsKey(workspaceId) });
    },
  });
}
