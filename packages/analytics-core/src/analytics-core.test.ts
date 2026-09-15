import { analyticsMetricSchema, analyticsProviderCapabilitySchema } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { unimplementedAnalyticsCapability, unimplementedAnalyticsPlatforms } from './catalog';
import {
  assertCompleteMetricSet,
  countOrNotReported,
  deriveEngagementRate,
  measured,
  metricKeysFor,
  readCount,
  snapshotCompleteness,
  unavailable,
} from './metrics';
import {
  AnalyticsProviderError,
  describeCapability,
  finalizeMetrics,
  resolveSpec,
  unavailableFromSpecs,
  type MetricSpec,
} from './provider';
import {
  aggregateMetrics,
  analyticsRetryDelayMs,
  freshnessOf,
  sanitizeErrorMessage,
  sanitizeProviderMetadata,
  staleAfterFrom,
} from './support';

const views = (value: number) => measured('views', value, { sourceMetricName: 'viewCount' });
const likes = (value: number) => measured('likes', value, { sourceMetricName: 'likeCount' });
const comments = (value: number) =>
  measured('comments', value, { sourceMetricName: 'commentCount' });

/** A complete CONTENT set where everything not given is NOT_EXPOSED_BY_PLATFORM. */
function contentSet(given: ReturnType<typeof measured>[]) {
  const keys = new Set(given.map((metric) => metric.key));
  return [
    ...given,
    ...metricKeysFor('CONTENT')
      .filter((key) => !keys.has(key))
      .map((key) => unavailable(key, 'NOT_EXPOSED_BY_PLATFORM', 'not in this test')),
  ];
}

describe('missing metrics are never zero', () => {
  it('readCount refuses anything that is not a reported number', () => {
    expect(readCount('1234')).toBe(1234);
    expect(readCount(0)).toBe(0);
    expect(readCount(undefined)).toBeNull();
    expect(readCount(null)).toBeNull();
    expect(readCount('')).toBeNull();
    expect(readCount('12abc')).toBeNull();
    expect(readCount(Number.NaN)).toBeNull();
    expect(readCount(-3)).toBeNull();
    expect(readCount(-3, { allowNegative: true })).toBe(-3);
  });

  it('an absent field becomes NOT_REPORTED with a null value, not 0', () => {
    const metric = countOrNotReported('likes', undefined, 'statistics.likeCount');
    expect(metric.value).toBeNull();
    expect(metric.unavailableReason).toBe('NOT_REPORTED');
    expect(metric.completeness).toBe('UNAVAILABLE');
    expect(metric.sourceMetricName).toBe('statistics.likeCount');
  });

  it('a reported zero stays a zero, marked exact', () => {
    const metric = countOrNotReported('likes', '0', 'statistics.likeCount');
    expect(metric.value).toBe(0);
    expect(metric.unavailableReason).toBeNull();
    expect(metric.completeness).toBe('EXACT');
  });

  it('the contract rejects a null without a reason, and a value with one', () => {
    const base = {
      key: 'likes',
      sourceMetricName: null,
      unit: 'COUNT',
      detail: null,
    } as const;
    expect(
      analyticsMetricSchema.safeParse({
        ...base,
        value: null,
        completeness: 'UNAVAILABLE',
        unavailableReason: null,
      }).success,
    ).toBe(false);
    expect(
      analyticsMetricSchema.safeParse({
        ...base,
        value: 0,
        completeness: 'EXACT',
        unavailableReason: 'NOT_REPORTED',
      }).success,
    ).toBe(false);
    expect(
      analyticsMetricSchema.safeParse({
        ...base,
        value: 0,
        completeness: 'UNAVAILABLE',
        unavailableReason: null,
      }).success,
    ).toBe(false);
    expect(
      analyticsMetricSchema.safeParse(unavailable('likes', 'MISSING_SCOPE', 'x')).success,
    ).toBe(true);
    expect(analyticsMetricSchema.safeParse(likes(0)).success).toBe(true);
  });
});

