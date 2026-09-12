import './setup-env';

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createMediaLoader,
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
 * Phase 6F: YouTube video publishing (ADR-0037), end to end.
 *
 * "YouTube" here is a real HTTP server on 127.0.0.1 that behaves like Google
 * documents: an OAuth token endpoint that issues refresh tokens, channels.list,
 * and the resumable upload protocol — a session URI in a Location header,
 * 256 KiB chunks with Content-Range, 308 with what it has so far, and 201 with
 * the video resource. It enforces what Google enforces: bearer tokens with the
 * right scope, per-project quota, and uploads from an unaudited project coming
 * back private. Every token contains TOKENVALUE, so a leak is one string search.
 */

const runId = randomBytes(4).toString('hex');
const PASSWORD = 'integration-test-password-1';
const KEY = generateEncryptionKey();
const RING = { keys: { 'social-v1': KEY }, activeKeyId: 'social-v1' };
const APP = { id: 'youtube-client-id', secret: `youtube-secret-${runId}` };
const LEAK = 'TOKENVALUE';
const CHANNEL = 'UC_x5XG1OV2P6uZZ5FSM9Ttw';
const CHUNK = 262_144;
const UPLOAD = 'https://www.googleapis.com/auth/youtube.upload';
const READONLY = 'https://www.googleapis.com/auth/youtube.readonly';
/** A video just over two chunks, so an upload really is chunked. */
const VIDEO_BYTES = Buffer.alloc(CHUNK * 2 + 1024, 9);
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('spectra-integration-thumbnail'),
  Buffer.from([0xff, 0xd9]),
]);

interface Session {
  received: number;
  total: number;
  privacyStatus: string;
  title: string;
  notifySubscribers: string | null;
  videoId: string | null;
}

interface MockYouTube {
  base: string;
  server: Server;
  codes: Map<string, { scopes: string[]; redirectUri: string }>;
  tokens: Map<string, { scopes: string[] }>;
  refreshTokens: Map<string, { scopes: string[] }>;
  sessions: Map<string, Session>;
  calls: Array<{ method: string; path: string; params: URLSearchParams }>;
  thumbnails: string[];
  /** Refuse to accept more than this many bytes, so an upload stalls. */
  stopAfterBytes: number | null;
  quotaExceeded: boolean;
  thumbnailForbidden: boolean;
  /** Google forces uploads from an unaudited project to private. */
  projectAudited: boolean;
  counter: number;
}

type Send = (status: number, body?: unknown, headers?: Record<string, string>) => void;

const googleError = (code: number, reason: string, message = reason) => ({
  error: { code, message, errors: [{ domain: 'youtube.api', reason, message }] },
});

function issueToken(mock: MockYouTube, scopes: string[], kind: 'access' | 'refresh'): string {
  mock.counter += 1;
  const token = `ya29-${kind}-${LEAK}-${mock.counter}`;
  (kind === 'access' ? mock.tokens : mock.refreshTokens).set(token, { scopes });
  return token;
}

function bearer(req: IncomingMessage): string {
  return String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
}

function tokenEndpoint(mock: MockYouTube, params: URLSearchParams, send: Send): void {
  if (params.get('client_id') !== APP.id || params.get('client_secret') !== APP.secret) {
    return send(401, { error: 'invalid_client' });
  }
  const grant = params.get('grant_type');
  if (grant === 'refresh_token') {
    const existing = mock.refreshTokens.get(params.get('refresh_token') ?? '');
    if (!existing) return send(400, { error: 'invalid_grant' });
    return send(200, {
      access_token: issueToken(mock, existing.scopes, 'access'),
      expires_in: 3599,
      scope: existing.scopes.join(' '),
      token_type: 'Bearer',
    });
  }
  const code = params.get('code') ?? '';
  const issued = mock.codes.get(code);
  mock.codes.delete(code); // single use
  if (!issued || issued.redirectUri !== params.get('redirect_uri')) {
    return send(400, { error: 'invalid_grant' });
  }
  return send(200, {
    access_token: issueToken(mock, issued.scopes, 'access'),
    // Spectra asks for offline access, so Google returns a refresh token.
    refresh_token: issueToken(mock, issued.scopes, 'refresh'),
    expires_in: 3599,
    scope: issued.scopes.join(' '),
    token_type: 'Bearer',
  });
}

