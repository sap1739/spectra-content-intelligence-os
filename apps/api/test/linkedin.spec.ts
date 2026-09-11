import './setup-env';

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  createMediaLoader,
  createPublisherResolver,
  executePublication,
} from '@spectra/publishing';
import { decryptSecret, generateEncryptionKey } from '@spectra/security';
import { resolveOAuthPlatform } from '@spectra/social-oauth';
import { S3ObjectStorageProvider, buildObjectKey } from '@spectra/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv, resetApiEnvCache } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 6D: LinkedIn as a live publisher (ADR-0035), end to end.
 *
 * "LinkedIn" here is a real HTTP server on 127.0.0.1 that behaves like
 * LinkedIn's official APIs: the OAuth token endpoint, OpenID Connect userinfo,
 * Organization Access Control, organizationsLookup, the Images API (with a
 * real upload URL that receives the bytes) and the Posts API. It enforces what
 * LinkedIn enforces — bearer tokens, per-scope permissions, the version and
 * Rest.li headers, single-use codes — so the adapter is exercised, not stubbed.
 * Every token contains TOKENVALUE, so a leak is one string search.
 */

const runId = randomBytes(4).toString('hex');
const PASSWORD = 'integration-test-password-1';
const KEY = generateEncryptionKey();
const RING = { keys: { 'social-v1': KEY }, activeKeyId: 'social-v1' };
const CLIENT = { id: 'li-client', secret: `li-secret-${runId}` };
const VERSION = '202608';
const MEMBER = 'member123';
const MEMBER_URN = `urn:li:person:${MEMBER}`;
const PAGE_URN = 'urn:li:organization:5515715';
const ALL_SCOPES = [
  'openid',
  'profile',
  'w_member_social',
  'r_organization_admin',
  'w_organization_social',
];
const SELF_SERVE = ['openid', 'profile', 'w_member_social'];
const LEAK = 'TOKENVALUE';
// A 1×1 PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

interface Grant {
  scopes: string[];
  grantId: string;
}

interface MockLinkedIn {
  base: string;
  server: Server;
  codes: Map<string, { scopes: string[]; refresh: boolean; redirectUri: string }>;
  access: Map<string, Grant>;
  refresh: Map<string, Grant>;
  uploads: Map<string, Buffer>;
  calls: Array<{
    method: string;
    path: string;
    query: URLSearchParams;
    headers: IncomingHttpHeaders;
    json: unknown;
  }>;
  posts: Array<{ token: string; body: Record<string, unknown> }>;
  failNextPost: { status: number; body: unknown } | null;
  counter: number;
}

type Send = (status: number, body?: unknown, headers?: Record<string, string>) => void;

function tokenEndpoint(mock: MockLinkedIn, form: URLSearchParams, send: Send): void {
  if (form.get('client_id') !== CLIENT.id || form.get('client_secret') !== CLIENT.secret) {
    return send(401, { error: 'invalid_client' });
  }
  const issueAccess = (grant: Grant) => {
    mock.counter += 1;
    const token = `li-at-${LEAK}-${mock.counter}`;
    mock.access.set(token, grant);
    return token;
  };
  if (form.get('grant_type') === 'authorization_code') {
    const code = form.get('code') ?? '';
    const issued = mock.codes.get(code);
    mock.codes.delete(code); // single use
    if (!issued || issued.redirectUri !== form.get('redirect_uri'))
      return send(400, { error: 'invalid_grant' });
    const grant = { scopes: issued.scopes, grantId: code };
    const response: Record<string, unknown> = {
      access_token: issueAccess(grant),
      expires_in: 5_184_000,
      // LinkedIn reports granted scopes comma-separated.
      scope: grant.scopes.join(','),
    };
    if (issued.refresh) {
      const refreshToken = `li-rt-${LEAK}-${mock.counter}`;
      mock.refresh.set(refreshToken, grant);
      response['refresh_token'] = refreshToken;
      response['refresh_token_expires_in'] = 31_536_000;
    }
    return send(200, response);
  }
  if (form.get('grant_type') === 'refresh_token') {
    const grant = mock.refresh.get(form.get('refresh_token') ?? '');
    if (!grant) return send(400, { error: 'invalid_grant' });
    // A refresh retires the grant's older access tokens: only the new one works.
    for (const [token, existing] of mock.access) {
      if (existing.grantId === grant.grantId) mock.access.delete(token);
    }
    return send(200, {
      access_token: issueAccess(grant),
      expires_in: 5_184_000,
      scope: grant.scopes.join(','),
    });
  }
  return send(400, { error: 'unsupported_grant_type' });
}

