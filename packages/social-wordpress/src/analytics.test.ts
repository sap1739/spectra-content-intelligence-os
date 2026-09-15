import { analyticsProviderCapabilitySchema, type AnalyticsMetric } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { WordPressAnalyticsProvider, describeWordPressAnalytics } from './analytics';

/** WordPress analytics against a stand-in site that answers like the core REST API. */

const SITE = 'https://blog.example.test';

function site(options: {
  total?: string | null;
  postStatus?: number;
  commentsStatus?: number;
  retryAfter?: string;
}) {
  const calls: string[] = [];
  const impl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    expect((init?.headers as Record<string, string>).authorization).toMatch(/^Basic /);
    if (url.pathname.startsWith('/wp-json/wp/v2/posts/')) {
      return new Response(JSON.stringify({ id: 42 }), { status: options.postStatus ?? 200 });
    }
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (options.total !== null) headers['x-wp-total'] = options.total ?? '7';
    if (options.retryAfter) headers['retry-after'] = options.retryAfter;
    return new Response('[]', { status: options.commentsStatus ?? 200, headers });
  };
  return { calls, impl };
}

const provider = (impl: typeof fetch) =>
  new WordPressAnalyticsProvider({
    siteUrl: SITE,
    username: 'editor',
    applicationPassword: 'abcd efgh ijkl',
    fetch: impl,
  });
const target = { externalContentId: '42', publishedAt: null };
const get = (metrics: AnalyticsMetric[], key: string) =>
  metrics.find((metric) => metric.key === key);

describe('WordPress analytics provider', () => {
  it('counts approved comments from X-WP-Total and says everything else is not in core', async () => {
    const fake = site({ total: '7' });
    const result = await provider(fake.impl).fetchContentAnalytics(target);
    expect(get(result.metrics, 'comments')).toMatchObject({ value: 7, completeness: 'EXACT' });
    for (const key of ['views', 'likes', 'impressions', 'shares', 'engagementRate']) {
      const metric = get(result.metrics, key);
      expect(metric?.value).toBeNull();
      expect(metric?.unavailableReason).toBe('NOT_EXPOSED_BY_PLATFORM');
      expect(metric?.detail).toContain('Jetpack');
    }
    expect(fake.calls).toEqual([
      '/wp-json/wp/v2/posts/42?_fields=id',
      '/wp-json/wp/v2/comments?post=42&per_page=1&_fields=id',
    ]);
  });

  it('a missing X-WP-Total header is an unknown count, not zero comments', async () => {
    const result = await provider(site({ total: null }).impl).fetchContentAnalytics(target);
    expect(get(result.metrics, 'comments')).toMatchObject({
      value: null,
      unavailableReason: 'NOT_REPORTED',
    });
  });

  it('a deleted post is NOT_FOUND instead of "0 comments"', async () => {
    await expect(
      provider(site({ postStatus: 404 }).impl).fetchContentAnalytics(target),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('a refused application password needs a new credential; a 429 is retryable with the wait', async () => {
    await expect(
      provider(site({ postStatus: 401 }).impl).fetchContentAnalytics(target),
    ).rejects.toMatchObject({
      code: 'REAUTH_REQUIRED',
    });
    await expect(
      provider(site({ commentsStatus: 429, retryAfter: '120' }).impl).fetchContentAnalytics(target),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 120 });
  });

  it('has no site-level analytics and makes no request for them', async () => {
    const fake = site({});
    const result = await provider(fake.impl).fetchAccountAnalytics();
    expect(result.metrics.every((metric) => metric.value === null)).toBe(true);
    expect(fake.calls).toEqual([]);
    const capability = describeWordPressAnalytics();
    expect(analyticsProviderCapabilitySchema.parse(capability)).toBeTruthy();
    expect(capability.availability).toBe('AVAILABLE');
    expect(capability.levels.account.supported).toBe(false);
    expect(
      capability.metrics.filter((metric) => metric.availability === 'AVAILABLE').map((m) => m.key),
    ).toEqual(['comments']);
  });
});
