import {
  AnalyticsProviderError,
  countOrNotReported,
  describeCapability,
  fetchableKeys,
  finalizeMetrics,
  readCount,
  unavailable,
  unavailableFromSpecs,
  type AnalyticsContentTarget,
  type AnalyticsFetchResult,
  type AnalyticsProvider,
  type MetricSpec,
} from '@spectra/analytics-core';
import type { AnalyticsMetric, AnalyticsProviderCapability } from '@spectra/contracts';

import { YouTubeApiError, YouTubeClient, type YouTubeApiOptions } from './client';
import {
  DEFAULT_YOUTUBE_ANALYTICS_API_BASE_URL,
  VIDEO_ID,
  YOUTUBE_PLATFORM,
  YOUTUBE_SCOPES,
} from './constants';

/**
 * YouTube analytics (ADR-0039), from two official APIs, checked 2026-09-14:
 *
 * - YouTube Data API v3 `videos.list?part=statistics` (1 quota unit) and
 *   `channels.list?part=statistics&mine=true`: view, like and comment counts
 *   per video; view and subscriber counts per channel. Google documents
 *   `subscriberCount` as "rounded down to three significant figures", so it is
 *   APPROXIMATE, and `dislikeCount` as private to the owner — it is not read.
 * - YouTube Analytics API `reports.query` with `filters=video==ID`:
 *   `estimatedMinutesWatched`, `averageViewDuration` and `shares`. Needs
 *   `yt-analytics.readonly`, which Spectra does not request by default; without
 *   it those three are MISSING_SCOPE and the Data API counts still come back.
 *   Google says a report "contains data up until the last day for which all
 *   metrics in the query are available", so recent days can be missing.
 */

export const YOUTUBE_ANALYTICS_PROVIDER_ID = 'youtube-data-v3+analytics-v2';

const VIEW_DEFINITION_NOTE =
  'YouTube counts views its own way; from 24 August 2026 a view is counted when playback starts, including autoplay.';
const REPORT_DELAY_NOTE =
  'YouTube Analytics reports data up to the last day all requested metrics are available, so the most recent days may not be included yet.';

const notRead = (detail: string) => ({ reason: 'NOT_IMPLEMENTED' as const, detail });
const notExposed = (detail: string) => ({ reason: 'NOT_EXPOSED_BY_PLATFORM' as const, detail });

const ANALYTICS_SCOPE = [YOUTUBE_SCOPES.analytics];
const READ_SCOPE = [YOUTUBE_SCOPES.readonly];

