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
  /** Set when the target was discovered through an OAuth connection. */
  connectionId?: string | null;
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

// ---------------------------------------------------------------------------
// OAuth connections (Phase 6C, ADR-0034)
// ---------------------------------------------------------------------------

export interface OAuthPlatformEntry {
  platform: string;
  displayName: string;
  configured: boolean;
  /** Environment variable NAMES that are unset — never values. */
  missingConfiguration: string[];
  redirectUri: string | null;
  scopes: string[];
  pkce: 'required' | 'supported' | 'none';
  refresh: 'standard' | 'none';
  approval: { required: boolean; notes: string[] };
  docsUrl: string;
  adapters: { publishing: boolean; discovery: boolean };
  /** Configured AND credential storage available. */
  canConnect: boolean;
  limitation: string;
}

export interface OAuthPlatformsResponse {
  credentialStorageConfigured: boolean;
  stateTtlSeconds: number;
  definitionsRecordedAt: string;
  platforms: OAuthPlatformEntry[];
}

export interface SocialConnectionRow {
  id: string;
  platform: string;
  platformDisplayName: string;
  status: 'CONNECTED' | 'EXPIRED' | 'REAUTH_REQUIRED' | 'REVOKED' | 'ERROR';
  label: string;
  externalSubjectId: string | null;
  requestedScopes: string[];
  /** null = the platform did not report what it granted. */
  grantedScopes: string[] | null;
  hasRefreshToken: boolean;
  accessTokenExpiresAt: string | null;
  accessTokenExpired: boolean;
  lastRefreshedAt: string | null;
  lastErrorCode: string | null;
  connectedAt: string;
  refresh: { available: boolean; reason: string };
  discovery: { status: 'NOT_AVAILABLE' | 'COMPLETE' | 'FAILED'; note: string };
  publishing: { wired: boolean; note: string };
  accounts: Array<{
    id: string;
    displayName: string;
    kind: string;
    externalAccountId: string;
    status: string;
  }>;
}

export interface OAuthStartResponse {
  authorizationUrl: string;
  expiresAt: string;
}

export interface RefreshResult {
  connectionId: string;
  status: 'REFRESHED' | 'NOT_SUPPORTED' | 'REAUTH_REQUIRED' | 'FAILED';
  accessTokenExpiresAt: string | null;
  detail: string;
}

export interface DisconnectResult {
  connectionId: string;
  disconnected: boolean;
  providerRevocation: 'REVOKED' | 'NOT_SUPPORTED' | 'FAILED' | 'SKIPPED';
  note: string;
}

const connectionsKey = (ws: string) => ['workspaces', ws, 'social-connections'] as const;

export function useOAuthPlatforms(workspaceId: string) {
  return useQuery<OAuthPlatformsResponse, ApiError>({
    queryKey: ['workspaces', workspaceId, 'oauth-platforms'],
    queryFn: () =>
      api.get<OAuthPlatformsResponse>(`/v1/workspaces/${workspaceId}/social/oauth/platforms`),
    staleTime: 60_000,
  });
}

export function useConnections(workspaceId: string) {
  return useQuery<SocialConnectionRow[], ApiError>({
    queryKey: connectionsKey(workspaceId),
    queryFn: () =>
      api.get<SocialConnectionRow[]>(`/v1/workspaces/${workspaceId}/social/connections`),
  });
}

/** Starts a flow. The caller navigates the browser to `authorizationUrl`. */
export function useStartOAuth(workspaceId: string) {
  return useMutation<OAuthStartResponse, ApiError, string>({
    mutationFn: (platform) =>
      api.post<OAuthStartResponse>(
        `/v1/workspaces/${workspaceId}/social/oauth/${platform.toLowerCase()}/start`,
        {},
      ),
  });
}

export function useReconnectConnection(workspaceId: string) {
  return useMutation<OAuthStartResponse, ApiError, string>({
    mutationFn: (id) =>
      api.post<OAuthStartResponse>(
        `/v1/workspaces/${workspaceId}/social/connections/${id}/reconnect`,
        {},
      ),
  });
}

export function useRefreshConnection(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<RefreshResult, ApiError, string>({
    mutationFn: (id) =>
      api.post<RefreshResult>(`/v1/workspaces/${workspaceId}/social/connections/${id}/refresh`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: connectionsKey(workspaceId) }),
  });
}

export function useDisconnectConnection(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<DisconnectResult, ApiError, string>({
    mutationFn: (id) =>
      api.delete<DisconnectResult>(`/v1/workspaces/${workspaceId}/social/connections/${id}`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: connectionsKey(workspaceId) });
      void queryClient.invalidateQueries({ queryKey: accountsKey(workspaceId) });
    },
  });
}