function startLinkedIn(): Promise<MockLinkedIn> {
  const mock = {
    codes: new Map(),
    access: new Map(),
    refresh: new Map(),
    uploads: new Map(),
    calls: [],
    posts: [],
    failNextPost: null,
    counter: 0,
  } as unknown as MockLinkedIn;

  mock.server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url ?? '/', 'http://mock.local');
      const path = url.pathname;
      const send: Send = (status, body, headers = {}) => {
        res.writeHead(status, {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...headers,
        });
        res.end(body !== undefined ? JSON.stringify(body) : undefined);
      };
      let json: unknown = null;
      if (
        String(req.headers['content-type'] ?? '').includes('application/json') &&
        raw.length > 0
      ) {
        try {
          json = JSON.parse(raw.toString());
        } catch {
          json = null;
        }
      }
      mock.calls.push({
        method: req.method ?? 'GET',
        path,
        query: url.searchParams,
        headers: req.headers,
        json,
      });

      if (path === '/oauth/v2/accessToken') {
        return tokenEndpoint(mock, new URLSearchParams(raw.toString()), send);
      }

      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const grant = mock.access.get(bearer);
      if (!grant) {
        return send(401, {
          status: 401,
          code: 'EXPIRED_ACCESS_TOKEN',
          message: 'The token used in the request has expired',
        });
      }
      const has = (scope: string) => grant.scopes.includes(scope);
      const canActAs = (owner: string) =>
        owner === MEMBER_URN
          ? has('w_member_social')
          : owner === PAGE_URN
            ? has('w_organization_social')
            : false;

      if (path === '/v2/userinfo') {
        return has('openid') && has('profile')
          ? send(200, {
              sub: MEMBER,
              name: 'Jane Doe',
              email: 'jane@example.com',
              email_verified: true,
            })
          : send(403, { code: 'ACCESS_DENIED' });
      }
      if (
        path.startsWith('/rest/') &&
        (req.headers['linkedin-version'] !== VERSION ||
          req.headers['x-restli-protocol-version'] !== '2.0.0')
      ) {
        return send(400, {
          status: 400,
          code: 'VERSION_MISSING',
          message: 'A version header is required',
        });
      }
      if (path === '/rest/organizationAcls') {
        if (!has('r_organization_admin') && !has('rw_organization_admin'))
          return send(403, { code: 'ACCESS_DENIED' });
        return send(200, {
          paging: { start: 0, count: 100, links: [] },
          elements: [
            {
              role: 'ADMINISTRATOR',
              state: 'APPROVED',
              organization: PAGE_URN,
              roleAssignee: MEMBER_URN,
            },
            {
              role: 'ANALYST',
              state: 'APPROVED',
              organization: 'urn:li:organization:999',
              roleAssignee: MEMBER_URN,
            },
          ],
        });
      }
      if (path === '/rest/organizationsLookup') {
        return send(200, {
          results: { '5515715': { localizedName: 'Acme Corp', vanityName: 'acme', id: 5515715 } },
          statuses: {},
          errors: {},
        });
      }
      if (path === '/rest/images' && url.searchParams.get('action') === 'initializeUpload') {
        const owner =
          (json as { initializeUploadRequest?: { owner?: string } } | null)?.initializeUploadRequest
            ?.owner ?? '';
        if (!canActAs(owner)) return send(403, { code: 'ACCESS_DENIED' });
        mock.counter += 1;
        const id = `C4E10AQ${mock.counter}`;
        return send(200, {
          value: {
            uploadUrl: `${mock.base}/dms-uploads/${id}/uploaded-image/0`,
            image: `urn:li:image:${id}`,
            uploadUrlExpiresAt: Date.now() + 3_600_000,
          },
        });
      }
      if (req.method === 'PUT' && path.startsWith('/dms-uploads/')) {
        mock.uploads.set(`urn:li:image:${path.split('/')[2]}`, raw);
        return send(201);
      }
      if (req.method === 'GET' && path.startsWith('/rest/images/')) {
        // Member-only tokens are write-only for images; page tokens may read.
        if (!has('w_organization_social'))
          return send(403, { status: 403, message: 'Accessing this image resource is forbidden.' });
        const urn = decodeURIComponent(path.slice('/rest/images/'.length));
        return send(200, {
          id: urn,
          status: mock.uploads.has(urn) ? 'AVAILABLE' : 'WAITING_UPLOAD',
        });
      }
      if (req.method === 'POST' && path === '/rest/posts') {
        if (mock.failNextPost) {
          const failure = mock.failNextPost;
          mock.failNextPost = null;
          return send(failure.status, failure.body);
        }
        const body = (json ?? {}) as Record<string, unknown>;
        if (!canActAs(String(body['author']))) {
          return send(403, {
            status: 403,
            code: 'ACCESS_DENIED',
            message: 'Not enough permissions to access: partnerApiPostsExternal.CREATE',
          });
        }
        const media = (body['content'] as { media?: { id?: string } } | undefined)?.media;
        if (media && !mock.uploads.has(String(media.id)))
          return send(400, { status: 400, code: 'INVALID_IMAGE_ID' });
        mock.counter += 1;
        mock.posts.push({ token: bearer, body });
        return send(201, undefined, { 'x-restli-id': `urn:li:share:70000${mock.counter}` });
      }
      return send(404, { code: 'NOT_FOUND' });
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

