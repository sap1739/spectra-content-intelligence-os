'use client';

import type {
  CreateVideoProjectInput,
  Storyboard,
  UpdateVideoProjectInput,
  VideoFailureReason,
  VideoFormat,
  VideoProjectKind,
  VideoProjectStatus,
  VideoRenderStatus,
} from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, apiFetch, type ApiError } from './api';

/** Video rendering (Phase 7B, ADR-0041). */

const base = (workspaceId: string) => `/v1/workspaces/${workspaceId}/video`;
const key = (workspaceId: string, ...rest: string[]) => [
  'workspaces',
  workspaceId,
  'video',
  ...rest,
];

export interface VideoCapabilities {
  available: boolean;
  reason: string;
  engine: string;
  engineVersion: string | null;
  videoCodec: string | null;
  features: {
    textOverlays: boolean;
    burnedCaptions: boolean;
    crossfades: boolean;
    audioBed: boolean;
    thumbnails: boolean;
  };
  missing: string[];
  generatesVideo: boolean;
  generationNote: string;
  maxAttempts: number;
  timeoutMs: number;
  failureReasons: Record<VideoFailureReason, string>;
}

export interface VideoRenderRow {
  id: string;
  projectId: string;
  status: VideoRenderStatus;
  formatKey: string;
  progressPercent: number;
  plannedDurationMs: number;
  attempt: number;
  maxAttempts: number;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason: VideoFailureReason | null;
  failureDetail: string | null;
  engine: string | null;
  engineVersion: string | null;
  videoCodec: string | null;
  durationMs: number | null;
  widthPx: number | null;
  heightPx: number | null;
  sizeBytes: number | null;
  warnings: string[];
  mediaAssetId: string | null;
  captionAssetId: string | null;
  thumbnailAssetId: string | null;
  createdAt: string;
}

export interface VideoProjectRow {
  id: string;
  name: string;
  description: string | null;
  kind: VideoProjectKind;
  status: VideoProjectStatus;
  formatKey: string;
  storyboard: Storyboard;
  brandId: string | null;
  contentItemId: string | null;
  campaignId: string | null;
  createdAt: string;
  updatedAt: string;
  _count?: { renders: number };
}

export interface VideoProjectDetail {
  project: VideoProjectRow;
  renders: VideoRenderRow[];
  plan: { totalDurationMs: number; scenes: number; warnings: string[] } | null;
  problems: string[];
}

export function useVideoCapabilities(workspaceId: string) {
  return useQuery<VideoCapabilities, ApiError>({
    queryKey: key(workspaceId, 'capabilities'),
    queryFn: () => api.get(`${base(workspaceId)}/capabilities`),
    staleTime: 300_000,
  });
}

export function useVideoFormats(workspaceId: string) {
  return useQuery<{ formats: VideoFormat[] }, ApiError>({
    queryKey: key(workspaceId, 'formats'),
    queryFn: () => api.get(`${base(workspaceId)}/formats`),
    staleTime: 300_000,
  });
}

export function useVideoProjects(workspaceId: string) {
  return useQuery<{ projects: VideoProjectRow[] }, ApiError>({
    queryKey: key(workspaceId, 'projects'),
    queryFn: () => api.get(`${base(workspaceId)}/projects`),
  });
}

/**
 * One project. While a render is queued or running the query polls, because a
 * render finishes in the worker rather than in the response that started it.
 */
export function useVideoProject(workspaceId: string, projectId: string) {
  return useQuery<VideoProjectDetail, ApiError>({
    queryKey: key(workspaceId, 'project', projectId),
    queryFn: () => api.get(`${base(workspaceId)}/projects/${projectId}`),
    enabled: Boolean(projectId),
    refetchInterval: (query) => {
      const active = query.state.data?.renders.some(
        (render) => render.status === 'QUEUED' || render.status === 'RUNNING',
      );
      return active ? 2000 : false;
    },
  });
}

export function useCreateVideoProject(workspaceId: string) {
  const client = useQueryClient();
  return useMutation<{ project: VideoProjectRow }, ApiError, CreateVideoProjectInput>({
    mutationFn: (input) => api.post(`${base(workspaceId)}/projects`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useUpdateVideoProject(workspaceId: string, projectId: string) {
  const client = useQueryClient();
  return useMutation<VideoProjectDetail, ApiError, UpdateVideoProjectInput>({
    mutationFn: (input) =>
      apiFetch(`${base(workspaceId)}/projects/${projectId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useStartVideoRender(workspaceId: string, projectId: string) {
  const client = useQueryClient();
  return useMutation<
    { created: boolean; render: VideoRenderRow },
    ApiError,
    { captions: 'NONE' | 'SRT' | 'VTT'; thumbnail: boolean; crf: number; formatKey?: string }
  >({
    mutationFn: (input) => api.post(`${base(workspaceId)}/projects/${projectId}/renders`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useCancelVideoRender(workspaceId: string) {
  const client = useQueryClient();
  return useMutation<{ render: VideoRenderRow }, ApiError, string>({
    mutationFn: (renderId) => api.post(`${base(workspaceId)}/renders/${renderId}/cancel`),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

/** A short-lived signed URL for a finished render's video, captions or poster. */
export function useVideoRenderUrl(workspaceId: string) {
  return useMutation<
    { url: string; expiresAt: string; mimeType: string; sizeBytes: number },
    ApiError,
    { renderId: string; file?: 'video' | 'captions' | 'poster' }
  >({
    mutationFn: ({ renderId, file }) =>
      api.get(`${base(workspaceId)}/renders/${renderId}/url${file ? `?file=${file}` : ''}`),
  });
}

export const RENDER_STATUS_VARIANT: Record<
  VideoRenderStatus,
  'success' | 'warning' | 'destructive' | 'secondary' | 'muted'
> = {
  QUEUED: 'muted',
  RUNNING: 'warning',
  SUCCEEDED: 'success',
  FAILED: 'destructive',
  CANCELLED: 'muted',
  TIMED_OUT: 'destructive',
};

export function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * A script becomes a storyboard: one scene per non-empty line, each with the
 * line as its heading and its caption. It is a starting point the editor then
 * refines — never a hidden transformation of what the user wrote.
 */
export function scriptToStoryboard(script: string, msPerScene = 3000) {
  const lines = script
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 20);
  return {
    schemaVersion: 1 as const,
    transitionMs: 0,
    burnCaptions: false,
    scenes: lines.map((line, index) => ({
      id: `scene-${index + 1}`,
      durationMs: msPerScene,
      background: {
        kind: 'COLOR' as const,
        color: index % 2 === 0 ? '#0F766E' : '#1E293B',
      },
      heading: {
        text: line.slice(0, 280),
        position: 'CENTER' as const,
        color: '#FFFFFF',
        sizeRatio: 0.06,
        background: 'BAND' as const,
      },
      caption: line.slice(0, 500),
    })),
  };
}