export const YOUTUBE_ANALYTICS_SPECS: readonly MetricSpec[] = [
  // --- Channel ---------------------------------------------------------------
  {
    key: 'followers',
    level: 'ACCOUNT',
    sourceMetricName: 'statistics.subscriberCount',
    requiredScopes: READ_SCOPE,
    expectedCompleteness: 'APPROXIMATE',
    note: 'YouTube rounds subscriber counts down to three significant figures.',
  },
  {
    key: 'views',
    level: 'ACCOUNT',
    sourceMetricName: 'statistics.viewCount',
    requiredScopes: READ_SCOPE,
    note: VIEW_DEFINITION_NOTE,
  },
  {
    key: 'impressions',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads no YouTube impressions metric.'),
  },
  {
    key: 'reach',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads no YouTube reach metric.'),
  },
  {
    key: 'videoViews',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notExposed('YouTube reports a single view count; it is shown as views.'),
  },
  {
    key: 'watchTimeMinutes',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads watch time per video, not per channel.'),
  },
  {
    key: 'averageViewDurationSeconds',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads average view duration per video, not per channel.'),
  },
  {
    key: 'likes',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads likes per video, not per channel.'),
  },
  {
    key: 'reactions',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notExposed(
      'YouTube has likes, not reaction types; dislikes are private to the owner and not read.',
    ),
  },
  {
    key: 'comments',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads comments per video, not per channel.'),
  },
  {
    key: 'shares',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads shares per video, not per channel.'),
  },
  {
    key: 'saves',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notExposed('YouTube reports no saves metric through these APIs.'),
  },
  {
    key: 'clicks',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Spectra does not read YouTube card or end-screen click metrics.'),
  },
  {
    key: 'linkClicks',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Spectra does not read YouTube card or end-screen click metrics.'),
  },
  {
    key: 'engagementRate',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Engagement rate is calculated per video.'),
  },
  {
    key: 'profileVisits',
    level: 'ACCOUNT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads no YouTube channel-visit metric.'),
  },

  // --- Video -----------------------------------------------------------------
  {
    key: 'views',
    level: 'CONTENT',
    sourceMetricName: 'statistics.viewCount',
    requiredScopes: READ_SCOPE,
    note: VIEW_DEFINITION_NOTE,
  },
  {
    key: 'likes',
    level: 'CONTENT',
    sourceMetricName: 'statistics.likeCount',
    requiredScopes: READ_SCOPE,
  },
  {
    key: 'comments',
    level: 'CONTENT',
    sourceMetricName: 'statistics.commentCount',
    requiredScopes: READ_SCOPE,
  },
  {
    key: 'watchTimeMinutes',
    level: 'CONTENT',
    sourceMetricName: 'estimatedMinutesWatched',
    requiredScopes: ANALYTICS_SCOPE,
    reviewRequired: true,
    note: REPORT_DELAY_NOTE,
  },
  {
    key: 'averageViewDurationSeconds',
    level: 'CONTENT',
    sourceMetricName: 'averageViewDuration',
    requiredScopes: ANALYTICS_SCOPE,
    reviewRequired: true,
    note: REPORT_DELAY_NOTE,
  },
  {
    key: 'shares',
    level: 'CONTENT',
    sourceMetricName: 'shares',
    requiredScopes: ANALYTICS_SCOPE,
    reviewRequired: true,
    note: REPORT_DELAY_NOTE,
  },
  {
    key: 'impressions',
    level: 'CONTENT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads no YouTube impressions metric.'),
  },
  {
    key: 'reach',
    level: 'CONTENT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads no YouTube reach metric.'),
  },
  {
    key: 'videoViews',
    level: 'CONTENT',
    sourceMetricName: null,
    unavailable: notExposed('YouTube reports a single view count; it is shown as views.'),
  },
  {
    key: 'reactions',
    level: 'CONTENT',
    sourceMetricName: null,
    unavailable: notExposed(
      'YouTube has likes, not reaction types; dislikes are private to the owner and not read.',
    ),
  },
  {
    key: 'saves',
    level: 'CONTENT',
    sourceMetricName: null,
    unavailable: notExposed('YouTube reports no saves metric through these APIs.'),
  },
  {
    key: 'clicks',
    level: 'CONTENT',
    sourceMetricName: null,
    unavailable: notRead('Spectra does not read YouTube card or end-screen click metrics.'),
  },
  {
    key: 'linkClicks',
    level: 'CONTENT',
    sourceMetricName: null,
    unavailable: notRead('Spectra does not read YouTube card or end-screen click metrics.'),
  },
  {
    key: 'profileVisits',
    level: 'CONTENT',
    sourceMetricName: null,
    unavailable: notRead('Spectra reads no YouTube channel-visit metric.'),
  },
  {
    key: 'engagementRate',
    level: 'CONTENT',
    sourceMetricName: null,
    expectedCompleteness: 'DERIVED',
  },
];

const REPORT_METRICS = [
  { key: 'watchTimeMinutes', column: 'estimatedMinutesWatched' },
  { key: 'averageViewDurationSeconds', column: 'averageViewDuration' },
  { key: 'shares', column: 'shares' },
] as const;

/** What YouTube analytics can read with a given grant. No token needed. */
export function describeYouTubeAnalytics(input: {
  grantedScopes: readonly string[] | null;
  configured: boolean;
}): AnalyticsProviderCapability {
  return describeCapability({
    platform: YOUTUBE_PLATFORM,
    providerId: YOUTUBE_ANALYTICS_PROVIDER_ID,
    providerName: 'YouTube Data API v3 + YouTube Analytics API',
    summary:
      'Per-video views, likes and comments (Data API) plus watch time, average view duration and shares (Analytics API, needs yt-analytics.readonly), and channel views and subscribers. Comment text is not ingested.',
    implemented: true,
    configured: input.configured,
    specs: YOUTUBE_ANALYTICS_SPECS,
    grantedScopes: input.grantedScopes,
    levels: {
      account: {
        supported: true,
        reason: 'Channel views and (rounded) subscribers from channels.list.',
      },
      content: { supported: true, reason: 'Per-video statistics and Analytics API reports.' },
      campaign: {
        supported: false,
        reason:
          "YouTube has no campaign object for organic videos; Spectra sums the campaign's video snapshots itself.",
      },
      comments: {
        supported: true,
        reason: 'Comment counts only (statistics.commentCount). Comment text is not ingested.',
      },
    },
    approval: {
      required: true,
      notes: [
        'YouTube scopes are sensitive: Google OAuth verification is required before users outside your test list can connect.',
        'yt-analytics.readonly is not in Spectra’s default scopes. Add it with SOCIAL_OAUTH_YOUTUBE_SCOPES and reconnect to read watch time, average view duration and shares.',
      ],
    },
    freshnessNote: `Data API counts are current when fetched. ${REPORT_DELAY_NOTE}`,
    rateLimitNote:
      'videos.list and channels.list cost 1 Data API quota unit each against the project’s daily quota; the Analytics API has its own quota. A quota or rate refusal is retried with backoff.',
    paidApi: false,
    docsUrls: [
      'https://developers.google.com/youtube/v3/docs/videos',
      'https://developers.google.com/youtube/v3/docs/channels',
      'https://developers.google.com/youtube/analytics/reference/reports/query',
      'https://developers.google.com/youtube/analytics/metrics',
    ],
  });
}

