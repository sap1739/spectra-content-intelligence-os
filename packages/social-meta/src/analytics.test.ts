import { analyticsProviderCapabilitySchema, type AnalyticsMetric } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { MetaAnalyticsProvider, describeMetaAnalytics } from './analytics';

/** Meta analytics against a stand-in Graph API answering like the insights references. */

const API = 'https://graph.test';
const PAGE = '1234567890';
const POST = '1234567890_9876543210';
const IG_USER = '17841400000000001';
const IG_MEDIA = '17932174733377207';
const FB_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'read_insights',
];
const IG_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'instagram_basic',
  'instagram_content_publish',
  'instagram_manage_insights',
];

interface Fake {
  calls: string[];
  data?: unknown[];
  error?: { status: number; code: number };
}

function graph(state: Fake): typeof fetch {
  return async (input) => {
    const url = new URL(String(input));
    state.calls.push(
      `${url.pathname}?metric=${url.searchParams.get('metric') ?? ''}&fields=${url.searchParams.get('fields') ?? ''}`,
    );
    expect(url.searchParams.get('access_token')).toContain('TOKENVALUE');
    if (state.error) {
      return new Response(
        JSON.stringify({ error: { message: 'Denied', code: state.error.code } }),
        { status: state.error.status },
      );
    }
    if (url.pathname.endsWith('/insights')) {
      return new Response(JSON.stringify({ data: state.data ?? [] }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ id: url.pathname.split('/').pop(), followers_count: 5120, media_count: 88 }),
      { status: 200 },
    );
  };
}

const row = (name: string, value: unknown) => ({
  name,
  period: 'lifetime',
  values: [{ value }],
  id: `x/${name}`,
});

function provider(platform: 'FACEBOOK' | 'INSTAGRAM', state: Fake, grantedScopes: string[] | null) {
  return new MetaAnalyticsProvider({
    apiBaseUrl: API,
    version: 'v26.0',
    platform,
    accessToken: 'EAA-TOKENVALUE',
    accountId: platform === 'FACEBOOK' ? PAGE : IG_USER,
    grantedScopes,
    fetchImpl: graph(state),
    now: () => new Date('2026-09-14T00:00:00Z'),
  });
}

const get = (metrics: AnalyticsMetric[], key: string) =>
  metrics.find((metric) => metric.key === key);
const recent = (id: string) => ({
  externalContentId: id,
  publishedAt: new Date('2026-09-10T00:00:00Z'),
});

