import {
  AnalyticsProviderError,
  describeCapability,
  finalizeMetrics,
  measured,
  readCount,
  unavailable,
  type AnalyticsContentTarget,
  type AnalyticsFetchResult,
  type AnalyticsProvider,
  type MetricSpec,
} from '@spectra/analytics-core';
import {
  ANALYTICS_METRIC_DEFINITIONS,
  ANALYTICS_METRIC_KEYS,
  type AnalyticsMetric,
  type AnalyticsProviderCapability,
} from '@spectra/contracts';

/**
 * WordPress analytics (ADR-0039) — deliberately small, because WordPress core
 * records very little.
 *
 * What core's REST API really exposes: comments. `GET /wp/v2/comments?post=ID`
 * returns the post's comments and, like every collection, an `X-WP-Total`
 * header — "the total number of records in the collection". Its `status`
 * argument defaults to `approve`, so the count is APPROVED comments. The post
 * is looked up first, so a deleted post is NOT_FOUND rather than "0 comments".
 *
 * What it does not: views, likes, shares or followers. Those come from plugins
 * (Jetpack Stats through WordPress.com), which Spectra does not integrate — so
 * every one of them is NOT_EXPOSED_BY_PLATFORM, with that explanation.
 */

export const WORDPRESS_ANALYTICS_PROVIDER_ID = 'wordpress-rest-comments';

const CORE_HAS_NO_STATS =
  'WordPress core records no views, impressions, likes, shares or followers. View statistics come from plugins such as Jetpack Stats (through WordPress.com), which Spectra does not integrate.';

function specs(): MetricSpec[] {
  const out: MetricSpec[] = [];
  for (const level of ['ACCOUNT', 'CONTENT'] as const) {
    for (const key of ANALYTICS_METRIC_KEYS) {
      if (!ANALYTICS_METRIC_DEFINITIONS[key].levels.includes(level)) continue;
      if (level === 'CONTENT' && key === 'comments') {
        out.push({
          key,
          level,
          sourceMetricName: 'X-WP-Total (GET /wp/v2/comments?post=ID)',
          note: 'Approved comments only — the REST API lists comments with status "approve" by default.',
        });
        continue;
      }
      out.push({
        key,
        level,
        sourceMetricName: null,
        unavailable: {
          reason: 'NOT_EXPOSED_BY_PLATFORM',
          detail:
            key === 'engagementRate'
              ? `No engagement rate: ${CORE_HAS_NO_STATS}`
              : level === 'ACCOUNT'
                ? `No site-level analytics in core. ${CORE_HAS_NO_STATS}`
                : CORE_HAS_NO_STATS,
        },
      });
    }
  }
  return out;
}

export const WORDPRESS_ANALYTICS_SPECS: readonly MetricSpec[] = specs();

export function describeWordPressAnalytics(): AnalyticsProviderCapability {
  return describeCapability({
    platform: 'WORDPRESS',
    providerId: WORDPRESS_ANALYTICS_PROVIDER_ID,
    providerName: 'WordPress REST API (core)',
    summary:
      'Approved comment counts per published post, from the site’s own REST API with the stored application password. WordPress core records no views, likes or shares, so those are not available.',
    implemented: true,
    configured: true,
    specs: WORDPRESS_ANALYTICS_SPECS,
    grantedScopes: null,
    levels: {
      account: { supported: false, reason: `No site-level analytics. ${CORE_HAS_NO_STATS}` },
      content: { supported: true, reason: 'Approved comment count per post.' },
      campaign: {
        supported: false,
        reason:
          "WordPress has no campaign object; Spectra sums the campaign's post snapshots itself.",
      },
      comments: {
        supported: true,
        reason: 'Approved comment counts only. Comment text is not ingested.',
      },
    },
    approval: { required: false, notes: [] },
    freshnessNote: 'Counts are read live from the site when the sync runs.',
    rateLimitNote:
      'WordPress core has no API rate limit of its own; hosts and security plugins may throttle, and a 429 is retried with backoff.',
    paidApi: false,
    docsUrls: [
      'https://developer.wordpress.org/rest-api/reference/comments/',
      'https://developer.wordpress.org/rest-api/using-the-rest-api/pagination/',
    ],
  });
}

export interface WordPressAnalyticsOptions {
  siteUrl: string;
  username: string;
  applicationPassword: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

function siteBase(siteUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(siteUrl);
  } catch {
    throw new AnalyticsProviderError('VALIDATION', 'The WordPress site URL is not a valid URL.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new AnalyticsProviderError('VALIDATION', 'The WordPress site URL must be http(s).');
  }
  return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
}

export class WordPressAnalyticsProvider implements AnalyticsProvider {
  readonly platform = 'WORDPRESS' as const;
  readonly providerId = WORDPRESS_ANALYTICS_PROVIDER_ID;
  private readonly base: string;
  private readonly auth: string;