async function handle(mock: MockYouTube, req: IncomingMessage, raw: Buffer, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://mock.local');
  const method = req.method ?? 'GET';
  const send: Send = (status, body, headers = {}) => {
    res.writeHead(status, {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...headers,
    });
    res.end(body !== undefined ? JSON.stringify(body) : undefined);
  };
  const params = new URLSearchParams(url.search);
  if (String(req.headers['content-type'] ?? '').startsWith('application/x-www-form-urlencoded')) {
    for (const [key, value] of new URLSearchParams(raw.toString())) params.set(key, value);
  }
  mock.calls.push({ method, path: url.pathname, params });

  if (url.pathname === '/token') return tokenEndpoint(mock, params, send);

  // Everything else needs a bearer token with the right scope.
  const token = mock.tokens.get(bearer(req));
  if (!token) return send(401, googleError(401, 'authError', 'Invalid Credentials'));

  if (url.pathname === '/youtube/v3/channels') {
    if (!token.scopes.includes(READONLY)) {
      return send(403, googleError(403, 'insufficientPermissions'));
    }
    return send(200, {
      items: [
        {
          id: CHANNEL,
          snippet: { title: 'Acme Coffee', customUrl: '@acmecoffee' },
          status: { privacyStatus: 'public', longUploadsStatus: 'allowed', madeForKids: false },
        },
      ],
    });
  }

  if (url.pathname === '/upload/youtube/v3/videos') {
    if (!token.scopes.includes(UPLOAD)) {
      return send(403, googleError(403, 'insufficientPermissions'));
    }
    if (mock.quotaExceeded) {
      return send(403, googleError(403, 'quotaExceeded', 'The request cannot be completed.'));
    }
    const body = JSON.parse(raw.toString() || '{}') as {
      snippet?: { title?: string };
      status?: { privacyStatus?: string };
    };
    mock.counter += 1;
    const id = `session-${mock.counter}`;
    mock.sessions.set(id, {
      received: 0,
      total: Number(req.headers['x-upload-content-length'] ?? 0),
      privacyStatus: body.status?.privacyStatus ?? 'private',
      title: body.snippet?.title ?? '',
      notifySubscribers: params.get('notifySubscribers'),
      videoId: null,
    });
    return send(200, {}, { location: `${mock.base}/upload/session/${id}` });
  }

  if (url.pathname.startsWith('/upload/session/') && method === 'PUT') {
    const session = mock.sessions.get(url.pathname.split('/').pop() as string);
    if (!session) return send(404, googleError(404, 'notFound'));
    const range = String(req.headers['content-range'] ?? '');
    const probe = /^bytes \*\/(\d+)$/.test(range);
    if (!probe) {
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
      if (!match) return send(400, googleError(400, 'badRequest', 'bad Content-Range'));
      const to = Number(match[2]) + 1;
      const ceiling = mock.stopAfterBytes ?? Infinity;
      session.received = Math.max(session.received, Math.min(to, ceiling));
    }
    if (session.received >= session.total) {
      if (!session.videoId) {
        mock.counter += 1;
        session.videoId = `vid_${runId}${mock.counter}`;
      }
      return send(201, {
        id: session.videoId,
        status: {
          uploadStatus: 'uploaded',
          // An unaudited project cannot publish anything but private.
          privacyStatus: mock.projectAudited ? session.privacyStatus : 'private',
        },
      });
    }
    return send(
      308,
      undefined,
      session.received > 0 ? { range: `bytes=0-${session.received - 1}` } : {},
    );
  }

  if (url.pathname === '/upload/youtube/v3/thumbnails/set') {
    if (mock.thumbnailForbidden) {
      return send(
        403,
        googleError(403, 'forbidden', 'The authenticated user cannot set custom thumbnails.'),
      );
    }
    mock.thumbnails.push(params.get('videoId') ?? '');
    return send(200, { items: [] });
  }
  return send(404, googleError(404, 'notFound'));
}

