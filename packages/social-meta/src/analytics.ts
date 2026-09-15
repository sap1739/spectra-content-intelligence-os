import {
  AnalyticsProviderError,
  countOrNotReported,
  describeCapability,
  fetchableKeys,
  finalizeMetrics,
  measured,
  readCount,
  unavailable,
  unavailableFromSpecs,
  type AnalyticsContentTarget,
  type AnalyticsFetchResult,
  type AnalyticsProvider,
  type MetricSpec,
} from '@spectra/analytics-core';
import type {
  AnalyticsMetric,
  AnalyticsMetricKey,
  AnalyticsProviderCapability,
} from '@spectra/contracts';

import { MetaApiError, MetaGraphClient, type MetaGraphOptions } from './client';
import { GRAPH_ID } from './constants';

/**
 * Meta analytics (ADR-0039), from Meta's own references, checked 2026-09-14.
 *
 * Facebook Pages — `GET /{page-post-id}/insights` needs `read_insights` and
 * `pages_read_engagement`. Metrics read: `post_media_view` ("the number of
 * times your content was played or displayed"), `post_total_media_view_unique`
 * (Meta: metrics with the `_unique` suffix "are approximate"), `post_clicks`
 * and `post_reactions_by_type_total`. `post_impressions` is "Deprecated above
 * Graph API v25" and is reported as DEPRECATED_BY_PLATFORM. "Most metrics will
 * update once every 24 hours", and only "the last two years" are available.
 * Page followers come from the Page node's `followers_count`.
 *
 * Instagram — `GET /{ig-media-id}/insights` needs `instagram_manage_insights`
 * (plus `instagram_basic` and `pages_read_engagement`). FEED metrics read:
 * likes, comments, shares, saved, profile_visits, reach (labelled "Metric is
 * estimated") and views (labelled "Metric in development") — both APPROXIMATE.
 * `impressions` is deprecated for media created after 2 July 2024. Meta: "Data
 * used to calculate metrics can be delayed up to 48 hours" and "is stored for
 * up to 2 years". Account followers come from the IG User `followers_count`.
 */

export const META_ANALYTICS_PROVIDER_ID = 'meta-graph-insights';
export const META_ANALYTICS_SCOPES = {
  pageInsights: 'read_insights',
  pageRead: 'pages_read_engagement',
  instagramInsights: 'instagram_manage_insights',
  instagramBasic: 'instagram_basic',
} as const;

const RETENTION_MS = 2 * 365 * 86_400_000;
const FACEBOOK_DELAY = 'Meta updates most Page post metrics once every 24 hours.';
const INSTAGRAM_DELAY = 'Meta says Instagram insights data can be delayed up to 48 hours.';

type Platform = 'FACEBOOK' | 'INSTAGRAM';

const notRead = (detail: string) => ({ reason: 'NOT_IMPLEMENTED' as const, detail });
const notExposed = (detail: string) => ({ reason: 'NOT_EXPOSED_BY_PLATFORM' as const, detail });
const photoOnly = (platform: string) => ({
  reason: 'CONTENT_TYPE_UNSUPPORTED' as const,
  detail: `Spectra publishes image and text posts to ${platform}, which have no video watch metrics.`,
});

const FACEBOOK_POST_METRICS: ReadonlyArray<{
  key: AnalyticsMetricKey;
  metric: string;
  approximate?: boolean;
}> = [
  { key: 'views', metric: 'post_media_view' },
  { key: 'reach', metric: 'post_total_media_view_unique', approximate: true },
  { key: 'clicks', metric: 'post_clicks' },
];

const INSTAGRAM_MEDIA_METRICS: ReadonlyArray<{
  key: AnalyticsMetricKey;
  metric: string;
  approximate?: string;
}> = [
  { key: 'likes', metric: 'likes' },
  { key: 'comments', metric: 'comments' },
  { key: 'shares', metric: 'shares' },
  { key: 'saves', metric: 'saved' },
  { key: 'profileVisits', metric: 'profile_visits' },
  { key: 'reach', metric: 'reach', approximate: 'Meta labels reach "Metric is estimated".' },
  { key: 'views', metric: 'views', approximate: 'Meta labels views "Metric in development".' },
];

