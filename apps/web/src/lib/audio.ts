'use client';

import type {
  AudioFailureReason,
  AudioProviderCapability,
  AudioRenderStatus,
  CreatePodcastEpisodeInput,
  CreateVoiceProfileInput,
  PodcastEpisodeStatus,
  PodcastScript,
  RecordVoiceConsentInput,
  TranscriptSource,
  UpdatePodcastEpisodeInput,
  VoiceBlockReason,
  VoiceConsentScope,
  VoiceConsentStatus,
  VoiceKind,
} from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, apiFetch, type ApiError } from './api';

/** Audio, voiceover and podcasts (Phase 7C, ADR-0042). */

const base = (workspaceId: string) => `/v1/workspaces/${workspaceId}/audio`;
const key = (workspaceId: string, ...rest: string[]) => [
  'workspaces',
  workspaceId,
  'audio',
  ...rest,
];

export interface AudioCapabilities {
  engine: {
    available: boolean;
    reason: string;
    engineVersion: string | null;
    audioCodec: string | null;
    features: {
      mixing: boolean;
      normalization: boolean;
      waveform: boolean;
      audiogram: boolean;
      burnedCaptions: boolean;
    };
    missing: string[];
  };
  providers: AudioProviderCapability[];
  generatesAudio: boolean;
  generationNote: string;
  consentPolicy: string;
  failureReasons: Record<AudioFailureReason, string>;
}

export interface ConsentRow {
  id: string;
  subjectName: string;
  method: string;
  scopes: VoiceConsentScope[];
  status: VoiceConsentStatus;
  grantedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  reference: string | null;
}

export interface VoiceRow {
  id: string;
  name: string;
  kind: VoiceKind;
  language: string;
  description: string | null;
  subjectName: string | null;
  consents: ConsentRow[];
  requiresConsent: boolean;
  usable: boolean;
  blockReason: VoiceBlockReason | null;
  message: string | null;
}

export interface AudioRenderRow {
  id: string;
  episodeId: string;
  kind: string;
  status: AudioRenderStatus;
  progressPercent: number;
  failureReason: AudioFailureReason | null;
  failureDetail: string | null;
  durationMs: number | null;
  sizeBytes: number | null;
  integratedLufs: number | null;
  warnings: string[];
  mediaAssetId: string | null;
  waveformAssetId: string | null;
  createdAt: string;
}

export interface EpisodeRow {
  id: string;
  title: string;
  summary: string | null;
  showNotes: string | null;
  status: PodcastEpisodeStatus;
  script: PodcastScript;
  consentScope: VoiceConsentScope;
  audioAssetId: string | null;
  durationMs: number | null;
  integratedLufs: number | null;
  createdAt: string;
  updatedAt: string;
  _count?: { renders: number };
}

export interface EpisodeDetail {
  episode: EpisodeRow;
  renders: AudioRenderRow[];
  transcripts: Array<{ id: string; source: TranscriptSource; language: string; cues: unknown[] }>;
  plan: { segments: number; warnings: string[] } | null;
  problems: string[];
  voices: Array<{
    id: string;
    name: string;
    kind: VoiceKind;
    usable: boolean;
    reason: VoiceBlockReason | null;
    message: string | null;
    requiresConsent: boolean;
  }>;
}

export function useAudioCapabilities(workspaceId: string) {
  return useQuery<AudioCapabilities, ApiError>({
    queryKey: key(workspaceId, 'capabilities'),
    queryFn: () => api.get(`${base(workspaceId)}/capabilities`),
    staleTime: 300_000,
  });
}

export function useVoices(workspaceId: string) {
  return useQuery<{ voices: VoiceRow[] }, ApiError>({
    queryKey: key(workspaceId, 'voices'),
    queryFn: () => api.get(`${base(workspaceId)}/voices`),
  });
}

