import './setup-env';

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createMediaLoader,
  createMediaUrlSigner,
  createPublisherResolver,
  executePublication,
} from '@spectra/publishing';
import { generateEncryptionKey } from '@spectra/security';
import { resolveOAuthPlatform } from '@spectra/social-oauth';
import { S3ObjectStorageProvider, buildObjectKey } from '@spectra/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv, resetApiEnvCache } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 6G: TikTok, X, Threads and Pinterest (ADR-0038), end to end.
 *
 * One HTTP server on 127.0.0.1 stands in for all four platforms, behaving as
 * each documents: TikTok's creator-info-then-init-then-chunks-then-status flow,
 * Threads' container and publish, X's chunked media upload and post, and
 * Pinterest's paged boards and pin creation. It enforces what they enforce —
 * bearer tokens, per-scope refusals, a creator's own privacy options, an
 * unenrolled X app — so the honest states are exercised, not asserted in the
 * abstract. Every token contains TOKENVALUE, so a leak is one string search.
 */

const runId = randomBytes(4).toString('hex');
const PASSWORD = 'integration-test-password-1';
const KEY = generateEncryptionKey();
const RING = { keys: { 'social-v1': KEY }, activeKeyId: 'social-v1' };
const LEAK = 'TOKENVALUE';

const APPS = {
  TIKTOK: { id: 'tiktok-client-key', secret: `tiktok-secret-${runId}` },
  THREADS: { id: 'threads-app-id', secret: `threads-secret-${runId}` },
  X: { id: 'x-client-id', secret: `x-secret-${runId}` },
  PINTEREST: { id: 'pinterest-app-id', secret: `pinterest-secret-${runId}` },
} as const;

const TIKTOK_OPEN_ID = 'open-id-acme';
const THREADS_USER = '17841400000000009';
const X_USER = '1200300040005000';
const BOARDS = ['board-roasts', 'board-brewing'];

const TIKTOK_SCOPES = 'user.info.basic,video.publish';
const THREADS_SCOPES = 'threads_basic,threads_content_publish';
const X_SCOPES = 'tweet.read tweet.write users.read media.write offline.access';
const PINTEREST_SCOPES = 'user_accounts:read,boards:read,pins:read,pins:write';

const VIDEO = Buffer.alloc(1024, 7);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('spectra-integration-jpeg'),
  Buffer.from([0xff, 0xd9]),
]);

interface Mock {
  base: string;
  server: Server;
  /** code -> the scopes that code will be exchanged for. */
  codes: Map<string, { platform: string; scopes: string; redirectUri: string }>;
  tokens: Map<string, { platform: string; scopes: string }>;
  refreshTokens: Map<string, { platform: string; scopes: string }>;
  calls: Array<{ method: string; path: string }>;
  /** TikTok */
  privacyOptions: string[];
  tiktokStatus: string;
  uploads: number;
  /** X */
  xRefuse: { status: number; body: unknown } | null;
  /** Threads */
  containers: number;
  /** Pinterest */
  pins: Array<Record<string, unknown>>;
  refreshes: number;
  counter: number;
}

type Send = (status: number, body?: unknown) => void;

function issue(mock: Mock, platform: string, scopes: string, kind: 'access' | 'refresh'): string {
  mock.counter += 1;
  const token = `${platform.toLowerCase()}-${kind}-${LEAK}-${mock.counter}`;
  (kind === 'access' ? mock.tokens : mock.refreshTokens).set(token, { platform, scopes });
  return token;
}

function bearer(req: IncomingMessage): string {
  return String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
}

/** Every platform's token endpoint, told apart by path. */
function tokenEndpoint(mock: Mock, path: string, params: URLSearchParams, send: Send): void {
  const platform = path.includes('tiktok')
    ? 'TIKTOK'
    : path.includes('threads')
      ? 'THREADS'
      : path.includes('pinterest')
        ? 'PINTEREST'
        : 'X';
  const grant = params.get('grant_type');
  if (grant === 'refresh_token') {
    const existing = mock.refreshTokens.get(params.get('refresh_token') ?? '');
    if (!existing) return send(400, { error: 'invalid_grant' });
    mock.refreshes += 1;
    return send(200, {
      access_token: issue(mock, platform, existing.scopes, 'access'),
      refresh_token: issue(mock, platform, existing.scopes, 'refresh'),
      expires_in: 7200,
      scope: existing.scopes,
      token_type: 'Bearer',
      ...(platform === 'TIKTOK' ? { open_id: TIKTOK_OPEN_ID, refresh_expires_in: 31_536_000 } : {}),
    });
  }
  const code = params.get('code') ?? '';
  const issued = mock.codes.get(code);
  mock.codes.delete(code); // single use
  if (!issued) return send(400, { error: 'invalid_grant' });
  return send(200, {
    access_token: issue(mock, platform, issued.scopes, 'access'),
    refresh_token: issue(mock, platform, issued.scopes, 'refresh'),
    expires_in: platform === 'TIKTOK' ? 86_400 : 7200,
    scope: issued.scopes,
    token_type: 'Bearer',
    ...(platform === 'TIKTOK' ? { open_id: TIKTOK_OPEN_ID, refresh_expires_in: 31_536_000 } : {}),
    ...(platform === 'THREADS' ? { user_id: THREADS_USER } : {}),
  });
}

