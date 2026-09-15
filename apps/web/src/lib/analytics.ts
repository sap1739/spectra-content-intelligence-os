'use client';

import type {
  AnalyticsAggregateMetric,
  AnalyticsAvailability,
  AnalyticsFreshness,
  AnalyticsMetric,
  AnalyticsMetricDefinition,
  AnalyticsProviderCapability,
  AnalyticsSnapshot,
  AnalyticsSyncRequest,
  AnalyticsSyncRun,
  AnalyticsUnavailableReason,
  NormalizedCampaignAnalytics,
} from '@spectra/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api, apiFetch, type ApiError } from './api';

// ---------------------------------------------------------------------------
// First-party overview
// ---------------------------------------------------------------------------

export interface AnalyticsOverview {
  source?: 'FIRST_PARTY_MEASURED';
  content: {
    total: number;
    byLifecycleState: Record<string, number>;
    published: number;
    awaitingReview: number;
  };
  drafts: { total: number; byStatus: Record<string, number> };
  publications: { total: number; byStatus: Record<string, number>; unsupported: number };
  research: {
    runs: number;
    runsByStatus: Record<string, number>;
    findings: number;
    evidencePacksReady: number;
  };
  trends: { total: number; byState: Record<string, number> };
  engagement: { externalAvailable: boolean; note: string };
  generatedAt: string;
}

export function useAnalyticsOverview(workspaceId: string) {
  return useQuery<AnalyticsOverview, ApiError>({
    queryKey: ['workspaces', workspaceId, 'analytics-overview'],
    queryFn: () => api.get<AnalyticsOverview>(`/v1/workspaces/${workspaceId}/analytics/overview`),
    staleTime: 15_000,
  });
}

// ---------------------------------------------------------------------------
// External analytics (ADR-0039)
// ---------------------------------------------------------------------------

export interface AnalyticsProvidersResponse {
  metricDefinitions: AnalyticsMetricDefinition[];
  providers: AnalyticsProviderCapability[];
  scheduledSync: { enabled: boolean; intervalMinutes: number };
  note: string;
}

export interface AccountAvailabilityRow {
  socialAccountId: string;
  platform: string;
  kind: string;
  displayName: string;
  availability: AnalyticsAvailability;
  reason: string;
  capability: AnalyticsProviderCapability;
  freshness: AnalyticsFreshness;
}

export interface AnalyticsSummary {
  source: 'EXTERNAL_MEASURED';
  externalAvailable: boolean;
  publishedPosts: number;
  postsWithSnapshots: number;
  postsWithMeasuredValues: number;
  postsWithoutAnalytics: number;
  accountsWithSnapshots: number;
  content: AnalyticsAggregateMetric[];
  followers: AnalyticsAggregateMetric;
  byPlatform: Array<{ platform: string; posts: number; metrics: AnalyticsAggregateMetric[] }>;
  freshness: AnalyticsFreshness;
  lastRun: AnalyticsSyncRun | null;
  note: string;
}

export interface UnavailableMetricRow {
  platform: string;
  level: 'ACCOUNT' | 'CONTENT';
  metric: string;
  label: string;
  reason: AnalyticsUnavailableReason;
  detail: string | null;
  snapshots: number;
}

export interface ContentAnalyticsResponse {
  item: { id: string; title: string; lifecycleState: string; campaignId: string | null };
  source: 'EXTERNAL_MEASURED';
  entries: Array<{
    scheduleEntryId: string;
    platform: string;
    status: string;
    externalUrl: string | null;
    publishedAt: string | null;
    latest: AnalyticsSnapshot | null;
    history: Array<{ snapshotId: string; retrievedAt: string; metrics: AnalyticsMetric[] }>;
    freshness: AnalyticsFreshness;
    unavailableReason: string | null;
  }>;
}

export interface CampaignAnalyticsResponse {
  campaign: { id: string; name: string; status: string };
  analytics: NormalizedCampaignAnalytics;
  note: string;
  posts: Array<{
    scheduleEntryId: string;
    contentItemId: string;
    title: string;
    platform: string;
    publishedAt: string | null;
    externalUrl: string | null;
    snapshot: AnalyticsSnapshot | null;
  }>;
}

