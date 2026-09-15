import { analyticsProviderCapabilitySchema, type AnalyticsMetric } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { YouTubeAnalyticsProvider, describeYouTubeAnalytics } from './analytics';
import { YOUTUBE_SCOPES } from './constants';

/**
 * YouTube analytics against a stand-in for the Data API (videos.list,
 * channels.list) and the Analytics API (reports.query) that answers the way
 * Google documents: counts as decimal strings, a rounded subscriber count, and
 * a report with columnHeaders + rows.
 */

const API = 'https://youtube.test';
const ANALYTICS = 'https://analytics.youtube.test';
const CHANNEL = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const VIDEO = 'vid_abcdefgh';
const FULL = [YOUTUBE_SCOPES.upload, YOUTUBE_SCOPES.readonly, YOUTUBE_SCOPES.analytics];
const DEFAULT = [YOUTUBE_SCOPES.upload, YOUTUBE_SCOPES.readonly];

interface Fake {
  calls: string[];
  statistics?: Record<string, unknown>;
  noVideo?: boolean;
  reportStatus?: number;
  reportReason?: string;
  reportRows?: unknown[][];
  dataStatus?: number;
  dataReason?: string;
}

function fakeGoogle(state: Fake): typeof fetch {
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const error = (status: number, reason: string) =>
    json(status, {
      error: { code: status, message: reason, errors: [{ reason, message: reason }] },
    });
  return async (input) => {
    const url = new URL(String(input));
    state.calls.push(url.pathname);
    if (url.origin === ANALYTICS) {
      if (state.reportStatus) return error(state.reportStatus, state.reportReason ?? 'forbidden');
      expect(url.searchParams.get('ids')).toBe('channel==MINE');
      expect(url.searchParams.get('filters')).toBe(`video==${VIDEO}`);
      return json(200, {
        columnHeaders: [
          { name: 'estimatedMinutesWatched' },
          { name: 'averageViewDuration' },
          { name: 'shares' },
        ],
        rows: state.reportRows ?? [[1250, 94, 17]],
      });
    }
    if (state.dataStatus) return error(state.dataStatus, state.dataReason ?? 'quotaExceeded');
    if (url.pathname === '/youtube/v3/videos') {
      expect(url.searchParams.get('part')).toBe('statistics');
      if (state.noVideo) return json(200, { items: [] });
      return json(200, {
        items: [
          {
            id: VIDEO,
            statistics: state.statistics ?? {
              viewCount: '4200',
              likeCount: '210',
              favoriteCount: '0',
              commentCount: '0',
            },
          },
        ],
      });
    }
    if (url.pathname === '/youtube/v3/channels') {
      return json(200, {
        items: [
          {
            id: CHANNEL,
            statistics: {
              viewCount: '98000',
              subscriberCount: '12300',
              hiddenSubscriberCount: false,
              videoCount: '41',
            },
          },
        ],
      });
    }
    return error(404, 'notFound');
  };
}

function provider(
  state: Fake,
  grantedScopes: string[] | null = FULL,
  onAuthRejected?: () => Promise<void>,
) {
  return new YouTubeAnalyticsProvider({
    apiBaseUrl: API,
    analyticsApiBaseUrl: ANALYTICS,
    accessToken: 'ya29-TOKENVALUE',
    channelId: CHANNEL,
    grantedScopes,
    fetchImpl: fakeGoogle(state),
    now: () => new Date('2026-09-14T00:00:00Z'),
    ...(onAuthRejected ? { onAuthRejected } : {}),
  });
}

const target = { externalContentId: VIDEO, publishedAt: new Date('2026-09-01T00:00:00Z') };
const byKey = (metrics: AnalyticsMetric[]): Partial<Record<string, AnalyticsMetric>> =>
  Object.fromEntries(metrics.map((metric) => [metric.key, metric]));