export interface YouTubeAnalyticsProviderOptions extends YouTubeApiOptions {
  accessToken: string;
  channelId: string;
  /** null = Google did not report the grant; everything is attempted. */
  grantedScopes: readonly string[] | null;
  analyticsApiBaseUrl?: string;
  now?: () => Date;
  /** Called when Google rejects the token itself, so the connection is marked for reconnect. */
  onAuthRejected?: () => Promise<void>;
}

interface StatisticsItem {
  id?: unknown;
  statistics?: Record<string, unknown>;
  snippet?: { publishedAt?: unknown };
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

export class YouTubeAnalyticsProvider implements AnalyticsProvider {
  readonly platform = YOUTUBE_PLATFORM;
  readonly providerId = YOUTUBE_ANALYTICS_PROVIDER_ID;
  private readonly client: YouTubeClient;

  constructor(private readonly options: YouTubeAnalyticsProviderOptions) {
    this.client = new YouTubeClient(options.accessToken, options);
  }

  capability(): AnalyticsProviderCapability {
    return describeYouTubeAnalytics({
      grantedScopes: this.options.grantedScopes,
      configured: true,
    });
  }

  async fetchAccountAnalytics(): Promise<AnalyticsFetchResult> {
    const grant = this.options.grantedScopes;
    const metrics: AnalyticsMetric[] = unavailableFromSpecs(
      YOUTUBE_ANALYTICS_SPECS,
      'ACCOUNT',
      grant,
    );
    const fetchable = fetchableKeys(YOUTUBE_ANALYTICS_SPECS, 'ACCOUNT', grant);
    const notes: string[] = [];
    let hidden: boolean | null = null;
    if (fetchable.size > 0) {
      const body = await this.call(() =>
        this.client.get<{ items?: StatisticsItem[] }>('channels', {
          part: 'statistics',
          mine: 'true',
        }),
      );
      const channel = (body.items ?? []).find((item) => item.id === this.options.channelId);
      if (!channel) {
        throw new AnalyticsProviderError(
          'NOT_FOUND',
          'YouTube did not return this channel for the connected account, so its statistics could not be read. Reconnect YouTube with the account that owns the channel.',
        );
      }
      const stats = channel.statistics ?? {};
      hidden = stats['hiddenSubscriberCount'] === true;
      if (fetchable.has('followers')) {
        metrics.push(
          countOrNotReported('followers', stats['subscriberCount'], 'statistics.subscriberCount', {
            completeness: 'APPROXIMATE',
            detail: 'Rounded down to three significant figures by YouTube.',
          }),
        );
      }
      if (fetchable.has('views')) {
        metrics.push(
          countOrNotReported('views', stats['viewCount'], 'statistics.viewCount', {
            detail: VIEW_DEFINITION_NOTE,
          }),
        );
      }
      if (hidden) notes.push('The channel hides its subscriber count from the public.');
    }
    return {
      metrics: finalizeMetrics(YOUTUBE_ANALYTICS_SPECS, 'ACCOUNT', metrics),
      notes,
      dataAsOf: null,
      providerMetadata: hidden === null ? {} : { hiddenSubscriberCount: hidden },
    };
  }

  async fetchContentAnalytics(target: AnalyticsContentTarget): Promise<AnalyticsFetchResult> {
    if (!VIDEO_ID.test(target.externalContentId)) {
      throw new AnalyticsProviderError(
        'VALIDATION',
        'The recorded YouTube video id is not a YouTube video id, so no analytics were requested.',
      );
    }
    const grant = this.options.grantedScopes;
    const metrics: AnalyticsMetric[] = unavailableFromSpecs(
      YOUTUBE_ANALYTICS_SPECS,
      'CONTENT',
      grant,
    );
    const fetchable = fetchableKeys(YOUTUBE_ANALYTICS_SPECS, 'CONTENT', grant);
    const notes: string[] = [];

    const statisticKeys = (['views', 'likes', 'comments'] as const).filter((key) =>
      fetchable.has(key),
    );
    if (statisticKeys.length > 0) {
      const body = await this.call(() =>
        this.client.get<{ items?: StatisticsItem[] }>('videos', {
          part: 'statistics',
          id: target.externalContentId,
        }),
      );
      const video = (body.items ?? []).find((item) => item.id === target.externalContentId);
      if (!video) {
        throw new AnalyticsProviderError(
          'NOT_FOUND',
          'YouTube returned no video with this id — it may have been deleted, or is not visible to this channel.',
        );
      }
      const stats = video.statistics ?? {};
      const source = {
        views: 'statistics.viewCount',
        likes: 'statistics.likeCount',
        comments: 'statistics.commentCount',
      } as const;
      for (const key of statisticKeys) {
        metrics.push(
          countOrNotReported(key, stats[source[key].split('.')[1] as string], source[key], {
            ...(key === 'views' ? { detail: VIEW_DEFINITION_NOTE } : {}),
          }),
        );
      }
      if (fetchable.has('likes') && stats['likeCount'] === undefined) {
        notes.push('The video owner has hidden its like count, so YouTube did not report it.');
      }
    }

    const reportKeys = REPORT_METRICS.filter((metric) => fetchable.has(metric.key));
    if (reportKeys.length > 0) {
      metrics.push(...(await this.reportMetrics(target, reportKeys)));
      notes.push(REPORT_DELAY_NOTE);
    }

    return {
      metrics: finalizeMetrics(YOUTUBE_ANALYTICS_SPECS, 'CONTENT', metrics),
      notes,
      dataAsOf: null,
      providerMetadata: {},
    };
  }

