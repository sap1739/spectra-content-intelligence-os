import { analyticsProviderCapabilitySchema, type AnalyticsMetric } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { LinkedInAnalyticsProvider, describeLinkedInAnalytics } from './analytics';

/**
 * LinkedIn analytics against a stand-in that answers like the documented
 * organizationalEntityShareStatistics and memberCreatorPostAnalytics endpoints.
 */

const API = 'https://linkedin.test';
const ORG = 'urn:li:organization:2414183';
const MEMBER = 'urn:li:person:782bbtaQ';
const SHARE = 'urn:li:share:7132564752928563200';

interface Fake {
  calls: string[];
  elements?: unknown[];
  status?: number;
  memberCounts?: Record<string, number | undefined>;
}

function fake(state: Fake): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    state.calls.push(url.replace(API, ''));
    const headers = init?.headers as Record<string, string>;
    expect(headers['Linkedin-Version']).toBe('202608');
    expect(headers['X-Restli-Protocol-Version']).toBe('2.0.0');
    if (state.status) {
      return new Response(
        JSON.stringify({ status: state.status, code: 'ACCESS_DENIED', message: 'denied' }),
        {
          status: state.status,
        },
      );
    }
    if (url.includes('organizationalEntityShareStatistics')) {
      return new Response(JSON.stringify({ elements: state.elements ?? [] }), { status: 200 });
    }
    const queryType = /queryType=([A-Z_]+)/.exec(url)?.[1] ?? '';
    const count = state.memberCounts?.[queryType];
    return new Response(
      JSON.stringify({ elements: count === undefined ? [] : [{ count, metricType: queryType }] }),
      { status: 200 },
    );
  };
}

const page = (state: Fake, grantedScopes: string[] | null = ['rw_organization_admin']) =>
  new LinkedInAnalyticsProvider({
    apiBaseUrl: API,
    version: '202608',
    accessToken: 'li-TOKENVALUE',
    authorUrn: ORG,
    kind: 'PAGE',
    grantedScopes,
    fetchImpl: fake(state),
    now: () => new Date('2026-09-14T00:00:00Z'),
  });

const member = (state: Fake, grantedScopes: string[] | null = ['r_member_postAnalytics']) =>
  new LinkedInAnalyticsProvider({
    apiBaseUrl: API,
    version: '202608',
    accessToken: 'li-TOKENVALUE',
    authorUrn: MEMBER,
    kind: 'PROFILE',
    grantedScopes,
    fetchImpl: fake(state),
  });

const recent = { externalContentId: SHARE, publishedAt: new Date('2026-09-01T00:00:00Z') };
const get = (metrics: AnalyticsMetric[], key: string) =>
  metrics.find((metric) => metric.key === key);