describe('engagement rate', () => {
  it('is only calculated when a denominator was reported', () => {
    const rate = deriveEngagementRate([likes(10), comments(5)]);
    expect(rate.value).toBeNull();
    expect(rate.unavailableReason).toBe('DENOMINATOR_UNKNOWN');
  });

  it('is undefined, not zero, over a reported zero denominator', () => {
    const rate = deriveEngagementRate([views(0), likes(0)]);
    expect(rate.value).toBeNull();
    expect(rate.unavailableReason).toBe('DENOMINATOR_UNKNOWN');
  });

  it('never fills a missing interaction count with zero silently — it names what was left out', () => {
    const rate = deriveEngagementRate([
      views(200),
      likes(10),
      unavailable('comments', 'MISSING_SCOPE', 'x'),
    ]);
    expect(rate.value).toBeCloseTo(0.05);
    expect(rate.completeness).toBe('DERIVED');
    expect(rate.detail).toContain('Not reported, so not included: comments');
  });

  it('prefers impressions and does not add likes on top of reactions', () => {
    const rate = deriveEngagementRate([
      measured('impressions', 1000, { sourceMetricName: 'impressionCount' }),
      views(50),
      likes(40),
      measured('reactions', 50, { sourceMetricName: 'reactionCount' }),
      comments(0),
    ]);
    expect(rate.value).toBeCloseTo(0.05);
    expect(rate.detail).toContain('(reactions + comments) / impressions');
  });

  it('needs at least one interaction count', () => {
    const rate = deriveEngagementRate([views(100)]);
    expect(rate.value).toBeNull();
    expect(rate.unavailableReason).toBe('NOT_REPORTED');
  });
});

