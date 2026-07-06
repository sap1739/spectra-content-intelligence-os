'use client';

import type { CreateVerticalInput, CustomVertical } from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

/** API row shape (dates serialized). */
export type VerticalRow = Omit<CustomVertical, 'createdAt' | 'updatedAt' | 'deletedAt'> & {
  createdAt: string;
  updatedAt: string;
};

const keyFor = (workspaceId: string) => ['workspaces', workspaceId, 'verticals'] as const;

export function useVerticals(workspaceId: string) {
  return useQuery<VerticalRow[], ApiError>({
    queryKey: keyFor(workspaceId),
    queryFn: () => api.get<VerticalRow[]>(`/v1/workspaces/${workspaceId}/verticals`),
  });
}

export function useCreateVertical(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<VerticalRow, ApiError, CreateVerticalInput>({
    mutationFn: (input) => api.post<VerticalRow>(`/v1/workspaces/${workspaceId}/verticals`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keyFor(workspaceId) }),
  });
}

export function useArchiveVertical(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => api.delete<void>(`/v1/workspaces/${workspaceId}/verticals/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keyFor(workspaceId) }),
  });
}