describe('Facebook Page analytics', () => {
  it('reads post insights, sums reactions, and reports impressions as deprecated', async () => {
    const state: Fake = {
      calls: [],
      data: [
        row('post_media_view', 900),
        row('post_total_media_view_unique', 610),
        row('post_clicks', 33),
        row('post_reactions_by_type_total', { like: 40, love: 5 }),
      ],
    };
    const { metrics } = await provider('FACEBOOK', state, FB_SCOPES).fetchContentAnalytics(
      recent(POST),
    );
    expect(get(metrics, 'views')).toMatchObject({
      value: 900,
      sourceMetricName: 'post_media_view',
      completeness: 'EXACT',
    });
    expect(get(metrics, 'reach')).toMatchObject({ value: 610, completeness: 'APPROXIMATE' });
    expect(get(metrics, 'reactions')?.value).toBe(45);
    expect(get(metrics, 'likes')?.value).toBe(40);
    expect(get(metrics, 'impressions')).toMatchObject({
      value: null,
      unavailableReason: 'DEPRECATED_BY_PLATFORM',
    });
    expect(get(metrics, 'comments')?.unavailableReason).toBe('NOT_IMPLEMENTED');
    expect(get(metrics, 'engagementRate')?.value).toBeCloseTo(45 / 900);
    expect(state.calls[0]).toContain(
      'post_media_view,post_total_media_view_unique,post_clicks,post_reactions_by_type_total',
    );
  });

  it('without read_insights: followers still come back; post insights are MISSING_SCOPE and never requested', async () => {
    const state: Fake = { calls: [] };
    const fb = provider('FACEBOOK', state, [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
    ]);
    const account = await fb.fetchAccountAnalytics();
    expect(get(account.metrics, 'followers')?.value).toBe(5120);
    const content = await fb.fetchContentAnalytics(recent(POST));
    expect(get(content.metrics, 'views')).toMatchObject({
      value: null,
      unavailableReason: 'MISSING_SCOPE',
    });
    expect(get(content.metrics, 'views')?.detail).toContain('read_insights');
    expect(state.calls.some((call) => call.includes('/insights'))).toBe(false);
    expect(
      describeMetaAnalytics({
        platform: 'FACEBOOK',
        grantedScopes: ['pages_read_engagement'],
        configured: true,
      }).availability,
    ).toBe('PARTIAL');
  });

  it('Meta refusing the insights edge is APPROVAL_REQUIRED per metric, not a failed sync; a rate limit is retryable', async () => {
    const refused = await provider(
      'FACEBOOK',
      { calls: [], error: { status: 403, code: 200 } },
      null,
    ).fetchContentAnalytics(recent(POST));
    expect(get(refused.metrics, 'views')?.unavailableReason).toBe('APPROVAL_REQUIRED');
    await expect(
      provider(
        'FACEBOOK',
        { calls: [], error: { status: 400, code: 4 } },
        FB_SCOPES,
      ).fetchContentAnalytics(recent(POST)),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
  });

  it('a post older than two years is outside Meta’s retention window', async () => {
    const state: Fake = { calls: [] };
    const { metrics } = await provider('FACEBOOK', state, FB_SCOPES).fetchContentAnalytics({
      externalContentId: POST,
      publishedAt: new Date('2023-01-01T00:00:00Z'),
    });
    expect(get(metrics, 'views')?.unavailableReason).toBe('OUTSIDE_RETENTION_WINDOW');
    expect(state.calls).toEqual([]);
  });
});

describe('Instagram analytics', () => {
  it('reads media insights, marking estimated and in-development metrics approximate', async () => {
    const state: Fake = {
      calls: [],
      data: [
        row('likes', 120),
        row('comments', 9),
        row('shares', 4),
        row('saved', 11),
        row('profile_visits', 3),
        row('reach', 2000),
        row('views', 2600),
      ],
    };
    const { metrics } = await provider('INSTAGRAM', state, IG_SCOPES).fetchContentAnalytics(
      recent(IG_MEDIA),
    );
    expect(get(metrics, 'saves')).toMatchObject({ value: 11, sourceMetricName: 'saved' });
    expect(get(metrics, 'reach')).toMatchObject({ value: 2000, completeness: 'APPROXIMATE' });
    expect(get(metrics, 'views')?.detail).toContain('in development');
    expect(get(metrics, 'impressions')?.unavailableReason).toBe('DEPRECATED_BY_PLATFORM');
    expect(get(metrics, 'clicks')?.unavailableReason).toBe('NOT_EXPOSED_BY_PLATFORM');
    const rate = get(metrics, 'engagementRate');
    expect(rate?.value).toBeCloseTo((120 + 9 + 4 + 11) / 2600);
    expect(rate?.detail).toContain('approximate');
  });

  it('a metric Meta left out is NOT_REPORTED, never zero', async () => {
    const { metrics } = await provider(
      'INSTAGRAM',
      { calls: [], data: [row('likes', 1)] },
      IG_SCOPES,
    ).fetchContentAnalytics(recent(IG_MEDIA));
    expect(get(metrics, 'comments')).toMatchObject({
      value: null,
      unavailableReason: 'NOT_REPORTED',
    });
  });

  it('describes default Meta scopes as partial for Instagram (followers only)', async () => {
    const capability = describeMetaAnalytics({
      platform: 'INSTAGRAM',
      grantedScopes: [
        'pages_show_list',
        'pages_read_engagement',
        'pages_manage_posts',
        'instagram_basic',
        'instagram_content_publish',
      ],
      configured: true,
    });
    expect(analyticsProviderCapabilitySchema.parse(capability)).toBeTruthy();
    expect(capability.availability).toBe('PARTIAL');
    expect(
      capability.metrics.find((metric) => metric.key === 'likes' && metric.level === 'CONTENT')
        ?.availability,
    ).toBe('MISSING_SCOPE');
  });
});
