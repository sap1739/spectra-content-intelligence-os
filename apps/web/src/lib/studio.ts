'use client';

import type {
  BrandKit,
  CreateDesignInput,
  DesignFormat,
  DesignOutputFormat,
  DesignStatus,
  DesignTemplateCategory,
  TemplateLayout,
  UpdateBrandKitInput,
  UpdateDesignInput,
} from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as React from 'react';

import { API_BASE_URL, api, apiFetch, type ApiError } from './api';

/** Design studio (Phase 7A, ADR-0040). */

export interface StudioCapabilities {
  engine: string;
  engineVersion: string;
  outputs: DesignOutputFormat[];
  pdf: string;
  fonts: string;
  aiImageGeneration: boolean;
  note: string;
}

export interface TemplateSummary {
  key?: string;
  id?: string;
  name: string;
  description: string | null;
  category: DesignTemplateCategory;
  formats: string[];
  defaultFormat: string;
  version: number;
  layout: TemplateLayout;
  source: 'BUILT_IN' | 'WORKSPACE';
}

export interface DesignRenderRow {
  id: string;
  outputFormat: DesignOutputFormat;
  pageIndex: number | null;
  pageCount: number;
  formatKey: string;
  widthPx: number;
  heightPx: number;
  warnings: string[];
  createdAt: string;
  mediaAsset: { id: string; mimeType: string; sizeBytes: number };
}

export interface DesignRow {
  id: string;
  name: string;
  status: DesignStatus;
  category: DesignTemplateCategory;
  formatKey: string;
  templateBuiltInKey: string | null;
  templateId: string | null;
  brandId: string | null;
  brand: { id: string; name: string } | null;
  contentItemId: string | null;
  campaignId: string | null;
  contentItem?: { id: string; title: string; lifecycleState: string } | null;
  campaign?: { id: string; name: string } | null;
  values: Record<string, string>;
  images: Record<string, string>;
  layout: TemplateLayout;
  reviewNote: string | null;
  approvedAt: string | null;
  publishedAt: string | null;
  updatedAt: string;
  renders: DesignRenderRow[];
}

export interface ExportResult {
  reused: boolean;
  warnings: string[];
  renders: DesignRenderRow[];
}

const base = (workspaceId: string) => `/v1/workspaces/${workspaceId}/studio`;
const key = (workspaceId: string, ...rest: string[]) => [
  'workspaces',
  workspaceId,
  'studio',
  ...rest,
];

export function useStudioCapabilities(workspaceId: string) {
  return useQuery<StudioCapabilities, ApiError>({
    queryKey: key(workspaceId, 'capabilities'),
    queryFn: () => api.get(`${base(workspaceId)}/capabilities`),
    staleTime: 300_000,
  });
}

export function useDesignFormats(workspaceId: string) {
  return useQuery<DesignFormat[], ApiError>({
    queryKey: key(workspaceId, 'formats'),
    queryFn: () => api.get(`${base(workspaceId)}/formats`),
    staleTime: 300_000,
  });
}

export function useDesignTemplates(workspaceId: string) {
  return useQuery<{ builtIn: TemplateSummary[]; workspace: TemplateSummary[] }, ApiError>({
    queryKey: key(workspaceId, 'templates'),
    queryFn: () => api.get(`${base(workspaceId)}/templates`),
    staleTime: 60_000,
  });
}

export function useDesigns(
  workspaceId: string,
  filter: { contentItemId?: string; campaignId?: string } = {},
) {
  const query = new URLSearchParams();
  if (filter.contentItemId) query.set('contentItemId', filter.contentItemId);
  if (filter.campaignId) query.set('campaignId', filter.campaignId);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return useQuery<DesignRow[], ApiError>({
    queryKey: key(workspaceId, 'designs', suffix),
    queryFn: () => api.get(`${base(workspaceId)}/designs${suffix}`),
  });
}

export function useDesign(workspaceId: string, designId: string) {
  return useQuery<DesignRow, ApiError>({
    queryKey: key(workspaceId, 'design', designId),
    queryFn: () => api.get(`${base(workspaceId)}/designs/${designId}`),
    enabled: Boolean(designId),
  });
}