async function startYouTube(): Promise<MockYouTube> {
  const mock: MockYouTube = {
    base: '',
    server: createServer(),
    codes: new Map(),
    tokens: new Map(),
    refreshTokens: new Map(),
    sessions: new Map(),
    calls: [],
    thumbnails: [],
    stopAfterBytes: null,
    quotaExceeded: false,
    thumbnailForbidden: false,
    projectAudited: false,
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
  const address = mock.server.address() as AddressInfo;
  mock.base = `http://127.0.0.1:${address.port}`;
  return mock;
}

interface Tenant {
  email: string;
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

describe('API integration: YouTube video publishing (ADR-0037)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mock: MockYouTube;
  let storage: S3ObjectStorageProvider;
  const tenants: Tenant[] = [];
  const storedKeys: string[] = [];

  let owner: Tenant;
  let other: Tenant;
  let videoAssetId = '';
  let thumbnailAssetId = '';

  const inject = () => app.getHttpAdapter().getInstance();

  async function registerTenant(label: string): Promise<Tenant> {
    const email = `youtube-${label}-${runId}@itest.local`;
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, name: `YouTube ${label}` },
    });
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] as string;
    const me = res.json() as MeBody;
    const tenant = {
      email,
      cookie,
      orgId: me.memberships[0]?.organizationId as string,
      workspaceId: me.workspaces[0]?.id as string,
    };
    tenants.push(tenant);
    return tenant;
  }

  /** Starts a flow, plays Google's consent screen, and returns the connection id. */
  async function connect(t: Tenant, scopes: string[]) {
    const started = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${t.workspaceId}/social/oauth/youtube/start`,
      headers: { cookie: t.cookie },
      payload: {},
    });
    expect(started.statusCode).toBe(201);
    const url = new URL((started.json() as { authorizationUrl: string }).authorizationUrl);
    // Without offline access Google issues no refresh token at all.
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    const code = `code-${randomBytes(6).toString('hex')}`;
    mock.codes.set(code, { scopes, redirectUri: url.searchParams.get('redirect_uri') as string });
    const callback = await inject().inject({
      method: 'GET',
      url: `/v1/social/oauth/youtube/callback?${new URLSearchParams({
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

  async function channelAccount(t: Tenant) {
    const row = await prisma.client.socialAccount.findFirst({
      where: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        platform: 'YOUTUBE',
        externalAccountId: CHANNEL,
        deletedAt: null,
      },
    });
    if (!row) throw new Error('no YouTube account');
    return row;
  }

  async function approvedItem(t: Tenant) {
    return prisma.client.contentItem.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        title: 'Quarterly roast report',
        contentType: 'POST',
        lifecycleState: 'APPROVED',
        body: 'What changed this quarter.',
      },
    });
  }

  const details = (over: Record<string, unknown> = {}) => ({
    youtube: {
      title: 'Quarterly roast report',
      description: 'What changed this quarter.',
      tags: ['coffee'],
      privacyStatus: 'public',
      madeForKids: false,
      notifySubscribers: false,
      ...over,
    },
  });

  async function schedule(t: Tenant, socialAccountId: string, extra: Record<string, unknown> = {}) {
    const item = await approvedItem(t);
    return inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${t.workspaceId}/calendar`,
      headers: { cookie: t.cookie },
      payload: {
        contentItemId: item.id,
        platform: 'YOUTUBE',
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        socialAccountId,
        mediaAssetId: videoAssetId,
        publishMetadata: details(),
        ...extra,
      },
    });
  }

  /** Schedules, then flips to QUEUED the way the dispatcher's claim does. */
  async function queued(t: Tenant, socialAccountId: string, extra: Record<string, unknown> = {}) {
    const res = await schedule(t, socialAccountId, extra);
    expect(res.statusCode).toBe(201);
    const entryId = (res.json() as { id: string }).id;
    await prisma.client.contentScheduleEntry.update({
      where: { id: entryId },
      data: { status: 'QUEUED' },
    });
    return entryId;
  }

  async function entryRow(entryId: string) {
    return prisma.client.contentScheduleEntry.findUniqueOrThrow({ where: { id: entryId } });
  }

  async function uploadRow(t: Tenant, accountId: string, assetId: string) {
    return prisma.client.socialMediaUpload.findFirst({
      where: { organizationId: t.orgId, socialAccountId: accountId, mediaAssetId: assetId },
    });
  }

  /**
   * A video of its own per test. The ledger is keyed by account + asset, and a
   * video an earlier attempt already uploaded is deliberately never uploaded
   * again — so sharing one asset would make every later test a no-op.
   */
  async function freshVideo(t: Tenant = owner) {
    return storeAsset(t, { kind: 'VIDEO', mimeType: 'video/mp4', bytes: VIDEO_BYTES });
  }

  async function storeAsset(
    t: Tenant,
    options: { kind: 'VIDEO' | 'IMAGE'; mimeType: string; bytes: Buffer },
  ) {
    const id = randomUUID();
    const key = buildObjectKey({
      organizationId: t.orgId,
      workspaceId: t.workspaceId,
      domain: 'media',
      resourceId: id,
      filename: options.kind === 'VIDEO' ? 'video.mp4' : 'thumb.jpg',
    });
    await storage.putObject({ key, body: options.bytes, contentType: options.mimeType });
    storedKeys.push(key);
    await prisma.client.mediaAsset.create({
      data: {
        id,
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        kind: options.kind,
        storageKey: key,
        mimeType: options.mimeType,
        sizeBytes: options.bytes.length,
      },
    });
    return id;
  }

  /** The worker's exact wiring, against the mock. */
  function publishDeps() {
    const oauth = resolveOAuthPlatform(getApiEnv(), 'YOUTUBE');
    return {
      prisma: prisma.client,
      resolvePublisher: createPublisherResolver({
        prisma: prisma.client,
        ring: RING,
        linkedin: { api: { apiBaseUrl: 'http://127.0.0.1:9', version: '202608' }, oauth: null },
        youtube: {
          api: { apiBaseUrl: mock.base, projectAudited: mock.projectAudited, chunkBytes: CHUNK },
          oauth: oauth.configured ? oauth.config : null,
        },
      }),
      loadMedia: createMediaLoader(storage),
    };
  }

  const uploadStarts = () =>
    mock.calls.filter((c) => c.path === '/upload/youtube/v3/videos').length;

  beforeAll(async () => {
    mock = await startYouTube();
    Object.assign(process.env, {
      SOCIAL_TOKEN_ENCRYPTION_KEY: KEY,
      SOCIAL_OAUTH_REDIRECT_BASE_URL: 'http://localhost:4100',
      SOCIAL_OAUTH_YOUTUBE_CLIENT_ID: APP.id,
      SOCIAL_OAUTH_YOUTUBE_CLIENT_SECRET: APP.secret,
      SOCIAL_OAUTH_YOUTUBE_AUTHORIZATION_URL: `${mock.base}/o/oauth2/v2/auth`,
      SOCIAL_OAUTH_YOUTUBE_TOKEN_URL: `${mock.base}/token`,
      YOUTUBE_API_BASE_URL: mock.base,
      YOUTUBE_UPLOAD_CHUNK_BYTES: String(CHUNK),
    });
    resetApiEnvCache();
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);
    storage = new S3ObjectStorageProvider(getApiEnv());
    await storage.ensureBucket();
    owner = await registerTenant('owner');
    other = await registerTenant('other');
    videoAssetId = await storeAsset(owner, {
      kind: 'VIDEO',
      mimeType: 'video/mp4',
      bytes: VIDEO_BYTES,
    });
    thumbnailAssetId = await storeAsset(owner, {
      kind: 'IMAGE',
      mimeType: 'image/jpeg',
      bytes: JPEG,
    });
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

  describe('connecting and discovery', () => {
    it('stores a refresh token and discovers the channel with what it can publish', async () => {
      const connectionId = await connect(owner, [UPLOAD, READONLY]);
      const connection = await prisma.client.socialConnection.findFirstOrThrow({
        where: { id: connectionId, organizationId: owner.orgId },
      });
      expect(connection.hasRefreshToken).toBe(true);
      expect(connection.grantedScopesReported).toBe(true);
      expect(connection.grantedScopes).toEqual([UPLOAD, READONLY]);
      expect(connection.discoveryStatus).toBe('COMPLETE');
      expect(JSON.stringify(connection)).not.toContain(LEAK);

      const account = await channelAccount(owner);
      expect(account.kind).toBe('CHANNEL');
      expect(account.displayName).toBe('Acme Coffee');
      const capabilities = account.capabilities as {
        postTypes: Record<string, { status: string }>;
        notes: string[];
      };
      expect(capabilities.postTypes.VIDEO?.status).toBe('AVAILABLE');
      expect(capabilities.postTypes.TEXT?.status).toBe('NOT_SUPPORTED');
      // The audit restriction is stated up front, not discovered at publish time.
      expect(capabilities.notes.some((n) => n.includes('restricted to private viewing'))).toBe(
        true,
      );
    });

    it('reports YouTube publishing as wired, with exactly what it can publish', async () => {
      const res = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${owner.workspaceId}/social/oauth/platforms`,
        headers: { cookie: owner.cookie },
      });
      const body = res.json() as {
        platforms: Array<{
          platform: string;
          adapters: { publishing: boolean };
          limitation: string;
        }>;
      };
      const youtube = body.platforms.find((p) => p.platform === 'YOUTUBE');
      expect(youtube?.adapters.publishing).toBe(true);
      expect(youtube?.limitation).toContain('resumable');
      expect(youtube?.limitation).toContain('not implemented');
    });
  });

  describe('registering an uploaded video', () => {
    it('creates the asset only once storage confirms the object, with the size storage reports', async () => {
      const ticket = await inject().inject({
        method: 'POST',
        url: `/v1/workspaces/${owner.workspaceId}/media/uploads`,
        headers: { cookie: owner.cookie },
        payload: { filename: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: VIDEO_BYTES.length },
      });
      expect(ticket.statusCode).toBe(201);
      const { uploadId, uploadUrl, headers } = ticket.json() as {
        uploadId: string;
        uploadUrl: string;
        headers: Record<string, string>;
      };

      // Nothing exists until the bytes are actually there.
      const early = await inject().inject({
        method: 'POST',
        url: `/v1/workspaces/${owner.workspaceId}/media/uploads/complete`,
        headers: { cookie: owner.cookie },
        payload: { uploadId },
      });
      expect(early.statusCode).toBe(422);
      expect(problemText(early.json())).toContain('No file was uploaded');

      const put = await fetch(uploadUrl, { method: 'PUT', headers, body: VIDEO_BYTES });
      expect(put.ok).toBe(true);

      const completed = await inject().inject({
        method: 'POST',
        url: `/v1/workspaces/${owner.workspaceId}/media/uploads/complete`,
        headers: { cookie: owner.cookie },
        payload: { uploadId },
      });
      expect(completed.statusCode).toBe(201);
      const asset = completed.json() as { id: string; kind: string; sizeBytes: number };
      expect(asset.kind).toBe('VIDEO');
      expect(asset.sizeBytes).toBe(VIDEO_BYTES.length);
      storedKeys.push(
        buildObjectKey({
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          domain: 'media',
          resourceId: uploadId,
          filename: 'upload.bin',
        }),
      );

      // Completing the same ticket twice is the same asset, not a second one.
      const again = await inject().inject({
        method: 'POST',
        url: `/v1/workspaces/${owner.workspaceId}/media/uploads/complete`,
        headers: { cookie: owner.cookie },
        payload: { uploadId },
      });
      expect((again.json() as { id: string }).id).toBe(asset.id);
    });
  });

  describe('publishing', () => {
    it('uploads the video in chunks and links to the watch page', async () => {
      const account = await channelAccount(owner);
      const asset = await freshVideo();
      const before = uploadStarts();
      const entryId = await queued(owner, account.id, { mediaAssetId: asset });
      const outcome = await executePublication(publishDeps(), { entryId });
      const entry = await entryRow(entryId);
      expect(`${outcome.status} ${entry.failureReason ?? ''}`.trim()).toBe('PUBLISHED');
      expect(entry.externalPostId).toMatch(/^vid_/);
      expect(entry.externalUrl).toBe(`https://www.youtube.com/watch?v=${entry.externalPostId}`);
      expect(uploadStarts()).toBe(before + 1);
      // Three PUTs for two-and-a-bit chunks.
      expect(mock.calls.filter((c) => c.method === 'PUT').length).toBeGreaterThanOrEqual(3);
      expect(
        mock.calls
          .find((c) => c.path === '/upload/youtube/v3/videos')
          ?.params.get('notifySubscribers'),
      ).toBe('false');

      const upload = await uploadRow(owner, account.id, asset);
      expect(upload?.status).toBe('UPLOADED');
      expect(upload?.uploadedBytes).toBe(VIDEO_BYTES.length);
      // The session URL is a secret with no further use once the upload is done.
      expect(upload?.encryptedUploadUrl).toBeNull();
    });

    it('resumes an interrupted upload instead of starting a new one', async () => {
      const account = await channelAccount(owner);
      const asset = await freshVideo();
      mock.stopAfterBytes = CHUNK;
      const entryId = await queued(owner, account.id, { mediaAssetId: asset });
      const stalled = await executePublication(publishDeps(), { entryId });
      expect(stalled.status).toBe('FAILED');

      let entry = await entryRow(entryId);
      expect(entry.failureCode).toBe('TRANSIENT');
      expect(entry.failureReason).toContain('resume');
      const midway = await uploadRow(owner, account.id, asset);
      expect(midway?.uploadedBytes).toBe(CHUNK);
      // Sealed, never the plain session URL.
      expect(midway?.encryptedUploadUrl).toBeTruthy();
      expect(midway?.encryptedUploadUrl).not.toContain('/upload/session/');
      expect(midway?.credentialKeyId).toBe('social-v1');

      const starts = uploadStarts();
      mock.stopAfterBytes = null;
      await prisma.client.contentScheduleEntry.update({
        where: { id: entryId },
        data: { status: 'QUEUED' },
      });
      const outcome = await executePublication(publishDeps(), { entryId });
      expect(outcome.status).toBe('PUBLISHED');
      // Resumed: no second videos.insert session was opened.
      expect(uploadStarts()).toBe(starts);
      entry = await entryRow(entryId);
      expect(entry.externalPostId).toMatch(/^vid_/);
    });

    it('sets a custom thumbnail, and keeps the video when YouTube refuses one', async () => {
      const account = await channelAccount(owner);
      const withThumb = await queued(owner, account.id, {
        mediaAssetId: await freshVideo(),
        thumbnailAssetId,
      });
      expect((await executePublication(publishDeps(), { entryId: withThumb })).status).toBe(
        'PUBLISHED',
      );
      expect(mock.thumbnails.length).toBeGreaterThan(0);

      mock.thumbnailForbidden = true;
      const refused = await queued(owner, account.id, {
        mediaAssetId: await freshVideo(),
        thumbnailAssetId,
      });
      expect((await executePublication(publishDeps(), { entryId: refused })).status).toBe(
        'PUBLISHED',
      );
      const entry = await entryRow(refused);
      expect(entry.publishNote).toContain('did not set the custom thumbnail');
      mock.thumbnailForbidden = false;
    });

    it('says so when an unaudited project forces the video private', async () => {
      const account = await channelAccount(owner);
      // The mock is unaudited, so `public` comes back `private`.
      const entryId = await queued(owner, account.id, { mediaAssetId: await freshVideo() });
      await executePublication(publishDeps(), { entryId });
      const entry = await entryRow(entryId);
      expect(entry.status).toBe('PUBLISHED');
      expect(entry.publishNote).toContain('You asked for public');
      expect(entry.publishNote).toContain('restricted to private viewing mode');
    });

    it('reports an exhausted quota as a quota problem, not a generic failure', async () => {
      const account = await channelAccount(owner);
      mock.quotaExceeded = true;
      const entryId = await queued(owner, account.id, { mediaAssetId: await freshVideo() });
      const outcome = await executePublication(publishDeps(), { entryId });
      mock.quotaExceeded = false;
      expect(outcome.status).toBe('FAILED');
      const entry = await entryRow(entryId);
      expect(entry.failureCode).toBe('QUOTA');
      expect(entry.failureReason).toContain('quotaExceeded');
      expect(entry.failureReason).toContain('midnight Pacific Time');
    });

    it('refuses video details YouTube would reject, before anything is uploaded', async () => {
      const account = await channelAccount(owner);
      const starts = uploadStarts();
      const tooLong = await schedule(owner, account.id, {
        publishMetadata: details({ title: 'x'.repeat(101) }),
      });
      expect(tooLong.statusCode).toBe(422);

      const noVideo = await schedule(owner, account.id, { mediaAssetId: undefined });
      expect(noVideo.statusCode).toBe(422);
      expect(problemText(noVideo.json())).toContain('attach a video');
      expect(uploadStarts()).toBe(starts);
    });
  });

  describe('permissions and isolation', () => {
    it('refuses to upload without the upload scope, before contacting YouTube', async () => {
      const readOnly = await registerTenant('readonly');
      await connect(readOnly, [READONLY]);
      const account = await prisma.client.socialAccount.findFirstOrThrow({
        where: { organizationId: readOnly.orgId, platform: 'YOUTUBE', deletedAt: null },
      });
      const capabilities = account.capabilities as {
        postTypes: Record<string, { status: string }>;
      };
      expect(capabilities.postTypes.VIDEO?.status).toBe('MISSING_PERMISSION');

      const asset = await storeAsset(readOnly, {
        kind: 'VIDEO',
        mimeType: 'video/mp4',
        bytes: VIDEO_BYTES,
      });
      const item = await approvedItem(readOnly);
      const entry = await prisma.client.contentScheduleEntry.create({
        data: {
          organizationId: readOnly.orgId,
          workspaceId: readOnly.workspaceId,
          contentItemId: item.id,
          platform: 'YOUTUBE',
          scheduledAt: new Date(),
          status: 'QUEUED',
          socialAccountId: account.id,
          mediaAssetId: asset,
          idempotencyKey: randomUUID(),
          publishMetadata: details() as object,
        },
      });
      const starts = uploadStarts();
      const outcome = await executePublication(publishDeps(), { entryId: entry.id });
      expect(outcome.status).toBe('FAILED');
      const row = await entryRow(entry.id);
      expect(row.failureCode).toBe('PERMISSION');
      expect(row.failureReason).toContain('youtube.upload');
      expect(uploadStarts()).toBe(starts);
    });

    it('lets no other tenant schedule to this channel or publish through it', async () => {
      const account = await channelAccount(owner);
      const item = await approvedItem(other);
      const foreign = await inject().inject({
        method: 'POST',
        url: `/v1/workspaces/${other.workspaceId}/calendar`,
        headers: { cookie: other.cookie },
        payload: {
          contentItemId: item.id,
          platform: 'YOUTUBE',
          scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
          socialAccountId: account.id,
          mediaAssetId: videoAssetId,
          publishMetadata: details(),
        },
      });
      // A foreign account and a missing one are the same answer.
      expect(foreign.statusCode).toBe(404);

      const entry = await prisma.client.contentScheduleEntry.create({
        data: {
          organizationId: other.orgId,
          workspaceId: other.workspaceId,
          contentItemId: item.id,
          platform: 'YOUTUBE',
          scheduledAt: new Date(),
          status: 'QUEUED',
          socialAccountId: account.id,
          idempotencyKey: randomUUID(),
        },
      });
      const starts = uploadStarts();
      const outcome = await executePublication(publishDeps(), { entryId: entry.id });
      expect(outcome.status).toBe('UNSUPPORTED');
      expect((await entryRow(entry.id)).failureReason).toContain(
        'does not exist in this workspace',
      );
      expect(uploadStarts()).toBe(starts);
    });
  });
});
