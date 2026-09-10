'use client';

import type { CreateBrandInput, UpdateBrandInput } from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

/** API row shape (dates serialized). */
export interface BrandRow {
  id: string;
  organizationId: string;
  workspaceId: string;
  name: string;
  slug: string;
  description: string | null;
  websiteUrl: string | null;
  voice: {
    tone?: string[];
    personaDescription?: string | null;
    doNots?: string[];
    preferredTerms?: string[];
  } | null;
  guidelines: Record<string, unknown>;
  languages: string[];
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  createdAt: string;
  updatedAt: string;
}

const keyFor = (workspaceId: string) => ['workspaces', workspaceId, 'brands'] as const;

export function useBrands(workspaceId: string) {
  return useQuery<BrandRow[], ApiError>({
    queryKey: keyFor(workspaceId),
    queryFn: () => api.get<BrandRow[]>(`/v1/workspaces/${workspaceId}/brands`),
  });
}

export function useBrand(workspaceId: string, brandId: string | null) {
  return useQuery<BrandRow, ApiError>({
    queryKey: [...keyFor(workspaceId), brandId],
    queryFn: () => api.get<BrandRow>(`/v1/workspaces/${workspaceId}/brands/${brandId as string}`),
    enabled: brandId !== null,
  });
}

export function useCreateBrand(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<BrandRow, ApiError, CreateBrandInput>({
    mutationFn: (input) => api.post<BrandRow>(`/v1/workspaces/${workspaceId}/brands`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keyFor(workspaceId) }),
  });
}

export function useUpdateBrand(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<BrandRow, ApiError, { id: string; input: UpdateBrandInput }>({
    mutationFn: ({ id, input }) =>
      api.patch<BrandRow>(`/v1/workspaces/${workspaceId}/brands/${id}`, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keyFor(workspaceId) }),
  });
}

/**
 * Archives a brand. The API soft-deletes (status ARCHIVED) rather than removing
 * the row, because brands are referenced by content lineage — the label says
 * "Archive", not "Delete", so the UI does not promise destruction it will not do.
 */
export function useArchiveBrand(workspaceId: string) {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => api.delete<void>(`/v1/workspaces/${workspaceId}/brands/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keyFor(workspaceId) }),
  });
}
