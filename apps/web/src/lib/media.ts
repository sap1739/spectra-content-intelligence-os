'use client';

import type { ProcessImageInput } from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { API_BASE_URL, api, type ApiError } from './api';

export interface MediaStatus {
  image: boolean;
  video: boolean;
  audio: boolean;
  htmlToImage: boolean;
  engine: string;
}

export interface MediaAssetRow {
  id: string;
  kind: string;
  storageKey: string;
  mimeType: string;
  sizeBytes: number;
  widthPx: number | null;
  heightPx: number | null;
  engine: string | null;
  sourceAssetId: string | null;
  createdAt: string;
}

export function useMediaStatus(workspaceId: string) {
  return useQuery<MediaStatus, ApiError>({
    queryKey: ['workspaces', workspaceId, 'media-status'],
    queryFn: () => api.get<MediaStatus>(`/v1/workspaces/${workspaceId}/media/status`),
    staleTime: 60_000,
  });
}

const mediaKey = (ws: string) => ['workspaces', ws, 'media'] as const;

export function useMediaAssets(workspaceId: string) {
  return useQuery<MediaAssetRow[], ApiError>({
    queryKey: mediaKey(workspaceId),
    queryFn: () => api.get<MediaAssetRow[]>(`/v1/workspaces/${workspaceId}/media`),
  });
}

export function useProcessImage(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<MediaAssetRow, ApiError, ProcessImageInput>({
    mutationFn: (input) =>
      api.post<MediaAssetRow>(`/v1/workspaces/${workspaceId}/media/images`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: mediaKey(workspaceId) }),
  });
}

/** The authenticated content URL for an asset (used for a credentialed blob fetch). */
export function mediaContentUrl(workspaceId: string, assetId: string): string {
  return `${API_BASE_URL}/v1/workspaces/${workspaceId}/media/${assetId}/content`;
}
