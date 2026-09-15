import {
  ANALYTICS_METRIC_DEFINITIONS,
  ANALYTICS_METRIC_KEYS,
  type AnalyticsProviderCapability,
  type AnalyticsUnavailableReason,
  type SocialPlatform,
} from '@spectra/contracts';

import { describeCapability, type MetricSpec } from './provider';

/**
 * Platforms with NO analytics adapter in this codebase, each with the truthful
 * reason. Checked against each platform's documentation on 2026-09-14; where a
 * detail could not be verified it is not stated.
 *
 * Nothing here is ever fetched — these records exist so the API and UI can say
 * "not implemented, and here is what it would take" instead of showing blanks.
 */

interface UnimplementedPlatform {
  providerName: string;
  reason: AnalyticsUnavailableReason;
  summary: string;
  approvalNotes: string[];
  paidApi: boolean;
  docsUrls: string[];
}

const UNIMPLEMENTED: Partial<Record<SocialPlatform, UnimplementedPlatform>> = {
  TIKTOK: {
    providerName: 'TikTok',
    reason: 'NOT_IMPLEMENTED',
    summary:
      "Not implemented. TikTok's Display API documents per-video view, like, comment and share counts, but reading them needs a Display API scope Spectra does not request, and no TikTok analytics adapter exists yet.",
    approvalNotes: ['TikTok reviews the scopes an app requests before they can be used.'],
    paidApi: false,
    docsUrls: ['https://developers.tiktok.com/doc/tiktok-api-v2-video-object'],
  },
  X: {
    providerName: 'X',
    reason: 'NOT_IMPLEMENTED',
    summary:
      "Not implemented. X API v2 documents public metrics on posts (likes, reposts, replies, quotes, bookmarks, impressions) and owner-only non-public metrics for posts from the last 30 days. X's API is pay-per-usage, so reading them would cost credits per request; no X analytics adapter exists yet.",
    approvalNotes: [
      'X API v2 is pay-per-usage: every analytics read would be billed, and a budget pre-flight would apply.',
    ],
    paidApi: true,
    docsUrls: ['https://docs.x.com/x-api/fundamentals/metrics'],
  },
  THREADS: {
    providerName: 'Threads',
    reason: 'NOT_IMPLEMENTED',
    summary:
      'Not implemented. The Threads Insights API documents per-post views, likes, replies, reposts, quotes and shares behind threads_manage_insights, which Spectra does not request; no Threads analytics adapter exists yet.',
    approvalNotes: ['Meta App Review is required for threads_manage_insights.'],
    paidApi: false,
    docsUrls: ['https://developers.facebook.com/docs/threads/insights'],
  },
  PINTEREST: {
    providerName: 'Pinterest',
    reason: 'NOT_IMPLEMENTED',
    summary:
      "Not implemented. Pinterest's API offers pin analytics, but their metric list and access requirements were not verified for this release, so no Pinterest analytics adapter exists yet.",
    approvalNotes: ['Pinterest reviews apps before Standard access.'],
    paidApi: false,
    docsUrls: ['https://developers.pinterest.com/docs/api/v5/'],
  },
  EMAIL: {
    providerName: 'Email',
    reason: 'NOT_EXPOSED_BY_PLATFORM',
    summary:
      'Unsupported. Email is not integrated with any sending provider (a deliberate placeholder), so there are no opens, clicks or deliveries to read.',
    approvalNotes: [],
    paidApi: false,
    docsUrls: [],
  },
};

/** The capability record for a platform with no analytics adapter, or null when one exists. */
export function unimplementedAnalyticsCapability(
  platform: SocialPlatform,
): AnalyticsProviderCapability | null {
  const entry = UNIMPLEMENTED[platform];
  if (!entry) return null;
  const specs: MetricSpec[] = [];
  for (const level of ['ACCOUNT', 'CONTENT'] as const) {
    for (const key of ANALYTICS_METRIC_KEYS) {
      if (!ANALYTICS_METRIC_DEFINITIONS[key].levels.includes(level)) continue;
      specs.push({
        key,
        level,
        sourceMetricName: null,
        unavailable: { reason: entry.reason, detail: entry.summary },
      });
    }
  }
  const capability = describeCapability({
    platform,
    providerId: `${platform.toLowerCase()}-analytics-none`,
    providerName: entry.providerName,
    summary: entry.summary,
    implemented: false,
    configured: true,
    specs,
    grantedScopes: null,
    levels: {
      account: { supported: false, reason: entry.summary },
      content: { supported: false, reason: entry.summary },
      campaign: { supported: false, reason: entry.summary },
      comments: { supported: false, reason: entry.summary },
    },
    approval: { required: entry.approvalNotes.length > 0, notes: entry.approvalNotes },
    freshnessNote: 'Nothing is retrieved, so nothing can be fresh or stale.',
    rateLimitNote: 'No calls are made.',
    paidApi: entry.paidApi,
    docsUrls: entry.docsUrls,
  });
  return entry.reason === 'NOT_EXPOSED_BY_PLATFORM'
    ? { ...capability, availability: 'UNSUPPORTED' }
    : capability;
}

/** Platforms whose analytics are explicitly not implemented or unsupported. */
export function unimplementedAnalyticsPlatforms(): SocialPlatform[] {
  return Object.keys(UNIMPLEMENTED) as SocialPlatform[];
}
