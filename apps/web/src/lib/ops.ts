'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

export interface QueueCounts {
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
  deadLettered: number;
}

export interface QueueStatus {
  reachable: boolean;
  /** Null when unreachable — NOT zeros, which would read as a healthy empty queue. */
  counts: QueueCounts | null;
  reason: string;
}

export interface FailedJob {
  id: string;
  name: string;
  category: string;
  attemptsMade: number;
  maxAttempts: number;
  reason: string;
  failedAt: string | null;
  correlationId: string | null;
  organizationId: string | null;
  workspaceId: string | null;
  resourceId: string | null;
}

export interface FailedJobsResponse {
  reachable: boolean;
  failed: FailedJob[];
  deadLettered: FailedJob[];
  note: string;
}

export function useQueueStatus(workspaceId: string) {
  return useQuery<QueueStatus, ApiError>({
    queryKey: ['ops', workspaceId, 'queue'],
    queryFn: () => api.get<QueueStatus>(`/v1/workspaces/${workspaceId}/ops/queue`),
    refetchInterval: 15_000,
  });
}

export function useFailedJobs(workspaceId: string) {
  return useQuery<FailedJobsResponse, ApiError>({
    queryKey: ['ops', workspaceId, 'failed-jobs'],
    queryFn: () => api.get<FailedJobsResponse>(`/v1/workspaces/${workspaceId}/ops/failed-jobs`),
    refetchInterval: 30_000,
  });
}

export function useRetryJob(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ retried: boolean; note: string }, ApiError, string>({
    mutationFn: (jobId) =>
      api.post<{ retried: boolean; note: string }>(
        `/v1/workspaces/${workspaceId}/ops/failed-jobs/${jobId}/retry`,
        {},
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ops', workspaceId] }),
  });
}
