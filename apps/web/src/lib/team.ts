'use client';

import type {
  CreateInvitationInput,
  CreateWatchlistInput,
  ScheduleResearchInput,
} from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';
import type { ProjectRow } from './research';

// ---------------------------------------------------------------------------
// Members & invitations
// ---------------------------------------------------------------------------

export interface MemberRow {
  membershipId: string;
  role: string;
  status: string;
  joinedAt: string;
  user: { id: string; email: string; name: string; status: string };
}

export interface InvitationRow {
  id: string;
  email: string;
  role: string;
  token: string;
  expiresAt: string;
  createdAt: string;
}

const membersKey = (org: string) => ['organizations', org, 'members'] as const;
const invitationsKey = (org: string) => ['organizations', org, 'invitations'] as const;

export function useMembers(organizationId: string) {
  return useQuery<MemberRow[], ApiError>({
    queryKey: membersKey(organizationId),
    queryFn: () => api.get<MemberRow[]>(`/v1/organizations/${organizationId}/members`),
  });
}

export function useInvitations(organizationId: string, enabled: boolean) {
  return useQuery<InvitationRow[], ApiError>({
    queryKey: invitationsKey(organizationId),
    queryFn: () => api.get<InvitationRow[]>(`/v1/organizations/${organizationId}/invitations`),
    enabled,
    retry: false,
  });
}

export function useInvite(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation<InvitationRow, ApiError, CreateInvitationInput>({
    mutationFn: (input) =>
      api.post<InvitationRow>(`/v1/organizations/${organizationId}/invitations`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsKey(organizationId) }),
  });
}

export function useRevokeInvitation(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (invitationId) =>
      api.delete<void>(`/v1/organizations/${organizationId}/invitations/${invitationId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: invitationsKey(organizationId) }),
  });
}

// ---------------------------------------------------------------------------
// Watchlists
// ---------------------------------------------------------------------------

export interface WatchlistRow {
  id: string;
  name: string;
  keywords: string[];
  threshold: number;
  createdAt: string;
}

const watchlistsKey = (ws: string) => ['workspaces', ws, 'watchlists'] as const;

export function useWatchlists(workspaceId: string) {
  return useQuery<WatchlistRow[], ApiError>({
    queryKey: watchlistsKey(workspaceId),
    queryFn: () => api.get<WatchlistRow[]>(`/v1/workspaces/${workspaceId}/watchlists`),
  });
}

export function useCreateWatchlist(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<WatchlistRow, ApiError, CreateWatchlistInput>({
    mutationFn: (input) =>
      api.post<WatchlistRow>(`/v1/workspaces/${workspaceId}/watchlists`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: watchlistsKey(workspaceId) }),
  });
}

export function useDeleteWatchlist(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => api.delete<void>(`/v1/workspaces/${workspaceId}/watchlists/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: watchlistsKey(workspaceId) }),
  });
}

// ---------------------------------------------------------------------------
// Research schedules
// ---------------------------------------------------------------------------

export function useSetSchedule(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<ProjectRow, ApiError, ScheduleResearchInput>({
    mutationFn: (input) =>
      api.put<ProjectRow>(
        `/v1/workspaces/${workspaceId}/research-projects/${projectId}/runs/schedule`,
        input,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['workspaces', workspaceId, 'research-projects'],
      }),
  });
}

export function useClearSchedule(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  return useMutation<ProjectRow, ApiError, void>({
    mutationFn: () =>
      api.delete<ProjectRow>(
        `/v1/workspaces/${workspaceId}/research-projects/${projectId}/runs/schedule`,
      ),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ['workspaces', workspaceId, 'research-projects'],
      }),
  });
}
