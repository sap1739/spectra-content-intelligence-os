import './setup-env';

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  claimDueAnalyticsSyncs,
  createAnalyticsProviderResolver,
  executeAnalyticsSync,
  measuredEngagementForTopic,
  requestAnalyticsSync,
  type AnalyticsSyncDeps,
} from '@spectra/analytics-pipeline';
import { PrismaUsageRecorder } from '@spectra/metering';
import { encryptSecret, generateEncryptionKey } from '@spectra/security';
import { sealTokenBundle } from '@spectra/social-oauth';
import {
  DEFAULT_TREND_SCORING_CONFIG,
  WeightedTrendScoringEngine,
  withMeasuredEngagement,
} from '@spectra/trend-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv, resetApiEnvCache } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 6H: external analytics (ADR-0039), end to end.
 *
 * One HTTP server on 127.0.0.1 stands in for YouTube (Data API + Analytics
 * API), a WordPress site, LinkedIn's share statistics and Meta's Graph API,
 * answering as each documents and enforcing what each enforces — bearer tokens,
 * per-scope refusals, rate limits. Accounts and connections are created
 * directly with sealed credentials (the OAuth flow itself is covered by the
 * 6C–6G suites). Sync runs are executed through `executeAnalyticsSync` — the
 * worker's own code path — so nothing races a running worker.
 *
 * Every token contains TOKENVALUE, so a leak into a stored row is one search.
 */

const runId = randomBytes(4).toString('hex');
const PASSWORD = 'integration-test-password-1';
const KEY = generateEncryptionKey();
const RING = { keys: { 'social-v1': KEY }, activeKeyId: 'social-v1' };
const LEAK = 'TOKENVALUE';

const YT_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
const YT_READ = 'https://www.googleapis.com/auth/youtube.readonly';
const YT_ANALYTICS = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const CHANNEL = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const ORG_URN = 'urn:li:organization:2414183';
const PAGE_ID = '1234567890';

interface Mock {
  base: string;
  server: Server;
  /** access token -> granted scopes */
  tokens: Map<string, string[]>;
  calls: string[];
  youtubeRateLimited: boolean;
  youtubeAuthFails: boolean;
  videos: Map<string, { viewCount: string; likeCount?: string; commentCount: string }>;
  wordpressComments: Map<string, number>;
}

type Send = (status: number, body?: unknown, headers?: Record<string, string>) => void;

async function handle(mock: Mock, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://mock.local');
  const send: Send = (status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(body === undefined ? '' : JSON.stringify(body));
  };
  mock.calls.push(url.pathname);
  const googleError = (status: number, reason: string) =>
    send(status, {
      error: { code: status, message: reason, errors: [{ reason, message: reason }] },
    });

  // --- WordPress (Basic auth with the application password) ------------------
  if (url.pathname.startsWith('/wp-json/')) {
    const auth = String(req.headers.authorization ?? '');
    if (auth !== `Basic ${Buffer.from('editor:abcd efgh ijkl').toString('base64')}`) {
      return send(401, { code: 'rest_not_logged_in' });
    }
    const post = /^\/wp-json\/wp\/v2\/posts\/(\d+)$/.exec(url.pathname);
    if (post) {
      return mock.wordpressComments.has(post[1] as string)
        ? send(200, { id: Number(post[1]) })
        : send(404, { code: 'rest_post_invalid_id' });
    }
    if (url.pathname === '/wp-json/wp/v2/comments') {
      const total = mock.wordpressComments.get(url.searchParams.get('post') ?? '') ?? 0;
      return send(200, [], { 'x-wp-total': String(total), 'x-wp-totalpages': '1' });
    }
    return send(404, {});
  }

  // --- Meta Graph (access_token parameter) -----------------------------------
  if (url.pathname.startsWith('/v26.0/')) {
    const token = url.searchParams.get('access_token') ?? '';
    if (!token.includes(LEAK))
      return send(400, { error: { message: 'Invalid OAuth access token', code: 190 } });
    if (url.pathname.endsWith('/insights')) {
      // The Page token was issued without read_insights.
      return send(403, { error: { message: '(#10) Requires read_insights permission', code: 10 } });
    }
    return send(200, { id: PAGE_ID, followers_count: 5120 });
  }

  // --- Everything else: bearer tokens ----------------------------------------
  const bearer = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const scopes = mock.tokens.get(bearer);

  if (url.pathname.startsWith('/rest/')) {
    if (!scopes)
      return send(401, { status: 401, code: 'REVOKED_ACCESS_TOKEN', message: 'revoked' });
    if (!scopes.includes('rw_organization_admin')) {
      return send(403, { status: 403, code: 'ACCESS_DENIED', message: 'Not enough permissions' });
    }
    const shares = /List\(([^)]*)\)/.exec(url.search)?.[1];
    const share = shares ? decodeURIComponent(shares) : null;
    return send(200, {
      elements: share
        ? [
            {
              organizationalEntity: ORG_URN,
              share,
              totalShareStatistics: {
                clickCount: 78,
                commentCount: 24,
                engagement: 0.0228,
                impressionCount: 5287,
                likeCount: 14,
                shareCount: 5,
              },
            },
          ]
        : [
            {
              organizationalEntity: ORG_URN,
              totalShareStatistics: {
                clickCount: 900,
                commentCount: 60,
                engagement: 0.01,
                impressionCount: 90000,
                uniqueImpressionsCount: 41000,
                likeCount: 300,
                shareCount: 20,
              },
            },
          ],
    });
  }

  if (!scopes || mock.youtubeAuthFails) return googleError(401, 'authError');
  if (mock.youtubeRateLimited) return googleError(429, 'rateLimitExceeded');
  if (url.pathname === '/youtube/v3/videos') {
    if (!scopes.includes(YT_READ)) return googleError(403, 'insufficientPermissions');
    const id = url.searchParams.get('id') ?? '';
    const video = mock.videos.get(id);
    return send(200, {
      items: video ? [{ id, statistics: { ...video, favoriteCount: '0' } }] : [],
    });
  }
  if (url.pathname === '/youtube/v3/channels') {
    if (!scopes.includes(YT_READ)) return googleError(403, 'insufficientPermissions');
    return send(200, {
      items: [
        {
          id: CHANNEL,
          statistics: {
            viewCount: '98000',
            subscriberCount: '12300',
            hiddenSubscriberCount: false,
          },
        },
      ],
    });
  }
  if (url.pathname === '/v2/reports') {
    if (!scopes.includes(YT_ANALYTICS)) return googleError(403, 'insufficientPermissions');
    return send(200, {
      columnHeaders: [
        { name: 'estimatedMinutesWatched' },
        { name: 'averageViewDuration' },
        { name: 'shares' },
      ],
      rows: [[1250, 94, 17]],
    });
  }
  return googleError(404, 'notFound');
}

