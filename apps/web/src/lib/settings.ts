'use client';

import type {
  UpdateOrganizationInput,
  UpdateUserPreferencesInput,
  UpdateWorkspaceInput,
} from '@spectra/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

/**
 * Settings mutations.
 *
 * Every field here maps to a column the backend genuinely persists — there is
 * deliberately no organization timezone, because the Organization table has no
 * such column and offering one would be a setting that silently does nothing.
 */

export interface WorkspaceSettingsRow {
  id: string;
  name: string;
  description: string | null;
  timezone: string;
  status: string;
}

export function useUpdateWorkspace(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<WorkspaceSettingsRow, ApiError, UpdateWorkspaceInput>({
    mutationFn: (input) => api.patch<WorkspaceSettingsRow>(`/v1/workspaces/${workspaceId}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auth', 'me'] }),
  });
}

export function useUpdateOrganization(organizationId: string) {
  const queryClient = useQueryClient();
  return useMutation<{ id: string; name: string }, ApiError, UpdateOrganizationInput>({
    mutationFn: (input) =>
      api.patch<{ id: string; name: string }>(`/v1/organizations/${organizationId}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auth', 'me'] }),
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  return useMutation<
    { id: string; name: string; timezone: string; locale: string },
    ApiError,
    UpdateUserPreferencesInput
  >({
    mutationFn: (input) =>
      api.patch<{ id: string; name: string; timezone: string; locale: string }>(
        '/v1/me/preferences',
        input,
      ),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['auth', 'me'] }),
  });
}

/** A small, honest set — not an exhaustive IANA list we cannot validate. */
export const COMMON_TIMEZONES = [
  'UTC',
  'Asia/Kolkata',
  'Asia/Singapore',
  'Asia/Dubai',
  'Europe/London',
  'Europe/Berlin',
  'America/New_York',
  'America/Chicago',
  'America/Los_Angeles',
  'Australia/Sydney',
] as const;