export interface ProviderStatusResponse {
  providers: Array<{
    platform: string;
    lastErrorCode: string;
    lastMessage: string | null;
    at: string;
    occurrences: number;
  }>;
  rateLimits: Array<{
    runId: string;
    status: string;
    limited: boolean;
    retryAfterSeconds: number | null;
    nextAttemptAt: string | null;
    note: string | null;
  }>;
  recentRuns: number;
}

const base = (workspaceId: string) => `/v1/workspaces/${workspaceId}/analytics`;
const key = (workspaceId: string, ...rest: string[]) => [
  'workspaces',
  workspaceId,
  'analytics',
  ...rest,
];

export function useAnalyticsProviders(workspaceId: string) {
  return useQuery<AnalyticsProvidersResponse, ApiError>({
    queryKey: key(workspaceId, 'providers'),
    queryFn: () => api.get(`${base(workspaceId)}/providers`),
    staleTime: 60_000,
  });
}

export function useAnalyticsAvailability(workspaceId: string) {
  return useQuery<{ accounts: AccountAvailabilityRow[]; note: string }, ApiError>({
    queryKey: key(workspaceId, 'availability'),
    queryFn: () => api.get(`${base(workspaceId)}/availability`),
    staleTime: 15_000,
  });
}

export function useAnalyticsSummary(workspaceId: string) {
  return useQuery<AnalyticsSummary, ApiError>({
    queryKey: key(workspaceId, 'summary'),
    queryFn: () => api.get(`${base(workspaceId)}/summary`),
    staleTime: 15_000,
  });
}

export function useUnavailableMetrics(workspaceId: string) {
  return useQuery<{ metrics: UnavailableMetricRow[] }, ApiError>({
    queryKey: key(workspaceId, 'unavailable'),
    queryFn: () => api.get(`${base(workspaceId)}/unavailable-metrics`),
    staleTime: 15_000,
  });
}

export function useProviderStatus(workspaceId: string) {
  return useQuery<ProviderStatusResponse, ApiError>({
    queryKey: key(workspaceId, 'provider-status'),
    queryFn: () => api.get(`${base(workspaceId)}/provider-status`),
    staleTime: 15_000,
  });
}

export function isSyncActive(run: Pick<AnalyticsSyncRun, 'status'> | null | undefined): boolean {
  return run?.status === 'QUEUED' || run?.status === 'RUNNING';
}

export function useSyncRuns(workspaceId: string) {
  return useQuery<AnalyticsSyncRun[], ApiError>({
    queryKey: key(workspaceId, 'sync-runs'),
    queryFn: () => api.get(`${base(workspaceId)}/sync-runs?limit=10`),
    // Poll only while something is in flight.
    refetchInterval: (query) => (query.state.data?.some(isSyncActive) ? 4_000 : false),
  });
}

export function useContentAnalytics(workspaceId: string, contentItemId: string) {
  return useQuery<ContentAnalyticsResponse, ApiError>({
    queryKey: key(workspaceId, 'content', contentItemId),
    queryFn: () => api.get(`${base(workspaceId)}/content/${contentItemId}`),
    enabled: Boolean(contentItemId),
  });
}

export function useCampaignAnalytics(workspaceId: string, campaignId: string) {
  return useQuery<CampaignAnalyticsResponse, ApiError>({
    queryKey: key(workspaceId, 'campaign', campaignId),
    queryFn: () => api.get(`${base(workspaceId)}/campaigns/${campaignId}`),
    enabled: Boolean(campaignId),
  });
}

/**
 * Starts a sync. Each click carries its own Idempotency-Key, so a double
 * submit (or a retried request) joins the same run instead of starting two.
 */
export function useStartAnalyticsSync(workspaceId: string) {
  const client = useQueryClient();
  return useMutation<{ created: boolean; run: AnalyticsSyncRun }, ApiError, AnalyticsSyncRequest>({
    mutationFn: (body) =>
      apiFetch(`${base(workspaceId)}/sync`, {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'idempotency-key': `ui-${crypto.randomUUID()}` },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key(workspaceId) }),
  });
}

// ---------------------------------------------------------------------------
// Display — unavailable is never rendered as zero
// ---------------------------------------------------------------------------

