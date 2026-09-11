import './setup-env';

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createMediaLoader,
  createMediaUrlSigner,
  createPublisherResolver,
  executePublication,
} from '@spectra/publishing';
import { decryptSecret, generateEncryptionKey } from '@spectra/security';
import { S3ObjectStorageProvider, buildObjectKey } from '@spectra/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv, resetApiEnvCache } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 6E: Facebook Pages and Instagram professional accounts (ADR-0036),
 * end to end.
 *
 * "Meta" here is a real HTTP server on 127.0.0.1 that behaves like the Graph
 * API as Meta documents it: the token endpoint (GET, with the long-lived
 * fb_exchange_token grant), /me/permissions, /me, /me/accounts with Page
 * tokens and linked Instagram accounts, Page feed and multipart photo posts,
 * and Instagram content publishing — containers that FETCH their image from
 * the signed link Spectra gives them (here, the real MinIO object), status
 * codes, media_publish and the publishing limit. It enforces what Meta
 * enforces: appsecret_proof on every call, Page tokens for Page and Instagram
 * writes, per-permission refusals, single-use codes. Every token contains
 * TOKENVALUE, so a leak is one string search.
 */

const runId = randomBytes(4).toString('hex');
const PASSWORD = 'integration-test-password-1';
const KEY = generateEncryptionKey();
const RING = { keys: { 'social-v1': KEY }, activeKeyId: 'social-v1' };
const APP = { id: 'meta-app-id', secret: `meta-secret-${runId}` };
const VERSION = 'v26.0';
const LEAK = 'TOKENVALUE';
const USER_ID = '10001';
/** A Page the user can create content on, with a professional Instagram account linked. */
const PAGE = '20001';
/** A Page where the user's role yields no token, with an Instagram account linked only in settings. */
const QUIET_PAGE = '20002';
const IG_PRO = '17841400000000001';
const IG_PERSONAL = '17841400000000002';
const PAGE_SCOPES = ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'];
const ALL_SCOPES = [...PAGE_SCOPES, 'instagram_basic', 'instagram_content_publish'];
// Minimal JPEG and PNG payloads: the mock checks the magic bytes, as Meta checks formats.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  Buffer.from('spectra-integration-jpeg'),
  Buffer.from([0xff, 0xd9]),
]);
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

interface Grant {
  scopes: string[];
  declined: string[];
}

interface MockMeta {
  base: string;
  server: Server;
  codes: Map<string, Grant & { redirectUri: string }>;
  userTokens: Map<string, { grant: Grant; longLived: boolean }>;
  pageTokens: Map<string, { pageId: string; grant: Grant }>;
  containers: Map<
    string,
    { bytes: Buffer; caption: string | null; altText: string | null; status: string }
  >;
  posts: Array<{
    target: string;
    kind: 'feed' | 'photo' | 'instagram';
    text: string | null;
    bytes?: Buffer;
    token: string;
  }>;
  calls: Array<{ method: string; route: string; params: URLSearchParams }>;
  fetchedImages: string[];
  revoked: Set<string>;
  failExchange: boolean;
  dropNextPublishResponse: boolean;
  quotaUsage: number;
  counter: number;
}

type Send = (status: number, body?: unknown) => void;

const graphError = (code: number, message: string, subcode?: number) => ({
  error: {
    message,
    type: 'OAuthException',
    code,
    ...(subcode !== undefined ? { error_subcode: subcode } : {}),
    fbtrace_id: 'AxYzTrace',
  },
});

function issueUserToken(mock: MockMeta, grant: Grant, longLived: boolean): string {
  mock.counter += 1;
  const token = `EAAU-${LEAK}-${mock.counter}`;
  mock.userTokens.set(token, { grant, longLived });
  return token;
}

function issuePageToken(mock: MockMeta, pageId: string, grant: Grant): string {
  mock.counter += 1;
  const token = `EAAP-${LEAK}-${mock.counter}`;
  mock.pageTokens.set(token, { pageId, grant });
  return token;
}

async function readParams(
  req: IncomingMessage,
  raw: Buffer,
  url: URL,
): Promise<{ params: URLSearchParams; file: Buffer | null }> {
  const params = new URLSearchParams(url.search);
  let file: Buffer | null = null;
  const type = String(req.headers['content-type'] ?? '');
  if (type.startsWith('application/x-www-form-urlencoded')) {
    for (const [key, value] of new URLSearchParams(raw.toString())) params.set(key, value);
  } else if (type.startsWith('multipart/form-data')) {
    const form = await new Response(raw, { headers: { 'content-type': type } }).formData();
    for (const [key, value] of form) {
      if (typeof value === 'string') params.set(key, value);
      else file = Buffer.from(await value.arrayBuffer());
    }
  }
  return { params, file };
}

