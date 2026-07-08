'use client';

import type {
  CreateResearchProjectInput,
  ResearchRunStats,
  ReviewFindingInput,
  StartResearchRunInput,
  TrendScoreResult,
} from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

// ---------------------------------------------------------------------------
// Row shapes (API responses; dates arrive as ISO strings)
// ---------------------------------------------------------------------------

export interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  objective: string | null;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'COMPLETED' | 'ARCHIVED';
  verticalId: string | null;
  scheduleEveryMinutes: number | null;
  scheduleFeedUrls: string[];
  createdAt: string;
}

export interface RunRow {
  id: string;
  status:
    'PENDING' | 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'PARTIALLY_SUCCEEDED' | 'FAILED' | 'CANCELLED';
  currentStage: string | null;
  stats: Partial<ResearchRunStats>;
  failureReason: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface FindingRow {
  id: string;
  summary: string;
  excerpt: string | null;
  status: 'PENDING_REVIEW' | 'VALIDATED' | 'REJECTED' | 'STALE';
  topics: string[];
  credibilityScore: number | null;
  freshnessScore: number | null;
  createdAt: string;
  source: {
    url: string;
    title: string | null;
    publisher: string | null;
    publishedAt: string | null;
    retrievedAt: string;
  };
}

export interface TrendRow {
  id: string;
  title: string;
  summary: string | null;
  state: string;
  topicKey: string | null;
  normalizedScore: number | null;
  latestScore: TrendScoreResult | null;
  sourceIds: string[];
  findingIds: string[];
  lastSeenAt: string | null;
}

const RUN_ACTIVE_STATES = new Set(['PENDING', 'QUEUED', 'RUNNING']);
export function isRunActive(run: RunRow): boolean {
  return RUN_ACTIVE_STATES.has(run.status);
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

const projectsKey = (ws: string) => ['workspaces', ws, 'research-projects'] as const;

export function useResearchProjects(workspaceId: string) {
  return useQuery<ProjectRow[], ApiError>({
    queryKey: projectsKey(workspaceId),
    queryFn: () => api.get<ProjectRow[]>(`/v1/workspaces/${workspaceId}/research-projects`),
  });
}

export function useResearchProject(workspaceId: string, projectId: string) {
  return useQuery<ProjectRow, ApiError>({
    queryKey: [...projectsKey(workspaceId), projectId],
    queryFn: () =>
      api.get<ProjectRow>(`/v1/workspaces/${workspaceId}/research-projects/${projectId}`),
  });
}

export function useCreateResearchProject(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<ProjectRow, ApiError, CreateResearchProjectInput>({
    mutationFn: (input) =>
      api.post<ProjectRow>(`/v1/workspaces/${workspaceId}/research-projects`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: projectsKey(workspaceId) }),
  });
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const runsKey = (ws: string, project: string) =>
  ['workspaces', ws, 'research-projects', project, 'runs'] as const;

export function useRuns(workspaceId: string, projectId: string) {
  return useQuery<RunRow[], ApiError>({
    queryKey: runsKey(workspaceId, projectId),
    queryFn: () =>
      api.get<RunRow[]>(`/v1/workspaces/${workspaceId}/research-projects/${projectId}/runs`),
    // Poll while any run is active so stage/stats update live.
    refetchInterval: (query) => ((query.state.data ?? []).some(isRunActive) ? 3000 : false),
  });
}

export function useStartRun(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<RunRow, ApiError, StartResearchRunInput>({
    mutationFn: (input) =>
      api.post<RunRow>(`/v1/workspaces/${workspaceId}/research-projects/${projectId}/runs`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: runsKey(workspaceId, projectId) });
    },
  });
}

// ---------------------------------------------------------------------------
// Findings review
// ---------------------------------------------------------------------------

const findingsKey = (ws: string, project: string, status?: string) =>
  ['workspaces', ws, 'research-projects', project, 'findings', status ?? 'ALL'] as const;

export function useFindings(workspaceId: string, projectId: string, status?: FindingRow['status']) {
  return useQuery<FindingRow[], ApiError>({
    queryKey: findingsKey(workspaceId, projectId, status),
    queryFn: () =>
      api.get<FindingRow[]>(
        `/v1/workspaces/${workspaceId}/research-projects/${projectId}/findings${
          status ? `?status=${status}` : ''
        }`,
      ),
  });
}

export function useReviewFinding(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<FindingRow, ApiError, { findingId: string } & ReviewFindingInput>({
    mutationFn: ({ findingId, status }) =>
      api.patch<FindingRow>(
        `/v1/workspaces/${workspaceId}/research-projects/${projectId}/findings/${findingId}`,
        { status },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ['workspaces', workspaceId, 'research-projects', projectId, 'findings'],
      });
    },
  });
}

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

export function useTrends(workspaceId: string) {
  return useQuery<TrendRow[], ApiError>({
    queryKey: ['workspaces', workspaceId, 'trends'],
    queryFn: () => api.get<TrendRow[]>(`/v1/workspaces/${workspaceId}/trends`),
  });
}