describe('metric specs and capability', () => {
  const specs: MetricSpec[] = [
    { key: 'views', level: 'CONTENT', sourceMetricName: 'viewCount', requiredScopes: ['read'] },
    {
      key: 'watchTimeMinutes',
      level: 'CONTENT',
      sourceMetricName: 'estimatedMinutesWatched',
      requiredScopes: ['read', 'analytics'],
      reviewRequired: true,
    },
    {
      key: 'saves',
      level: 'CONTENT',
      sourceMetricName: null,
      unavailable: { reason: 'NOT_EXPOSED_BY_PLATFORM', detail: 'No saves on this platform.' },
    },
  ];

  it('reports a missing scope by name instead of calling the platform', () => {
    const resolution = resolveSpec(specs[1] as MetricSpec, ['read']);
    expect(resolution.fetch).toBe(false);
    if (!resolution.fetch) {
      expect(resolution.reason).toBe('MISSING_SCOPE');
      expect(resolution.detail).toContain('analytics');
      expect(resolution.detail).toContain('reviews this permission');
    }
    // Scopes the platform did not report: try, and let the platform decide.
    expect(resolveSpec(specs[1] as MetricSpec, null).fetch).toBe(true);
  });

  it('turns unfetchable specs into unavailable metrics with the platform statement', () => {
    const metrics = unavailableFromSpecs(specs, 'CONTENT', ['read']);
    expect(metrics.map((metric) => [metric.key, metric.unavailableReason])).toEqual([
      ['watchTimeMinutes', 'MISSING_SCOPE'],
      ['saves', 'NOT_EXPOSED_BY_PLATFORM'],
    ]);
  });

  it('derives overall availability honestly', () => {
    const base = {
      platform: 'YOUTUBE' as const,
      providerId: 'test',
      providerName: 'Test',
      summary: 's',
      implemented: true,
      configured: true,
      specs,
      levels: {
        account: { supported: true, reason: 'r' },
        content: { supported: true, reason: 'r' },
        campaign: { supported: false, reason: 'r' },
        comments: { supported: false, reason: 'r' },
      },
      approval: { required: false, notes: [] },
      freshnessNote: 'f',
      rateLimitNote: 'r',
      paidApi: false,
      docsUrls: [],
    };
    const partial = describeCapability({ ...base, grantedScopes: ['read'] });
    expect(partial.availability).toBe('PARTIAL');
    expect(analyticsProviderCapabilitySchema.parse(partial)).toBeTruthy();
    expect(describeCapability({ ...base, grantedScopes: ['read', 'analytics'] }).availability).toBe(
      'AVAILABLE',
    );
    expect(describeCapability({ ...base, grantedScopes: [] }).availability).toBe('MISSING_SCOPE');
    const unconfigured = describeCapability({
      ...base,
      grantedScopes: ['read'],
      configured: false,
    });
    expect(unconfigured.availability).toBe('UNCONFIGURED');
    expect(unconfigured.metrics.every((metric) => metric.availability === 'UNCONFIGURED')).toBe(
      true,
    );
  });

  it('finalizeMetrics refuses an incomplete set rather than letting a key vanish', () => {
    expect(() => finalizeMetrics([], 'CONTENT', [views(1)])).toThrow(/missing/);
    const complete = finalizeMetrics(
      [
        {
          key: 'engagementRate',
          level: 'CONTENT',
          sourceMetricName: null,
          expectedCompleteness: 'DERIVED',
        },
      ],
      'CONTENT',
      contentSet([views(100), likes(7)]).filter((metric) => metric.key !== 'engagementRate'),
    );
    expect(complete.find((metric) => metric.key === 'engagementRate')?.value).toBeCloseTo(0.07);
    expect(() => assertCompleteMetricSet('CONTENT', complete)).not.toThrow();
  });

  it('classifies snapshot completeness', () => {
    expect(snapshotCompleteness(contentSet([views(1)]))).toBe('COMPLETE');
    expect(snapshotCompleteness([views(1), unavailable('likes', 'RATE_LIMITED', 'later')])).toBe(
      'PARTIAL',
    );
    expect(snapshotCompleteness([unavailable('likes', 'MISSING_SCOPE', 'x')])).toBe('UNAVAILABLE');
  });

  it('provider errors know which failures are worth retrying', () => {
    expect(new AnalyticsProviderError('RATE_LIMITED', 'slow down').retryable).toBe(true);
    expect(new AnalyticsProviderError('REAUTH_REQUIRED', 'reconnect').retryable).toBe(false);
  });
});

describe('aggregation', () => {
  it('sums only what was reported and counts the rest as unavailable, not zero', () => {
    const [likeSum] = aggregateMetrics(
      [
        { metrics: [likes(5)] },
        { metrics: [likes(3)] },
        { metrics: [unavailable('likes', 'MISSING_SCOPE', 'x')] },
      ],
      ['likes'],
    );
    expect(likeSum?.value).toBe(8);
    expect(likeSum?.contributing).toBe(2);
    expect(likeSum?.unavailable).toBe(1);
    expect(likeSum?.detail).toContain('not counted as zero');
  });

  it('a metric nobody reported is null with a reason — never 0', () => {
    const [saves] = aggregateMetrics(
      [
        { metrics: [unavailable('saves', 'NOT_EXPOSED_BY_PLATFORM', 'x')] },
        { metrics: [unavailable('saves', 'NOT_EXPOSED_BY_PLATFORM', 'x')] },
      ],
      ['saves'],
    );
    expect(saves?.value).toBeNull();
    expect(saves?.unavailableReason).toBe('NOT_EXPOSED_BY_PLATFORM');
    const [empty] = aggregateMetrics([], ['likes']);
    expect(empty?.value).toBeNull();
  });

  it('refuses to add up non-additive metrics', () => {
    const [reach] = aggregateMetrics(
      [
        { metrics: [measured('reach', 10, { sourceMetricName: 'reach' })] },
        { metrics: [measured('reach', 20, { sourceMetricName: 'reach' })] },
      ],
      ['reach'],
    );
    expect(reach?.value).toBeNull();
    expect(reach?.unavailableReason).toBe('NOT_ADDITIVE');
  });

  it('recomputes engagement rate from snapshots that reported a denominator only', () => {
    const [rate] = aggregateMetrics(
      [{ metrics: [views(100), likes(10)] }, { metrics: [likes(50)] }],
      ['engagementRate'],
    );
    expect(rate?.value).toBeCloseTo(0.1);
    expect(rate?.contributing).toBe(1);
    expect(rate?.unavailable).toBe(1);
  });

  it('keeps an approximate input approximate in the sum', () => {
    const [followers] = aggregateMetrics(
      [
        {
          metrics: [
            measured('followers', 1230, {
              sourceMetricName: 'subscriberCount',
              completeness: 'APPROXIMATE',
            }),
          ],
        },
      ],
      ['followers'],
    );
    expect(followers?.completeness).toBe('APPROXIMATE');
  });
});