describe('LinkedIn page analytics', () => {
  it('maps share statistics, keeps LinkedIn’s own engagement ratio, and a negative like count as reported', async () => {
    const state: Fake = {
      calls: [],
      elements: [
        {
          organizationalEntity: ORG,
          share: SHARE,
          totalShareStatistics: {
            clickCount: 78,
            commentCount: 24,
            engagement: 0.0228,
            impressionCount: 5287,
            likeCount: -1,
            shareCount: 5,
          },
        },
      ],
    };
    const { metrics } = await page(state).fetchContentAnalytics(recent);
    expect(get(metrics, 'impressions')).toMatchObject({
      value: 5287,
      sourceMetricName: 'totalShareStatistics.impressionCount',
    });
    expect(get(metrics, 'likes')?.value).toBe(-1);
    expect(get(metrics, 'engagementRate')).toMatchObject({ value: 0.0228, completeness: 'EXACT' });
    // Present element, missing field: not reported — not zero.
    expect(get(metrics, 'reach')).toMatchObject({ value: null, unavailableReason: 'NOT_REPORTED' });
    expect(get(metrics, 'saves')?.unavailableReason).toBe('NOT_EXPOSED_BY_PLATFORM');
    expect(get(metrics, 'views')?.unavailableReason).toBe('CONTENT_TYPE_UNSUPPORTED');
    expect(state.calls[0]).toContain(`shares=List(${encodeURIComponent(SHARE)})`);
  });

  it('an omitted post is LinkedIn’s documented zero, quoted — and its ratio is undefined', async () => {
    const { metrics, notes } = await page({ calls: [], elements: [] }).fetchContentAnalytics(
      recent,
    );
    expect(get(metrics, 'impressions')).toMatchObject({ value: 0, completeness: 'EXACT' });
    expect(get(metrics, 'impressions')?.detail).toContain('can be assumed to have counts of 0');
    expect(get(metrics, 'engagementRate')).toMatchObject({
      value: null,
      unavailableReason: 'DENOMINATOR_UNKNOWN',
    });
    expect(notes.join(' ')).toContain('can be assumed to have counts of 0');
  });

  it('a post older than the 12-month window is not requested', async () => {
    const state: Fake = { calls: [] };
    const { metrics } = await page(state).fetchContentAnalytics({
      externalContentId: SHARE,
      publishedAt: new Date('2025-01-01T00:00:00Z'),
    });
    expect(get(metrics, 'impressions')?.unavailableReason).toBe('OUTSIDE_RETENTION_WINDOW');
    expect(state.calls).toEqual([]);
  });

  it('without rw_organization_admin nothing is requested and every metric names the scope', async () => {
    const state: Fake = { calls: [] };
    const { metrics } = await page(state, ['w_organization_social']).fetchContentAnalytics(recent);
    expect(get(metrics, 'impressions')).toMatchObject({
      value: null,
      unavailableReason: 'MISSING_SCOPE',
    });
    expect(get(metrics, 'impressions')?.detail).toContain('rw_organization_admin');
    expect(state.calls).toEqual([]);
    expect(
      describeLinkedInAnalytics({
        kind: 'PAGE',
        grantedScopes: ['w_organization_social'],
        configured: true,
      }).availability,
    ).toBe('MISSING_SCOPE');
  });

  it('a 403 is an approval problem, a 429 is retryable', async () => {
    await expect(
      page({ calls: [], status: 403 }).fetchContentAnalytics(recent),
    ).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    await expect(
      page({ calls: [], status: 429 }).fetchContentAnalytics(recent),
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryable: true,
    });
  });

  it('reads page-wide statistics at account level', async () => {
    const { metrics } = await page({
      calls: [],
      elements: [
        {
          organizationalEntity: ORG,
          totalShareStatistics: {
            impressionCount: 900,
            uniqueImpressionsCount: 400,
            clickCount: 1,
            likeCount: 2,
            commentCount: 3,
            shareCount: 4,
            engagement: 0.01,
          },
        },
      ],
    }).fetchAccountAnalytics();
    expect(get(metrics, 'reach')?.value).toBe(400);
    expect(get(metrics, 'followers')?.unavailableReason).toBe('NOT_IMPLEMENTED');
  });
});

describe('LinkedIn member analytics', () => {
  it('one call per metric, every value approximate, a missing one not reported', async () => {
    const state: Fake = {
      calls: [],
      memberCounts: {
        IMPRESSION: 1200,
        MEMBERS_REACHED: 800,
        REACTION: 40,
        COMMENT: 6,
        RESHARE: 2,
        POST_SAVE: 1,
        LINK_CLICKS: 9,
      },
    };
    const { metrics } = await member(state).fetchContentAnalytics(recent);
    expect(state.calls).toHaveLength(8);
    expect(state.calls[0]).toContain(`entity=(share:${encodeURIComponent(SHARE)})`);
    expect(get(metrics, 'impressions')).toMatchObject({ value: 1200, completeness: 'APPROXIMATE' });
    expect(get(metrics, 'profileVisits')).toMatchObject({
      value: null,
      unavailableReason: 'NOT_REPORTED',
    });
    expect(get(metrics, 'likes')?.unavailableReason).toBe('NOT_EXPOSED_BY_PLATFORM');
    // (reactions + comments + shares + saves) / impressions, derived.
    expect(get(metrics, 'engagementRate')?.value).toBeCloseTo((40 + 6 + 2 + 1) / 1200);
    expect(get(metrics, 'engagementRate')?.completeness).toBe('DERIVED');
  });

  it('has no member-wide analytics and says so', async () => {
    await expect(member({ calls: [] }).fetchAccountAnalytics()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    const capability = describeLinkedInAnalytics({
      kind: 'PROFILE',
      grantedScopes: ['w_member_social'],
      configured: true,
    });
    expect(analyticsProviderCapabilitySchema.parse(capability)).toBeTruthy();
    expect(capability.levels.account.supported).toBe(false);
    expect(capability.availability).toBe('MISSING_SCOPE');
    expect(capability.approval.notes.join(' ')).toContain('r_member_postAnalytics');
  });
});