async function handle(mock: Mock, req: IncomingMessage, raw: Buffer, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://mock.local');
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const send: Send = (status, body) => {
    res.writeHead(status, body !== undefined ? { 'content-type': 'application/json' } : {});
    res.end(body !== undefined ? JSON.stringify(body) : undefined);
  };
  mock.calls.push({ method, path });

  const params = new URLSearchParams(url.search);
  const type = String(req.headers['content-type'] ?? '');
  if (type.startsWith('application/x-www-form-urlencoded')) {
    for (const [key, value] of new URLSearchParams(raw.toString())) params.set(key, value);
  }
  const json = () => {
    try {
      return JSON.parse(raw.toString() || '{}') as Record<string, unknown>;
    } catch {
      return {};
    }
  };

  if (path.startsWith('/token/')) return tokenEndpoint(mock, path, params, send);

  // TikTok's upload URL carries its own authorization, so no token here.
  if (path.startsWith('/tiktok-upload/')) {
    mock.uploads += 1;
    return send(201);
  }

  const token = mock.tokens.get(bearer(req)) ?? mock.tokens.get(params.get('access_token') ?? '');
  if (!token) return send(401, { error: { code: 'access_token_invalid', message: 'no token' } });
  const scopes = token.scopes.split(/[,\s]+/);

  // ---- TikTok ----
  if (path === '/v2/post/publish/creator_info/query/') {
    if (!scopes.includes('video.publish')) {
      return send(200, { error: { code: 'scope_not_authorized', message: 'video.publish' } });
    }
    return send(200, {
      data: {
        creator_username: 'acmecoffee',
        creator_nickname: 'Acme Coffee',
        privacy_level_options: mock.privacyOptions,
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: false,
        max_video_post_duration_sec: 600,
      },
      error: { code: 'ok', message: '' },
    });
  }
  if (path === '/v2/post/publish/video/init/') {
    const body = json() as { post_info?: { privacy_level?: string } };
    if (!mock.privacyOptions.includes(String(body.post_info?.privacy_level))) {
      return send(200, {
        error: { code: 'privacy_level_option_mismatch', message: 'not allowed' },
      });
    }
    mock.counter += 1;
    return send(200, {
      data: { publish_id: `publish-${mock.counter}`, upload_url: `${mock.base}/tiktok-upload/1` },
      error: { code: 'ok', message: '' },
    });
  }
  if (path === '/v2/post/publish/status/fetch/') {
    return send(200, {
      data: {
        status: mock.tiktokStatus,
        ...(mock.tiktokStatus === 'PUBLISH_COMPLETE'
          ? { publicaly_available_post_id: ['7411111111111111111'] }
          : {}),
        ...(mock.tiktokStatus === 'FAILED' ? { fail_reason: 'duration_check_failed' } : {}),
      },
      error: { code: 'ok', message: '' },
    });
  }

  // ---- Threads ----
  if (path === '/v1.0/me') {
    return send(200, { id: THREADS_USER, username: 'acmecoffee', name: 'Acme Coffee' });
  }
  if (path === `/v1.0/${THREADS_USER}/threads`) {
    if (!scopes.includes('threads_content_publish')) {
      return send(403, { error: { message: 'no permission', code: 10 } });
    }
    mock.containers += 1;
    return send(200, { id: `container-${mock.containers}` });
  }
  if (path === `/v1.0/${THREADS_USER}/threads_publish`) {
    return send(200, { id: '7799999999999999999' });
  }

  // ---- X ----
  if (path === '/2/users/me') {
    return send(200, { data: { id: X_USER, username: 'acmecoffee', name: 'Acme' } });
  }
  if (path === '/2/media/upload/initialize') return send(200, { data: { id: 'media-1' } });
  if (path.startsWith('/2/media/upload/') && path.endsWith('/append')) {
    return send(200, { data: { id: 'media-1' } });
  }
  if (path.startsWith('/2/media/upload/') && path.endsWith('/finalize')) {
    return send(200, { data: { id: 'media-1', processing_info: { state: 'in_progress' } } });
  }
  if (path === '/2/media/upload') {
    return send(200, { data: { id: 'media-1', processing_info: { state: 'succeeded' } } });
  }
  if (path === '/2/tweets') {
    if (mock.xRefuse) return send(mock.xRefuse.status, mock.xRefuse.body);
    if (!scopes.includes('tweet.write')) {
      return send(403, { title: 'Forbidden', detail: 'no write scope' });
    }
    return send(201, { data: { id: '1899111111111111111', text: 'ok' } });
  }

  // ---- Pinterest ----
  if (path === '/v5/user_account') {
    return send(200, { username: 'acmecoffee', account_type: 'BUSINESS' });
  }
  if (path === '/v5/boards') {
    if (!scopes.includes('boards:read')) return send(403, { message: 'no boards scope' });
    const after = params.get('bookmark');
    const index = after ? Number(after) : 0;
    const board = BOARDS[index];
    return send(200, {
      items: board ? [{ id: board, name: `Board ${index}`, privacy: 'PUBLIC', pin_count: 3 }] : [],
      bookmark: index + 1 < BOARDS.length ? String(index + 1) : null,
    });
  }
  if (path === '/v5/pins') {
    if (!scopes.includes('pins:write')) return send(403, { message: 'no pins scope' });
    const body = json();
    mock.pins.push(body);
    return send(201, { id: `pin-${mock.pins.length}` });
  }
  return send(404, { error: { message: `no route ${path}`, code: 803 } });
}