describe('freshness, redaction and backoff', () => {
  it('labels fresh, stale and never-synced', () => {
    const retrievedAt = new Date('2026-09-14T00:00:00Z');
    const staleAfter = staleAfterFrom(retrievedAt, 3_600_000);
    expect(freshnessOf({ retrievedAt, staleAfter }, new Date('2026-09-14T00:30:00Z')).state).toBe(
      'FRESH',
    );
    expect(freshnessOf({ retrievedAt, staleAfter }, new Date('2026-09-14T02:00:00Z')).state).toBe(
      'STALE',
    );
    expect(freshnessOf(null, retrievedAt).state).toBe('NEVER_SYNCED');
  });

  it('keeps harmless primitives and drops anything that could be a secret or personal detail', () => {
    const cleaned = sanitizeProviderMetadata({
      hiddenSubscriberCount: false,
      videoCount: 12,
      privacyStatus: 'public',
      access_token: 'ya29.abc',
      uploadUrl: 'https://upload.example/x',
      email: 'someone@example.com',
      opaque: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcd',
      nested: { a: 1 },
      bearerish: 'Bearer abc',
    });
    expect(cleaned).toEqual({
      hiddenSubscriberCount: false,
      videoCount: 12,
      privacyStatus: 'public',
    });
  });

  it('scrubs tokens out of stored error messages', () => {
    const text = sanitizeErrorMessage('failed with Bearer ya29.SECRET and access_token=abc', [
      'ya29.SECRET',
    ]);
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('abc');
  });

  it('backs off exponentially, never sooner than the platform asked', () => {
    expect(analyticsRetryDelayMs(1, null)).toBe(60_000);
    expect(analyticsRetryDelayMs(3, null)).toBe(240_000);
    expect(analyticsRetryDelayMs(1, 900)).toBe(900_000);
    expect(analyticsRetryDelayMs(20, null)).toBe(6 * 60 * 60 * 1000);
  });
});

describe('platforms without an analytics adapter', () => {
  it('say so for every metric, with the reason — nothing is left blank', () => {
    expect(unimplementedAnalyticsPlatforms().sort()).toEqual([
      'EMAIL',
      'PINTEREST',
      'THREADS',
      'TIKTOK',
      'X',
    ]);
    for (const platform of unimplementedAnalyticsPlatforms()) {
      const capability = unimplementedAnalyticsCapability(platform);
      expect(capability).not.toBeNull();
      expect(analyticsProviderCapabilitySchema.parse(capability)).toBeTruthy();
      expect(capability?.implemented).toBe(false);
      expect(['NOT_IMPLEMENTED', 'UNSUPPORTED']).toContain(capability?.availability);
      expect(capability?.metrics.every((metric) => metric.availability !== 'AVAILABLE')).toBe(true);
    }
    expect(unimplementedAnalyticsCapability('X')?.paidApi).toBe(true);
    expect(unimplementedAnalyticsCapability('EMAIL')?.availability).toBe('UNSUPPORTED');
    expect(unimplementedAnalyticsCapability('YOUTUBE')).toBeNull();
  });
});