  constructor(private readonly options: WordPressAnalyticsOptions) {
    this.base = siteBase(options.siteUrl);
    // Basic auth with the application password. Never logged.
    this.auth = `Basic ${Buffer.from(`${options.username}:${options.applicationPassword}`).toString('base64')}`;
  }

  capability(): AnalyticsProviderCapability {
    return describeWordPressAnalytics();
  }

  /** Core has no site-level analytics; every metric says so. No request is made. */
  async fetchAccountAnalytics(): Promise<AnalyticsFetchResult> {
    return {
      metrics: finalizeMetrics(
        WORDPRESS_ANALYTICS_SPECS,
        'ACCOUNT',
        WORDPRESS_ANALYTICS_SPECS.filter((spec) => spec.level === 'ACCOUNT').map((spec) =>
          unavailable(
            spec.key,
            'NOT_EXPOSED_BY_PLATFORM',
            spec.unavailable?.detail ?? CORE_HAS_NO_STATS,
          ),
        ),
      ),
      notes: [],
      dataAsOf: null,
      providerMetadata: {},
    };
  }

  async fetchContentAnalytics(target: AnalyticsContentTarget): Promise<AnalyticsFetchResult> {
    if (!/^\d{1,20}$/.test(target.externalContentId)) {
      throw new AnalyticsProviderError(
        'VALIDATION',
        'The recorded WordPress post id is not numeric, so no analytics were requested.',
      );
    }
    const id = target.externalContentId;
    // The post first: the comments collection does not check that a post
    // exists, and a deleted post must not read as "0 comments".
    await this.request(`/wp-json/wp/v2/posts/${id}?_fields=id`, 'post');
    const response = await this.request(
      `/wp-json/wp/v2/comments?post=${id}&per_page=1&_fields=id`,
      'comments',
    );
    const total = readCount(response.headers.get('x-wp-total'));
    const metrics: AnalyticsMetric[] = WORDPRESS_ANALYTICS_SPECS.filter(
      (spec) => spec.level === 'CONTENT' && spec.unavailable,
    ).map((spec) =>
      unavailable(
        spec.key,
        spec.unavailable?.reason ?? 'NOT_EXPOSED_BY_PLATFORM',
        spec.unavailable?.detail ?? CORE_HAS_NO_STATS,
      ),
    );
    metrics.push(
      total === null
        ? unavailable(
            'comments',
            'NOT_REPORTED',
            'The site did not send an X-WP-Total header (a proxy or plugin may strip it), so the comment count is unknown.',
            { sourceMetricName: 'X-WP-Total' },
          )
        : measured('comments', total, {
            sourceMetricName: 'X-WP-Total (GET /wp/v2/comments?post=ID)',
            detail: 'Approved comments.',
          }),
    );
    return {
      metrics: finalizeMetrics(WORDPRESS_ANALYTICS_SPECS, 'CONTENT', metrics),
      notes: [
        'WordPress core reports comments only; views and likes need a stats plugin Spectra does not integrate.',
      ],
      dataAsOf: null,
      providerMetadata: {},
    };
  }

  private async request(path: string, what: 'post' | 'comments'): Promise<Response> {
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await fetchImpl(`${this.base}${path}`, {
        method: 'GET',
        headers: { authorization: this.auth, accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
      });
    } catch {
      throw new AnalyticsProviderError('TRANSIENT', 'The WordPress site could not be reached.');
    }
    if (response.ok) return response;
    const retryAfter = readCount(response.headers.get('retry-after'));
    if (response.status === 401 || response.status === 403) {
      throw new AnalyticsProviderError(
        'REAUTH_REQUIRED',
        `WordPress refused the stored application password (${response.status}). Update the credential for this site.`,
      );
    }
    if (response.status === 404) {
      throw new AnalyticsProviderError(
        'NOT_FOUND',
        what === 'post'
          ? 'WordPress has no post with this id any more — it may have been deleted.'
          : 'The WordPress comments endpoint was not found (the REST API may be disabled).',
      );
    }
    if (response.status === 429) {
      throw new AnalyticsProviderError(
        'RATE_LIMITED',
        'The WordPress site is rate limiting requests (429).',
        {
          retryAfterSeconds: retryAfter,
        },
      );
    }
    if (response.status >= 500) {
      throw new AnalyticsProviderError(
        'TRANSIENT',
        `The WordPress site responded ${response.status}.`,
      );
    }
    throw new AnalyticsProviderError(
      'PROVIDER_ERROR',
      `The WordPress site responded ${response.status}.`,
    );
  }
}