/** Nest puts an HttpException's message in `title`; read both, as clients do. */
function problemText(body: unknown): string {
  const problem = body as { title?: string; detail?: string };
  return `${problem.title ?? ''} ${problem.detail ?? ''}`;
}

describe('API integration: LinkedIn live publishing (ADR-0035)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let mock: MockLinkedIn;
  let storage: S3ObjectStorageProvider;
  const tenants: Tenant[] = [];
  const storedKeys: string[] = [];

  let owner: Tenant;
  let selfServe: Tenant;
  let ownerConnectionId = '';
  let pageImageAssetId = '';
  let publishedEntryId = '';

  const inject = () => app.getHttpAdapter().getInstance();

  async function registerTenant(label: string): Promise<Tenant> {
    const email = `li-${label}-${runId}@itest.local`;
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, name: `LinkedIn ${label}` },
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

  /** Runs the real 6C OAuth flow; the mock plays LinkedIn's consent screen. */
  async function connect(t: Tenant, scopes: string[], options: { refresh?: boolean } = {}) {
    const started = await inject().inject({
      method: 'POST',
      url: `/v1/workspaces/${t.workspaceId}/social/oauth/linkedin/start`,
      headers: { cookie: t.cookie },
      payload: {},
    });
    expect(started.statusCode).toBe(201);
    const url = new URL((started.json() as { authorizationUrl: string }).authorizationUrl);
    const code = `code-${randomBytes(6).toString('hex')}`;
    mock.codes.set(code, {
      scopes,
      refresh: options.refresh ?? false,
      redirectUri: url.searchParams.get('redirect_uri') as string,
    });
    const callback = await inject().inject({
      method: 'GET',
      url: `/v1/social/oauth/linkedin/callback?${new URLSearchParams({
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

  async function account(t: Tenant, externalAccountId: string) {
    const row = await prisma.client.socialAccount.findFirst({
      where: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        externalAccountId,
        deletedAt: null,
      },
    });
    if (!row) throw new Error(`no account ${externalAccountId}`);
    return row;
  }

  async function approvedItem(t: Tenant, body = 'Q3 is up (again) #results') {
    return prisma.client.contentItem.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        title: 'Q3 results',
        contentType: 'POST',
        lifecycleState: 'APPROVED',
        body,
      },
    });
  }

  async function schedule(
    t: Tenant,
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
        platform: 'LINKEDIN',
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
    socialAccountId: string,
    extra: { mediaAssetId?: string; mediaAltText?: string } = {},
  ) {
    const res = await schedule(t, socialAccountId, extra);
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
  async function directEntry(t: Tenant, socialAccountId: string, mediaAssetId?: string) {
    const item = await approvedItem(t);
    const entry = await prisma.client.contentScheduleEntry.create({
      data: {
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        contentItemId: item.id,
        platform: 'LINKEDIN',
        scheduledAt: new Date(),
        status: 'QUEUED',
        socialAccountId,
        idempotencyKey: randomUUID(),
        ...(mediaAssetId ? { mediaAssetId } : {}),
      },
    });
    return entry.id;
  }

  async function mediaAsset(t: Tenant, kind: 'IMAGE' | 'VIDEO' = 'IMAGE', mimeType = 'image/png') {
    const id = randomUUID();
    const key = buildObjectKey({
      organizationId: t.orgId,
      workspaceId: t.workspaceId,
      domain: 'media',
      resourceId: id,
      filename: kind === 'IMAGE' ? 'chart.png' : 'clip.mp4',
    });
    await storage.putObject({ key, body: PNG, contentType: mimeType });
    storedKeys.push(key);
    await prisma.client.mediaAsset.create({
      data: {
        id,
        organizationId: t.orgId,
        workspaceId: t.workspaceId,
        kind,
        storageKey: key,
        mimeType,
        sizeBytes: PNG.length,
        widthPx: kind === 'IMAGE' ? 1 : null,
        heightPx: kind === 'IMAGE' ? 1 : null,
      },
    });
    return id;
  }

  /** The worker's exact wiring, against the mock. */
  function publishDeps() {
    const oauth = resolveOAuthPlatform(getApiEnv(), 'LINKEDIN');
    return {
      prisma: prisma.client,
      resolvePublisher: createPublisherResolver({
        prisma: prisma.client,
        ring: RING,
        linkedin: {
          api: { apiBaseUrl: mock.base, version: VERSION },
          oauth: oauth.configured ? oauth.config : null,
          imageStatusChecks: 2,
          sleep: async () => undefined,
        },
      }),
      loadMedia: createMediaLoader(storage),
    };
  }

  const postCalls = () => mock.calls.filter((c) => c.path === '/rest/posts').length;

  beforeAll(async () => {
    mock = await startLinkedIn();
    Object.assign(process.env, {
      SOCIAL_TOKEN_ENCRYPTION_KEY: KEY,
      SOCIAL_OAUTH_REDIRECT_BASE_URL: 'http://localhost:4100',
      SOCIAL_OAUTH_LINKEDIN_CLIENT_ID: CLIENT.id,
      SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET: CLIENT.secret,
      SOCIAL_OAUTH_LINKEDIN_AUTHORIZATION_URL: `${mock.base}/oauth/v2/authorization`,
      SOCIAL_OAUTH_LINKEDIN_TOKEN_URL: `${mock.base}/oauth/v2/accessToken`,
      SOCIAL_OAUTH_LINKEDIN_SCOPES: ALL_SCOPES.join(' '),
      LINKEDIN_API_BASE_URL: mock.base,
      LINKEDIN_API_VERSION: VERSION,
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

  describe('connection and discovery', () => {
    it('discovers the member and the pages they can post as, each with its capabilities', async () => {
      ownerConnectionId = await connect(owner, ALL_SCOPES);
      const connection = await prisma.client.socialConnection.findFirst({
        where: { id: ownerConnectionId, organizationId: owner.orgId },
      });
      expect(connection).toMatchObject({
        discoveryStatus: 'COMPLETE',
        externalSubjectId: MEMBER_URN,
      });

      const member = await account(owner, MEMBER_URN);
      expect(member).toMatchObject({
        kind: 'PROFILE',
        displayName: 'Jane Doe',
        status: 'CONNECTED',
      });
      expect(member.connectionId).toBe(ownerConnectionId);
      const memberCaps = member.capabilities as { postTypes: Record<string, { status: string }> };
      expect(memberCaps.postTypes['TEXT']?.status).toBe('AVAILABLE');
      expect(memberCaps.postTypes['VIDEO']?.status).toBe('NOT_IMPLEMENTED');
      // The member's email was returned by userinfo and deliberately not kept.
      expect(JSON.stringify(member)).not.toContain('jane@example.com');

      const page = await account(owner, PAGE_URN);
      expect(page).toMatchObject({ kind: 'PAGE', displayName: 'Acme Corp' });
      // An ANALYST role cannot post, so that page is not a target.
      expect(
        await prisma.client.socialAccount.findFirst({
          where: { organizationId: owner.orgId, externalAccountId: 'urn:li:organization:999' },
        }),
      ).toBeNull();

      const list = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${owner.workspaceId}/social/connections`,
        headers: { cookie: owner.cookie },
      });
      expect(list.body).not.toContain(LEAK);
      const [row] = list.json() as Array<{
        permissions: Array<{ id: string; status: string }>;
        accounts: Array<{ externalAccountId: string; capabilities: unknown }>;
      }>;
      expect(row?.permissions.every((p) => p.status === 'GRANTED')).toBe(true);
      expect(row?.accounts.map((a) => a.externalAccountId).sort()).toEqual(
        [PAGE_URN, MEMBER_URN].sort(),
      );
    });

    it('reports LinkedIn publishing as wired, with exactly what it can post', async () => {
      const declared = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${owner.workspaceId}/social/platforms`,
        headers: { cookie: owner.cookie },
      });
      const entry = (
        declared.json() as {
          platforms: Array<{
            capability: { platform: string };
            publisherWired: boolean;
            publisherSummary: string | null;
          }>;
        }
      ).platforms.find((p) => p.capability.platform === 'LINKEDIN');
      expect(entry?.publisherWired).toBe(true);
      expect(entry?.publisherSummary).toMatch(/Video, document, multi-image/);

      const oauth = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${owner.workspaceId}/social/oauth/platforms`,
        headers: { cookie: owner.cookie },
      });
      const linkedIn = (
        oauth.json() as {
          platforms: Array<{
            platform: string;
            adapters: { publishing: boolean };
            limitation: string;
          }>;
        }
      ).platforms.find((p) => p.platform === 'LINKEDIN');
      expect(linkedIn?.adapters.publishing).toBe(true);
      expect(linkedIn?.limitation).toBe(entry?.publisherSummary);
    });

    it('names the missing products for a self-serve app, and looks up no pages', async () => {
      selfServe = await registerTenant('self-serve');
      const aclCalls = mock.calls.filter((c) => c.path === '/rest/organizationAcls').length;
      await connect(selfServe, SELF_SERVE);
      expect(mock.calls.filter((c) => c.path === '/rest/organizationAcls').length).toBe(aclCalls);

      const list = await inject().inject({
        method: 'GET',
        url: `/v1/workspaces/${selfServe.workspaceId}/social/connections`,
        headers: { cookie: selfServe.cookie },
      });
      const [row] = list.json() as Array<{
        permissions: Array<{
          id: string;
          status: string;
          reviewRequired: boolean;
          missingScopes: string[];
        }>;
        accounts: Array<{ externalAccountId: string }>;
      }>;
      const byId = Object.fromEntries((row?.permissions ?? []).map((p) => [p.id, p]));
      expect(byId['share-on-linkedin']?.status).toBe('GRANTED');
      expect(byId['community-management-posting']).toMatchObject({
        status: 'MISSING',
        reviewRequired: true,
        missingScopes: ['w_organization_social'],
      });
      expect(row?.accounts.map((a) => a.externalAccountId)).toEqual([MEMBER_URN]);
    });
  });

  describe('publishing', () => {
    it('publishes a text post as the member through the Posts API', async () => {
      const member = await account(owner, MEMBER_URN);
      const entryId = await queued(owner, member.id);
      const outcome = await executePublication(publishDeps(), { entryId });
      expect(outcome.status).toBe('PUBLISHED');

      const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
      expect(row?.status).toBe('PUBLISHED');
      expect(row?.externalPostId).toMatch(/^urn:li:share:/);
      expect(row?.externalUrl).toBe(`https://www.linkedin.com/feed/update/${row?.externalPostId}/`);
      expect(row?.failureCode).toBeNull();
      expect(mock.posts.at(-1)?.body).toMatchObject({
        author: MEMBER_URN,
        commentary: 'Q3 is up \\(again\\) #results',
        visibility: 'PUBLIC',
        lifecycleState: 'PUBLISHED',
      });
      const item = await prisma.client.contentItem.findUnique({
        where: { id: row?.contentItemId as string },
      });
      expect(item?.lifecycleState).toBe('PUBLISHED');
    });

    it('publishes a single-image post as the page: register, upload, confirm processing, attach', async () => {
      const page = await account(owner, PAGE_URN);
      pageImageAssetId = await mediaAsset(owner);
      publishedEntryId = await queued(owner, page.id, {
        mediaAssetId: pageImageAssetId,
        mediaAltText: 'A chart of Q3 results',
      });
      const outcome = await executePublication(publishDeps(), { entryId: publishedEntryId });
      expect(outcome.status).toBe('PUBLISHED');

      const init = mock.calls.filter((c) => c.query.get('action') === 'initializeUpload').at(-1);
      expect(init?.json).toEqual({ initializeUploadRequest: { owner: PAGE_URN } });
      const upload = await prisma.client.socialMediaUpload.findFirst({
        where: {
          organizationId: owner.orgId,
          socialAccountId: page.id,
          mediaAssetId: pageImageAssetId,
        },
      });
      expect(upload).toMatchObject({ status: 'UPLOADED', verified: true });
      expect(mock.uploads.get(upload?.externalMediaId as string)?.equals(PNG)).toBe(true);
      // A page token may read image status, so processing was confirmed first.
      expect(mock.calls.some((c) => c.method === 'GET' && c.path.startsWith('/rest/images/'))).toBe(
        true,
      );
      expect(mock.posts.at(-1)?.body).toMatchObject({
        author: PAGE_URN,
        content: { media: { id: upload?.externalMediaId, altText: 'A chart of Q3 results' } },
      });
      const row = await prisma.client.contentScheduleEntry.findUnique({
        where: { id: publishedEntryId },
      });
      expect(upload?.lastPostId).toBe(row?.externalPostId);
    });

    it('never re-sends a finished entry, and a retried attempt reuses the uploaded image', async () => {
      const posts = postCalls();
      expect((await executePublication(publishDeps(), { entryId: publishedEntryId })).status).toBe(
        'SKIPPED',
      );
      expect(postCalls()).toBe(posts);

      const page = await account(owner, PAGE_URN);
      const entryId = await queued(owner, page.id, { mediaAssetId: pageImageAssetId });
      const initializations = () =>
        mock.calls.filter((c) => c.query.get('action') === 'initializeUpload').length;
      const initsBefore = initializations();

      mock.failNextPost = { status: 429, body: { status: 429, code: 'TOO_MANY_REQUESTS' } };
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('FAILED');
      const failed = await prisma.client.contentScheduleEntry.findUnique({
        where: { id: entryId },
      });
      expect(failed?.failureCode).toBe('RATE_LIMIT');
      expect(failed?.failureReason).toMatch(/rate limit/i);

      await requeue(entryId);
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');
      // The image LinkedIn already holds was reused — never uploaded twice.
      expect(initializations()).toBe(initsBefore);
    });

    it('refuses formats LinkedIn does not accept, and video, when scheduling — and at publish time', async () => {
      const member = await account(owner, MEMBER_URN);
      const webp = await mediaAsset(owner, 'IMAGE', 'image/webp');
      const refusedWebp = await schedule(owner, member.id, { mediaAssetId: webp });
      expect(refusedWebp.statusCode).toBe(422);
      expect(problemText(refusedWebp.json())).toContain('JPG, PNG and GIF');

      const video = await mediaAsset(owner, 'VIDEO', 'video/mp4');
      const refusedVideo = await schedule(owner, member.id, { mediaAssetId: video });
      expect(refusedVideo.statusCode).toBe(422);
      expect(problemText(refusedVideo.json())).toContain('does not upload video');

      // Written straight to the database, past the API: the executor still refuses.
      const entryId = await directEntry(owner, member.id, video);
      const calls = mock.calls.length;
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('UNSUPPORTED');
      const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
      expect(row?.failureCode).toBe('UNSUPPORTED_MEDIA');
      expect(mock.calls.length).toBe(calls);
    });
  });

  describe('tenant isolation', () => {
    it('another tenant can neither schedule to this account, attach this media, nor publish through it', async () => {
      const ownerMember = await account(owner, MEMBER_URN);
      expect((await schedule(selfServe, ownerMember.id)).statusCode).toBe(404);

      const theirMember = await account(selfServe, MEMBER_URN);
      expect(
        (await schedule(selfServe, theirMember.id, { mediaAssetId: pageImageAssetId })).statusCode,
      ).toBe(404);

      // An entry in their workspace pointing at our account, written directly.
      const entryId = await directEntry(selfServe, ownerMember.id);
      const calls = mock.calls.length;
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('UNSUPPORTED');
      const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
      expect(row?.failureCode).toBe('NOT_CONNECTED');
      expect(mock.calls.length).toBe(calls);
    });
  });

  describe('permissions and tokens', () => {
    it('refuses to post without w_member_social, before contacting LinkedIn', async () => {
      const noShare = await registerTenant('no-share');
      await connect(noShare, ['openid', 'profile']);
      const member = await account(noShare, MEMBER_URN);
      expect(
        (member.capabilities as { postTypes: Record<string, { status: string }> }).postTypes['TEXT']
          ?.status,
      ).toBe('MISSING_PERMISSION');

      const refused = await schedule(noShare, member.id);
      expect(refused.statusCode).toBe(422);
      expect(problemText(refused.json())).toContain('w_member_social');

      const entryId = await directEntry(noShare, member.id);
      const posts = postCalls();
      expect((await executePublication(publishDeps(), { entryId })).status).toBe('FAILED');
      const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
      expect(row).toMatchObject({ failureCode: 'PERMISSION' });
      expect(row?.failureReason).toContain('w_member_social');
      expect(postCalls()).toBe(posts);
    });

    it('refreshes an expired token before publishing, and re-seals the new one', async () => {
      const partner = await registerTenant('partner');
      const connectionId = await connect(partner, SELF_SERVE, { refresh: true });
      await prisma.client.socialConnection.update({
        where: { id: connectionId },
        data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) },
      });
      const member = await account(partner, MEMBER_URN);
      const entryId = await queued(partner, member.id);

      expect((await executePublication(publishDeps(), { entryId })).status).toBe('PUBLISHED');
      const refreshCall = mock.calls.filter((c) => c.path === '/oauth/v2/accessToken').at(-2);
      expect(refreshCall).toBeDefined();
      // The mock retires old access tokens on refresh, so success proves the new one was used.
      const usedToken = mock.posts.at(-1)?.token as string;
      expect(mock.access.has(usedToken)).toBe(true);

      const connection = await prisma.client.socialConnection.findFirst({
        where: { id: connectionId, organizationId: partner.orgId },
      });
      expect(connection?.lastRefreshedAt).not.toBeNull();
      expect(connection?.accessTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now());
      const bundle = JSON.parse(decryptSecret(connection?.encryptedCredential as string, RING)) as {
        accessToken: string;
        refreshToken: string;
      };
      expect(bundle.accessToken).toBe(usedToken);
      // LinkedIn does not rotate refresh tokens: the original is kept, not dropped.
      expect(bundle.refreshToken).toContain('li-rt-');
    });

    it('asks for a reconnect when the token expired and LinkedIn issued no refresh token', async () => {
      const lapsed = await registerTenant('lapsed');
      const connectionId = await connect(lapsed, SELF_SERVE);
      await prisma.client.socialConnection.update({
        where: { id: connectionId },
        data: { accessTokenExpiresAt: new Date(Date.now() - 60_000) },
      });
      const member = await account(lapsed, MEMBER_URN);
      const entryId = await queued(lapsed, member.id);
      const posts = postCalls();

      expect((await executePublication(publishDeps(), { entryId })).status).toBe('FAILED');
      const row = await prisma.client.contentScheduleEntry.findUnique({ where: { id: entryId } });
      expect(row?.failureCode).toBe('REAUTH_REQUIRED');
      expect(row?.failureReason).toMatch(/expired/);
      expect(row?.failureReason).toMatch(/Reconnect LinkedIn/);
      const connection = await prisma.client.socialConnection.findFirst({
        where: { id: connectionId, organizationId: lapsed.orgId },
      });
      expect(connection?.status).toBe('EXPIRED');
      expect(postCalls()).toBe(posts);
    });

    it('marks the connection for reconnect when LinkedIn rejects the token, then stops sending', async () => {
      const member = await account(owner, MEMBER_URN);
      mock.failNextPost = { status: 401, body: { status: 401, code: 'EXPIRED_ACCESS_TOKEN' } };
      const first = await queued(owner, member.id);
      expect((await executePublication(publishDeps(), { entryId: first })).status).toBe('FAILED');
      const firstRow = await prisma.client.contentScheduleEntry.findUnique({
        where: { id: first },
      });
      expect(firstRow?.failureCode).toBe('AUTH');
      const connection = await prisma.client.socialConnection.findFirst({
        where: { id: ownerConnectionId, organizationId: owner.orgId },
      });
      expect(connection?.status).toBe('REAUTH_REQUIRED');

      const posts = postCalls();
      const second = await queued(owner, member.id);
      expect((await executePublication(publishDeps(), { entryId: second })).status).toBe('FAILED');
      const secondRow = await prisma.client.contentScheduleEntry.findUnique({
        where: { id: second },
      });
      expect(secondRow?.failureCode).toBe('REAUTH_REQUIRED');
      expect(postCalls()).toBe(posts);
    });
  });
});