  /**
   * The Analytics API report for one video. A refusal that is specific to this
   * API (the scope, the project) leaves these three metrics unavailable with
   * Google's reason and keeps the Data API counts; a token or rate refusal
   * fails the whole fetch like any other call.
   */
  private async reportMetrics(
    target: AnalyticsContentTarget,
    keys: ReadonlyArray<(typeof REPORT_METRICS)[number]>,
  ): Promise<AnalyticsMetric[]> {
    const now = (this.options.now ?? (() => new Date()))();
    const start = target.publishedAt ?? new Date(now.getTime() - 365 * 86_400_000);
    let body: { columnHeaders?: Array<{ name?: unknown }>; rows?: unknown[][] };
    try {
      body = await this.client.analyticsReport(
        this.options.analyticsApiBaseUrl ?? DEFAULT_YOUTUBE_ANALYTICS_API_BASE_URL,
        {
          ids: 'channel==MINE',
          startDate: isoDay(start),
          endDate: isoDay(now),
          metrics: keys.map((key) => key.column).join(','),
          filters: `video==${target.externalContentId}`,
        },
      );
    } catch (error) {
      if (error instanceof YouTubeApiError && error.kind === 'PERMISSION') {
        return keys.map((key) =>
          unavailable(
            key.key,
            'MISSING_SCOPE',
            `YouTube Analytics refused the report (${error.reason ?? 'forbidden'}). It needs ${YOUTUBE_SCOPES.analytics}.`,
            { sourceMetricName: key.column },
          ),
        );
      }
      throw await this.translate(error);
    }
    const headers = (body.columnHeaders ?? []).map((header) => header.name);
    const row = body.rows?.[0];
    return keys.map((key) => {
      if (!row) {
        return unavailable(
          key.key,
          'NOT_YET_AVAILABLE',
          'YouTube Analytics returned no rows for this video yet — reports lag behind the Data API counts.',
          { sourceMetricName: key.column },
        );
      }
      const index = headers.indexOf(key.column);
      const value = index >= 0 ? readCount(row[index]) : null;
      return value === null
        ? unavailable(key.key, 'NOT_REPORTED', `The report did not include ${key.column}.`, {
            sourceMetricName: key.column,
          })
        : countOrNotReported(key.key, value, key.column, { detail: REPORT_DELAY_NOTE });
    });
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw await this.translate(error);
    }
  }

  private async translate(error: unknown): Promise<AnalyticsProviderError> {
    if (!(error instanceof YouTubeApiError)) {
      return new AnalyticsProviderError('PROVIDER_ERROR', 'YouTube analytics could not be read.');
    }
    switch (error.kind) {
      case 'AUTH':
        await this.options.onAuthRejected?.();
        return new AnalyticsProviderError(
          'REAUTH_REQUIRED',
          'Google rejected the YouTube authorization. Reconnect YouTube.',
        );
      case 'PERMISSION':
        return new AnalyticsProviderError(
          'MISSING_SCOPE',
          `${error.message}. Reconnect YouTube and allow read access.`,
        );
      case 'QUOTA':
        return new AnalyticsProviderError(
          'QUOTA_EXCEEDED',
          `${error.message}. The project's daily YouTube quota is used up; it resets at midnight Pacific time.`,
        );
      case 'RATE_LIMIT':
        return new AnalyticsProviderError('RATE_LIMITED', error.message);
      case 'NOT_FOUND':
        return new AnalyticsProviderError('NOT_FOUND', error.message);
      case 'TRANSIENT':
        return new AnalyticsProviderError('TRANSIENT', error.message);
      default:
        return new AnalyticsProviderError('PROVIDER_ERROR', error.message);
    }
  }
}