/** Meta documents the token endpoint as GET with query parameters. */
function tokenEndpoint(mock: MockMeta, method: string, params: URLSearchParams, send: Send): void {
  if (method !== 'GET') return send(400, graphError(100, 'Unsupported post request.'));
  if (params.get('client_id') !== APP.id || params.get('client_secret') !== APP.secret) {
    return send(400, graphError(101, 'Error validating application. Invalid application ID.'));
  }
  if (params.get('grant_type') === 'fb_exchange_token') {
    if (mock.failExchange) {
      mock.failExchange = false;
      return send(400, graphError(190, 'Error validating access token: Session has expired'));
    }
    const short = mock.userTokens.get(params.get('fb_exchange_token') ?? '');
    if (!short) return send(400, graphError(190, 'Invalid OAuth access token.'));
    return send(200, {
      access_token: issueUserToken(mock, short.grant, true),
      token_type: 'bearer',
      expires_in: 5_183_944,
    });
  }
  const code = params.get('code') ?? '';
  const issued = mock.codes.get(code);
  mock.codes.delete(code); // single use
  if (!issued || issued.redirectUri !== params.get('redirect_uri')) {
    return send(400, graphError(100, 'Invalid verification code format.'));
  }
  // A short-lived token, and — as with Meta — no scopes in the response.
  return send(200, {
    access_token: issueUserToken(mock, { scopes: issued.scopes, declined: issued.declined }, false),
    token_type: 'bearer',
    expires_in: 5_400,
  });
}

async function handle(mock: MockMeta, req: IncomingMessage, raw: Buffer, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://mock.local');
  const method = req.method ?? 'GET';
  const send: Send = (status, body) => {
    res.writeHead(status, body !== undefined ? { 'content-type': 'application/json' } : {});
    res.end(body !== undefined ? JSON.stringify(body) : undefined);
  };
  const { params, file } = await readParams(req, raw, url);
  if (!url.pathname.startsWith(`/${VERSION}/`)) {
    return send(400, graphError(2635, 'You are calling an unsupported version of the Graph API.'));
  }
  const route = url.pathname.slice(VERSION.length + 2);
  mock.calls.push({ method, route, params });
  if (route === 'oauth/access_token') return tokenEndpoint(mock, method, params, send);

  const token = params.get('access_token') ?? '';
  if (!token)
    return send(400, graphError(104, 'An access token is required to request this resource.'));
  if (
    params.get('appsecret_proof') !== createHmac('sha256', APP.secret).update(token).digest('hex')
  ) {
    return send(400, graphError(100, 'Invalid appsecret_proof provided in the API argument'));
  }
  if (mock.revoked.has(token)) {
    return send(
      400,
      graphError(190, 'Error validating access token: the user changed their password.', 460),
    );
  }
  const user = mock.userTokens.get(token);
  const page = mock.pageTokens.get(token);
  if (!user && !page)
    return send(400, graphError(190, 'Invalid OAuth access token - Cannot parse access token'));
  const grant = (user?.grant ?? page?.grant) as Grant;
  const has = (scope: string) => grant.scopes.includes(scope);

  if (user) {
    if (method === 'GET' && route === 'me/permissions') {
      return send(200, {
        data: [
          ...grant.scopes.map((permission) => ({ permission, status: 'granted' })),
          ...grant.declined.map((permission) => ({ permission, status: 'declined' })),
          { permission: 'public_profile', status: 'granted' },
        ],
      });
    }
    // The email is never requested, so never returned.
    if (method === 'GET' && route === 'me') return send(200, { id: USER_ID, name: 'Jane Doe' });
    if (method === 'GET' && route === 'me/accounts') {
      if (!has('pages_show_list')) {
        return send(
          403,
          graphError(200, '(#200) Requires pages_show_list permission to manage the object'),
        );
      }
      const ig =
        (params.get('fields') ?? '').includes('instagram_business_account') &&
        has('instagram_basic');
      return send(200, {
        data: [
          {
            id: PAGE,
            name: 'Acme Coffee',
            category: 'Coffee Shop',
            tasks: ['ANALYZE', 'ADVERTISE', 'MODERATE', 'CREATE_CONTENT', 'MANAGE'],
            access_token: issuePageToken(mock, PAGE, grant),
            ...(ig
              ? {
                  instagram_business_account: {
                    id: IG_PRO,
                    username: 'acmecoffee',
                    name: 'Acme Coffee',
                  },
                }
              : {}),
          },
          {
            id: QUIET_PAGE,
            name: 'Garden Club',
            category: 'Community',
            tasks: ['ANALYZE'],
            ...(ig
              ? { connected_instagram_account: { id: IG_PERSONAL, username: 'jane.gardens' } }
              : {}),
          },
        ],
        paging: { cursors: { before: 'QVFIUmJ', after: 'QVFIUnZ' } },
      });
    }
    return send(400, graphError(100, 'Unsupported request with a user token'));
  }

  // Page token from here on: Page writes and Instagram, as the Page.
  const pageId = page?.pageId;
  if (method === 'POST' && (route === `${PAGE}/feed` || route === `${PAGE}/photos`)) {
    if (pageId !== PAGE || !has('pages_manage_posts')) {
      return send(
        403,
        graphError(
          200,
          '(#200) If posting to a page, requires both pages_read_engagement and pages_manage_posts',
        ),
      );
    }
    mock.counter += 1;
    const postId = `${PAGE}_${7000 + mock.counter}`;
    if (route.endsWith('/feed')) {
      if (!params.get('message'))
        return send(400, graphError(100, 'Missing message or attachment'));
      mock.posts.push({ target: PAGE, kind: 'feed', text: params.get('message'), token });
      return send(200, { id: postId });
    }
    if (!file) return send(400, graphError(324, 'Requires upload file'));
    mock.posts.push({
      target: PAGE,
      kind: 'photo',
      text: params.get('caption'),
      bytes: file,
      token,
    });
    return send(200, { id: `${8000 + mock.counter}`, post_id: postId });
  }
  if (method === 'GET' && route.startsWith(`${PAGE}_`)) {
    return send(200, {
      id: route,
      permalink_url: `https://www.facebook.com/${PAGE}/posts/${route.split('_')[1]}`,
    });
  }

  if (route.startsWith(`${IG_PRO}/`) || route.startsWith(`${IG_PERSONAL}/`)) {
    if (!route.startsWith(`${IG_PRO}/`) || pageId !== PAGE) {
      return send(400, graphError(10, 'Application does not have permission for this action'));
    }
    if (!has('instagram_basic') || !has('instagram_content_publish')) {
      return send(
        403,
        graphError(10, '(#10) Application does not have permission for this action'),
      );
    }
    if (method === 'GET' && route === `${IG_PRO}/content_publishing_limit`) {
      return send(200, {
        data: [
          { quota_usage: mock.quotaUsage, config: { quota_total: 100, quota_duration: 86400 } },
        ],
      });
    }
    if (method === 'POST' && route === `${IG_PRO}/media`) {
      const imageUrl = params.get('image_url');
      if (!imageUrl) return send(400, graphError(100, 'The parameter image_url is required'));
      // Instagram fetches the image itself, from the link it was given.
      let bytes: Buffer;
      try {
        const fetched = await fetch(imageUrl);
        if (!fetched.ok) throw new Error(String(fetched.status));
        bytes = Buffer.from(await fetched.arrayBuffer());
      } catch {
        return send(400, graphError(9004, 'The media could not be fetched from this uri', 2207052));
      }
      mock.fetchedImages.push(imageUrl);
      if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
        return send(400, graphError(9004, 'Only JPEG images are supported', 2207026));
      }
      mock.counter += 1;
      const id = `9001${String(mock.counter).padStart(10, '0')}`;
      mock.containers.set(id, {
        bytes,
        caption: params.get('caption'),
        altText: params.get('alt_text'),
        status: 'FINISHED',
      });
      return send(200, { id });
    }
    if (method === 'POST' && route === `${IG_PRO}/media_publish`) {
      const container = mock.containers.get(params.get('creation_id') ?? '');
      if (!container) return send(400, graphError(100, 'Invalid creation_id'));
      if (container.status !== 'FINISHED') {
        return send(400, graphError(100, `The media container is ${container.status}`));
      }
      mock.counter += 1;
      const mediaId = `1790${String(mock.counter).padStart(13, '0')}`;
      container.status = 'PUBLISHED';
      mock.posts.push({
        target: IG_PRO,
        kind: 'instagram',
        text: container.caption,
        bytes: container.bytes,
        token,
      });
      mock.quotaUsage += 1;
      if (mock.dropNextPublishResponse) {
        // Published — but the answer is lost to a server error.
        mock.dropNextPublishResponse = false;
        return send(
          503,
          graphError(2, 'An unexpected error has occurred. Please retry your request later.'),
        );
      }
      return send(200, { id: mediaId });
    }
  }
  if (method === 'GET' && mock.containers.has(route)) {
    return send(200, { id: route, status_code: mock.containers.get(route)?.status });
  }
  if (method === 'GET' && route.startsWith('1790')) {
    return send(200, { id: route, permalink: `https://www.instagram.com/p/C${route.slice(-6)}/` });
  }
  return send(404, graphError(803, 'Some of the aliases you requested do not exist'));
}