async function startMock(): Promise<Mock> {
  const mock: Mock = {
    base: '',
    server: createServer(),
    tokens: new Map(),
    calls: [],
    youtubeRateLimited: false,
    youtubeAuthFails: false,
    videos: new Map(),
    wordpressComments: new Map(),
  };
  mock.server.on('request', (req, res) => {
    req.resume();
    req.on('end', () => {
      void handle(mock, req, res).catch(() => {
        res.writeHead(500);
        res.end();
      });
    });
  });
  await new Promise<void>((resolve) => mock.server.listen(0, '127.0.0.1', resolve));
  mock.base = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`;
  return mock;
}

interface Tenant {
  email: string;
  cookie: string;
  userId: string;
  orgId: string;
  workspaceId: string;
}

interface RunBody {
  id: string;
  status: string;
  attempt: number;
  counts: { succeeded: number; partial: number; failed: number; unavailable: number };
  error: { code: string; message: string } | null;
  rateLimit: { limited: boolean; nextAttemptAt: string | null } | null;
  results: Array<{
    level: string;
    platform: string;
    outcome: string;
    errorCode: string | null;
    message: string | null;
  }>;
}

function problemText(body: unknown): string {
  const problem = body as { title?: string; detail?: string };
  return `${problem.title ?? ''} ${problem.detail ?? ''}`;
}

describe('API integration: external analytics (ADR-0039)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mock: Mock;
  const tenants: Tenant[] = [];
  let owner: Tenant;
  let other: Tenant;

  const inject = () => app.getHttpAdapter().getInstance();
  const ws = (t: Tenant = owner) => `/v1/workspaces/${t.workspaceId}/analytics`;

  async function registerTenant(label: string): Promise<Tenant> {
    const email = `analytics-${label}-${runId}@itest.local`;
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, name: `Analytics ${label}` },
    });
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] as string;
    const me = res.json() as {
      user: { id: string };
      memberships: Array<{ organizationId: string }>;
      workspaces: Array<{ id: string }>;
    };
    const tenant = {
      email,
      cookie,
      userId: me.user.id,
      orgId: me.memberships[0]?.organizationId as string,
      workspaceId: me.workspaces[0]?.id as string,
    };
    tenants.push(tenant);
    return tenant;
  }

  function issue(scopes: string[]): string {
    const token = `token-${LEAK}-${randomBytes(6).toString('hex')}`;
    mock.tokens.set(token, scopes);
    return token;
  }

  async function connection(
    t: Tenant,
    platform: 'YOUTUBE' | 'LINKEDIN' | 'FACEBOOK' | 'TIKTOK',
    scopes: string[],
    extra: { status?: 'CONNECTED' | 'REAUTH_REQUIRED'; expiresAt?: Date | null } = {},
  ) {
    const sealed = sealTokenBundle(
      { accessToken: issue(scopes), refreshToken: null, tokenType: 'Bearer' },
      RING,
    );
    return prisma.client.socialConnection.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        platform,
        label: `${platform} ${runId}`,
        status: extra.status ?? 'CONNECTED',
        requestedScopes: scopes,
        grantedScopes: scopes,
        grantedScopesReported: true,
        encryptedCredential: sealed.sealed,
        credentialKeyId: sealed.keyId,
        hasRefreshToken: false,
        accessTokenExpiresAt: extra.expiresAt ?? new Date(Date.now() + 3_600_000),
      },
    });
  }

  async function account(
    t: Tenant,
    data: {
      platform: 'YOUTUBE' | 'LINKEDIN' | 'FACEBOOK' | 'TIKTOK' | 'WORDPRESS';
      kind: 'CHANNEL' | 'PAGE' | 'PROFILE' | 'SITE';
      externalAccountId: string;
      connectionId?: string | null;
      encryptedToken?: string | null;
    },
  ) {
    return prisma.client.socialAccount.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        displayName: `${data.platform} account`,
        status: 'CONNECTED',
        platform: data.platform,
        kind: data.kind,
        externalAccountId: data.externalAccountId,
        connectionId: data.connectionId ?? null,
        encryptedToken: data.encryptedToken ?? null,
      },
    });
  }

  async function publishedEntry(
    t: Tenant,
    accountRow: { id: string; platform: string },
    externalPostId: string,
    extra: { campaignId?: string; topicKey?: string; status?: 'PUBLISHED' | 'SCHEDULED' } = {},
  ) {
    const item = await prisma.client.contentItem.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        title: `Post ${externalPostId}`,
        contentType: 'POST',
        lifecycleState: 'PUBLISHED',
        campaignId: extra.campaignId ?? null,
        topicKey: extra.topicKey ?? null,
      },
    });
    const published = (extra.status ?? 'PUBLISHED') === 'PUBLISHED';
    const entry = await prisma.client.contentScheduleEntry.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        contentItemId: item.id,
        socialAccountId: accountRow.id,
        platform: accountRow.platform,
        scheduledAt: new Date(Date.now() - 86_400_000),
        status: extra.status ?? 'PUBLISHED',
        externalPostId: published ? externalPostId : null,
        publishedAt: published ? new Date(Date.now() - 3 * 86_400_000) : null,
        idempotencyKey: randomUUID(),
      },
    });
    return { item, entry };
  }

  function deps(overrides: Partial<AnalyticsSyncDeps> = {}): AnalyticsSyncDeps {
    return {
      prisma: prisma.client,
      resolveProvider: createAnalyticsProviderResolver({
        prisma: prisma.client,
        ring: RING,
        youtube: { api: { apiBaseUrl: mock.base }, oauth: null, analyticsApiBaseUrl: mock.base },
        linkedin: { api: { apiBaseUrl: mock.base, version: '202608' }, oauth: null },
        meta: { api: { apiBaseUrl: mock.base, version: 'v26.0' } },
      }),
      usage: new PrismaUsageRecorder(prisma.client),
      retryBaseMs: 60_000,
      ...overrides,
    };
  }

  async function run(t: Tenant, id: string): Promise<RunBody> {
    const res = await inject().inject({
      method: 'GET',
      url: `${ws(t)}/sync-runs/${id}`,
      headers: { cookie: t.cookie },
    });
    expect(res.statusCode).toBe(200);
    return res.json() as RunBody;
  }

  async function post(t: Tenant, payload: unknown, headers: Record<string, string> = {}) {
    return inject().inject({
      method: 'POST',
      url: `${ws(t)}/sync`,
      headers: { cookie: t.cookie, ...headers },
      payload: payload as Record<string, unknown>,
    });
  }

  // Fixtures shared across tests.
  let ytFull: { id: string; platform: string };
  let ytDefault: { id: string; platform: string };
  let wordpress: { id: string; platform: string };
  let linkedinPage: { id: string; platform: string };
  let facebookPage: { id: string; platform: string };
  let tiktok: { id: string; platform: string };
  let campaignId = '';
  let ytFullEntry: { item: { id: string }; entry: { id: string } };
  let wpEntry: { item: { id: string }; entry: { id: string } };
  let tiktokEntry: { item: { id: string }; entry: { id: string } };

  beforeAll(async () => {
    mock = await startMock();
    Object.assign(process.env, { SOCIAL_TOKEN_ENCRYPTION_KEY: KEY });
    resetApiEnvCache();
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);
    owner = await registerTenant('owner');
    other = await registerTenant('other');

    mock.videos.set('vid_full0001', { viewCount: '4200', likeCount: '210', commentCount: '0' });
    mock.videos.set('vid_dflt0001', { viewCount: '1000', likeCount: '40', commentCount: '10' });
    mock.wordpressComments.set('42', 7);

    const campaign = await prisma.client.campaign.create({
      data: { organizationId: owner.orgId, workspaceId: owner.workspaceId, name: 'Autumn launch' },
    });
    campaignId = campaign.id;

    // Owner: a YouTube channel with the analytics scope, and one with Spectra's defaults.
    const fullConnection = await connection(owner, 'YOUTUBE', [YT_UPLOAD, YT_READ, YT_ANALYTICS]);
    ytFull = await account(owner, {
      platform: 'YOUTUBE',
      kind: 'CHANNEL',
      externalAccountId: CHANNEL,
      connectionId: fullConnection.id,
    });
    const defaultConnection = await connection(owner, 'YOUTUBE', [YT_UPLOAD, YT_READ]);
    ytDefault = await account(owner, {
      platform: 'YOUTUBE',
      kind: 'CHANNEL',
      externalAccountId: CHANNEL,
      connectionId: defaultConnection.id,
    });
    wordpress = await account(owner, {
      platform: 'WORDPRESS',
      kind: 'SITE',
      externalAccountId: mock.base,
      encryptedToken: encryptSecret('editor:abcd efgh ijkl', RING),
    });
    const linkedinConnection = await connection(owner, 'LINKEDIN', [
      'openid',
      'profile',
      'rw_organization_admin',
      'w_organization_social',
    ]);
    linkedinPage = await account(owner, {
      platform: 'LINKEDIN',
      kind: 'PAGE',
      externalAccountId: ORG_URN,
      connectionId: linkedinConnection.id,
    });
    const metaConnection = await connection(owner, 'FACEBOOK', [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
    ]);
    facebookPage = await account(owner, {
      platform: 'FACEBOOK',
      kind: 'PAGE',
      externalAccountId: PAGE_ID,
      connectionId: metaConnection.id,
      encryptedToken: encryptSecret(`page-${LEAK}`, RING),
    });
    const tiktokConnection = await connection(owner, 'TIKTOK', [
      'user.info.basic',
      'video.publish',
    ]);
    tiktok = await account(owner, {
      platform: 'TIKTOK',
      kind: 'PROFILE',
      externalAccountId: 'open-id-acme',
      connectionId: tiktokConnection.id,
    });

    ytFullEntry = await publishedEntry(owner, ytFull, 'vid_full0001', {
      campaignId,
      topicKey: `roasting-${runId}`,
    });
    await publishedEntry(owner, ytDefault, 'vid_dflt0001', { campaignId });
    wpEntry = await publishedEntry(owner, wordpress, '42', { topicKey: `roasting-${runId}` });
    await publishedEntry(owner, linkedinPage, 'urn:li:share:7132564752928563200');
    await publishedEntry(owner, facebookPage, `${PAGE_ID}_9876543210`);
    tiktokEntry = await publishedEntry(owner, tiktok, '7300000000000000001');
  });

  afterAll(async () => {
    for (const tenant of tenants) {
      await prisma.client.organization
        .deleteMany({ where: { id: tenant.orgId } })
        .catch(() => undefined);
      await prisma.client.user
        .deleteMany({ where: { email: tenant.email } })
        .catch(() => undefined);
    }
    await app.close();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  describe('providers and availability', () => {
    it('lists every platform with an honest status and per-metric reasons', async () => {
      const res = await inject().inject({
        method: 'GET',
        url: `${ws()}/providers`,
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        providers: Array<{
          platform: string;
          implemented: boolean;
          availability: string;
          paidApi: boolean;
          metrics: Array<{ availability: string; reason: string | null }>;
        }>;
        metricDefinitions: unknown[];
        scheduledSync: { enabled: boolean };
      };
      const byPlatform = Object.fromEntries(
        body.providers.map((provider) => [provider.platform, provider]),
      );
      expect(Object.keys(byPlatform).sort()).toEqual(
        [
          'EMAIL',
          'FACEBOOK',
          'INSTAGRAM',
          'LINKEDIN',
          'PINTEREST',
          'THREADS',
          'TIKTOK',
          'WORDPRESS',
          'X',
          'YOUTUBE',
        ].sort(),
      );
      for (const platform of ['WORDPRESS', 'YOUTUBE', 'LINKEDIN', 'FACEBOOK', 'INSTAGRAM']) {
        expect(byPlatform[platform]?.implemented, platform).toBe(true);
      }
      expect(byPlatform.TIKTOK?.availability).toBe('NOT_IMPLEMENTED');
      expect(byPlatform.EMAIL?.availability).toBe('UNSUPPORTED');
      expect(byPlatform.X?.paidApi).toBe(true);
      // No OAuth client is configured in this environment: connectable platforms say so.
      expect(byPlatform.YOUTUBE?.availability).toBe('UNCONFIGURED');
      expect(body.metricDefinitions.length).toBe(16);
      expect(body.scheduledSync.enabled).toBe(false);
      for (const provider of body.providers) {
        for (const metric of provider.metrics) {
          if (metric.availability !== 'AVAILABLE')
            expect(metric.reason, provider.platform).toBeTruthy();
        }
      }
    });

    it('reports missing scopes, unsupported platforms and connection state per account', async () => {
      const res = await inject().inject({
        method: 'GET',
        url: `${ws()}/availability`,
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(200);
      const { accounts } = res.json() as {
        accounts: Array<{
          socialAccountId: string;
          availability: string;
          reason: string;
          freshness: { state: string };
        }>;
      };
      const of = (id: string) => accounts.find((row) => row.socialAccountId === id);
      expect(of(ytFull.id)?.availability).toBe('AVAILABLE');
      expect(of(ytDefault.id)?.availability).toBe('PARTIAL');
      expect(of(ytDefault.id)?.reason).toContain('yt-analytics.readonly');
      expect(of(facebookPage.id)?.availability).toBe('PARTIAL');
      expect(of(facebookPage.id)?.reason).toContain('read_insights');
      expect(of(tiktok.id)?.availability).toBe('NOT_IMPLEMENTED');
      expect(of(wordpress.id)?.availability).toBe('AVAILABLE');
      expect(of(ytFull.id)?.freshness.state).toBe('NEVER_SYNCED');
    });
  });

  describe('no fake fallback metrics', () => {
    it('with no provider configured, a sync is UNAVAILABLE and stores nothing', async () => {
      const { run: created } = await requestAnalyticsSync(prisma.client, {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        target: 'WORKSPACE',
        idempotencyKey: `no-provider-${runId}`,
      });
      const outcome = await executeAnalyticsSync({ prisma: prisma.client }, { runId: created.id });
      expect(outcome.status).toBe('UNAVAILABLE');
      expect(
        await prisma.client.analyticsSnapshot.count({ where: { organizationId: owner.orgId } }),
      ).toBe(0);

      const summary = await inject().inject({
        method: 'GET',
        url: `${ws()}/summary`,
        headers: { cookie: owner.cookie },
      });
      const body = summary.json() as {
        externalAvailable: boolean;
        content: Array<{ key: string; value: number | null }>;
      };
      expect(body.externalAvailable).toBe(false);
      expect(body.content.every((metric) => metric.value === null)).toBe(true);
      const overview = await inject().inject({
        method: 'GET',
        url: `${ws()}/overview`,
        headers: { cookie: owner.cookie },
      });
      expect(
        (overview.json() as { engagement: { externalAvailable: boolean } }).engagement
          .externalAvailable,
      ).toBe(false);
    });

    it('the database itself refuses a missing metric without a reason, and a value with one', async () => {
      const snapshot = await prisma.client.analyticsSnapshot.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          platform: 'YOUTUBE',
          providerId: 'test',
          level: 'CONTENT',
          completeness: 'UNAVAILABLE',
          retrievedAt: new Date(),
          staleAfter: new Date(),
          dedupeKey: `check-${runId}`,
        },
      });
      const base = {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        snapshotId: snapshot.id,
        unit: 'COUNT',
      };
      await expect(
        prisma.client.analyticsMetricValue.create({
          data: { ...base, metricKey: 'likes', value: null, completeness: 'UNAVAILABLE' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.client.analyticsMetricValue.create({
          data: {
            ...base,
            metricKey: 'views',
            value: 0,
            completeness: 'EXACT',
            unavailableReason: 'NOT_REPORTED',
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.client.analyticsMetricValue.create({
          data: { ...base, metricKey: 'shares', value: 0, completeness: 'UNAVAILABLE' },
        }),
      ).rejects.toThrow();
      await prisma.client.analyticsSnapshot.deleteMany({
        where: { organizationId: owner.orgId, id: snapshot.id },
      });
    });
  });

  describe('manual sync', () => {
    it('happy path: POST sync for one published YouTube video, executed, stored with sources and freshness', async () => {
      const res = await post(owner, {
        target: 'SCHEDULE_ENTRY',
        scheduleEntryId: ytFullEntry.entry.id,
      });
      expect(res.statusCode).toBe(202);
      const accepted = res.json() as { created: boolean; run: RunBody };
      expect(accepted.created).toBe(true);
      expect(accepted.run.status).toBe('QUEUED');

      const outcome = await executeAnalyticsSync(deps(), { runId: accepted.run.id });
      expect(outcome.status).toBe('SUCCEEDED');
      const body = await run(owner, accepted.run.id);
      expect(body.counts).toEqual({ succeeded: 1, partial: 0, failed: 0, unavailable: 0 });
      expect(body.results[0]).toMatchObject({
        level: 'CONTENT',
        platform: 'YOUTUBE',
        outcome: 'SUCCEEDED',
      });

      const detail = await inject().inject({
        method: 'GET',
        url: `${ws()}/content/${ytFullEntry.item.id}`,
        headers: { cookie: owner.cookie },
      });
      expect(detail.statusCode).toBe(200);
      const content = detail.json() as {
        entries: Array<{
          latest: {
            metrics: Array<{
              key: string;
              value: number | null;
              sourceMetricName: string | null;
              unavailableReason: string | null;
            }>;
            freshness: { state: string };
          } | null;
        }>;
      };
      const latest = content.entries[0]?.latest;
      const metric = (key: string) => latest?.metrics.find((m) => m.key === key);
      expect(metric('views')).toMatchObject({
        value: 4200,
        sourceMetricName: 'statistics.viewCount',
      });
      expect(metric('comments')).toMatchObject({ value: 0, unavailableReason: null });
      expect(metric('watchTimeMinutes')?.value).toBe(1250);
      expect(metric('impressions')).toMatchObject({
        value: null,
        unavailableReason: 'NOT_IMPLEMENTED',
      });
      expect(latest?.freshness.state).toBe('FRESH');

      // No token, anywhere it was stored.
      const snapshots = await prisma.client.analyticsSnapshot.findMany({
        where: { organizationId: owner.orgId },
        include: { metrics: true },
      });
      expect(JSON.stringify(snapshots)).not.toContain(LEAK);
      const runRow = await prisma.client.analyticsSyncRun.findFirstOrThrow({
        where: { organizationId: owner.orgId, id: accepted.run.id },
      });
      expect(JSON.stringify(runRow)).not.toContain(LEAK);
    });

    it('partial success: the workspace sync reads what each platform gives and says what it could not', async () => {
      const { run: created } = await requestAnalyticsSync(prisma.client, {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        target: 'WORKSPACE',
      });
      const outcome = await executeAnalyticsSync(deps(), { runId: created.id });
      expect(outcome.status).toBe('PARTIAL');
      const body = await run(owner, created.id);
      const outcomeOf = (platform: string, level: string) =>
        body.results
          .filter((r) => r.platform === platform && r.level === level)
          .map((r) => r.outcome);

      expect(outcomeOf('WORDPRESS', 'CONTENT')).toEqual(['SUCCEEDED']);
      expect(outcomeOf('LINKEDIN', 'CONTENT')).toEqual(['SUCCEEDED']);
      expect(outcomeOf('LINKEDIN', 'ACCOUNT')).toEqual(['SUCCEEDED']);
      // Default YouTube scopes: counts come back, watch time does not.
      expect(outcomeOf('YOUTUBE', 'CONTENT')).toContain('PARTIAL');
      // Without read_insights no Facebook post metric is readable — the post is
      // UNAVAILABLE, with the scope named — while Page followers still came back.
      expect(outcomeOf('FACEBOOK', 'ACCOUNT')).toEqual(['SUCCEEDED']);
      expect(outcomeOf('FACEBOOK', 'CONTENT')).toEqual(['UNAVAILABLE']);
      expect(
        body.results.find((r) => r.platform === 'FACEBOOK' && r.level === 'CONTENT')?.message,
      ).toContain('read_insights');
      // TikTok has no analytics adapter: unavailable, with the reason, nothing stored.
      const tiktokResult = body.results.find(
        (r) => r.platform === 'TIKTOK' && r.level === 'CONTENT',
      );
      expect(tiktokResult).toMatchObject({ outcome: 'UNAVAILABLE', errorCode: 'UNSUPPORTED' });
      expect(tiktokResult?.message).toContain('Not implemented');
      expect(
        await prisma.client.analyticsSnapshot.count({
          where: { organizationId: owner.orgId, platform: 'TIKTOK' },
        }),
      ).toBe(0);

      // The Facebook post's insights are MISSING_SCOPE — never requested.
      const fbInsightsCalls = mock.calls.filter((call) => call.endsWith('/insights'));
      expect(fbInsightsCalls).toEqual([]);
      const fbViews = await prisma.client.analyticsMetricValue.findFirst({
        where: {
          organizationId: owner.orgId,
          metricKey: 'views',
          snapshot: { platform: 'FACEBOOK', level: 'CONTENT' },
        },
      });
      expect(fbViews).toMatchObject({ value: null, unavailableReason: 'MISSING_SCOPE' });
    });

    it('platform unsupported: a TikTok entry sync is UNAVAILABLE; an unpublished entry has nothing to read', async () => {
      const { run: created } = await requestAnalyticsSync(prisma.client, {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        target: 'SCHEDULE_ENTRY',
        scheduleEntryId: tiktokEntry.entry.id,
      });
      expect((await executeAnalyticsSync(deps(), { runId: created.id })).status).toBe(
        'UNAVAILABLE',
      );

      const draft = await publishedEntry(owner, ytFull, 'vid_never', { status: 'SCHEDULED' });
      const { run: unpublished } = await requestAnalyticsSync(prisma.client, {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        target: 'SCHEDULE_ENTRY',
        scheduleEntryId: draft.entry.id,
      });
      expect((await executeAnalyticsSync(deps(), { runId: unpublished.id })).status).toBe(
        'UNAVAILABLE',
      );
      const body = await run(owner, unpublished.id);
      expect(body.error?.code).toBe('VALIDATION');
      expect(body.error?.message).toContain('not been published');
    });
  });

  describe('failures', () => {
    it('rate limit: the run waits for a backoff retry, then succeeds; with no attempts left it fails', async () => {
      mock.youtubeRateLimited = true;
      const { run: created } = await requestAnalyticsSync(prisma.client, {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        target: 'SCHEDULE_ENTRY',
        scheduleEntryId: ytFullEntry.entry.id,
        maxAttempts: 2,
      });
      const first = await executeAnalyticsSync(deps(), { runId: created.id });
      expect(first.status).toBe('QUEUED');
      expect(first.nextAttemptAt).not.toBeNull();
      let body = await run(owner, created.id);
      expect(body.error?.code).toBe('RATE_LIMITED');
      expect(body.rateLimit?.limited).toBe(true);
      expect(body.rateLimit?.nextAttemptAt).toBe(first.nextAttemptAt?.toISOString());

      // Before the backoff elapses, a redelivered job does nothing.
      expect((await executeAnalyticsSync(deps(), { runId: created.id })).status).toBe('SKIPPED');

      // After it, a second attempt — still limited, and the last one allowed.
      const later = () => new Date((first.nextAttemptAt as Date).getTime() + 1000);
      const second = await executeAnalyticsSync(deps({ now: later }), { runId: created.id });
      expect(second.status).toBe('FAILED');
      body = await run(owner, created.id);
      expect(body.attempt).toBe(2);
      expect(body.rateLimit?.nextAttemptAt).toBeNull();

      // A fresh run once the limit lifts succeeds.
      mock.youtubeRateLimited = false;
      const { run: retry } = await requestAnalyticsSync(prisma.client, {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        target: 'SCHEDULE_ENTRY',
        scheduleEntryId: ytFullEntry.entry.id,
      });
      expect((await executeAnalyticsSync(deps(), { runId: retry.id })).status).toBe('SUCCEEDED');
    });

    it('expired or rejected tokens: nothing is read, and the connection is marked for reconnect', async () => {
      // A token expired with no refresh token.
      const expiredConnection = await connection(owner, 'YOUTUBE', [YT_READ], {
        expiresAt: new Date(Date.now() - 60_000),
      });
      const expiredAccount = await account(owner, {
        platform: 'YOUTUBE',
        kind: 'CHANNEL',
        externalAccountId: CHANNEL,
        connectionId: expiredConnection.id,
      });
      const { run: expiredRun } = await requestAnalyticsSync(prisma.client, {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        target: 'SOCIAL_ACCOUNT',
        socialAccountId: expiredAccount.id,
      });
      const before = mock.calls.length;
      expect((await executeAnalyticsSync(deps(), { runId: expiredRun.id })).status).toBe(
        'UNAVAILABLE',
      );
      expect(mock.calls.length).toBe(before);
      const expiredBody = await run(owner, expiredRun.id);
      expect(expiredBody.results[0]).toMatchObject({
        outcome: 'UNAVAILABLE',
        errorCode: 'REAUTH_REQUIRED',
      });
      expect(expiredBody.results[0]?.message).toContain('No analytics were fetched');

      // A token the platform rejects.
      mock.youtubeAuthFails = true;
      try {
        const rejected = await connection(owner, 'YOUTUBE', [YT_READ]);
        const rejectedAccount = await account(owner, {
          platform: 'YOUTUBE',
          kind: 'CHANNEL',
          externalAccountId: CHANNEL,
          connectionId: rejected.id,
        });
        const { run: rejectedRun } = await requestAnalyticsSync(prisma.client, {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          target: 'SOCIAL_ACCOUNT',
          socialAccountId: rejectedAccount.id,
        });
        expect((await executeAnalyticsSync(deps(), { runId: rejectedRun.id })).status).toBe(
          'FAILED',
        );
        const row = await prisma.client.socialConnection.findFirstOrThrow({
          where: { organizationId: owner.orgId, id: rejected.id },
        });
        expect(row.status).toBe('REAUTH_REQUIRED');
        const body = await run(owner, rejectedRun.id);
        expect(body.error?.code).toBe('REAUTH_REQUIRED');
      } finally {
        mock.youtubeAuthFails = false;
      }
    });

    it('budget pre-flight: an ANALYTICS_SYNC limit of zero stops the run before any platform call', async () => {
      await prisma.client.budgetOperationLimit.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          kind: 'ANALYTICS_SYNC',
          maxRequests: 0,
        },
      });
      try {
        const { run: created } = await requestAnalyticsSync(prisma.client, {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          target: 'SCHEDULE_ENTRY',
          scheduleEntryId: wpEntry.entry.id,
        });
        const before = mock.calls.length;
        expect((await executeAnalyticsSync(deps(), { runId: created.id })).status).toBe('FAILED');
        expect(mock.calls.length).toBe(before);
        expect((await run(owner, created.id)).error?.code).toBe('BUDGET');
      } finally {
        await prisma.client.budgetOperationLimit.deleteMany({
          where: { organizationId: owner.orgId, kind: 'ANALYTICS_SYNC' },
        });
      }
    });
  });

  describe('idempotency', () => {
    it('the same Idempotency-Key, or a second request while one is active, returns the same run; a redelivery is a no-op', async () => {
      const key = `sync-${runId}-abc`;
      const first = await post(
        owner,
        { target: 'SOCIAL_ACCOUNT', socialAccountId: wordpress.id },
        { 'idempotency-key': key },
      );
      const again = await post(
        owner,
        { target: 'SOCIAL_ACCOUNT', socialAccountId: wordpress.id },
        { 'idempotency-key': key },
      );
      const noKey = await post(owner, { target: 'SOCIAL_ACCOUNT', socialAccountId: wordpress.id });
      const firstRun = first.json() as { run: RunBody; created: boolean };
      expect(firstRun.created).toBe(true);
      expect(again.json() as { run: RunBody; created: boolean }).toMatchObject({
        created: false,
        run: { id: firstRun.run.id },
      });
      expect((noKey.json() as { run: RunBody }).run.id).toBe(firstRun.run.id);

      expect((await executeAnalyticsSync(deps(), { runId: firstRun.run.id })).status).toBe(
        'SUCCEEDED',
      );
      expect((await executeAnalyticsSync(deps(), { runId: firstRun.run.id })).status).toBe(
        'SKIPPED',
      );
      expect(
        await prisma.client.analyticsSnapshot.count({
          where: { organizationId: owner.orgId, syncRunId: firstRun.run.id },
        }),
      ).toBe(1);

      const invalid = await post(owner, { target: 'WORKSPACE' }, { 'idempotency-key': 'bad key!' });
      expect(invalid.statusCode).toBe(422);
    });

    it('a crashed attempt is re-run and rewrites its own snapshot instead of adding another', async () => {
      const { run: created } = await requestAnalyticsSync(prisma.client, {
        organizationId: owner.orgId,
        workspaceId: owner.workspaceId,
        target: 'SCHEDULE_ENTRY',
        scheduleEntryId: wpEntry.entry.id,
      });
      await executeAnalyticsSync(deps(), { runId: created.id });
      // Simulate a worker that died mid-run long ago: RUNNING with an old lease.
      await prisma.client.analyticsSyncRun.updateMany({
        where: { organizationId: owner.orgId, id: created.id },
        data: { status: 'RUNNING', startedAt: new Date(Date.now() - 60 * 60_000) },
      });
      mock.wordpressComments.set('42', 9);
      expect((await executeAnalyticsSync(deps(), { runId: created.id })).status).toBe('SUCCEEDED');
      const rows = await prisma.client.analyticsSnapshot.findMany({
        where: { organizationId: owner.orgId, syncRunId: created.id },
        include: { metrics: true },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.metrics.find((m) => m.metricKey === 'comments')?.value).toBe(9);
    });
  });

  describe('dashboards', () => {
    it('workspace summary sums only what was reported, with counts and freshness', async () => {
      const res = await inject().inject({
        method: 'GET',
        url: `${ws()}/summary`,
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        source: string;
        externalAvailable: boolean;
        publishedPosts: number;
        postsWithoutAnalytics: number;
        content: Array<{
          key: string;
          value: number | null;
          contributing: number;
          unavailable: number;
          unavailableReason: string | null;
        }>;
        followers: { value: number | null; completeness: string };
        byPlatform: Array<{ platform: string }>;
        freshness: { state: string; retrievedAt: string | null };
        lastRun: RunBody | null;
      };
      expect(body.source).toBe('EXTERNAL_MEASURED');
      expect(body.externalAvailable).toBe(true);
      const metric = (key: string) => body.content.find((m) => m.key === key);
      // Likes came from YouTube (2 videos) and LinkedIn; WordPress and Facebook reported none.
      expect(metric('likes')?.contributing).toBeGreaterThanOrEqual(3);
      expect(metric('likes')?.unavailable).toBeGreaterThan(0);
      // Nobody reported saves: null with a reason, not 0.
      expect(metric('saves')).toMatchObject({ value: null, contributing: 0 });
      expect(metric('saves')?.unavailableReason).not.toBeNull();
      expect(metric('reach')?.unavailableReason).toBe('NOT_ADDITIVE');
      // YouTube's rounded subscriber count keeps the sum approximate.
      expect(body.followers.value).not.toBeNull();
      expect(body.followers.completeness).toBe('APPROXIMATE');
      expect(body.byPlatform.map((row) => row.platform)).toEqual(
        expect.arrayContaining(['LINKEDIN', 'WORDPRESS', 'YOUTUBE']),
      );
      expect(body.freshness.state).toBe('FRESH');
      expect(body.postsWithoutAnalytics).toBeGreaterThanOrEqual(1); // TikTok
      expect(body.lastRun).not.toBeNull();
    });

    it('campaign analytics are a labelled sum over the campaign’s posts', async () => {
      const res = await inject().inject({
        method: 'GET',
        url: `${ws()}/campaigns/${campaignId}`,
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        analytics: {
          aggregation: string;
          publishedPosts: number;
          postsWithAnalytics: number;
          metrics: Array<{ key: string; value: number | null }>;
        };
        posts: Array<{ snapshot: unknown }>;
      };
      expect(body.analytics.aggregation).toBe('SUM_OF_POST_SNAPSHOTS');
      expect(body.analytics.publishedPosts).toBe(2);
      expect(body.analytics.postsWithAnalytics).toBe(2);
      expect(body.analytics.metrics.find((m) => m.key === 'views')?.value).toBe(4200 + 1000);
      expect(body.posts).toHaveLength(2);
    });

    it('lists unavailable metrics with reasons, freshness, and provider errors', async () => {
      const unavailable = await inject().inject({
        method: 'GET',
        url: `${ws()}/unavailable-metrics`,
        headers: { cookie: owner.cookie },
      });
      const { metrics } = unavailable.json() as {
        metrics: Array<{ platform: string; metric: string; reason: string; detail: string | null }>;
      };
      expect(metrics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            platform: 'YOUTUBE',
            metric: 'watchTimeMinutes',
            reason: 'MISSING_SCOPE',
          }),
          expect.objectContaining({
            platform: 'WORDPRESS',
            metric: 'views',
            reason: 'NOT_EXPOSED_BY_PLATFORM',
          }),
          expect.objectContaining({
            platform: 'FACEBOOK',
            metric: 'impressions',
            reason: 'DEPRECATED_BY_PLATFORM',
          }),
        ]),
      );

      const freshness = await inject().inject({
        method: 'GET',
        url: `${ws()}/freshness`,
        headers: { cookie: owner.cookie },
      });
      const fresh = freshness.json() as {
        counts: { fresh: number; stale: number };
        items: Array<{ freshness: { state: string } }>;
      };
      expect(fresh.counts.fresh).toBeGreaterThan(0);
      expect(fresh.items.every((item) => ['FRESH', 'STALE'].includes(item.freshness.state))).toBe(
        true,
      );

      const status = await inject().inject({
        method: 'GET',
        url: `${ws()}/provider-status`,
        headers: { cookie: owner.cookie },
      });
      const providers = status.json() as {
        providers: Array<{ platform: string; lastErrorCode: string }>;
        rateLimits: unknown[];
      };
      expect(providers.providers.map((p) => p.platform)).toEqual(
        expect.arrayContaining(['TIKTOK', 'YOUTUBE']),
      );
      expect(providers.rateLimits.length).toBeGreaterThan(0);
    });
  });

  describe('trend scoring', () => {
    it('real analytics join the score as EXTERNAL_MEASURED; a topic without them keeps its research score exactly', async () => {
      const scope = { organizationId: owner.orgId, workspaceId: owner.workspaceId };
      const measured = await measuredEngagementForTopic(prisma.client, scope, `roasting-${runId}`);
      expect(measured.available).toBe(true);
      if (measured.available) {
        expect(measured.source).toBe('EXTERNAL_MEASURED');
        // Only the YouTube video reported a denominator; the WordPress post (comments only) did not.
        expect(measured.sampleSize).toBe(1);
        expect(measured.rate).toBeCloseTo((210 + 0 + 17) / 4200);
      }
      const missing = await measuredEngagementForTopic(prisma.client, scope, `no-posts-${runId}`);
      expect(missing.available).toBe(false);

      const engine = new WeightedTrendScoringEngine(DEFAULT_TREND_SCORING_CONFIG);
      const research = {
        trendCandidateId: randomUUID(),
        components: { freshness: 0.7, velocity: 0.5, sourceDiversity: 0.6, sourceCredibility: 0.8 },
        sourceCount: 3,
      };
      const baseline = engine.score(research);
      expect(engine.score(withMeasuredEngagement(research, missing)).normalizedScore).toBe(
        baseline.normalizedScore,
      );
      const withReal = engine.score(withMeasuredEngagement(research, measured));
      expect(withReal.components.find((c) => c.key === 'measuredEngagement')?.source).toBe(
        'EXTERNAL_MEASURED',
      );
    });
  });

  describe('scheduling', () => {
    it('creates one scheduled workspace run per interval, and picks up retries that are due', async () => {
      const now = new Date();
      const ids = await claimDueAnalyticsSyncs(prisma.client, now, {
        scheduled: true,
        intervalMs: 24 * 60 * 60_000,
        platforms: ['WORDPRESS'],
      });
      const scheduled = await prisma.client.analyticsSyncRun.findMany({
        where: { organizationId: owner.orgId, trigger: 'SCHEDULED' },
      });
      expect(scheduled).toHaveLength(1);
      expect(ids).toContain(scheduled[0]?.id);
      await claimDueAnalyticsSyncs(prisma.client, now, {
        scheduled: true,
        intervalMs: 24 * 60 * 60_000,
        platforms: ['WORDPRESS'],
      });
      expect(
        await prisma.client.analyticsSyncRun.count({
          where: { organizationId: owner.orgId, trigger: 'SCHEDULED' },
        }),
      ).toBe(1);
      // The other tenant has no accounts, so no run was made for it.
      expect(
        await prisma.client.analyticsSyncRun.count({ where: { organizationId: other.orgId } }),
      ).toBe(0);
      await executeAnalyticsSync(deps(), { runId: scheduled[0]?.id as string });
    });
  });

  describe('tenant isolation and permissions', () => {
    it('a foreign run, account, entry, campaign or content item is the same 404 as a missing one', async () => {
      const ownerRun = (
        await prisma.client.analyticsSyncRun.findFirstOrThrow({
          where: { organizationId: owner.orgId },
        })
      ).id;
      const foreign = await inject().inject({
        method: 'GET',
        url: `${ws(other)}/sync-runs/${ownerRun}`,
        headers: { cookie: other.cookie },
      });
      const missing = await inject().inject({
        method: 'GET',
        url: `${ws(other)}/sync-runs/${randomUUID()}`,
        headers: { cookie: other.cookie },
      });
      expect(foreign.statusCode).toBe(404);
      expect(missing.statusCode).toBe(404);
      expect(problemText(foreign.json())).toBe(problemText(missing.json()));

      expect(
        (await post(other, { target: 'SOCIAL_ACCOUNT', socialAccountId: ytFull.id })).statusCode,
      ).toBe(404);
      expect(
        (await post(other, { target: 'SCHEDULE_ENTRY', scheduleEntryId: ytFullEntry.entry.id }))
          .statusCode,
      ).toBe(404);
      for (const url of [
        `${ws(other)}/campaigns/${campaignId}`,
        `${ws(other)}/content/${ytFullEntry.item.id}`,
      ]) {
        expect(
          (await inject().inject({ method: 'GET', url, headers: { cookie: other.cookie } }))
            .statusCode,
        ).toBe(404);
      }
      // Reaching the owner's workspace path as a non-member is refused outright.
      expect(
        (
          await inject().inject({
            method: 'GET',
            url: `${ws(owner)}/summary`,
            headers: { cookie: other.cookie },
          })
        ).statusCode,
      ).toBe(404);

      const summary = await inject().inject({
        method: 'GET',
        url: `${ws(other)}/summary`,
        headers: { cookie: other.cookie },
      });
      expect(summary.json()).toMatchObject({ externalAvailable: false, postsWithSnapshots: 0 });
      const runs = await inject().inject({
        method: 'GET',
        url: `${ws(other)}/sync-runs`,
        headers: { cookie: other.cookie },
      });
      expect(runs.json()).toEqual([]);
    });

    it('analytics:read reads, analytics:sync syncs — and neither is assumed', async () => {
      await prisma.client.membership.create({
        data: {
          organizationId: owner.orgId,
          userId: other.userId,
          role: 'READ_ONLY',
          status: 'ACTIVE',
        },
      });
      try {
        const read = await inject().inject({
          method: 'GET',
          url: `${ws(owner)}/summary`,
          headers: { cookie: other.cookie },
        });
        expect(read.statusCode).toBe(200);
        const denied = await post({ ...owner, cookie: other.cookie }, { target: 'WORKSPACE' });
        expect(denied.statusCode).toBe(403);
        expect(problemText(denied.json())).toContain('analytics:sync');

        await prisma.client.membership.updateMany({
          where: { organizationId: owner.orgId, userId: other.userId },
          data: { role: 'CLIENT_REVIEWER' },
        });
        for (const path of [
          'summary',
          'providers',
          'availability',
          'sync-runs',
          'freshness',
          'unavailable-metrics',
          'provider-status',
        ]) {
          const res = await inject().inject({
            method: 'GET',
            url: `${ws(owner)}/${path}`,
            headers: { cookie: other.cookie },
          });
          expect(res.statusCode, path).toBe(403);
        }

        await prisma.client.membership.updateMany({
          where: { organizationId: owner.orgId, userId: other.userId },
          data: { role: 'ANALYST' },
        });
        const allowed = await post({ ...owner, cookie: other.cookie }, { target: 'WORKSPACE' });
        expect(allowed.statusCode).toBe(202);
      } finally {
        await prisma.client.membership.deleteMany({
          where: { organizationId: owner.orgId, userId: other.userId },
        });
      }
    });
  });
});
