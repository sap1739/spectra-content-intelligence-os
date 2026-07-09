'use client';

import type {
  CreateCampaignInput,
  CreatePersonaInput,
  CreatePillarInput,
  CreateTopicIdeaInput,
  UpdateTopicIdeaStatusInput,
  UpsertCampaignBriefInput,
} from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, type ApiError } from './api';

export interface BriefRow {
  id: string;
  background: string | null;
  objectives: string[];
  keyMessages: string[];
  mandatories: string[];
  doNots: string[];
  tone: string | null;
}

export interface CampaignRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  timezone: string;
  startAt: string | null;
  endAt: string | null;
  createdAt: string;
  brief: BriefRow | null;
  _count: { contentItems: number };
}

export interface PersonaRow {
  id: string;
  name: string;
  description: string | null;
  roles: string[];
  seniority: string | null;
  industries: string[];
  painPoints: string[];
  goals: string[];
  preferredPlatforms: string[];
  languages: string[];
}

export interface PillarRow {
  id: string;
  name: string;
  description: string | null;
  keywords: string[];
}

export interface TopicIdeaRow {
  id: string;
  title: string;
  description: string | null;
  status: 'PROPOSED' | 'SHORTLISTED' | 'IN_USE' | 'DISCARDED';
  evidencePackId: string | null;
  findingIds: string[];
  createdAt: string;
}

// --- Campaigns -------------------------------------------------------------

const campaignsKey = (ws: string) => ['workspaces', ws, 'campaigns'] as const;

export function useCampaigns(workspaceId: string) {
  return useQuery<CampaignRow[], ApiError>({
    queryKey: campaignsKey(workspaceId),
    queryFn: () => api.get<CampaignRow[]>(`/v1/workspaces/${workspaceId}/campaigns`),
  });
}

export function useCreateCampaign(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<CampaignRow, ApiError, CreateCampaignInput>({
    mutationFn: (input) => api.post<CampaignRow>(`/v1/workspaces/${workspaceId}/campaigns`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignsKey(workspaceId) }),
  });
}

export function useUpsertBrief(workspaceId: string, campaignId: string) {
  const qc = useQueryClient();
  return useMutation<BriefRow, ApiError, UpsertCampaignBriefInput>({
    mutationFn: (input) =>
      api.put<BriefRow>(`/v1/workspaces/${workspaceId}/campaigns/${campaignId}/brief`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: campaignsKey(workspaceId) }),
  });
}

// --- Personas --------------------------------------------------------------

const personasKey = (ws: string) => ['workspaces', ws, 'personas'] as const;

export function usePersonas(workspaceId: string) {
  return useQuery<PersonaRow[], ApiError>({
    queryKey: personasKey(workspaceId),
    queryFn: () => api.get<PersonaRow[]>(`/v1/workspaces/${workspaceId}/personas`),
  });
}

export function useCreatePersona(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<PersonaRow, ApiError, CreatePersonaInput>({
    mutationFn: (input) => api.post<PersonaRow>(`/v1/workspaces/${workspaceId}/personas`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: personasKey(workspaceId) }),
  });
}

export function useDeletePersona(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => api.delete<void>(`/v1/workspaces/${workspaceId}/personas/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: personasKey(workspaceId) }),
  });
}

// --- Pillars ---------------------------------------------------------------

const pillarsKey = (ws: string) => ['workspaces', ws, 'content-pillars'] as const;

export function usePillars(workspaceId: string) {
  return useQuery<PillarRow[], ApiError>({
    queryKey: pillarsKey(workspaceId),
    queryFn: () => api.get<PillarRow[]>(`/v1/workspaces/${workspaceId}/content-pillars`),
  });
}

export function useCreatePillar(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<PillarRow, ApiError, CreatePillarInput>({
    mutationFn: (input) =>
      api.post<PillarRow>(`/v1/workspaces/${workspaceId}/content-pillars`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: pillarsKey(workspaceId) }),
  });
}

export function useDeletePillar(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => api.delete<void>(`/v1/workspaces/${workspaceId}/content-pillars/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: pillarsKey(workspaceId) }),
  });
}

// --- Topic ideas -----------------------------------------------------------

const topicsKey = (ws: string) => ['workspaces', ws, 'topic-ideas'] as const;

export function useTopicIdeas(workspaceId: string) {
  return useQuery<TopicIdeaRow[], ApiError>({
    queryKey: topicsKey(workspaceId),
    queryFn: () => api.get<TopicIdeaRow[]>(`/v1/workspaces/${workspaceId}/topic-ideas`),
  });
}

export function useCreateTopicIdea(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<TopicIdeaRow, ApiError, CreateTopicIdeaInput>({
    mutationFn: (input) =>
      api.post<TopicIdeaRow>(`/v1/workspaces/${workspaceId}/topic-ideas`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: topicsKey(workspaceId) }),
  });
}

export function useSetTopicStatus(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<TopicIdeaRow, ApiError, { id: string } & UpdateTopicIdeaStatusInput>({
    mutationFn: ({ id, status }) =>
      api.patch<TopicIdeaRow>(`/v1/workspaces/${workspaceId}/topic-ideas/${id}`, { status }),
    onSuccess: () => qc.invalidateQueries({ queryKey: topicsKey(workspaceId) }),
  });
}

export function useDeleteTopicIdea(workspaceId: string) {
  const qc = useQueryClient();
  return useMutation<void, ApiError, string>({
    mutationFn: (id) => api.delete<void>(`/v1/workspaces/${workspaceId}/topic-ideas/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: topicsKey(workspaceId) }),
  });
}