async function startMock(): Promise<Mock> {
  const mock: Mock = {
    base: '',
    server: createServer(),
    codes: new Map(),
    tokens: new Map(),
    refreshTokens: new Map(),
    calls: [],
    privacyOptions: ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'],
    tiktokStatus: 'PUBLISH_COMPLETE',
    uploads: 0,
    xRefuse: null,
    containers: 0,
    pins: [],
    refreshes: 0,
    counter: 0,
  };
  mock.server.on('request', (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void handle(mock, req, Buffer.concat(chunks), res).catch(() => {
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
  cookie: string;
  orgId: string;
  workspaceId: string;
}
interface MeBody {
  memberships: Array<{ organizationId: string }>;
  workspaces: Array<{ id: string }>;
}

function problemText(body: unknown): string {
  const problem = body as { title?: string; detail?: string };
  return `${problem.title ?? ''} ${problem.detail ?? ''}`;
}

describe('API integration: TikTok, X, Threads and Pinterest (ADR-0038)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mock: Mock;
  let storage: S3ObjectStorageProvider;
  const tenants: Tenant[] = [];
  const storedKeys: string[] = [];

  let owner: Tenant;
  let other: Tenant;
  let jpegAsset = '';

  const inject = () => app.getHttpAdapter().getInstance();

  async function registerTenant(label: string): Promise<Tenant> {
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: `g6-${label}-${runId}@itest.local`,
        password: PASSWORD,
        name: `Phase6G ${label}`,
      },
    });
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] as string;
    const me = res.json() as MeBody;
    const tenant = {
      cookie,
      orgId: me.memberships[0]?.organizationId as string,
      workspaceId: me.workspaces[0]?.id as string,
    };
    tenants.push(tenant);
    return tenant;
  }

  async function connect(t: Tenant, platform: string, scopes: string) {
    const slug = platform.toLowerCase();
    const started = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${t.workspaceId}/social/oauth/${slug}/start`,
      headers: { cookie: t.cookie },
      payload: {},
    });
    expect(started.statusCode).toBe(201);
    const url = new URL((started.json() as { authorizationUrl: string }).authorizationUrl);
    const code = `code-${randomBytes(6).toString('hex')}`;
    mock.codes.set(code, {
      platform,
      scopes,
      redirectUri: url.searchParams.get('redirect_uri') as string,
    });
    const callback = await inject().inject({
      method: 'GET',
      url: `/v1/social/oauth/${slug}/callback?${new URLSearchParams({
        code,
        state: url.searchParams.get('state') as string,
      }).toString()}`,
      headers: { cookie: t.cookie },
    });
    expect(callback.statusCode).toBe(302);
    const location = new URL(callback.headers.location as string);
    expect(location.searchParams.get('oauth')).toBe('connected');
    return location.searchParams.get('connection') as string;
  }

  async function accountFor(t: Tenant, platform: string, externalAccountId?: string) {
    const row = await prisma.client.socialAccount.findFirst({
      where: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        platform: platform as 'TIKTOK',
        deletedAt: null,
        ...(externalAccountId ? { externalAccountId } : {}),
      },
    });
    if (!row) throw new Error(`no ${platform} account`);
    return row;
  }

  async function storeAsset(t: Tenant, kind: 'VIDEO' | 'IMAGE') {
    const id = randomUUID();
    const key = buildObjectKey({
      organizationId: t.orgId,
      workspaceId: t.workspaceId,
      domain: 'media',
      resourceId: id,
      filename: kind === 'VIDEO' ? 'clip.mp4' : 'photo.jpg',
    });
    const bytes = kind === 'VIDEO' ? VIDEO : JPEG;
    await storage.putObject({
      key,
      body: bytes,
      contentType: kind === 'VIDEO' ? 'video/mp4' : 'image/jpeg',
    });
    storedKeys.push(key);
    await prisma.client.mediaAsset.create({
      data: {
        id,
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        kind,
        storageKey: key,
        mimeType: kind === 'VIDEO' ? 'video/mp4' : 'image/jpeg',
        sizeBytes: bytes.length,
        ...(kind === 'IMAGE' ? { widthPx: 1000, heightPx: 1250 } : {}),
      },
    });
    return id;
  }

  async function approvedItem(t: Tenant) {
    return prisma.client.contentItem.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        title: 'Fresh roast',
        contentType: 'POST',
        lifecycleState: 'APPROVED',
        body: 'Fresh roast Friday',
      },
    });
  }

  async function schedule(
    t: Tenant,
    platform: string,
    socialAccountId: string,
    extra: object = {},
  ) {
    const item = await approvedItem(t);
    return inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${t.workspaceId}/calendar`,
      headers: { cookie: t.cookie },
      payload: {
        contentItemId: item.id,
        platform,
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        socialAccountId,
        ...extra,
      },
    });
  }

  /** Schedules, then flips to QUEUED the way the dispatcher's claim does. */
  async function queued(t: Tenant, platform: string, socialAccountId: string, extra: object = {}) {
    const res = await schedule(t, platform, socialAccountId, extra);
    expect(res.statusCode).toBe(201);
    const entryId = (res.json() as { id: string }).id;
    await prisma.client.contentScheduleEntry.update({
      where: { id: entryId },
      data: { status: 'QUEUED' },
    });
    return entryId;
  }

  const entryRow = (entryId: string) =>
    prisma.client.contentScheduleEntry.findUniqueOrThrow({ where: { id: entryId } });

  /** The worker's exact wiring, against the mock. */
  function publishDeps() {
    const oauth = (platform: 'TIKTOK' | 'THREADS' | 'X' | 'PINTEREST') => {
      const status = resolveOAuthPlatform(getApiEnv(), platform);
      return status.configured ? status.config : null;
    };
    return {
      prisma: prisma.client,
      resolvePublisher: createPublisherResolver({
        prisma: prisma.client,
        ring: RING,
        linkedin: { api: { apiBaseUrl: 'http://127.0.0.1:9', version: '202608' }, oauth: null },
        tiktok: {
          api: {
            apiBaseUrl: mock.base,
            clientAudited: false,
            chunkBytes: 5 * 1024 * 1024,
          },
          oauth: oauth('TIKTOK'),
        },
        threads: {
          api: { apiBaseUrl: mock.base, version: 'v1.0', mediaProblem: null },
          oauth: oauth('THREADS'),
          publishDelayMs: 0,
          sleep: async () => undefined,
        },
        x: { api: { apiBaseUrl: mock.base }, oauth: oauth('X') },
        pinterest: {
          api: { apiBaseUrl: mock.base, version: 'v5', mediaProblem: null },
          oauth: oauth('PINTEREST'),
        },
      }),
      loadMedia: createMediaLoader(storage),
      mediaUrl: createMediaUrlSigner(storage),
    };
  }

  beforeAll(async () => {
    mock = await startMock();
    const oauthEnv: Record<string, string> = {
      SOCIAL_TOKEN_ENCRYPTION_KEY: KEY,
      SOCIAL_OAUTH_REDIRECT_BASE_URL: 'http://localhost:4100',
      TIKTOK_API_BASE_URL: mock.base,
      THREADS_API_BASE_URL: mock.base,
      X_API_BASE_URL: mock.base,
      PINTEREST_API_BASE_URL: mock.base,
    };
    for (const [platform, app_] of Object.entries(APPS)) {
      oauthEnv[`SOCIAL_OAUTH_${platform}_CLIENT_ID`] = app_.id;
      oauthEnv[`SOCIAL_OAUTH_${platform}_CLIENT_SECRET`] = app_.secret;
      oauthEnv[`SOCIAL_OAUTH_${platform}_AUTHORIZATION_URL`] =
        `${mock.base}/dialog/${platform.toLowerCase()}`;
      oauthEnv[`SOCIAL_OAUTH_${platform}_TOKEN_URL`] =
        `${mock.base}/token/${platform.toLowerCase()}`;
    }
    Object.assign(process.env, oauthEnv);
    resetApiEnvCache();
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);
    storage = new S3ObjectStorageProvider(getApiEnv());
    await storage.ensureBucket();
    owner = await registerTenant('owner');
    other = await registerTenant('other');
    jpegAsset = await storeAsset(owner, 'IMAGE');
  });

  afterAll(async () => {
    for (const key of storedKeys) await storage.deleteObject(key).catch(() => undefined);
    for (const tenant of tenants) {
      await prisma.client.organization
        .deleteMany({ where: { id: tenant.orgId } })
        .catch(() => undefined);
    }
    await app?.close();
    await new Promise<void>((resolve) => mock.server.close(() => resolve()));
  });

  describe('platform configuration', () => {
    it('reports all four as configured and wired, each with what it can publish', async () => {
      const res = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${owner.workspaceId}/social/oauth/platforms`,
        headers: { cookie: owner.cookie },
      });
      const body = res.json() as {
        platforms: Array<{
          platform: string;
          configured: boolean;
          canConnect: boolean;
          adapters: { publishing: boolean; discovery: boolean };
          limitation: string;
          approval: { required: boolean; notes: string[] };
        }>;
      };
      for (const platform of ['TIKTOK', 'THREADS', 'X', 'PINTEREST']) {
        const entry = body.platforms.find((p) => p.platform === platform);
        expect(entry?.configured, platform).toBe(true);
        expect(entry?.canConnect, platform).toBe(true);
        expect(entry?.adapters.publishing, platform).toBe(true);
        expect(entry?.adapters.discovery, platform).toBe(true);
        // The summary must say what is NOT implemented, too.
        expect(entry?.limitation, platform).toContain('not implemented');
        expect(entry?.approval.notes.length, platform).toBeGreaterThan(0);
      }
      // The gate each platform puts in front of real use is stated up front.
      const tiktok = body.platforms.find((p) => p.platform === 'TIKTOK');
      expect(tiktok?.approval.notes.join(' ')).toContain('restricted to private viewing mode');
      const threads = body.platforms.find((p) => p.platform === 'THREADS');
      expect(threads?.approval.notes.join(' ')).toContain("app's tester accounts");
      const x = body.platforms.find((p) => p.platform === 'X');
      expect(x?.approval.notes.join(' ')).toContain('pay-per-usage');
      const pinterest = body.platforms.find((p) => p.platform === 'PINTEREST');
      expect(pinterest?.approval.notes.join(' ')).toContain('Trial access');
    });

    it('says exactly what is missing when a platform is not configured, and refuses to start', async () => {
      // EMAIL is not an OAuth platform at all, and never claims to be.
      const platforms = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${owner.workspaceId}/social/platforms`,
        headers: { cookie: owner.cookie },
      });
      const wired = (
        platforms.json() as {
          platforms: Array<{ capability: { platform: string }; publisherWired: boolean }>;
        }
      ).platforms;
      expect(wired.find((p) => p.capability.platform === 'EMAIL')?.publisherWired).toBe(false);

      const start = await inject().inject({
        method: 'POST',
        url: `/v1/workspaces/${owner.workspaceId}/social/oauth/email/start`,
        headers: { cookie: owner.cookie },
        payload: {},
      });
      expect(start.statusCode).toBe(400);
      expect(problemText(start.json())).toContain('Not an OAuth platform');
    });
  });

  describe('TikTok', () => {
    let connectionId = '';

    it('connects, and records the creator with the privacy levels TikTok reported', async () => {
      connectionId = await connect(owner, 'TIKTOK', TIKTOK_SCOPES);
      const connection = await prisma.client.socialConnection.findFirstOrThrow({
        where: { id: connectionId, organizationId: owner.orgId },
      });
      expect(connection.hasRefreshToken).toBe(true);
      expect(connection.externalSubjectId).toBe(TIKTOK_OPEN_ID);
      expect(JSON.stringify(connection)).not.toContain(LEAK);

      const account = await accountFor(owner, 'TIKTOK');
      expect(account.externalAccountId).toBe(TIKTOK_OPEN_ID);
      expect(account.displayName).toBe('Acme Coffee');
      const capabilities = account.capabilities as {
        postTypes: Record<string, { status: string }>;
        notes: string[];
      };
      expect(capabilities.postTypes.VIDEO?.status).toBe('AVAILABLE');
      expect(capabilities.postTypes.TEXT?.status).toBe('NOT_SUPPORTED');
      expect(capabilities.notes.some((n) => n.includes('PUBLIC_TO_EVERYONE'))).toBe(true);
      expect(capabilities.notes.some((n) => n.includes('restricted to private viewing'))).toBe(
        true,
      );
    });

    it('publishes a video, and never uploads the same one twice', async () => {
      const account = await accountFor(owner, 'TIKTOK');
      const asset = await storeAsset(owner, 'VIDEO');
      const entryId = await queued(owner, 'TIKTOK', account.id, {
        mediaAssetId: asset,
        publishMetadata: {
          tiktok: { title: 'Fresh roast Friday', privacyLevel: 'PUBLIC_TO_EVERYONE' },
        },
      });
      const before = mock.uploads;
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');
      const entry = await entryRow(entryId);
      expect(entry.externalPostId).toBe('7411111111111111111');
      expect(entry.externalUrl).toContain('tiktok.com/@acmecoffee/video/');
      expect(mock.uploads).toBe(before + 1);

      const upload = await prisma.client.socialMediaUpload.findFirstOrThrow({
        where: { organizationId: owner.orgId, socialAccountId: account.id, mediaAssetId: asset },
      });
      expect(upload.status).toBe('UPLOADED');
      // The signed upload URL is a secret with no further use.
      expect(upload.encryptedUploadUrl).toBeNull();

      // A second attempt asks TikTok about the recorded publish instead.
      await prisma.client.contentScheduleEntry.update({
        where: { id: entryId },
        data: { status: 'QUEUED' },
      });
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');
      expect(mock.uploads).toBe(before + 1);
    });

    it('refuses a privacy level the creator may not use, quoting the audit rule', async () => {
      const account = await accountFor(owner, 'TIKTOK');
      const asset = await storeAsset(owner, 'VIDEO');
      mock.privacyOptions = ['SELF_ONLY'];
      const entryId = await queued(owner, 'TIKTOK', account.id, {
        mediaAssetId: asset,
        publishMetadata: {
          tiktok: { title: 'Fresh roast', privacyLevel: 'PUBLIC_TO_EVERYONE' },
        },
      });
      const outcome = await executePublication(publishDeps(), { entryId });
      mock.privacyOptions = ['PUBLIC_TO_EVERYONE', 'SELF_ONLY'];
      expect(outcome.status).toBe('FAILED');
      const entry = await entryRow(entryId);
      expect(entry.failureCode).toBe('PERMISSION');
      expect(entry.failureReason).toContain('restricted to private viewing mode');
    });

    it('reports what TikTok said when publishing failed', async () => {
      const account = await accountFor(owner, 'TIKTOK');
      const asset = await storeAsset(owner, 'VIDEO');
      mock.tiktokStatus = 'FAILED';
      const entryId = await queued(owner, 'TIKTOK', account.id, {
        mediaAssetId: asset,
        publishMetadata: { tiktok: { title: 'Fresh roast', privacyLevel: 'SELF_ONLY' } },
      });
      await executePublication(publishDeps(), { entryId });
      mock.tiktokStatus = 'PUBLISH_COMPLETE';
      const entry = await entryRow(entryId);
      expect(entry.status).toBe('FAILED');
      expect(entry.failureReason).toContain('duration_check_failed');
    });

    it('refreshes an expired token before publishing', async () => {
      const account = await accountFor(owner, 'TIKTOK');
      const asset = await storeAsset(owner, 'VIDEO');
      await prisma.client.socialConnection.update({
        where: { id: connectionId },
        data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) },
      });
      const before = mock.refreshes;
      const entryId = await queued(owner, 'TIKTOK', account.id, {
        mediaAssetId: asset,
        publishMetadata: { tiktok: { title: 'Fresh roast', privacyLevel: 'SELF_ONLY' } },
      });
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');
      expect(mock.refreshes).toBe(before + 1);
    });

    it('refuses a video with no TikTok scope, before contacting TikTok', async () => {
      const noPublish = await registerTenant('tiktok-readonly');
      await connect(noPublish, 'TIKTOK', 'user.info.basic');
      const account = await accountFor(noPublish, 'TIKTOK');
      const capabilities = account.capabilities as {
        postTypes: Record<string, { status: string }>;
      };
      expect(capabilities.postTypes.VIDEO?.status).toBe('MISSING_PERMISSION');

      const asset = await storeAsset(noPublish, 'VIDEO');
      const item = await approvedItem(noPublish);
      const entry = await prisma.client.contentScheduleEntry.create({
        data: {
          organizationId: noPublish.orgId,
          workspaceId: noPublish.workspaceId,
          contentItemId: item.id,
          platform: 'TIKTOK',
          scheduledAt: new Date(),
          status: 'QUEUED',
          socialAccountId: account.id,
          mediaAssetId: asset,
          idempotencyKey: randomUUID(),
        },
      });
      const uploads = mock.uploads;
      const outcome = await executePublication(publishDeps(), { entryId: entry.id });
      expect(outcome.status).toBe('FAILED');
      expect((await entryRow(entry.id)).failureCode).toBe('PERMISSION');
      expect(mock.uploads).toBe(uploads);
    });
  });

  describe('Threads', () => {
    it('connects, publishes text through a container, and reuses the container on retry', async () => {
      await connect(owner, 'THREADS', THREADS_SCOPES);
      const account = await accountFor(owner, 'THREADS');
      expect(account.externalAccountId).toBe(THREADS_USER);
      expect(account.displayName).toBe('@acmecoffee');

      const entryId = await queued(owner, 'THREADS', account.id);
      const before = mock.containers;
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');
      const entry = await entryRow(entryId);
      expect(entry.externalPostId).toBe('7799999999999999999');
      expect(entry.externalUrl).toContain('threads.net/@acmecoffee/post/');
      expect(mock.containers).toBe(before + 1);
      // The container id is recorded, which is what stops a double post.
      expect(entry.externalContainerId).toBe(`container-${mock.containers}`);
    });

    it('refuses an image post while storage is not reachable, in its own name', async () => {
      const account = await accountFor(owner, 'THREADS');
      const res = await schedule(owner, 'THREADS', account.id, {
        mediaAssetId: jpegAsset,
        mediaAltText: 'A cup of coffee',
      });
      // Storage here is MinIO on localhost, which Threads could not fetch.
      expect(res.statusCode).toBe(422);
      const reason = problemText(res.json());
      expect(reason).toContain('Threads fetches the image');
      expect(reason).not.toContain('Instagram');
    });

    it('publishes an image where storage IS reachable, from a signed link', async () => {
      const account = await accountFor(owner, 'THREADS');
      const item = await approvedItem(owner);
      // Written straight to the database: the resolver here is configured as a
      // deployment with public storage would be.
      const entry = await prisma.client.contentScheduleEntry.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          contentItemId: item.id,
          platform: 'THREADS',
          scheduledAt: new Date(),
          status: 'QUEUED',
          socialAccountId: account.id,
          mediaAssetId: jpegAsset,
          mediaAltText: 'A cup of coffee',
          idempotencyKey: randomUUID(),
        },
      });
      const before = mock.containers;
      expect((await executePublication(publishDeps(), { entryId: entry.id })).status).toBe(
        'PUBLISHED',
      );
      expect(mock.containers).toBe(before + 1);
    });

    it('refuses a video, which the adapter does not publish', async () => {
      const account = await accountFor(owner, 'THREADS');
      const asset = await storeAsset(owner, 'VIDEO');
      const res = await schedule(owner, 'THREADS', account.id, { mediaAssetId: asset });
      expect(res.statusCode).toBe(422);
      expect(problemText(res.json())).toContain('does not publish them yet');
    });
  });

  describe('X', () => {
    it('connects and posts text', async () => {
      await connect(owner, 'X', X_SCOPES);
      const account = await accountFor(owner, 'X');
      expect(account.externalAccountId).toBe(X_USER);
      const entryId = await queued(owner, 'X', account.id);
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');
      const entry = await entryRow(entryId);
      expect(entry.externalPostId).toBe('1899111111111111111');
      expect(entry.externalUrl).toBe('https://x.com/acmecoffee/status/1899111111111111111');
    });

    it('uploads an image through the chunked endpoints and attaches it', async () => {
      const account = await accountFor(owner, 'X');
      const entryId = await queued(owner, 'X', account.id, { mediaAssetId: jpegAsset });
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');
      const upload = await prisma.client.socialMediaUpload.findFirstOrThrow({
        where: {
          organizationId: owner.orgId,
          socialAccountId: account.id,
          mediaAssetId: jpegAsset,
        },
      });
      expect(upload.externalMediaId).toBe('media-1');
      expect(upload.verified).toBe(true);
    });

    it('reports an API-plan refusal as what it is', async () => {
      const account = await accountFor(owner, 'X');
      mock.xRefuse = {
        status: 403,
        body: { title: 'Client Forbidden', detail: 'Your client is not enrolled in a plan' },
      };
      const entryId = await queued(owner, 'X', account.id);
      await executePublication(publishDeps(), { entryId });
      mock.xRefuse = null;
      const entry = await entryRow(entryId);
      expect(entry.status).toBe('FAILED');
      expect(entry.failureCode).toBe('PERMISSION');
      expect(entry.failureReason).toContain('credits or a plan');
    });
  });

  describe('Pinterest', () => {
    it('lists every board as a target, and the account as somewhere you cannot pin', async () => {
      await connect(owner, 'PINTEREST', PINTEREST_SCOPES);
      const boards = await prisma.client.socialAccount.findMany({
        where: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          platform: 'PINTEREST',
          kind: 'CHANNEL',
          deletedAt: null,
        },
      });
      expect(boards.map((b) => b.externalAccountId).sort()).toEqual([...BOARDS].sort());

      const account = await accountFor(owner, 'PINTEREST', 'acmecoffee');
      const capabilities = account.capabilities as {
        postTypes: Record<string, { status: string; reason: string }>;
      };
      expect(capabilities.postTypes.IMAGE?.status).toBe('NOT_SUPPORTED');
      expect(capabilities.postTypes.IMAGE?.reason).toContain('pick a board');
    });

    it('refuses a pin while storage is not reachable, in its own name', async () => {
      const board = await accountFor(owner, 'PINTEREST', BOARDS[0] as string);
      const res = await schedule(owner, 'PINTEREST', board.id, { mediaAssetId: jpegAsset });
      expect(res.statusCode).toBe(422);
      const reason = problemText(res.json());
      expect(reason).toContain('Pinterest fetches the image');
      expect(reason).not.toContain('Instagram');
    });

    it('creates a pin on the chosen board, with the link the entry carried', async () => {
      const board = await accountFor(owner, 'PINTEREST', BOARDS[0] as string);
      const item = await approvedItem(owner);
      const created = await prisma.client.contentScheduleEntry.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          contentItemId: item.id,
          platform: 'PINTEREST',
          scheduledAt: new Date(),
          status: 'QUEUED',
          socialAccountId: board.id,
          mediaAssetId: jpegAsset,
          mediaAltText: 'A cup of coffee',
          publishMetadata: { pinterest: { link: 'https://example.test/roast' } },
          idempotencyKey: randomUUID(),
        },
      });
      expect((await executePublication(publishDeps(), { entryId: created.id })).status).toBe(
        'PUBLISHED',
      );
      const entry = await entryRow(created.id);
      expect(entry.externalUrl).toContain('pinterest.com/pin/');
      const pin = mock.pins.at(-1) as Record<string, unknown>;
      expect(pin.board_id).toBe(BOARDS[0]);
      expect(pin.link).toBe('https://example.test/roast');
      expect(pin.alt_text).toBe('A cup of coffee');
      expect((pin.media_source as { source_type: string }).source_type).toBe('image_url');
    });

    it('refuses a text-only pin at scheduling time', async () => {
      const board = await accountFor(owner, 'PINTEREST', BOARDS[0] as string);
      const res = await schedule(owner, 'PINTEREST', board.id);
      expect(res.statusCode).toBe(422);
      expect(problemText(res.json())).toContain('no text-only pins');
    });
  });

  describe('budget pre-flight', () => {
    it('refuses a publish the workspace budget will not allow, before contacting the platform', async () => {
      const account = await accountFor(owner, 'X');
      // A per-kind ceiling of zero publish attempts this month: the pre-flight
      // seam (ADR-0028) must stop the attempt rather than the adapter.
      await prisma.client.budgetOperationLimit.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          kind: 'PUBLISH_ATTEMPT',
          maxRequests: 0,
        },
      });
      const entryId = await queued(owner, 'X', account.id);
      const before = mock.calls.filter((c) => c.path === '/2/tweets').length;
      const outcome = await executePublication(publishDeps(), { entryId });
      await prisma.client.budgetOperationLimit.deleteMany({
        where: { organizationId: owner.orgId, kind: 'PUBLISH_ATTEMPT' },
      });

      expect(outcome.status).toBe('FAILED');
      const entry = await entryRow(entryId);
      expect(entry.failureCode).toBe('BUDGET');
      expect(entry.failureReason).toBeTruthy();
      // Nothing was sent to X.
      expect(mock.calls.filter((c) => c.path === '/2/tweets').length).toBe(before);
    });
  });

  describe('tenant isolation', () => {
    it('lets no other tenant schedule to these accounts or publish through them', async () => {
      const account = await accountFor(owner, 'X');
      const item = await approvedItem(other);
      const foreign = await inject().inject({
        method: 'POST',
        url: `/v1/workspaces/${other.workspaceId}/calendar`,
        headers: { cookie: other.cookie },
        payload: {
          contentItemId: item.id,
          platform: 'X',
          scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
          socialAccountId: account.id,
        },
      });
      // A foreign account and a missing one are the same answer.
      expect(foreign.statusCode).toBe(404);

      const entry = await prisma.client.contentScheduleEntry.create({
        data: {
          organizationId: other.orgId,
          workspaceId: other.workspaceId,
          contentItemId: item.id,
          platform: 'X',
          scheduledAt: new Date(),
          status: 'QUEUED',
          socialAccountId: account.id,
          idempotencyKey: randomUUID(),
        },
      });
      const outcome = await executePublication(publishDeps(), { entryId: entry.id });
      expect(outcome.status).toBe('UNSUPPORTED');
      expect((await entryRow(entry.id)).failureReason).toContain(
        'does not exist in this workspace',
      );
    });
  });
});
