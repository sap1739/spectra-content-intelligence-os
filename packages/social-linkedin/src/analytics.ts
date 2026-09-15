import {
  AnalyticsProviderError,
  countOrNotReported,
  describeCapability,
  fetchableKeys,
  finalizeMetrics,
  measured,
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

import { LinkedInApiError, LinkedInClient, type LinkedInApiOptions } from './client';
import { LINKEDIN_PLATFORM } from './constants';

/**
 * LinkedIn analytics (ADR-0039), from LinkedIn's Community Management API docs
 * (versions through 202608), checked 2026-09-14.
 *
 * Pages — `GET /rest/organizationalEntityShareStatistics?q=organizationalEntity`
 * with `shares=List(...)` or `ugcPosts=List(...)`. Needs `rw_organization_admin`
 * (the member must be an ADMINISTRATOR of the page). Organic activity only,
 * within "a rolling 12-month window". LinkedIn documents that "shares with no
 * actions or impressions are not included in the list of elements" and "can be
 * assumed to have counts of 0" — so an omitted post IS a documented zero, and
 * is stored as one with that quote, while a field missing from a returned
 * element stays NOT_REPORTED. `engagement` is LinkedIn's own ratio ("organic
 * clicks, likes, comments, and shares over impressions"). `likeCount` "can
 * become negative" and is kept as reported.
 *
 * Members — `GET /rest/memberCreatorPostAnalytics?q=entity`, one `queryType` per
 * call, `aggregation=TOTAL`. Needs `r_member_postAnalytics`. LinkedIn says the
 * data "is best-effort accurate and shouldn't be used for billing purposes", so
 * every value is APPROXIMATE.
 */

export const LINKEDIN_ANALYTICS_PROVIDER_ID = 'linkedin-community-management';
export const LINKEDIN_ANALYTICS_SCOPES = {
  page: 'rw_organization_admin',
  member: 'r_member_postAnalytics',
} as const;

const ORGANIC_NOTE =
  'Organic activity only (sponsored activity is excluded), within LinkedIn’s rolling 12-month window.';
const BEST_EFFORT_NOTE =
  'LinkedIn describes member post analytics as best-effort accurate, not for billing.';
const OMITTED_IS_ZERO_NOTE =
  'LinkedIn documents that posts with no actions or impressions are left out of the response and "can be assumed to have counts of 0".';
const RETENTION_MS = 365 * 86_400_000;

const notExposed = (detail: string) => ({ reason: 'NOT_EXPOSED_BY_PLATFORM' as const, detail });
const textAndImage = {
  reason: 'CONTENT_TYPE_UNSUPPORTED' as const,
  detail: 'Spectra publishes text and image posts to LinkedIn, which have no video metrics.',
};

type Level = 'ACCOUNT' | 'CONTENT';

function pageSpecs(level: Level): MetricSpec[] {
  const scope = [LINKEDIN_ANALYTICS_SCOPES.page];
  const stat = (key: AnalyticsMetricKey, field: string, note = ORGANIC_NOTE): MetricSpec => ({
    key,
    level,
    sourceMetricName: `totalShareStatistics.${field}`,
    requiredScopes: scope,
    reviewRequired: true,
    note,
  });
  return [
    stat('impressions', 'impressionCount'),
    stat('reach', 'uniqueImpressionsCount'),
    stat('clicks', 'clickCount'),
    stat(
      'likes',
      'likeCount',
      `${ORGANIC_NOTE} LinkedIn notes likeCount can become negative when a sponsored like is removed.`,
    ),
    stat('comments', 'commentCount'),
    stat('shares', 'shareCount'),
    {
      ...stat(
        'engagementRate',
        'engagement',
        'LinkedIn’s own ratio: organic clicks, likes, comments and shares over impressions.',
      ),
    },
    { key: 'views', level, sourceMetricName: null, unavailable: textAndImage },
    { key: 'videoViews', level, sourceMetricName: null, unavailable: textAndImage },
    { key: 'watchTimeMinutes', level, sourceMetricName: null, unavailable: textAndImage },
    { key: 'averageViewDurationSeconds', level, sourceMetricName: null, unavailable: textAndImage },
    {
      key: 'reactions',
      level,
      sourceMetricName: null,
      unavailable: notExposed(
        'Organization share statistics report likes, not every reaction type.',
      ),
    },
    {
      key: 'saves',
      level,
      sourceMetricName: null,
      unavailable: notExposed('Organization share statistics report no saves.'),
    },
    {
      key: 'linkClicks',
      level,
      sourceMetricName: null,
      unavailable: notExposed(
        'Organization share statistics report all clicks together (clickCount), not link clicks.',
      ),
    },
    {
      key: 'profileVisits',
      level,
      sourceMetricName: null,
      unavailable: notExposed('Organization share statistics report no page visits.'),
    },
    ...(level === 'ACCOUNT'
      ? [
          {
            key: 'followers' as const,
            level,
            sourceMetricName: null,
            unavailable: {
              reason: 'NOT_IMPLEMENTED' as const,
              detail: 'Spectra does not read LinkedIn page follower statistics yet.',
            },
          },
        ]
      : []),
  ];
}

const MEMBER_QUERY: ReadonlyArray<{ key: AnalyticsMetricKey; queryType: string }> = [
  { key: 'impressions', queryType: 'IMPRESSION' },
  { key: 'reach', queryType: 'MEMBERS_REACHED' },
  { key: 'reactions', queryType: 'REACTION' },
  { key: 'comments', queryType: 'COMMENT' },
  { key: 'shares', queryType: 'RESHARE' },
  { key: 'saves', queryType: 'POST_SAVE' },
  { key: 'linkClicks', queryType: 'LINK_CLICKS' },
  { key: 'profileVisits', queryType: 'PROFILE_VIEW_FROM_CONTENT' },
];

function memberSpecs(): MetricSpec[] {
  const scope = [LINKEDIN_ANALYTICS_SCOPES.member];
  const specs: MetricSpec[] = MEMBER_QUERY.map(({ key, queryType }) => ({
    key,
    level: 'CONTENT',
    sourceMetricName: `memberCreatorPostAnalytics:${queryType}`,
    requiredScopes: scope,
    reviewRequired: true,
    expectedCompleteness: 'APPROXIMATE',
    note: BEST_EFFORT_NOTE,
  }));
  specs.push(
    {
      key: 'likes',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: notExposed(
        'Member post analytics report all reactions together (REACTION), not likes separately.',
      ),
    },
    {
      key: 'clicks',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: notExposed('Member post analytics report link clicks, not all clicks.'),
    },
    { key: 'views', level: 'CONTENT', sourceMetricName: null, unavailable: textAndImage },
    { key: 'videoViews', level: 'CONTENT', sourceMetricName: null, unavailable: textAndImage },
    {
      key: 'watchTimeMinutes',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: textAndImage,
    },
    {
      key: 'averageViewDurationSeconds',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: textAndImage,
    },
    {
      key: 'engagementRate',
      level: 'CONTENT',
      sourceMetricName: null,
      expectedCompleteness: 'DERIVED',
    },
  );
  return specs;
}

const MEMBER_ACCOUNT_REASON =
  'Spectra reads LinkedIn member analytics per post; member-wide totals are not read.';

/** Specs for one account kind. PAGE = an organization; PROFILE = a member. */
export function linkedInAnalyticsSpecs(kind: string): MetricSpec[] {
  if (kind === 'PAGE') return [...pageSpecs('ACCOUNT'), ...pageSpecs('CONTENT')];
  return [...memberSpecs()];
}

export function describeLinkedInAnalytics(input: {
  kind: string;
  grantedScopes: readonly string[] | null;
  configured: boolean;
}): AnalyticsProviderCapability {
  const page = input.kind === 'PAGE';
  const scope = page ? LINKEDIN_ANALYTICS_SCOPES.page : LINKEDIN_ANALYTICS_SCOPES.member;
  return describeCapability({
    platform: LINKEDIN_PLATFORM,
    providerId: LINKEDIN_ANALYTICS_PROVIDER_ID,
    providerName: page
      ? 'LinkedIn organization share statistics'
      : 'LinkedIn member post analytics',
    summary: page
      ? 'Organic impressions, unique impressions, clicks, likes, comments, shares and LinkedIn’s engagement ratio for page posts and the page overall. Needs rw_organization_admin (Community Management API) and the ADMINISTRATOR role.'
      : 'Impressions, members reached, reactions, comments, reshares, saves, link clicks and profile views per post, best-effort accurate. Needs r_member_postAnalytics (Community Management API).',
    implemented: true,
    configured: input.configured,
    specs: page ? linkedInAnalyticsSpecs('PAGE') : memberSpecs(),
    grantedScopes: input.grantedScopes,
    levels: {
      account: page
        ? { supported: true, reason: `Page-wide organic share statistics. ${ORGANIC_NOTE}` }
        : { supported: false, reason: MEMBER_ACCOUNT_REASON },
      content: { supported: true, reason: page ? ORGANIC_NOTE : BEST_EFFORT_NOTE },
      campaign: {
        supported: false,
        reason:
          "LinkedIn's organic APIs have no campaign object (campaigns are ads, which Spectra does not run); Spectra sums the campaign's post snapshots itself.",
      },
      comments: { supported: true, reason: 'Comment counts only. Comment text is not ingested.' },
    },
    approval: {
      required: true,
      notes: [
        `${scope} is part of LinkedIn's Community Management API, which LinkedIn grants by application. It is not in Spectra's default scopes; add it with SOCIAL_OAUTH_LINKEDIN_SCOPES once approved and reconnect.`,
      ],
    },
    freshnessNote: page
      ? 'Lifetime statistics as LinkedIn reports them when fetched, limited to the last 12 months.'
      : 'Lifetime totals as LinkedIn reports them when fetched.',
    rateLimitNote:
      'LinkedIn applies per-application and per-member daily limits; a 429 is retried with backoff. Member post analytics cost one call per metric.',
    paidApi: false,
    docsUrls: [
      page
        ? 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/organizations/share-statistics'
        : 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/members/post-statistics',
    ],
  });
}

export interface LinkedInAnalyticsProviderOptions extends LinkedInApiOptions {
  accessToken: string;
  /** urn:li:organization:… for a page, urn:li:person:… for a member. */
  authorUrn: string;
  kind: string;
  grantedScopes: readonly string[] | null;
  now?: () => Date;
  onAuthRejected?: () => Promise<void>;
}

interface ShareStatisticsElement {
  share?: unknown;
  ugcPost?: unknown;
  totalShareStatistics?: Record<string, unknown>;
}

const POST_URN = /^urn:li:(share|ugcPost):\d{1,30}$/;

export class LinkedInAnalyticsProvider implements AnalyticsProvider {
  readonly platform = LINKEDIN_PLATFORM;
  readonly providerId = LINKEDIN_ANALYTICS_PROVIDER_ID;
  private readonly client: LinkedInClient;
  private readonly specs: MetricSpec[];

  constructor(private readonly options: LinkedInAnalyticsProviderOptions) {
    this.client = new LinkedInClient(options.accessToken, options);
    this.specs = linkedInAnalyticsSpecs(options.kind);
  }

  private get isPage(): boolean {
    return this.options.kind === 'PAGE';
  }

  capability(): AnalyticsProviderCapability {
    return describeLinkedInAnalytics({
      kind: this.options.kind,
      grantedScopes: this.options.grantedScopes,
      configured: true,
    });
  }

  async fetchAccountAnalytics(): Promise<AnalyticsFetchResult> {
    if (!this.isPage) {
      throw new AnalyticsProviderError('UNSUPPORTED', MEMBER_ACCOUNT_REASON);
    }
    const grant = this.options.grantedScopes;
    const metrics = unavailableFromSpecs(this.specs, 'ACCOUNT', grant);
    const fetchable = fetchableKeys(this.specs, 'ACCOUNT', grant);
    if (fetchable.size > 0) {
      const body = await this.call(() =>
        this.client.rest<{ elements?: ShareStatisticsElement[] }>(
          'GET',
          '/rest/organizationalEntityShareStatistics',
          {
            query: `q=organizationalEntity&organizationalEntity=${encodeURIComponent(this.options.authorUrn)}`,
          },
        ),
      );
      const element = (body.body?.elements ?? []).find((item) => !item.share && !item.ugcPost);
      metrics.push(
        ...this.pageMetrics('ACCOUNT', fetchable, element?.totalShareStatistics ?? null, false),
      );
    }
    return {
      metrics: finalizeMetrics(this.specs, 'ACCOUNT', metrics),
      notes: [ORGANIC_NOTE],
      dataAsOf: null,
      providerMetadata: {},
    };
  }

  async fetchContentAnalytics(target: AnalyticsContentTarget): Promise<AnalyticsFetchResult> {
    const urn = target.externalContentId;
    const match = POST_URN.exec(urn);
    if (!match) {
      throw new AnalyticsProviderError(
        'VALIDATION',
        'The recorded LinkedIn post id is not a share or ugcPost URN, so no analytics were requested.',
      );
    }
    const now = (this.options.now ?? (() => new Date()))();
    const grant = this.options.grantedScopes;
    const fetchable = fetchableKeys(this.specs, 'CONTENT', grant);

    if (
      this.isPage &&
      target.publishedAt &&
      now.getTime() - target.publishedAt.getTime() > RETENTION_MS
    ) {
      const metrics = unavailableFromSpecs(this.specs, 'CONTENT', grant);
      for (const key of fetchable) {
        metrics.push(
          unavailable(
            key,
            'OUTSIDE_RETENTION_WINDOW',
            'LinkedIn returns share statistics only within a rolling 12-month window, and this post is older.',
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

    const metrics = unavailableFromSpecs(this.specs, 'CONTENT', grant);
    const notes: string[] = [];
    if (this.isPage && fetchable.size > 0) {
      const list = match[1] === 'share' ? 'shares' : 'ugcPosts';
      const body = await this.call(() =>
        this.client.rest<{ elements?: ShareStatisticsElement[] }>(
          'GET',
          '/rest/organizationalEntityShareStatistics',
          {
            query: `q=organizationalEntity&organizationalEntity=${encodeURIComponent(
              this.options.authorUrn,
            )}&${list}=List(${encodeURIComponent(urn)})`,
          },
        ),
      );
      const element = (body.body?.elements ?? []).find(
        (item) => item.share === urn || item.ugcPost === urn,
      );
      if (!element) notes.push(OMITTED_IS_ZERO_NOTE);
      metrics.push(
        ...this.pageMetrics('CONTENT', fetchable, element?.totalShareStatistics ?? null, !element),
      );
      notes.push(ORGANIC_NOTE);
    } else if (!this.isPage) {
      const entity = `(${match[1] === 'share' ? 'share' : 'ugc'}:${encodeURIComponent(urn)})`;
      for (const { key, queryType } of MEMBER_QUERY) {
        if (!fetchable.has(key)) continue;
        const body = await this.call(() =>
          this.client.rest<{ elements?: Array<{ count?: unknown }> }>(
            'GET',
            '/rest/memberCreatorPostAnalytics',
            { query: `q=entity&entity=${entity}&queryType=${queryType}&aggregation=TOTAL` },
          ),
        );
        const first = body.body?.elements?.[0];
        metrics.push(
          countOrNotReported(key, first?.count, `memberCreatorPostAnalytics:${queryType}`, {
            completeness: 'APPROXIMATE',
            detail: BEST_EFFORT_NOTE,
          }),
        );
      }
      notes.push(BEST_EFFORT_NOTE);
    }
    return {
      metrics: finalizeMetrics(this.specs, 'CONTENT', metrics),
      notes,
      dataAsOf: null,
      providerMetadata: {},
    };
  }

  /**
   * Maps one totalShareStatistics object. `omitted` means LinkedIn left the
   * post out, which it documents as all-zero counts; the ratio is then
   * undefined rather than zero.
   */
  private pageMetrics(
    level: Level,
    fetchable: Set<AnalyticsMetricKey>,
    stats: Record<string, unknown> | null,
    omitted: boolean,
  ): AnalyticsMetric[] {
    const out: AnalyticsMetric[] = [];
    const fields: Array<[AnalyticsMetricKey, string]> = [
      ['impressions', 'impressionCount'],
      ['reach', 'uniqueImpressionsCount'],
      ['clicks', 'clickCount'],
      ['likes', 'likeCount'],
      ['comments', 'commentCount'],
      ['shares', 'shareCount'],
    ];
    for (const [key, field] of fields) {
      if (!fetchable.has(key)) continue;
      const source = `totalShareStatistics.${field}`;
      if (omitted) {
        out.push(measured(key, 0, { sourceMetricName: source, detail: OMITTED_IS_ZERO_NOTE }));
      } else if (!stats) {
        out.push(
          unavailable(key, 'NOT_REPORTED', 'LinkedIn returned no statistics element.', {
            sourceMetricName: source,
          }),
        );
      } else {
        out.push(
          countOrNotReported(key, stats[field], source, {
            allowNegative: key === 'likes',
            detail: level === 'ACCOUNT' ? ORGANIC_NOTE : null,
          }),
        );
      }
    }
    if (fetchable.has('engagementRate')) {
      const source = 'totalShareStatistics.engagement';
      if (omitted) {
        out.push(
          unavailable(
            'engagementRate',
            'DENOMINATOR_UNKNOWN',
            'LinkedIn reports no impressions for this post, so a rate is undefined.',
            {
              sourceMetricName: source,
            },
          ),
        );
      } else {
        const value = stats?.['engagement'];
        out.push(
          typeof value === 'number' && Number.isFinite(value)
            ? measured('engagementRate', value, {
                sourceMetricName: source,
                detail:
                  'LinkedIn’s own ratio: organic clicks, likes, comments and shares over impressions.',
              })
            : unavailable(
                'engagementRate',
                'NOT_REPORTED',
                'LinkedIn did not report an engagement ratio.',
                {
                  sourceMetricName: source,
                },
              ),
        );
      }
    }
    return out;
  }

  private async call<T>(request: () => Promise<T>): Promise<T> {
    try {
      return await request();
    } catch (error) {
      if (!(error instanceof LinkedInApiError)) {
        throw new AnalyticsProviderError('PROVIDER_ERROR', 'LinkedIn analytics could not be read.');
      }
      switch (error.kind) {
        case 'AUTH':
          await this.options.onAuthRejected?.();
          throw new AnalyticsProviderError(
            'REAUTH_REQUIRED',
            'LinkedIn rejected the authorization. Reconnect LinkedIn.',
          );
        case 'PERMISSION':
          throw new AnalyticsProviderError(
            'APPROVAL_REQUIRED',
            `${error.message}. Reading analytics needs ${
              this.isPage
                ? `${LINKEDIN_ANALYTICS_SCOPES.page} and the ADMINISTRATOR role on the page`
                : LINKEDIN_ANALYTICS_SCOPES.member
            } (Community Management API).`,
          );
        case 'RATE_LIMIT':
          throw new AnalyticsProviderError('RATE_LIMITED', error.message);
        case 'NOT_FOUND':
          throw new AnalyticsProviderError('NOT_FOUND', error.message);
        case 'TRANSIENT':
          throw new AnalyticsProviderError('TRANSIENT', error.message);
        default:
          throw new AnalyticsProviderError('PROVIDER_ERROR', error.message);
      }
    }
  }
}
