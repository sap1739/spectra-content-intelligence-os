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
  /** Files made elsewhere can be uploaded and published, even where nothing renders them. */
  upload?: boolean;
}

/** A short-lived signed URL to PUT one file straight to object storage. */
export interface UploadTicket {
  uploadId: string;
  uploadUrl: string;
  method: 'PUT';
  headers: Record<string, string>;
  expiresAt: string;
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

/**
 * Uploads a file the browser holds: ask for a ticket, PUT the bytes to object
 * storage, then register the asset. The API records the size and type STORAGE
 * reports, so a failed PUT never leaves an asset pointing at nothing.
 */
export function useUploadMedia(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<MediaAssetRow, Error, File>({
    mutationFn: async (file) => {
      const ticket = await api.post<UploadTicket>(`/v1/workspaces/${workspaceId}/media/uploads`, {
        filename: file.name,
        mimeType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
      });
      // Straight to storage, with no session cookie attached.
      const response = await fetch(ticket.uploadUrl, {
        method: ticket.method,
        headers: ticket.headers,
        body: file,
      }).catch(() => null);
      if (!response || !response.ok) {
        throw new Error(
          `Object storage refused the upload${response ? ` (${response.status})` : ''}. It must allow browser uploads from this origin.`,
        );
      }
      return api.post<MediaAssetRow>(`/v1/workspaces/${workspaceId}/media/uploads/complete`, {
        uploadId: ticket.uploadId,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: mediaKey(workspaceId) }),
  });
}

/** The authenticated content URL for an asset (used for a credentialed blob fetch). */
export function mediaContentUrl(workspaceId: string, assetId: string): string {
  return `${API_BASE_URL}/v1/workspaces/${workspaceId}/media/${assetId}/content`;
}
