'use client';

import type { ScheduleEntryInput } from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

export interface CalendarEntryRow {
  id: string;
  contentItemId: string;
  platform: string;
  scheduledAt: string;
  status: 'SCHEDULED' | 'CANCELLED' | 'PUBLISHED' | 'FAILED';
  note: string | null;
  contentItem: { title: string; contentType: string; lifecycleState: string };
}

const calendarKey = (ws: string) => ['workspaces', ws, 'calendar'] as const;

export function useCalendar(workspaceId: string) {
  return useQuery<CalendarEntryRow[], ApiError>({
    queryKey: calendarKey(workspaceId),
    queryFn: () => api.get<CalendarEntryRow[]>(`/v1/workspaces/${workspaceId}/calendar`),
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