export function useCreateVoice(workspaceId: string) {
  const client = useQueryClient();
  return useMutation<{ voice: VoiceRow }, ApiError, CreateVoiceProfileInput>({
    mutationFn: (input) => api.post(`${base(workspaceId)}/voices`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useRecordConsent(workspaceId: string, voiceId: string) {
  const client = useQueryClient();
  return useMutation<{ voice: VoiceRow }, ApiError, RecordVoiceConsentInput>({
    mutationFn: (input) => api.post(`${base(workspaceId)}/voices/${voiceId}/consent`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useRevokeConsent(workspaceId: string, voiceId: string) {
  const client = useQueryClient();
  return useMutation<{ voice: VoiceRow }, ApiError, { consentId: string; reason: string }>({
    mutationFn: ({ consentId, reason }) =>
      api.post(`${base(workspaceId)}/voices/${voiceId}/consent/${consentId}/revoke`, { reason }),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useEpisodes(workspaceId: string) {
  return useQuery<{ episodes: EpisodeRow[] }, ApiError>({
    queryKey: key(workspaceId, 'episodes'),
    queryFn: () => api.get(`${base(workspaceId)}/episodes`),
  });
}

/** Polls only while a render is queued or running — mixing happens in the worker. */
export function useEpisode(workspaceId: string, episodeId: string) {
  return useQuery<EpisodeDetail, ApiError>({
    queryKey: key(workspaceId, 'episode', episodeId),
    queryFn: () => api.get(`${base(workspaceId)}/episodes/${episodeId}`),
    enabled: Boolean(episodeId),
    refetchInterval: (query) => {
      const active = query.state.data?.renders.some(
        (render) => render.status === 'QUEUED' || render.status === 'RUNNING',
      );
      return active ? 2000 : false;
    },
  });
}

export function useCreateEpisode(workspaceId: string) {
  const client = useQueryClient();
  return useMutation<{ episode: EpisodeRow }, ApiError, CreatePodcastEpisodeInput>({
    mutationFn: (input) => api.post(`${base(workspaceId)}/episodes`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useUpdateEpisode(workspaceId: string, episodeId: string) {
  const client = useQueryClient();
  return useMutation<EpisodeDetail, ApiError, UpdatePodcastEpisodeInput>({
    mutationFn: (input) =>
      apiFetch(`${base(workspaceId)}/episodes/${episodeId}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useStartAudioRender(workspaceId: string, episodeId: string) {
  const client = useQueryClient();
  return useMutation<
    { created: boolean; render: AudioRenderRow },
    ApiError,
    { kind?: string; waveform?: boolean }
  >({
    mutationFn: (input) =>
      api.post(`${base(workspaceId)}/episodes/${episodeId}/renders`, {
        kind: 'EPISODE_MIX',
        waveform: true,
        ...input,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useCancelAudioRender(workspaceId: string) {
  const client = useQueryClient();
  return useMutation<{ render: AudioRenderRow }, ApiError, string>({
    mutationFn: (renderId) => api.post(`${base(workspaceId)}/renders/${renderId}/cancel`),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

export function useAudioRenderUrl(workspaceId: string) {
  return useMutation<
    { url: string; expiresAt: string; mimeType: string; sizeBytes: number },
    ApiError,
    { renderId: string; file?: 'audio' | 'waveform' }
  >({
    mutationFn: ({ renderId, file }) =>
      api.get(`${base(workspaceId)}/renders/${renderId}/url${file ? `?file=${file}` : ''}`),
  });
}

export const AUDIO_STATUS_VARIANT: Record<
  AudioRenderStatus,
  'success' | 'warning' | 'destructive' | 'muted'
> = {
  QUEUED: 'muted',
  RUNNING: 'warning',
  SUCCEEDED: 'success',
  FAILED: 'destructive',
  CANCELLED: 'muted',
  TIMED_OUT: 'destructive',
};

export const CONSENT_STATUS_VARIANT: Record<
  VoiceConsentStatus,
  'success' | 'warning' | 'destructive' | 'muted'
> = {
  GRANTED: 'success',
  PENDING: 'warning',
  REVOKED: 'destructive',
  EXPIRED: 'destructive',
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
 * A script becomes segments: one per non-empty line, alternating host turns.
 * Visible before anything is created — never a hidden transformation.
 */
export function scriptToSegments(text: string) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 50)
    .map((line, index) => ({
      id: `segment-${index + 1}`,
      kind: index === 0 ? ('INTRO' as const) : ('HOST' as const),
      title: line.slice(0, 60),
      source: { kind: 'SILENCE' as const, durationMs: 1000 },
      gainDb: 0,
      hostNotes: line.slice(0, 5000),
    }));
}