function facebookSpecs(): MetricSpec[] {
  const insights = [META_ANALYTICS_SCOPES.pageInsights, META_ANALYTICS_SCOPES.pageRead];
  return [
    {
      key: 'followers',
      level: 'ACCOUNT',
      sourceMetricName: 'followers_count',
      requiredScopes: [META_ANALYTICS_SCOPES.pageRead],
    },
    ...(
      [
        'impressions',
        'reach',
        'views',
        'videoViews',
        'watchTimeMinutes',
        'averageViewDurationSeconds',
        'likes',
        'reactions',
        'comments',
        'shares',
        'saves',
        'clicks',
        'linkClicks',
        'engagementRate',
        'profileVisits',
      ] as const
    ).map((key): MetricSpec => ({
      key,
      level: 'ACCOUNT',
      sourceMetricName: null,
      unavailable: notRead('Spectra reads Facebook insights per post, and followers per Page.'),
    })),
    ...FACEBOOK_POST_METRICS.map(({ key, metric, approximate }): MetricSpec => ({
      key,
      level: 'CONTENT',
      sourceMetricName: metric,
      requiredScopes: insights,
      reviewRequired: true,
      ...(approximate
        ? {
            expectedCompleteness: 'APPROXIMATE' as const,
            note: 'Meta: metrics with the _unique suffix are approximate.',
          }
        : { note: FACEBOOK_DELAY }),
    })),
    {
      key: 'reactions',
      level: 'CONTENT',
      sourceMetricName: 'post_reactions_by_type_total',
      requiredScopes: insights,
      reviewRequired: true,
      note: 'All reaction types added together.',
    },
    {
      key: 'likes',
      level: 'CONTENT',
      sourceMetricName: 'post_reactions_by_type_total.like',
      requiredScopes: insights,
      reviewRequired: true,
    },
    {
      key: 'impressions',
      level: 'CONTENT',
      sourceMetricName: 'post_impressions',
      unavailable: {
        reason: 'DEPRECATED_BY_PLATFORM',
        detail:
          'Meta marks post_impressions "Deprecated above Graph API v25"; views (post_media_view) is read instead.',
      },
    },
    {
      key: 'comments',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: notRead('Spectra does not read Facebook comment counts yet.'),
    },
    {
      key: 'shares',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: notRead('Spectra does not read Facebook share counts yet.'),
    },
    {
      key: 'saves',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: notRead('Spectra reads no Facebook saves metric.'),
    },
    {
      key: 'linkClicks',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: notRead('Spectra reads all clicks (post_clicks), not clicks by type.'),
    },
    {
      key: 'profileVisits',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: notRead('Spectra reads no Facebook Page-visit metric.'),
    },
    {
      key: 'videoViews',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: photoOnly('Facebook'),
    },
    {
      key: 'watchTimeMinutes',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: photoOnly('Facebook'),
    },
    {
      key: 'averageViewDurationSeconds',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: photoOnly('Facebook'),
    },
    {
      key: 'engagementRate',
      level: 'CONTENT',
      sourceMetricName: null,
      expectedCompleteness: 'DERIVED',
    },
  ];
}

