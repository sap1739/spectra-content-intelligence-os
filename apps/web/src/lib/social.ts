'use client';

import type { RegisterSocialAccountInput, ValidateVariantInput } from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

export interface PlatformCapability {
  platform: string;
  capabilityVersion: string;
  mediaFormats: Array<{ kind: string }>;
  limits: {
    maxCharacters: number | null;
    maxHashtags: number | null;
    maxMediaPerPost: number | null;
  };
  supports: Record<string, boolean | null>;
  oauth: { scopes: string[]; refreshSupported: boolean | null };
  notes: string | null;
}

export interface PlatformEntry {
  capability: PlatformCapability;
  publisherWired: boolean;
}

export interface PlatformsResponse {
  credentialStorageConfigured: boolean;
  platforms: PlatformEntry[];
}

export interface SocialAccountRow {
  id: string;
  platform: string;
  externalAccountId: string;
  displayName: string;
  kind: string;
  status: 'PENDING' | 'CONNECTED' | 'EXPIRED' | 'REVOKED' | 'ERROR';
  scopes: string[];
  tokenRef: string | null;
  connectedAt: string;
  createdAt: string;
}

export interface VariantValidation {
  platform: string;
  capabilityVersion: string;
  ok: boolean;
  issues: Array<{ code: string; message: string }>;
}

export function usePlatforms(workspaceId: string) {
  return useQuery<PlatformsResponse, ApiError>({
    queryKey: ['workspaces', workspaceId, 'social-platforms'],
    queryFn: () => api.get<PlatformsResponse>(`/v1/workspaces/${workspaceId}/social/platforms`),
    staleTime: 60_000,
  });
}

const accountsKey = (ws: string) => ['workspaces', ws, 'social-accounts'] as const;

export function useSocialAccounts(workspaceId: string) {
  return useQuery<SocialAccountRow[], ApiError>({
    queryKey: accountsKey(workspaceId),
    queryFn: () => api.get<SocialAccountRow[]>(`/v1/workspaces/${workspaceId}/social-accounts`),
  });
}

export function useRegisterSocialAccount(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<SocialAccountRow, ApiError, RegisterSocialAccountInput>({
    mutationFn: (input) =>
      api.post<SocialAccountRow>(`/v1/workspaces/${workspaceId}/social-accounts`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountsKey(workspaceId) }),
  });
}

export function useDisconnectSocialAccount(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => api.delete<void>(`/v1/workspaces/${workspaceId}/social-accounts/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: accountsKey(workspaceId) }),
  });
}

export function useValidateVariant(workspaceId: string) {
  return useMutation<VariantValidation, ApiError, ValidateVariantInput>({
    mutationFn: (input) =>
      api.post<VariantValidation>(`/v1/workspaces/${workspaceId}/social/validate`, input),
  });
}
