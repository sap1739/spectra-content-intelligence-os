'use client';

import type { AuthMeResponse, LoginRequest, RegisterRequest } from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { api, type ApiError } from './api';

const ME_KEY = ['auth', 'me'] as const;
const ACTIVE_WORKSPACE_STORAGE = 'spectra.activeWorkspaceId';

export function useMe() {
  return useQuery<AuthMeResponse, ApiError>({
    queryKey: ME_KEY,
    queryFn: () => api.get<AuthMeResponse>('/v1/auth/me'),
    retry: false,
    staleTime: 60_000,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation<AuthMeResponse, ApiError, LoginRequest>({
    mutationFn: (input) => api.post<AuthMeResponse>('/v1/auth/login', input),
    onSuccess: (me) => queryClient.setQueryData(ME_KEY, me),
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation<AuthMeResponse, ApiError, RegisterRequest>({
    mutationFn: (input) => api.post<AuthMeResponse>('/v1/auth/register', input),
    onSuccess: (me) => queryClient.setQueryData(ME_KEY, me),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationFn: () => api.post<void>('/v1/auth/logout'),
    onSettled: () => {
      queryClient.clear();
      window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE);
    },
  });
}

// ---------------------------------------------------------------------------
// Active workspace context
// ---------------------------------------------------------------------------

interface WorkspaceContextValue {
  me: AuthMeResponse;
  activeWorkspace: AuthMeResponse['workspaces'][number];
  setActiveWorkspaceId: (id: string) => void;
}

const WorkspaceContext = React.createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({
  me,
  children,
}: {
  me: AuthMeResponse;
  children: React.ReactNode;
}) {
  const [storedId, setStoredId] = React.useState<string | null>(() =>
    typeof window === 'undefined' ? null : window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE),
  );

  const activeWorkspace =
    me.workspaces.find((ws) => ws.id === storedId) ?? me.workspaces[0] ?? null;

  const setActiveWorkspaceId = React.useCallback((id: string) => {
    window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE, id);
    setStoredId(id);
  }, []);

  if (!activeWorkspace) {
    // Every registered account gets a default workspace; this is a safety net.
    return (
      <div className="flex min-h-[50vh] items-center justify-center text-sm text-muted-foreground">
        No accessible workspaces for this account.
      </div>
    );
  }

  return (
    <WorkspaceContext.Provider value={{ me, activeWorkspace, setActiveWorkspaceId }}>
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace(): WorkspaceContextValue {
  const context = React.useContext(WorkspaceContext);
  if (!context) {
    throw new Error('useWorkspace must be used inside WorkspaceProvider');
  }
  return context;
}
