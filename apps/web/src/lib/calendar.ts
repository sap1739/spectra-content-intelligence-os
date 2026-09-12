'use client';

import type { ScheduleEntryInput } from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

export type CalendarEntryStatus =
  'SCHEDULED' | 'QUEUED' | 'PUBLISHING' | 'PUBLISHED' | 'FAILED' | 'UNSUPPORTED' | 'CANCELLED';

export interface CalendarEntryRow {
  id: string;
  contentItemId: string;
  platform: string;
  scheduledAt: string;
  status: CalendarEntryStatus;
  note: string | null;
  socialAccountId: string | null;
  failureReason: string | null;
  /** PublishFailureCode — what to do next (reconnect, fix content, retry). */
  failureCode?: string | null;
  externalPostId?: string | null;
  externalUrl: string | null;
  mediaAssetId?: string | null;
  mediaAltText?: string | null;
  mediaAsset?: { id: string; kind: string; mimeType: string; sizeBytes?: number } | null;
  thumbnailAssetId?: string | null;
  thumbnailAsset?: { id: string; mimeType: string } | null;
  /** Platform-specific publish fields (YouTube video details). */
  publishMetadata?: { youtube?: { title?: string; privacyStatus?: string } } | null;
  /** True of a SUCCESSFUL publish: what the platform did differently. */
  publishNote?: string | null;
  /** How far a resumable upload got, for entries that upload a file. */
  upload?: { status: string; uploadedBytes: number; totalBytes: number | null } | null;
  publishedAt: string | null;
  attemptCount: number;
  contentItem: { title: string; contentType: string; lifecycleState: string };
}

const calendarKey = (ws: string) => ['workspaces', ws, 'calendar'] as const;

const IN_FLIGHT = new Set<CalendarEntryStatus>(['QUEUED', 'PUBLISHING']);

export function useCalendar(workspaceId: string) {
  return useQuery<CalendarEntryRow[], ApiError>({
    queryKey: calendarKey(workspaceId),
    queryFn: () => api.get<CalendarEntryRow[]>(`/v1/workspaces/${workspaceId}/calendar`),
    // Poll while any entry is mid-dispatch so the worker result appears live.
    refetchInterval: (query) =>
      (query.state.data ?? []).some((e) => IN_FLIGHT.has(e.status)) ? 2500 : false,
  });
}

export function usePublishNow(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<CalendarEntryRow, ApiError, string>({
    mutationFn: (id) =>
      api.post<CalendarEntryRow>(`/v1/workspaces/${workspaceId}/calendar/${id}/publish`),
    onSuccess: () => qc.invalidateQueries({ queryKey: calendarKey(workspaceId) }),
  });
}

export function useScheduleEntry(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<CalendarEntryRow, ApiError, ScheduleEntryInput>({
    mutationFn: (input) =>
      api.post<CalendarEntryRow>(`/v1/workspaces/${workspaceId}/calendar`, input),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: calendarKey(workspaceId) });
      void qc.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'content-items'] });
    },
  });
}

export function useCancelEntry(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<CalendarEntryRow, ApiError, string>({
    mutationFn: (id) =>
      api.delete<CalendarEntryRow>(`/v1/workspaces/${workspaceId}/calendar/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: calendarKey(workspaceId) }),
  });
}