function instagramSpecs(): MetricSpec[] {
  const insights = [
    META_ANALYTICS_SCOPES.instagramInsights,
    META_ANALYTICS_SCOPES.instagramBasic,
    META_ANALYTICS_SCOPES.pageRead,
  ];
  return [
    {
      key: 'followers',
      level: 'ACCOUNT',
      sourceMetricName: 'followers_count',
      requiredScopes: [META_ANALYTICS_SCOPES.instagramBasic],
    },
    ...(
      [
        'impressions',
        'reach',
        'views',
        'videoViews',
        'watchTimeMinutes',
        'averageViewDurationSeconds',
        'likes',
        'reactions',
        'comments',
        'shares',
        'saves',
        'clicks',
        'linkClicks',
        'engagementRate',
        'profileVisits',
      ] as const
    ).map((key): MetricSpec => ({
      key,
      level: 'ACCOUNT',
      sourceMetricName: null,
      unavailable: notRead('Spectra reads Instagram insights per post, and followers per account.'),
    })),
    ...INSTAGRAM_MEDIA_METRICS.map(({ key, metric, approximate }): MetricSpec => ({
      key,
      level: 'CONTENT',
      sourceMetricName: metric,
      requiredScopes: insights,
      reviewRequired: true,
      ...(approximate
        ? { expectedCompleteness: 'APPROXIMATE' as const, note: approximate }
        : { note: INSTAGRAM_DELAY }),
    })),
    {
      key: 'impressions',
      level: 'CONTENT',
      sourceMetricName: 'impressions',
      unavailable: {
        reason: 'DEPRECATED_BY_PLATFORM',
        detail:
          'Meta deprecated impressions for media created after 2 July 2024; views is read instead.',
      },
    },
    {
      key: 'reactions',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: notExposed('Instagram media insights report likes, not reaction types.'),
    },
    {
      key: 'clicks',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: notExposed('Instagram media insights report no click metrics for feed posts.'),
    },
    {
      key: 'linkClicks',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: notExposed('Instagram media insights report no link clicks for feed posts.'),
    },
    {
      key: 'videoViews',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: photoOnly('Instagram'),
    },
    {
      key: 'watchTimeMinutes',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: photoOnly('Instagram'),
    },
    {
      key: 'averageViewDurationSeconds',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: photoOnly('Instagram'),
    },
    {
      key: 'engagementRate',
      level: 'CONTENT',
      sourceMetricName: null,
      expectedCompleteness: 'DERIVED',
    },
  ];
}

export function metaAnalyticsSpecs(platform: Platform): MetricSpec[] {
  return platform === 'FACEBOOK' ? facebookSpecs() : instagramSpecs();
}

export function describeMetaAnalytics(input: {
  platform: Platform;
  grantedScopes: readonly string[] | null;
  configured: boolean;
}): AnalyticsProviderCapability {
  const facebook = input.platform === 'FACEBOOK';
  return describeCapability({
    platform: input.platform,
    providerId: META_ANALYTICS_PROVIDER_ID,
    providerName: facebook
      ? 'Facebook Page insights (Graph API)'
      : 'Instagram media insights (Graph API)',
    summary: facebook
      ? 'Per-post views, unique viewers (approximate), clicks and reactions from Page post insights (needs read_insights), and Page followers. Post impressions are deprecated by Meta.'
      : 'Per-post likes, comments, shares, saves, profile visits, reach (estimated) and views (in development) from media insights (needs instagram_manage_insights), and account followers.',
    implemented: true,
    configured: input.configured,
    specs: metaAnalyticsSpecs(input.platform),
    grantedScopes: input.grantedScopes,
    levels: {
      account: { supported: true, reason: 'Followers only.' },
      content: { supported: true, reason: facebook ? FACEBOOK_DELAY : INSTAGRAM_DELAY },
      campaign: {
        supported: false,
        reason:
          "Meta's organic insights have no campaign object (campaigns are ads, which Spectra does not run); Spectra sums the campaign's post snapshots itself.",
      },
      comments: {
        supported: !facebook,
        reason: facebook
          ? 'Facebook comment counts are not read yet.'
          : 'Comment counts only. Comment text is not ingested.',
      },
    },
    approval: {
      required: true,
      notes: [
        facebook
          ? 'read_insights needs Meta App Review (Advanced Access) and is not in Spectra’s default scopes. Add it with SOCIAL_OAUTH_FACEBOOK_SCOPES and reconnect Meta.'
          : 'instagram_manage_insights needs Meta App Review (Advanced Access) and is not in Spectra’s default scopes. Add it with SOCIAL_OAUTH_FACEBOOK_SCOPES and reconnect Meta.',
      ],
    },
    freshnessNote: `${facebook ? FACEBOOK_DELAY : INSTAGRAM_DELAY} Only the last two years are available.`,
    rateLimitNote:
      'Meta applies app- and account-level rate limits (error codes 4, 17, 32, 613); a rate-limited sync is retried with backoff.',
    paidApi: false,
    docsUrls: facebook
      ? [
          'https://developers.facebook.com/docs/graph-api/reference/insights',
          'https://developers.facebook.com/docs/graph-api/reference/page/',
        ]
      : [
          'https://developers.facebook.com/docs/instagram-platform/reference/instagram-media/insights',
          'https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user',
        ],
  });
}