export function useCreateDesign(workspaceId: string) {
  const client = useQueryClient();
  return useMutation<DesignRow, ApiError, CreateDesignInput>({
    mutationFn: (input) => api.post(`${base(workspaceId)}/designs`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useUpdateDesign(workspaceId: string, designId: string) {
  const client = useQueryClient();
  return useMutation<DesignRow, ApiError, UpdateDesignInput>({
    mutationFn: (input) =>
      apiFetch(`${base(workspaceId)}/designs/${designId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useExportDesign(workspaceId: string, designId: string) {
  const client = useQueryClient();
  return useMutation<
    ExportResult,
    ApiError,
    { outputFormat: DesignOutputFormat; quality?: number }
  >({
    mutationFn: (input) =>
      api.post(`${base(workspaceId)}/designs/${designId}/exports`, { quality: 90, ...input }),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useDesignWorkflow(workspaceId: string, designId: string) {
  const client = useQueryClient();
  return useMutation<
    DesignRow,
    ApiError,
    { action: 'submit' | 'approve' | 'request-changes'; note?: string }
  >({
    mutationFn: ({ action, note }) =>
      api.post(
        `${base(workspaceId)}/designs/${designId}/${action}`,
        action === 'submit' ? undefined : { note: note ?? null },
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

/** Opens an export through a short-lived signed URL. */
export function useRenderUrl(workspaceId: string) {
  return useMutation<{ url: string; expiresAt: string }, ApiError, string>({
    mutationFn: (renderId) => api.get(`${base(workspaceId)}/renders/${renderId}/url`),
  });
}

export function useUpdateBrandKit(workspaceId: string, brandId: string) {
  const client = useQueryClient();
  return useMutation<BrandKit & { id: string }, ApiError, UpdateBrandKitInput>({
    mutationFn: (input) =>
      apiFetch(`/v1/workspaces/${workspaceId}/brands/${brandId}/kit`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: ['workspaces', workspaceId, 'brands'] }),
  });
}

/**
 * A live preview: the API renders the page for real and returns PNG bytes.
 * Fetched with credentials (the session cookie is not sent on a cross-origin
 * <img>), turned into an object URL, and revoked when it is replaced.
 */
export function useDesignPreview(
  workspaceId: string,
  designId: string,
  page: number,
  version: unknown,
) {
  const [state, setState] = React.useState<{
    url: string | null;
    warnings: string[];
    pageCount: number;
    error: string | null;
    loading: boolean;
  }>({
    url: null,
    warnings: [],
    pageCount: 1,
    error: null,
    loading: Boolean(designId),
  });

  React.useEffect(() => {
    if (!designId) return undefined;
    let objectUrl: string | null = null;
    let cancelled = false;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    fetch(`${API_BASE_URL}${base(workspaceId)}/designs/${designId}/preview?page=${page}`, {
      credentials: 'include',
    })
      .then(async (response) => {
        if (!response.ok) {
          const problem = (await response.json().catch(() => null)) as {
            title?: string;
            detail?: string;
          } | null;
          throw new Error(
            problem?.detail ?? problem?.title ?? `Preview failed (${response.status})`,
          );
        }
        const warningsHeader = response.headers.get('x-design-warnings');
        const warnings = warningsHeader
          ? (JSON.parse(decodeURIComponent(warningsHeader)) as string[])
          : [];
        const pageCount = Number(response.headers.get('x-design-page-count') ?? '1');
        const blob = await response.blob();
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, warnings, pageCount, error: null, loading: false });
      })
      .catch((error: Error) => {
        if (!cancelled)
          setState({ url: null, warnings: [], pageCount: 1, error: error.message, loading: false });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [workspaceId, designId, page, version]);

  return state;
}

export const DESIGN_STATUS_VARIANT: Record<
  DesignStatus,
  'success' | 'warning' | 'secondary' | 'muted'
> = {
  DRAFT: 'muted',
  IN_REVIEW: 'warning',
  APPROVED: 'success',
  PUBLISHED: 'secondary',
  ARCHIVED: 'muted',
};

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