describe('YouTube analytics provider', () => {
  it('reads video statistics and the Analytics report, keeping source names', async () => {
    const state: Fake = { calls: [] };
    const result = await provider(state).fetchContentAnalytics(target);
    const m = byKey(result.metrics);
    expect(m.views).toMatchObject({
      value: 4200,
      completeness: 'EXACT',
      sourceMetricName: 'statistics.viewCount',
    });
    expect(m.likes?.value).toBe(210);
    // A reported zero is a zero.
    expect(m.comments).toMatchObject({ value: 0, unavailableReason: null });
    expect(m.watchTimeMinutes).toMatchObject({
      value: 1250,
      sourceMetricName: 'estimatedMinutesWatched',
    });
    expect(m.averageViewDurationSeconds?.value).toBe(94);
    expect(m.shares?.value).toBe(17);
    // (likes + comments + shares) / views
    expect(m.engagementRate?.value).toBeCloseTo((210 + 0 + 17) / 4200);
    expect(m.engagementRate?.completeness).toBe('DERIVED');
    // Not exposed or not read: said, not zeroed.
    expect(m.impressions?.value).toBeNull();
    expect(m.impressions?.unavailableReason).toBe('NOT_IMPLEMENTED');
    expect(m.saves?.unavailableReason).toBe('NOT_EXPOSED_BY_PLATFORM');
    expect(state.calls).toEqual(['/youtube/v3/videos', '/v2/reports']);
  });

  it('without yt-analytics.readonly: the Data API counts still come back, the rest is MISSING_SCOPE, and the report is not called', async () => {
    const state: Fake = { calls: [] };
    const result = await provider(state, DEFAULT).fetchContentAnalytics(target);
    const m = byKey(result.metrics);
    expect(m.views?.value).toBe(4200);
    expect(m.watchTimeMinutes?.value).toBeNull();
    expect(m.watchTimeMinutes?.unavailableReason).toBe('MISSING_SCOPE');
    expect(m.watchTimeMinutes?.detail).toContain('yt-analytics.readonly');
    expect(state.calls).toEqual(['/youtube/v3/videos']);
  });

  it('a hidden like count is NOT_REPORTED, never zero', async () => {
    const state: Fake = { calls: [], statistics: { viewCount: '10', commentCount: '1' } };
    const result = await provider(state, DEFAULT).fetchContentAnalytics(target);
    const m = byKey(result.metrics);
    expect(m.likes?.value).toBeNull();
    expect(m.likes?.unavailableReason).toBe('NOT_REPORTED');
    expect(result.notes.join(' ')).toContain('hidden its like count');
  });

  it('an Analytics API refusal keeps the Data API counts and names the scope', async () => {
    const state: Fake = { calls: [], reportStatus: 403, reportReason: 'insufficientPermissions' };
    const m = byKey((await provider(state, null).fetchContentAnalytics(target)).metrics);
    expect(m.views?.value).toBe(4200);
    expect(m.shares?.unavailableReason).toBe('MISSING_SCOPE');
  });

  it('a report with no rows yet is NOT_YET_AVAILABLE', async () => {
    const state: Fake = { calls: [], reportRows: [] };
    const m = byKey((await provider(state).fetchContentAnalytics(target)).metrics);
    expect(m.watchTimeMinutes?.unavailableReason).toBe('NOT_YET_AVAILABLE');
  });

  it('reads channel views and marks the subscriber count approximate', async () => {
    const result = await provider({ calls: [] }).fetchAccountAnalytics();
    const m = byKey(result.metrics);
    expect(m.followers).toMatchObject({ value: 12300, completeness: 'APPROXIMATE' });
    expect(m.views?.value).toBe(98000);
    expect(result.providerMetadata).toEqual({ hiddenSubscriberCount: false });
  });

  it('maps quota, rate and auth refusals to retryable or reconnect errors', async () => {
    await expect(
      provider({ calls: [], dataStatus: 403, dataReason: 'quotaExceeded' }).fetchContentAnalytics(
        target,
      ),
    ).rejects.toMatchObject({ code: 'QUOTA_EXCEEDED', retryable: true });
    await expect(
      provider({
        calls: [],
        dataStatus: 429,
        dataReason: 'rateLimitExceeded',
      }).fetchContentAnalytics(target),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    let rejected = false;
    await expect(
      provider({ calls: [], dataStatus: 401, dataReason: 'authError' }, FULL, async () => {
        rejected = true;
      }).fetchContentAnalytics(target),
    ).rejects.toMatchObject({ code: 'REAUTH_REQUIRED', retryable: false });
    expect(rejected).toBe(true);
  });

  it('a deleted video is NOT_FOUND, not a row of zeros', async () => {
    await expect(
      provider({ calls: [], noVideo: true }).fetchContentAnalytics(target),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('the token never appears in an error', async () => {
    const error = await provider({ calls: [], dataStatus: 500, dataReason: 'backendError' })
      .fetchContentAnalytics(target)
      .catch((caught: Error) => caught);
    expect(String((error as Error).message)).not.toContain('TOKENVALUE');
  });

  it('describes availability from the grant alone', () => {
    expect(describeYouTubeAnalytics({ grantedScopes: FULL, configured: true }).availability).toBe(
      'AVAILABLE',
    );
    const partial = describeYouTubeAnalytics({ grantedScopes: DEFAULT, configured: true });
    expect(partial.availability).toBe('PARTIAL');
    expect(analyticsProviderCapabilitySchema.parse(partial)).toBeTruthy();
    expect(
      describeYouTubeAnalytics({ grantedScopes: [YOUTUBE_SCOPES.upload], configured: true })
        .availability,
    ).toBe('MISSING_SCOPE');
    expect(describeYouTubeAnalytics({ grantedScopes: FULL, configured: false }).availability).toBe(
      'UNCONFIGURED',
    );
  });
});