export const UNAVAILABLE_REASON_LABEL: Record<AnalyticsUnavailableReason, string> = {
  NOT_EXPOSED_BY_PLATFORM: 'Not offered by the platform',
  DEPRECATED_BY_PLATFORM: 'Removed by the platform',
  NOT_IMPLEMENTED: 'Not read by Spectra yet',
  MISSING_SCOPE: 'Missing permission',
  APPROVAL_REQUIRED: 'Needs platform approval',
  PROVIDER_UNCONFIGURED: 'Not configured',
  NOT_CONNECTED: 'Not connected',
  REAUTH_REQUIRED: 'Reconnect needed',
  ACCOUNT_KIND_UNSUPPORTED: 'Not for this account type',
  CONTENT_NOT_PUBLISHED: 'Not published',
  CONTENT_TYPE_UNSUPPORTED: 'Not for this post type',
  OUTSIDE_RETENTION_WINDOW: 'Too old for the platform',
  NOT_YET_AVAILABLE: 'Not reported yet',
  RATE_LIMITED: 'Rate limited',
  QUOTA_EXCEEDED: 'Quota used up',
  PROVIDER_ERROR: 'Platform error',
  DENOMINATOR_UNKNOWN: 'No denominator',
  NOT_ADDITIVE: 'Cannot be summed',
  BUDGET_BLOCKED: 'Budget limit',
  NOT_REPORTED: 'Not reported',
};

export const AVAILABILITY_LABEL: Record<AnalyticsAvailability, string> = {
  AVAILABLE: 'Available',
  PARTIAL: 'Partial',
  MISSING_SCOPE: 'Missing scope',
  APPROVAL_REQUIRED: 'Approval required',
  NOT_CONNECTED: 'Not connected',
  REAUTH_REQUIRED: 'Reconnect needed',
  UNCONFIGURED: 'Unconfigured',
  NOT_IMPLEMENTED: 'Not implemented',
  UNSUPPORTED: 'Unsupported',
};

export function availabilityVariant(
  availability: AnalyticsAvailability,
): 'success' | 'warning' | 'destructive' | 'muted' {
  if (availability === 'AVAILABLE') return 'success';
  if (
    availability === 'PARTIAL' ||
    availability === 'MISSING_SCOPE' ||
    availability === 'APPROVAL_REQUIRED'
  ) {
    return 'warning';
  }
  if (availability === 'REAUTH_REQUIRED') return 'destructive';
  return 'muted';
}

/**
 * A metric value for display. `null` is ALWAYS "Unavailable" (with the reason
 * label when there is one) — never "0", never a dash that could pass for zero.
 */
export function formatMetricValue(metric: {
  value: number | null;
  unit: string;
  completeness: string;
  unavailableReason?: AnalyticsUnavailableReason | null;
}): string {
  if (metric.value === null) {
    return metric.unavailableReason
      ? `Unavailable · ${UNAVAILABLE_REASON_LABEL[metric.unavailableReason]}`
      : 'Unavailable';
  }
  const approx = metric.completeness === 'APPROXIMATE' ? '≈ ' : '';
  switch (metric.unit) {
    case 'RATIO':
      return `${approx}${(metric.value * 100).toFixed(2)}%`;
    case 'MINUTES':
      return `${approx}${Math.round(metric.value).toLocaleString('en-US')} min`;
    case 'SECONDS':
      return `${approx}${Math.round(metric.value).toLocaleString('en-US')} s`;
    default:
      return `${approx}${metric.value.toLocaleString('en-US')}`;
  }
}

export function freshnessLabel(freshness: AnalyticsFreshness, now: Date = new Date()): string {
  if (freshness.state === 'NEVER_SYNCED' || !freshness.retrievedAt) return 'Never synced';
  const minutes = Math.max(
    0,
    Math.round((now.getTime() - new Date(freshness.retrievedAt).getTime()) / 60_000),
  );
  const ago =
    minutes < 1
      ? 'just now'
      : minutes < 60
        ? `${minutes} min ago`
        : minutes < 48 * 60
          ? `${Math.round(minutes / 60)} h ago`
          : `${Math.round(minutes / 1440)} d ago`;
  return `${freshness.state === 'STALE' ? 'Stale' : 'Fresh'} · retrieved ${ago}`;
}