export interface MetaAnalyticsProviderOptions extends MetaGraphOptions {
  platform: Platform;
  /** The Page access token sealed on the account at discovery. */
  accessToken: string;
  /** Page id (Facebook) or IG user id (Instagram). */
  accountId: string;
  grantedScopes: readonly string[] | null;
  now?: () => Date;
  onAuthRejected?: () => Promise<void>;
}

interface InsightsBody {
  data?: Array<{ name?: unknown; values?: Array<{ value?: unknown }> }>;
}

export class MetaAnalyticsProvider implements AnalyticsProvider {
  readonly providerId = META_ANALYTICS_PROVIDER_ID;
  readonly platform: Platform;
  private readonly client: MetaGraphClient;
  private readonly specs: MetricSpec[];

  constructor(private readonly options: MetaAnalyticsProviderOptions) {
    this.platform = options.platform;
    this.client = new MetaGraphClient(options.accessToken, options);
    this.specs = metaAnalyticsSpecs(options.platform);
  }

  capability(): AnalyticsProviderCapability {
    return describeMetaAnalytics({
      platform: this.platform,
      grantedScopes: this.options.grantedScopes,
      configured: true,
    });
  }

  async fetchAccountAnalytics(): Promise<AnalyticsFetchResult> {
    const grant = this.options.grantedScopes;
    const metrics = unavailableFromSpecs(this.specs, 'ACCOUNT', grant);
    const providerMetadata: Record<string, number> = {};
    if (fetchableKeys(this.specs, 'ACCOUNT', grant).has('followers')) {
      const fields =
        this.platform === 'FACEBOOK' ? 'followers_count' : 'followers_count,media_count';
      const body = await this.call(() =>
        this.client.get<Record<string, unknown>>(this.options.accountId, { fields }),
      );
      metrics.push(countOrNotReported('followers', body['followers_count'], 'followers_count'));
      const mediaCount = readCount(body['media_count']);
      if (mediaCount !== null) providerMetadata['mediaCount'] = mediaCount;
    }
    return {
      metrics: finalizeMetrics(this.specs, 'ACCOUNT', metrics),
      notes: [],
      dataAsOf: null,
      providerMetadata,
    };
  }

  async fetchContentAnalytics(target: AnalyticsContentTarget): Promise<AnalyticsFetchResult> {
    const id = target.externalContentId;
    const valid =
      this.platform === 'FACEBOOK' ? /^\d{1,30}(_\d{1,30})?$/.test(id) : GRAPH_ID.test(id);
    if (!valid) {
      throw new AnalyticsProviderError(
        'VALIDATION',
        `The recorded ${this.platform === 'FACEBOOK' ? 'Facebook post' : 'Instagram media'} id is not a Graph id, so no analytics were requested.`,
      );
    }
    const grant = this.options.grantedScopes;
    const fetchable = fetchableKeys(this.specs, 'CONTENT', grant);
    const metrics = unavailableFromSpecs(this.specs, 'CONTENT', grant);
    const now = (this.options.now ?? (() => new Date()))();
    const delay = this.platform === 'FACEBOOK' ? FACEBOOK_DELAY : INSTAGRAM_DELAY;

    if (target.publishedAt && now.getTime() - target.publishedAt.getTime() > RETENTION_MS) {
      for (const key of fetchable) {
        if (key === 'engagementRate') continue;
        metrics.push(
          unavailable(
            key,
            'OUTSIDE_RETENTION_WINDOW',
            'Meta keeps insights for two years, and this post is older.',
          ),
        );
      }
      return {
        metrics: finalizeMetrics(this.specs, 'CONTENT', metrics),
        notes: [],
        dataAsOf: null,
        providerMetadata: {},
      };
    }

    const requested =
      this.platform === 'FACEBOOK'
        ? [
            ...FACEBOOK_POST_METRICS.filter((entry) => fetchable.has(entry.key)).map(
              (entry) => entry.metric,
            ),
            ...(fetchable.has('reactions') || fetchable.has('likes')
              ? ['post_reactions_by_type_total']
              : []),
          ]
        : INSTAGRAM_MEDIA_METRICS.filter((entry) => fetchable.has(entry.key)).map(
            (entry) => entry.metric,
          );

    if (requested.length > 0) {
      let body: InsightsBody;
      try {
        body = await this.client.get<InsightsBody>(`${id}/insights`, {
          metric: requested.join(','),
        });
      } catch (error) {
        if (error instanceof MetaApiError && error.kind === 'PERMISSION') {
          // Meta refused the insights edge itself (App Review, a role): the
          // metrics are unavailable with Meta's words, the sync carries on.
          const needed =
            this.platform === 'FACEBOOK' ? 'read_insights' : 'instagram_manage_insights';
          for (const key of fetchable) {
            if (key === 'engagementRate') continue;
            metrics.push(
              unavailable(
                key,
                'APPROVAL_REQUIRED',
                `${error.message}. Reading insights needs ${needed} (Meta App Review).`,
              ),
            );
          }
          return {
            metrics: finalizeMetrics(this.specs, 'CONTENT', metrics),
            notes: [],
            dataAsOf: null,
            providerMetadata: {},
          };
        }
        throw await this.translate(error);
      }
      const values = new Map<string, unknown>();
      for (const row of body.data ?? []) {
        if (typeof row.name === 'string') values.set(row.name, row.values?.[0]?.value);
      }
      if (this.platform === 'FACEBOOK') {
        for (const entry of FACEBOOK_POST_METRICS) {
          if (!fetchable.has(entry.key)) continue;
          metrics.push(
            countOrNotReported(entry.key, values.get(entry.metric), entry.metric, {
              ...(entry.approximate
                ? {
                    completeness: 'APPROXIMATE' as const,
                    detail: 'Meta: _unique metrics are approximate.',
                  }
                : { detail: delay }),
            }),
          );
        }
        metrics.push(
          ...this.facebookReactions(fetchable, values.get('post_reactions_by_type_total')),
        );
      } else {
        for (const entry of INSTAGRAM_MEDIA_METRICS) {
          if (!fetchable.has(entry.key)) continue;
          metrics.push(
            countOrNotReported(entry.key, values.get(entry.metric), entry.metric, {
              ...(entry.approximate
                ? { completeness: 'APPROXIMATE' as const, detail: entry.approximate }
                : { detail: delay }),
            }),
          );
        }
      }
    }
    return {
      metrics: finalizeMetrics(this.specs, 'CONTENT', metrics),
      notes: [delay],
      dataAsOf: null,
      providerMetadata: {},
    };
  }