function startMeta(): Promise<MockMeta> {
  const mock = {
    codes: new Map(),
    userTokens: new Map(),
    pageTokens: new Map(),
    containers: new Map(),
    posts: [],
    calls: [],
    fetchedImages: [],
    revoked: new Set(),
    failExchange: false,
    dropNextPublishResponse: false,
    quotaUsage: 0,
    counter: 0,
  } as unknown as MockMeta;
  mock.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void handle(mock, req, Buffer.concat(chunks), res);
    });
  });
  return new Promise((resolve) => {
    mock.server.listen(0, '127.0.0.1', () => {
      mock.base = `http://127.0.0.1:${(mock.server.address() as AddressInfo).port}`;
      resolve(mock);
    });
  });
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

type Caps = { postTypes: Record<string, { status: string; reason: string }> };

/** Nest puts an HttpException's message in `title`; read both, as clients do. */
function problemText(body: unknown): string {
  const problem = body as { title?: string; detail?: string };
  return `${problem.title ?? ''} ${problem.detail ?? ''}`;
}

describe('API integration: Meta — Facebook Pages and Instagram (ADR-0036)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mock: MockMeta;
  let storage: S3ObjectStorageProvider;
  const tenants: Tenant[] = [];
  const storedKeys: string[] = [];

  let owner: Tenant;
  let other: Tenant;
  let ownerConnectionId = '';
  let jpegAssetId = '';

  const inject = () => app.getHttpAdapter().getInstance();

  async function registerTenant(label: string): Promise<Tenant> {
    const email = `meta-${label}-${runId}@itest.local`;
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, name: `Meta ${label}` },
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

  /** Starts a flow, plays Meta's consent dialog, and returns where the callback sent the browser. */
  async function authorize(t: Tenant, startUrl: string, scopes: string[], declined: string[] = []) {
    const started = await inject().inject({
      method: 'POST',
      url: startUrl,
      headers: { cookie: t.cookie },
      payload: {},
    });
    expect(started.statusCode).toBe(201);
    const url = new URL((started.json() as { authorizationUrl: string }).authorizationUrl);
    expect(url.pathname).toBe(`/${VERSION}/dialog/oauth`);
    const code = `code-${randomBytes(6).toString('hex')}`;
    mock.codes.set(code, {
      scopes,
      declined,
      redirectUri: url.searchParams.get('redirect_uri') as string,
    });
    const callback = await inject().inject({
      method: 'GET',
      url: `/v1/social/oauth/facebook/callback?${new URLSearchParams({
        code,
        state: url.searchParams.get('state') as string,
      }).toString()}`,
      headers: { cookie: t.cookie },
    });
    expect(callback.statusCode).toBe(302);
    return new URL(callback.headers.location as string);
  }

  async function connect(t: Tenant, scopes: string[], declined: string[] = []) {
    const location = await authorize(
      t,
      `/v1/workspaces/${t.workspaceId}/social/oauth/facebook/start`,
      scopes,
      declined,
    );
    expect(location.searchParams.get('oauth')).toBe('connected');
    return location.searchParams.get('connection') as string;
  }

  async function account(t: Tenant, platform: 'FACEBOOK' | 'INSTAGRAM', externalAccountId: string) {
    const row = await prisma.client.socialAccount.findFirst({
      where: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        platform,
        externalAccountId,
        deletedAt: null,
      },
    });
    if (!row) throw new Error(`no ${platform} account ${externalAccountId}`);
    return row;
  }

  async function connectionRow(t: Tenant, id: string) {
    return prisma.client.socialConnection.findFirst({ where: { id, organizationId: t.orgId } });
  }

  async function approvedItem(t: Tenant, body = 'Fresh roast Friday #coffee') {
    return prisma.client.contentItem.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        title: 'Fresh roast',
        contentType: 'POST',
        lifecycleState: 'APPROVED',
        body,
      },
    });
  }

  async function schedule(
    t: Tenant,
    platform: 'FACEBOOK' | 'INSTAGRAM',
    socialAccountId: string,
    extra: { mediaAssetId?: string; mediaAltText?: string } = {},
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

  /**
   * Schedules, then flips to QUEUED the way the dispatcher's claim does —
   * never through publish-now, which would enqueue a job a running dev worker
   * could race.
   */
  async function queued(
    t: Tenant,
    platform: 'FACEBOOK' | 'INSTAGRAM',
    socialAccountId: string,
    extra: { mediaAssetId?: string; mediaAltText?: string } = {},
  ) {
    const res = await schedule(t, platform, socialAccountId, extra);
    expect(res.statusCode).toBe(201);
    const entryId = (res.json() as { id: string }).id;
    await requeue(entryId);
    return entryId;
  }

  async function requeue(entryId: string) {
    await prisma.client.contentScheduleEntry.update({
      where: { id: entryId },
      data: { status: 'QUEUED' },
    });
  }

  /** An entry written straight to the database, bypassing the API's checks. */
  async function directEntry(
    t: Tenant,
    platform: 'FACEBOOK' | 'INSTAGRAM',
    socialAccountId: string,
    mediaAssetId?: string,
  ) {
    const item = await approvedItem(t);
    const entry = await prisma.client.contentScheduleEntry.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        contentItemId: item.id,
        platform,
        scheduledAt: new Date(),
        status: 'QUEUED',
        socialAccountId,
        idempotencyKey: randomUUID(),
        ...(mediaAssetId ? { mediaAssetId } : {}),
      },
    });
    return entry.id;
  }

  async function mediaAsset(
    t: Tenant,
    options: { mimeType: string; bytes: Buffer; widthPx: number; heightPx: number },
  ) {
    const id = randomUUID();
    const key = buildObjectKey({
      organizationId: t.orgId,
      workspaceId: t.workspaceId,
      domain: 'media',
      resourceId: id,
      filename: options.mimeType === 'image/png' ? 'photo.png' : 'photo.jpg',
    });
    await storage.putObject({ key, body: options.bytes, contentType: options.mimeType });
    storedKeys.push(key);
    await prisma.client.mediaAsset.create({
      data: {
        id,
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        kind: 'IMAGE',
        storageKey: key,
        mimeType: options.mimeType,
        sizeBytes: options.bytes.length,
        widthPx: options.widthPx,
        heightPx: options.heightPx,
      },
    });
    return id;
  }

  /** The worker's exact wiring, against the mock (storage here is reachable by the mock). */
  function publishDeps() {
    return {
      prisma: prisma.client,
      resolvePublisher: createPublisherResolver({
        prisma: prisma.client,
        ring: RING,
        linkedin: { api: { apiBaseUrl: 'http://127.0.0.1:9', version: '202608' }, oauth: null },
        meta: {
          api: { apiBaseUrl: mock.base, version: VERSION, appSecret: APP.secret },
          instagramMediaProblem: null,
          statusChecks: 2,
          pollIntervalMs: 0,
          sleep: async () => undefined,
        },
      }),
      loadMedia: createMediaLoader(storage),
      mediaUrl: createMediaUrlSigner(storage),
    };
  }

  const graphWrites = () =>
    mock.calls.filter((c) => c.method === 'POST' && c.route !== 'oauth/access_token').length;
  const graphCalls = () => mock.calls.filter((c) => c.route !== 'oauth/access_token').length;

  beforeAll(async () => {
    mock = await startMeta();
    Object.assign(process.env, {
      SOCIAL_TOKEN_ENCRYPTION_KEY: KEY,
      SOCIAL_OAUTH_REDIRECT_BASE_URL: 'http://localhost:4100',
      SOCIAL_OAUTH_FACEBOOK_CLIENT_ID: APP.id,
      SOCIAL_OAUTH_FACEBOOK_CLIENT_SECRET: APP.secret,
      SOCIAL_OAUTH_FACEBOOK_AUTHORIZATION_URL: `${mock.base}/${VERSION}/dialog/oauth`,
      SOCIAL_OAUTH_FACEBOOK_TOKEN_URL: `${mock.base}/${VERSION}/oauth/access_token`,
      META_GRAPH_API_BASE_URL: mock.base,
      META_GRAPH_API_VERSION: VERSION,
    });
    resetApiEnvCache();
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);
    storage = new S3ObjectStorageProvider(getApiEnv());
    await storage.ensureBucket();
    owner = await registerTenant('owner');
  });

  afterAll(async () => {
    for (const key of storedKeys) await storage.deleteObject(key).catch(() => undefined);
    for (const t of tenants) {
      await prisma.client.organization.delete({ where: { id: t.orgId } }).catch(() => undefined);
      await prisma.client.user.delete({ where: { email: t.email } }).catch(() => undefined);
    }
    await app.close();
    await new Promise((resolve) => mock.server.close(resolve));
  });

  describe('OAuth and discovery', () => {
    it('exchanges the code with GET, upgrades to a long-lived token, and records what Meta granted', async () => {
      ownerConnectionId = await connect(owner, ALL_SCOPES);
      const exchanges = mock.calls.filter((c) => c.route === 'oauth/access_token');
      expect(exchanges.map((c) => c.method)).toEqual(['GET', 'GET']);
      expect(exchanges.map((c) => c.params.get('grant_type'))).toEqual([
        'authorization_code',
        'fb_exchange_token',
      ]);

      const connection = await connectionRow(owner, ownerConnectionId);
      expect(connection).toMatchObject({
        discoveryStatus: 'COMPLETE',
        externalSubjectId: USER_ID,
        grantedScopesReported: true,
        hasRefreshToken: false,
      });
      // Meta's token response reports no scopes: /me/permissions did.
      expect(connection?.grantedScopes).toEqual(expect.arrayContaining(ALL_SCOPES));
      // The long-lived token (about 60 days) is what was stored — not the one-hour one.
      expect(connection?.accessTokenExpiresAt?.getTime()).toBeGreaterThan(
        Date.now() + 50 * 86_400_000,
      );
      const bundle = JSON.parse(decryptSecret(connection?.encryptedCredential as string, RING)) as {
        accessToken: string;
      };
      expect(mock.userTokens.get(bundle.accessToken)?.longLived).toBe(true);
    });

    it('finds the Pages and linked Instagram accounts, each with a sealed token and an honest capability', async () => {
      const profile = await account(owner, 'FACEBOOK', USER_ID);
      expect(profile).toMatchObject({ kind: 'PROFILE', encryptedToken: null });
      expect((profile.capabilities as Caps).postTypes['TEXT']?.reason).toContain(
        'personal profiles',
      );

      const page = await account(owner, 'FACEBOOK', PAGE);
      expect(page).toMatchObject({
        kind: 'PAGE',
        displayName: 'Acme Coffee',
        connectionId: ownerConnectionId,
      });
      const pageToken = decryptSecret(page.encryptedToken as string, RING);
      expect(mock.pageTokens.get(pageToken)?.pageId).toBe(PAGE);
      expect(page.credentialKeyId).toBe('social-v1');
      expect((page.capabilities as Caps).postTypes['TEXT']?.status).toBe('AVAILABLE');

      const quiet = await account(owner, 'FACEBOOK', QUIET_PAGE);
      expect(quiet.encryptedToken).toBeNull();
      expect((quiet.capabilities as Caps).postTypes['TEXT']?.status).toBe('MISSING_PERMISSION');

      const pro = await account(owner, 'INSTAGRAM', IG_PRO);
      expect(pro).toMatchObject({
        kind: 'BUSINESS_ACCOUNT',
        displayName: '@acmecoffee',
        connectionId: ownerConnectionId,
      });
      expect(decryptSecret(pro.encryptedToken as string, RING)).toBe(pageToken);
      const proCaps = pro.capabilities as Caps;
      expect(proCaps.postTypes['IMAGE']?.status).toBe('AVAILABLE');
      expect(proCaps.postTypes['TEXT']?.status).toBe('NOT_SUPPORTED');

      const personal = await account(owner, 'INSTAGRAM', IG_PERSONAL);
      expect(personal).toMatchObject({ kind: 'PROFILE', encryptedToken: null });
      expect((personal.capabilities as Caps).postTypes['IMAGE']).toMatchObject({
        status: 'NOT_SUPPORTED',
      });

      const list = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${owner.workspaceId}/social/connections`,
        headers: { cookie: owner.cookie },
      });
      expect(list.body).not.toContain(LEAK);
      expect(list.body).not.toContain('encryptedToken');
      const [row] = list.json() as Array<{
        tokenNote: string | null;
        permissions: Array<{ status: string }>;
        accounts: Array<{ platform: string; externalAccountId: string }>;
      }>;
      expect(row?.permissions.every((p) => p.status === 'GRANTED')).toBe(true);
      expect(row?.tokenNote).toMatch(/Page tokens obtained with it do not expire/);
      expect(row?.accounts.map((a) => `${a.platform}:${a.externalAccountId}`).sort()).toEqual(
        [
          `FACEBOOK:${USER_ID}`,
          `FACEBOOK:${PAGE}`,
          `FACEBOOK:${QUIET_PAGE}`,
          `INSTAGRAM:${IG_PRO}`,
          `INSTAGRAM:${IG_PERSONAL}`,
        ].sort(),
      );
    });

    it('reports Facebook and Instagram publishing as wired, with exactly what each can post', async () => {
      const oauth = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${owner.workspaceId}/social/oauth/platforms`,
        headers: { cookie: owner.cookie },
      });
      const platforms = (
        oauth.json() as {
          platforms: Array<{
            platform: string;
            adapters: { publishing: boolean; discovery: boolean };
            limitation: string;
          }>;
        }
      ).platforms;
      const facebook = platforms.find((p) => p.platform === 'FACEBOOK');
      expect(facebook?.adapters).toEqual({ publishing: true, discovery: true });
      expect(facebook?.limitation).toMatch(/personal profiles/);
      expect(platforms.find((p) => p.platform === 'INSTAGRAM')?.adapters.publishing).toBe(true);

      const declared = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${owner.workspaceId}/social/platforms`,
        headers: { cookie: owner.cookie },
      });
      const instagram = (
        declared.json() as {
          platforms: Array<{
            capability: { platform: string };
            publisherWired: boolean;
            publisherSummary: string | null;
          }>;
        }
      ).platforms.find((p) => p.capability.platform === 'INSTAGRAM');
      expect(instagram?.publisherWired).toBe(true);
      expect(instagram?.publisherSummary).toMatch(/professional \(Business or Creator\)/);
    });

    it('names the missing Instagram permissions for a Pages-only grant, and asks Meta for no Instagram fields', async () => {
      other = await registerTenant('pages-only');
      await connect(other, PAGE_SCOPES, ['instagram_basic', 'instagram_content_publish']);
      const listing = mock.calls.filter((c) => c.route === 'me/accounts').at(-1);
      expect(listing?.params.get('fields')).not.toContain('instagram');

      const list = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${other.workspaceId}/social/connections`,
        headers: { cookie: other.cookie },
      });
      const [row] = list.json() as Array<{
        permissions: Array<{
          id: string;
          status: string;
          reviewRequired: boolean;
          missingScopes: string[];
        }>;
        accounts: Array<{ platform: string }>;
      }>;
      const byId = Object.fromEntries((row?.permissions ?? []).map((p) => [p.id, p]));
      expect(byId['pages-publishing']?.status).toBe('GRANTED');
      expect(byId['instagram-publishing']).toMatchObject({
        status: 'MISSING',
        reviewRequired: true,
        missingScopes: ['instagram_basic', 'instagram_content_publish'],
      });
      expect(row?.accounts.some((a) => a.platform === 'INSTAGRAM')).toBe(false);
    });

    it('stores nothing when Meta refuses the long-lived exchange — a one-hour grant is not kept', async () => {
      const refused = await registerTenant('no-long-lived');
      mock.failExchange = true;
      const location = await authorize(
        refused,
        `/v1/workspaces/${refused.workspaceId}/social/oauth/facebook/start`,
        ALL_SCOPES,
      );
      expect(location.searchParams.get('oauth')).toBe('token_exchange_failed');
      expect(
        await prisma.client.socialConnection.count({ where: { organizationId: refused.orgId } }),
      ).toBe(0);
    });
  });

  describe('publishing', () => {
    it('publishes a text post to the Page with the Page token', async () => {
      const page = await account(owner, 'FACEBOOK', PAGE);
      const entryId = await queued(owner, 'FACEBOOK', page.id);
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');

      const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
      expect(row?.externalPostId).toMatch(new RegExp(`^${PAGE}_\\d+$`));
      expect(row?.externalUrl).toBe(
        `https://www.facebook.com/${PAGE}/posts/${row?.externalPostId?.split('_')[1]}`,
      );
      const post = mock.posts.at(-1);
      expect(post).toMatchObject({
        target: PAGE,
        kind: 'feed',
        text: 'Fresh roast Friday #coffee',
      });
      expect(mock.pageTokens.has(post?.token as string)).toBe(true);
    });

    it('publishes a photo post: the bytes as multipart source, with the caption', async () => {
      const page = await account(owner, 'FACEBOOK', PAGE);
      const png = await mediaAsset(owner, {
        mimeType: 'image/png',
        bytes: PNG,
        widthPx: 1,
        heightPx: 1,
      });
      const entryId = await queued(owner, 'FACEBOOK', page.id, { mediaAssetId: png });
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');
      const post = mock.posts.at(-1);
      expect(post).toMatchObject({ kind: 'photo', text: 'Fresh roast Friday #coffee' });
      expect(post?.bytes?.equals(PNG)).toBe(true);
    });

    it('publishes to Instagram: a container that fetches the image from a signed link, then media_publish', async () => {
      const pro = await account(owner, 'INSTAGRAM', IG_PRO);
      jpegAssetId = await mediaAsset(owner, {
        mimeType: 'image/jpeg',
        bytes: JPEG,
        widthPx: 1080,
        heightPx: 1350,
      });
      const entryId = await queued(owner, 'INSTAGRAM', pro.id, {
        mediaAssetId: jpegAssetId,
        mediaAltText: 'Beans roasting in a drum',
      });
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');

      const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
      expect(row?.externalPostId).toMatch(/^1790\d+$/);
      expect(row?.externalUrl).toMatch(/^https:\/\/www\.instagram\.com\/p\//);
      expect(row?.externalContainerId).toMatch(/^9001\d+$/);
      const container = mock.containers.get(row?.externalContainerId as string);
      // Instagram really fetched the stored object through the signed link.
      expect(container?.bytes.equals(JPEG)).toBe(true);
      expect(container).toMatchObject({
        caption: 'Fresh roast Friday #coffee',
        altText: 'Beans roasting in a drum',
        status: 'PUBLISHED',
      });
      expect(mock.fetchedImages.at(-1)).toContain('X-Amz-Signature');
    });

    it('never publishes to Instagram twice: a retry finds the container already PUBLISHED', async () => {
      const pro = await account(owner, 'INSTAGRAM', IG_PRO);
      const entryId = await queued(owner, 'INSTAGRAM', pro.id, { mediaAssetId: jpegAssetId });
      mock.dropNextPublishResponse = true;
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('FAILED');
      const first = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
      expect(first?.failureCode).toBe('TRANSIENT');
      const published = mock.posts.filter((p) => p.kind === 'instagram').length;

      await requeue(entryId);
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('FAILED');
      const second = await prisma.client.contentScheduleEntry.findUnique({
        where: { id: entryId },
      });
      expect(second?.failureCode).toBe('AMBIGUOUS');
      expect(second?.failureReason).toMatch(/already published by an earlier attempt/);
      expect(mock.posts.filter((p) => p.kind === 'instagram').length).toBe(published);
    });

    it('refuses what Instagram does not accept — text only, PNG, the wrong shape — when scheduling and at publish time', async () => {
      const pro = await account(owner, 'INSTAGRAM', IG_PRO);
      const textOnly = await schedule(owner, 'INSTAGRAM', pro.id);
      expect(textOnly.statusCode).toBe(422);
      expect(problemText(textOnly.json())).toContain('no text-only posts');

      const png = await mediaAsset(owner, {
        mimeType: 'image/png',
        bytes: PNG,
        widthPx: 1080,
        heightPx: 1080,
      });
      const refusedPng = await schedule(owner, 'INSTAGRAM', pro.id, { mediaAssetId: png });
      expect(refusedPng.statusCode).toBe(422);
      expect(problemText(refusedPng.json())).toContain('JPEG images only');

      const tall = await mediaAsset(owner, {
        mimeType: 'image/jpeg',
        bytes: JPEG,
        widthPx: 1080,
        heightPx: 1600,
      });
      const refusedTall = await schedule(owner, 'INSTAGRAM', pro.id, { mediaAssetId: tall });
      expect(refusedTall.statusCode).toBe(422);
      expect(problemText(refusedTall.json())).toContain('4:5 and 1.91:1');

      // Past the API, straight to the database: the executor still refuses, sending nothing.
      const entryId = await directEntry(owner, 'INSTAGRAM', pro.id);
      const calls = graphCalls();
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('FAILED');
      const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
      expect(row?.failureCode).toBe('VALIDATION');
      expect(graphCalls()).toBe(calls);
    });

    it('refuses an Instagram account that is not professional, and a personal Facebook profile, truthfully', async () => {
      const personal = await account(owner, 'INSTAGRAM', IG_PERSONAL);
      const refusedIg = await schedule(owner, 'INSTAGRAM', personal.id, {
        mediaAssetId: jpegAssetId,
      });
      expect(refusedIg.statusCode).toBe(422);
      expect(problemText(refusedIg.json())).toContain('professional (Business or Creator)');

      const profile = await account(owner, 'FACEBOOK', USER_ID);
      const refusedProfile = await schedule(owner, 'FACEBOOK', profile.id);
      expect(refusedProfile.statusCode).toBe(422);
      expect(problemText(refusedProfile.json())).toContain('personal profiles');

      const calls = graphCalls();
      for (const [platform, target, media] of [
        ['INSTAGRAM', personal.id, jpegAssetId],
        ['FACEBOOK', profile.id, undefined],
      ] as const) {
        const entryId = await directEntry(owner, platform, target, media);
        expect((await executePublication(publishDeps(), { entryId })).status).toBe('UNSUPPORTED');
        const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
        expect(row?.failureCode).toBe('UNSUPPORTED_ACCOUNT');
      }
      expect(graphCalls()).toBe(calls);
    });
  });

  describe('tenant isolation', () => {
    it('another tenant can neither schedule to these accounts, attach this media, nor publish through them', async () => {
      const ownerPage = await account(owner, 'FACEBOOK', PAGE);
      const ownerIg = await account(owner, 'INSTAGRAM', IG_PRO);
      expect((await schedule(other, 'FACEBOOK', ownerPage.id)).statusCode).toBe(404);

      const theirPage = await account(other, 'FACEBOOK', PAGE);
      expect(
        (await schedule(other, 'FACEBOOK', theirPage.id, { mediaAssetId: jpegAssetId })).statusCode,
      ).toBe(404);
      // Same Page, two workspaces: each holds its own sealed token.
      expect(theirPage.encryptedToken).not.toBe(ownerPage.encryptedToken);

      const calls = graphCalls();
      for (const [platform, target] of [
        ['FACEBOOK', ownerPage.id],
        ['INSTAGRAM', ownerIg.id],
      ] as const) {
        const entryId = await directEntry(other, platform, target);
        expect((await executePublication(publishDeps(), { entryId })).status).toBe('UNSUPPORTED');
        const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
        expect(row?.failureCode).toBe('NOT_CONNECTED');
      }
      expect(graphCalls()).toBe(calls);
    });
  });

  describe('permissions and tokens', () => {
    it('refuses Instagram without instagram_content_publish, before contacting Meta', async () => {
      const noPublish = await registerTenant('no-ig-publish');
      await connect(noPublish, [...PAGE_SCOPES, 'instagram_basic'], ['instagram_content_publish']);
      const pro = await account(noPublish, 'INSTAGRAM', IG_PRO);
      expect((pro.capabilities as Caps).postTypes['IMAGE']).toMatchObject({
        status: 'MISSING_PERMISSION',
      });

      const asset = await mediaAsset(noPublish, {
        mimeType: 'image/jpeg',
        bytes: JPEG,
        widthPx: 1080,
        heightPx: 1080,
      });
      const refused = await schedule(noPublish, 'INSTAGRAM', pro.id, { mediaAssetId: asset });
      expect(refused.statusCode).toBe(422);
      expect(problemText(refused.json())).toContain('instagram_content_publish');

      const entryId = await directEntry(noPublish, 'INSTAGRAM', pro.id, asset);
      const writes = graphWrites();
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('FAILED');
      const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
      expect(row?.failureCode).toBe('PERMISSION');
      expect(row?.failureReason).toContain('instagram_content_publish');
      expect(graphWrites()).toBe(writes);
    });

    it('keeps publishing to Pages after the user token lapses — Page tokens do not expire', async () => {
      const lapsed = await registerTenant('lapsed');
      const connectionId = await connect(lapsed, ALL_SCOPES);
      const connection = await connectionRow(lapsed, connectionId);
      const bundle = JSON.parse(decryptSecret(connection?.encryptedCredential as string, RING)) as {
        accessToken: string;
      };
      // Sixty days on: Meta no longer honours the user token.
      mock.userTokens.delete(bundle.accessToken);
      await prisma.client.socialConnection.update({
        where: { id: connectionId },
        data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) },
      });

      const list = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${lapsed.workspaceId}/social/connections`,
        headers: { cookie: lapsed.cookie },
      });
      const [row] = list.json() as Array<{ status: string; refresh: { reason: string } }>;
      expect(row?.status).toBe('EXPIRED');
      expect(row?.refresh.reason).toMatch(/publishing to Pages and Instagram continues/);

      const page = await account(lapsed, 'FACEBOOK', PAGE);
      const entryId = await queued(lapsed, 'FACEBOOK', page.id);
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');
    });

    it('asks for a reconnect when Meta invalidates the Page token, stops sending, and a reconnect restores publishing', async () => {
      const page = await account(owner, 'FACEBOOK', PAGE);
      const oldToken = decryptSecret(page.encryptedToken as string, RING);
      mock.revoked.add(oldToken);

      const first = await queued(owner, 'FACEBOOK', page.id);
      expect((await executePublication(publishDeps(), { entryId: first })).status).toBe('FAILED');
      const firstRow = await prisma.client.contentScheduleEntry.findUnique({
        where: { id: first },
      });
      expect(firstRow?.failureCode).toBe('AUTH');
      expect(firstRow?.failureReason).toMatch(/reconnect Meta/);
      expect((await connectionRow(owner, ownerConnectionId))?.status).toBe('REAUTH_REQUIRED');

      const writes = graphWrites();
      const second = await queued(owner, 'FACEBOOK', page.id);
      expect((await executePublication(publishDeps(), { entryId: second })).status).toBe('FAILED');
      const secondRow = await prisma.client.contentScheduleEntry.findUnique({
        where: { id: second },
      });
      expect(secondRow?.failureCode).toBe('REAUTH_REQUIRED');
      expect(graphWrites()).toBe(writes);

      // Reconnect: a fresh grant, renewed in place, re-seals fresh Page tokens.
      const location = await authorize(
        owner,
        `/v1/workspaces/${owner.workspaceId}/social/connections/${ownerConnectionId}/reconnect`,
        ALL_SCOPES,
      );
      expect(location.searchParams.get('oauth')).toBe('reconnected');
      expect((await connectionRow(owner, ownerConnectionId))?.status).toBe('CONNECTED');
      const renewed = await account(owner, 'FACEBOOK', PAGE);
      expect(renewed.id).toBe(page.id);
      expect(decryptSecret(renewed.encryptedToken as string, RING)).not.toBe(oldToken);

      const third = await queued(owner, 'FACEBOOK', page.id);
      expect((await executePublication(publishDeps(), { entryId: third })).status).toBe(
        'PUBLISHED',
      );
    });

    it('deletes every sealed Page token on disconnect', async () => {
      const leaving = await registerTenant('leaving');
      const connectionId = await connect(leaving, ALL_SCOPES);
      const res = await inject().inject({
        method: 'DELETE',
        url: `/v1/workspaces/${leaving.workspaceId}/social/connections/${connectionId}`,
        headers: { cookie: leaving.cookie },
      });
      expect(res.statusCode).toBe(200);
      const rows = await prisma.client.socialAccount.findMany({
        where: { organizationId: leaving.orgId, connectionId },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row).toMatchObject({
          status: 'REVOKED',
          encryptedToken: null,
          credentialKeyId: null,
        });
        expect(row.deletedAt).not.toBeNull();
      }
    });
  });
});