  /** post_reactions_by_type_total is an object of counts per reaction type. */
  private facebookReactions(fetchable: Set<AnalyticsMetricKey>, raw: unknown): AnalyticsMetric[] {
    const out: AnalyticsMetric[] = [];
    const source = 'post_reactions_by_type_total';
    const byType =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    if (fetchable.has('reactions')) {
      if (!byType) {
        out.push(
          unavailable('reactions', 'NOT_REPORTED', `Meta did not report ${source}.`, {
            sourceMetricName: source,
          }),
        );
      } else {
        const counts = Object.values(byType).map((value) => readCount(value));
        out.push(
          counts.some((count) => count === null)
            ? unavailable(
                'reactions',
                'NOT_REPORTED',
                `${source} contained a value that is not a count.`,
                { sourceMetricName: source },
              )
            : measured(
                'reactions',
                counts.reduce<number>((sum, count) => sum + (count ?? 0), 0),
                { sourceMetricName: source, detail: 'All reaction types added together.' },
              ),
        );
      }
    }
    if (fetchable.has('likes')) {
      // An object with no `like` key means no likes were counted by type —
      // but that is Meta's omission to explain, not Spectra's zero to invent.
      out.push(
        byType
          ? countOrNotReported('likes', byType['like'], `${source}.like`)
          : unavailable('likes', 'NOT_REPORTED', `Meta did not report ${source}.`, {
              sourceMetricName: `${source}.like`,
            }),
      );
    }
    return out;
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      throw await this.translate(error);
    }
  }

  private async translate(error: unknown): Promise<AnalyticsProviderError> {
    if (!(error instanceof MetaApiError)) {
      return new AnalyticsProviderError('PROVIDER_ERROR', 'Meta analytics could not be read.');
    }
    switch (error.kind) {
      case 'AUTH':
        await this.options.onAuthRejected?.();
        return new AnalyticsProviderError(
          'REAUTH_REQUIRED',
          'Meta rejected the Page token. Reconnect Meta (Facebook).',
        );
      case 'PERMISSION':
        return new AnalyticsProviderError('APPROVAL_REQUIRED', error.message);
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
