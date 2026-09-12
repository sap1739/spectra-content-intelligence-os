import './setup-env';

import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { decryptSecret, generateEncryptionKey } from '@spectra/security';
import {
  accountDiscoveryRegistry,
  type AccountDiscoveryPort,
  type DiscoveryMetadata,
} from '@spectra/social-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv, resetApiEnvCache } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 6C OAuth token brokering (ADR-0034), end to end.
 *
 * The platform is a real HTTP server on 127.0.0.1 that behaves like an OAuth
 * provider: it issues single-use codes, verifies the PKCE verifier against the
 * challenge, checks client authentication, rotates refresh tokens and records
 * revocations. Nothing in Spectra is mocked — the API makes real requests.
 * Every token it issues contains TOKENVALUE, so a leak is one string search.
 */

const runId = randomBytes(4).toString('hex');
const PASSWORD = 'integration-test-password-1';
const WEB = 'http://localhost:3000';
const ENCRYPTION_KEY = generateEncryptionKey();
const RING = { keys: { 'social-v1': ENCRYPTION_KEY }, activeKeyId: 'social-v1' };
const LEAK = 'TOKENVALUE';

const CLIENTS = {
  x: { id: 'x-test-client', secret: `x-secret-${runId}` },
  linkedin: { id: 'li-test-client', secret: `li-secret-${runId}` },
  tiktok: { id: 'tt-test-key', secret: `tt-secret-${runId}` },
} as const;
type MockPlatform = keyof typeof CLIENTS;

interface Provider {
  base: string;
  server: Server;
  codes: Map<string, { challenge: string | null; redirectUri: string }>;
  refreshTokens: Set<string>;
  tokenRequests: Array<{ platform: string; form: URLSearchParams }>;
  revocations: Array<{ platform: string; form: URLSearchParams }>;
  rejectRefresh: boolean;
  issued: number;
}

function tokenResponse(platform: string, provider: Provider): Record<string, unknown> {
  provider.issued += 1;
  const n = `${provider.issued}-${randomBytes(3).toString('hex')}`;
  if (platform === 'x') {
    const refresh = `x-rt-${LEAK}-${n}`;
    provider.refreshTokens.add(refresh);
    return {
      access_token: `x-at-${LEAK}-${n}`,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: 7200,
      scope: 'tweet.read tweet.write users.read offline.access',
    };
  }
  if (platform === 'tiktok') {
    return {
      access_token: `tt-at-${LEAK}-${n}`,
      refresh_token: `tt-rt-${LEAK}-${n}`,
      expires_in: 86400,
      open_id: 'tt-open-id-1',
      scope: 'user.info.basic,video.publish',
    };
  }
  // LinkedIn without partner access: no refresh token, no scope list.
  return { access_token: `li-at-${LEAK}-${n}`, expires_in: 5184000 };
}

function startProvider(): Promise<Provider> {
  const provider = {
    codes: new Map(),
    refreshTokens: new Set<string>(),
    tokenRequests: [],
    revocations: [],
    rejectRefresh: false,
    issued: 0,
  } as unknown as Provider;

  provider.server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    req.on('end', () => {
      const form = new URLSearchParams(raw);
      const path = (req.url ?? '').split('?')[0] ?? '';
      const platform = path.split('/')[1] as MockPlatform;
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (path.endsWith('/revoke')) {
        provider.revocations.push({ platform, form });
        return send(200, {});
      }
      if (!path.endsWith('/token') || !(platform in CLIENTS)) return send(404, {});
      provider.tokenRequests.push({ platform, form });

      const client = CLIENTS[platform];
      if (platform === 'x') {
        const expected = `Basic ${Buffer.from(`${client.id}:${client.secret}`).toString('base64')}`;
        if (req.headers.authorization !== expected) return send(401, { error: 'invalid_client' });
      } else {
        const idParam = platform === 'tiktok' ? 'client_key' : 'client_id';
        if (form.get(idParam) !== client.id || form.get('client_secret') !== client.secret) {
          return send(401, { error: 'invalid_client' });
        }
      }

      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? '';
        const issued = provider.codes.get(code);
        provider.codes.delete(code); // single use, like a real platform
        if (!issued || issued.redirectUri !== form.get('redirect_uri')) {
          return send(400, { error: 'invalid_grant' });
        }
        if (issued.challenge) {
          const verifier = form.get('code_verifier') ?? '';
          if (createHash('sha256').update(verifier).digest('base64url') !== issued.challenge) {
            return send(400, { error: 'invalid_grant' });
          }
        }
        return send(200, tokenResponse(platform, provider));
      }
      if (form.get('grant_type') === 'refresh_token') {
        const presented = form.get('refresh_token') ?? '';
        if (provider.rejectRefresh || !provider.refreshTokens.has(presented)) {
          return send(400, { error: 'invalid_grant' });
        }
        provider.refreshTokens.delete(presented); // rotated: the old one is spent
        return send(200, tokenResponse(platform, provider));
      }
      return send(400, { error: 'unsupported_grant_type' });
    });
  });

  return new Promise((resolve) => {
    provider.server.listen(0, '127.0.0.1', () => {
      const { port } = provider.server.address() as AddressInfo;
      provider.base = `http://127.0.0.1:${port}`;
      resolve(provider);
    });
  });
}

interface MeBody {
  user: { id: string };
  memberships: Array<{ organizationId: string }>;
  workspaces: Array<{ id: string }>;
}

/** Nest puts an HttpException's message in `title`; read both, as clients do. */
function problemText(body: unknown): string {
  const problem = body as { title?: string; detail?: string };
  return `${problem.title ?? ''} ${problem.detail ?? ''}`;
}

function cookieOf(setCookie: string | string[] | undefined): string {
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  if (!raw) throw new Error('expected a set-cookie header');
  return raw.split(';')[0] as string;
}

describe('API integration: OAuth token brokering (ADR-0034)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let provider: Provider;
  const users: Array<{ email: string; orgId: string }> = [];

  // Owner of the workspace under test, plus a second tenant.
  let owner = { cookie: '', userId: '', orgId: '', workspaceId: '' };
  let other = { cookie: '', userId: '', orgId: '', workspaceId: '' };
  let xConnectionId = '';
  let linkedInConnectionId = '';

  const inject = () => app.getHttpAdapter().getInstance();

  async function registerUser(label: string) {
    const email = `oauth-${label}-${runId}@itest.local`;
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, name: `OAuth ${label}` },
    });
    const me = res.json() as MeBody;
    const orgId = me.memberships[0]?.organizationId as string;
    users.push({ email, orgId });
    return {
      cookie: cookieOf(res.headers['set-cookie']),
      userId: me.user.id,
      orgId,
      workspaceId: me.workspaces[0]?.id as string,
    };
  }

  const ws = (workspaceId = owner.workspaceId) => `/v1/workspaces/${workspaceId}/social`;

  async function start(platform: string, cookie = owner.cookie, workspaceId = owner.workspaceId) {
    return inject().inject({
      method: 'POST',
      url: `${ws(workspaceId)}/oauth/${platform}/start`,
      headers: { cookie },
      payload: {},
    });
  }

  /** Plays the platform's consent screen: issues a code bound to the URL's challenge. */
  function consent(authorizationUrl: string, overrides: { challenge?: string | null } = {}) {
    const url = new URL(authorizationUrl);
    const state = url.searchParams.get('state') as string;
    const code = `code-${randomBytes(8).toString('hex')}`;
    provider.codes.set(code, {
      challenge:
        overrides.challenge !== undefined
          ? overrides.challenge
          : url.searchParams.get('code_challenge'),
      redirectUri: url.searchParams.get('redirect_uri') as string,
    });
    return { code, state };
  }

  async function callback(platform: string, params: Record<string, string>, cookie?: string) {
    const res = await inject().inject({
      method: 'GET',
      url: `/v1/social/oauth/${platform}/callback?${new URLSearchParams(params).toString()}`,
      headers: cookie ? { cookie } : {},
    });
    expect(res.statusCode).toBe(302);
    const location = res.headers.location as string;
    // The ONLY place the callback ever sends a browser: the allow-listed web path.
    expect(location.startsWith(`${WEB}/social-accounts?`)).toBe(true);
    expect(location).not.toContain(LEAK);
    expect(res.headers['cache-control']).toBe('no-store');
    return new URL(location);
  }

  async function connect(platform: string, cookie = owner.cookie) {
    const started = await start(platform, cookie);
    expect(started.statusCode).toBe(201);
    const { code, state } = consent(
      (started.json() as { authorizationUrl: string }).authorizationUrl,
    );
    return callback(platform, { code, state }, cookie);
  }

  beforeAll(async () => {
    provider = await startProvider();
    Object.assign(process.env, {
      SOCIAL_TOKEN_ENCRYPTION_KEY: ENCRYPTION_KEY,
      SOCIAL_OAUTH_REDIRECT_BASE_URL: 'http://localhost:4100',
      SOCIAL_OAUTH_X_CLIENT_ID: CLIENTS.x.id,
      SOCIAL_OAUTH_X_CLIENT_SECRET: CLIENTS.x.secret,
      SOCIAL_OAUTH_X_AUTHORIZATION_URL: `${provider.base}/x/authorize`,
      SOCIAL_OAUTH_X_TOKEN_URL: `${provider.base}/x/token`,
      SOCIAL_OAUTH_X_REVOCATION_URL: `${provider.base}/x/revoke`,
      SOCIAL_OAUTH_LINKEDIN_CLIENT_ID: CLIENTS.linkedin.id,
      SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET: CLIENTS.linkedin.secret,
      SOCIAL_OAUTH_LINKEDIN_AUTHORIZATION_URL: `${provider.base}/linkedin/authorize`,
      SOCIAL_OAUTH_LINKEDIN_TOKEN_URL: `${provider.base}/linkedin/token`,
      SOCIAL_OAUTH_TIKTOK_CLIENT_ID: CLIENTS.tiktok.id,
      SOCIAL_OAUTH_TIKTOK_CLIENT_SECRET: CLIENTS.tiktok.secret,
      SOCIAL_OAUTH_TIKTOK_AUTHORIZATION_URL: `${provider.base}/tiktok/authorize`,
      SOCIAL_OAUTH_TIKTOK_TOKEN_URL: `${provider.base}/tiktok/token`,
      SOCIAL_OAUTH_TIKTOK_REVOCATION_URL: `${provider.base}/tiktok/revoke`,
      // LinkedIn discovery runs on connect (6D): keep it on the local server.
      LINKEDIN_API_BASE_URL: provider.base,
    });
    resetApiEnvCache();
    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    owner = await registerUser('owner');
    other = await registerUser('other');
  });

  afterAll(async () => {
    for (const user of users) {
      await prisma.client.organization.delete({ where: { id: user.orgId } }).catch(() => undefined);
      await prisma.client.user.delete({ where: { email: user.email } }).catch(() => undefined);
    }
    await app.close();
    await new Promise((resolve) => provider.server.close(resolve));
  });

  describe('configuration', () => {
    it('lists every OAuth platform, says what is missing, and never returns a secret', async () => {
      const res = await inject().inject({
        method: 'GET',
        url: `${ws()}/oauth/platforms`,
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        credentialStorageConfigured: boolean;
        platforms: Array<{
          platform: string;
          configured: boolean;
          missingConfiguration: string[];
          redirectUri: string | null;
          canConnect: boolean;
          adapters: { publishing: boolean; discovery: boolean };
          approval: { required: boolean; notes: string[] };
        }>;
      };
      expect(body.credentialStorageConfigured).toBe(true);
      expect(body.platforms).toHaveLength(8);

      const x = body.platforms.find((p) => p.platform === 'X');
      expect(x?.configured).toBe(true);
      expect(x?.canConnect).toBe(true);
      expect(x?.redirectUri).toBe('http://localhost:4100/v1/social/oauth/x/callback');

      const facebook = body.platforms.find((p) => p.platform === 'FACEBOOK');
      expect(facebook?.configured).toBe(false);
      expect(facebook?.canConnect).toBe(false);
      expect(facebook?.missingConfiguration).toEqual([
        'SOCIAL_OAUTH_FACEBOOK_CLIENT_ID',
        'SOCIAL_OAUTH_FACEBOOK_CLIENT_SECRET',
      ]);
      expect(facebook?.approval.notes.length).toBeGreaterThan(0);

      // Every OAuth platform has a publishing adapter after 6G (ADR-0038).
      expect(
        body.platforms
          .filter((p) => p.adapters.publishing)
          .map((p) => p.platform)
          .sort(),
      ).toEqual([
        'FACEBOOK',
        'INSTAGRAM',
        'LINKEDIN',
        'PINTEREST',
        'THREADS',
        'TIKTOK',
        'X',
        'YOUTUBE',
      ]);
      for (const client of Object.values(CLIENTS)) expect(res.body).not.toContain(client.secret);
    });

    it('refuses to start a platform that is not configured, naming what is missing', async () => {
      const res = await start('facebook');
      expect(res.statusCode).toBe(503);
      expect(problemText(res.json())).toContain('SOCIAL_OAUTH_FACEBOOK_CLIENT_ID');
    });

    it('refuses a platform that is not an OAuth platform', async () => {
      const res = await start('wordpress');
      expect(res.statusCode).toBe(400);
    });
  });

  describe('the flow', () => {
    it('starts with a fixed redirect URI, a stored-as-hash state and an S256 PKCE challenge', async () => {
      const res = await start('x');
      expect(res.statusCode).toBe(201);
      const body = res.json() as { authorizationUrl: string; expiresAt: string };
      const url = new URL(body.authorizationUrl);
      expect(`${url.origin}${url.pathname}`).toBe(`${provider.base}/x/authorize`);
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:4100/v1/social/oauth/x/callback',
      );
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('client_id')).toBe(CLIENTS.x.id);
      expect(body.authorizationUrl).not.toContain(CLIENTS.x.secret);

      const state = url.searchParams.get('state') as string;
      const attempt = await prisma.client.socialOAuthAttempt.findFirst({
        where: {
          organizationId: owner.orgId,
          stateHash: createHash('sha256').update(state).digest('hex'),
        },
      });
      expect(attempt).not.toBeNull();
      // Only the hash is stored, and the verifier is sealed.
      expect(JSON.stringify(attempt)).not.toContain(state);
      expect(attempt?.encryptedCodeVerifier?.startsWith('v1.social-v1.')).toBe(true);
      expect(Date.parse(body.expiresAt)).toBeGreaterThan(Date.now());
    });

    it('completes: the platform verifies PKCE, tokens are sealed, and nothing leaks', async () => {
      const location = await connect('x');
      expect(location.searchParams.get('oauth')).toBe('connected');
      expect(location.searchParams.get('platform')).toBe('x');
      xConnectionId = location.searchParams.get('connection') as string;

      // The exchange carried a verifier whose S256 matched the challenge —
      // the mock platform refuses the code otherwise.
      const exchange = provider.tokenRequests.at(-1);
      expect(exchange?.form.get('grant_type')).toBe('authorization_code');
      expect(exchange?.form.get('code_verifier')).toBeTruthy();

      const row = await prisma.client.socialConnection.findFirst({
        where: { id: xConnectionId, organizationId: owner.orgId },
      });
      expect(row?.status).toBe('CONNECTED');
      expect(row?.credentialKeyId).toBe('social-v1');
      expect(row?.encryptedCredential?.startsWith('v1.social-v1.')).toBe(true);
      expect(row?.encryptedCredential).not.toContain(LEAK);
      const bundle = JSON.parse(decryptSecret(row?.encryptedCredential as string, RING)) as {
        accessToken: string;
        refreshToken: string;
      };
      expect(bundle.accessToken).toContain('x-at-');
      expect(bundle.refreshToken).toContain('x-rt-');
      expect(row?.hasRefreshToken).toBe(true);
      expect(row?.grantedScopesReported).toBe(true);
      expect(row?.grantedScopes).toContain('tweet.write');
      // X gained a discovery adapter in 6G: discovery runs, and against this
      // OAuth stand-in (which serves no X user endpoint) it records the failure
      // rather than inventing an account.
      expect(row?.discoveryStatus).toBe('FAILED');
      expect(row?.accessTokenExpiresAt?.getTime()).toBeGreaterThan(Date.now() + 7_000_000);

      const list = await inject().inject({
        method: 'GET',
        url: `${ws()}/connections`,
        headers: { cookie: owner.cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.body).not.toContain(LEAK);
      expect(list.body).not.toContain('encryptedCredential');
      const rows = list.json() as Array<{
        id: string;
        discovery: { status: string };
        publishing: { wired: boolean };
      }>;
      const listed = rows.find((r) => r.id === xConnectionId);
      expect(listed?.discovery.status).toBe('FAILED');
      expect(listed?.publishing.wired).toBe(true);

      const audit = await prisma.client.auditLog.findMany({
        where: { organizationId: owner.orgId, action: { startsWith: 'social.' } },
      });
      expect(audit.map((a) => a.action)).toContain('social.connection.created');
      expect(JSON.stringify(audit)).not.toContain(LEAK);
    });

    it('stores a platform that reports no scopes as UNKNOWN, not as what was requested', async () => {
      const location = await connect('linkedin');
      linkedInConnectionId = location.searchParams.get('connection') as string;
      const row = await prisma.client.socialConnection.findFirst({
        where: { id: linkedInConnectionId, organizationId: owner.orgId },
      });
      expect(row?.grantedScopesReported).toBe(false);
      expect(row?.grantedScopes).toEqual([]);
      expect(row?.requestedScopes).toEqual(['openid', 'profile', 'w_member_social']);
      expect(row?.hasRefreshToken).toBe(false);
    });
  });

  describe('state validation', () => {
    it('rejects a replayed state without a second token exchange', async () => {
      const started = await start('x');
      const { code, state } = consent(
        (started.json() as { authorizationUrl: string }).authorizationUrl,
      );
      expect((await callback('x', { code, state }, owner.cookie)).searchParams.get('oauth')).toBe(
        'connected',
      );
      const exchanges = provider.tokenRequests.length;

      const replay = await callback('x', { code, state }, owner.cookie);
      expect(replay.searchParams.get('oauth')).toBe('state_invalid');
      expect(provider.tokenRequests.length).toBe(exchanges);
      const audit = await prisma.client.auditLog.findFirst({
        where: { organizationId: owner.orgId, action: 'social.oauth.replay_rejected' },
      });
      expect(audit).not.toBeNull();
    });

    it('rejects unknown and malformed states without contacting the platform', async () => {
      const exchanges = provider.tokenRequests.length;
      const unknown = await callback(
        'x',
        { code: 'c', state: randomBytes(32).toString('base64url') },
        owner.cookie,
      );
      expect(unknown.searchParams.get('oauth')).toBe('state_invalid');
      const malformed = await callback('x', { code: 'c', state: "x' OR 1=1 --" }, owner.cookie);
      expect(malformed.searchParams.get('oauth')).toBe('state_invalid');
      const missing = await callback('x', { code: 'c' }, owner.cookie);
      expect(missing.searchParams.get('oauth')).toBe('state_invalid');
      expect(provider.tokenRequests.length).toBe(exchanges);
    });

    it('rejects an expired state', async () => {
      const started = await start('x');
      const { code, state } = consent(
        (started.json() as { authorizationUrl: string }).authorizationUrl,
      );
      await prisma.client.socialOAuthAttempt.updateMany({
        where: {
          organizationId: owner.orgId,
          stateHash: createHash('sha256').update(state).digest('hex'),
        },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      const exchanges = provider.tokenRequests.length;
      const res = await callback('x', { code, state }, owner.cookie);
      expect(res.searchParams.get('oauth')).toBe('state_expired');
      expect(provider.tokenRequests.length).toBe(exchanges);
    });

    it('binds the state to the user who started the flow (login CSRF)', async () => {
      // A second member of the SAME organization, with every permission.
      await prisma.client.membership.create({
        data: {
          organizationId: owner.orgId,
          userId: other.userId,
          role: 'ORG_ADMIN',
          status: 'ACTIVE',
        },
      });
      try {
        const started = await start('x');
        const { code, state } = consent(
          (started.json() as { authorizationUrl: string }).authorizationUrl,
        );
        const exchanges = provider.tokenRequests.length;

        const hijack = await callback('x', { code, state }, other.cookie);
        expect(hijack.searchParams.get('oauth')).toBe('state_invalid');
        expect(provider.tokenRequests.length).toBe(exchanges);
        const rejections = await prisma.client.auditLog.findMany({
          where: { organizationId: owner.orgId, action: 'social.oauth.state_rejected' },
        });
        expect(
          rejections.some(
            (a) => (a.changes as { reason?: string } | null)?.reason === 'user_mismatch',
          ),
        ).toBe(true);

        // Not burned: the user who started it can still finish.
        const legit = await callback('x', { code, state }, owner.cookie);
        expect(legit.searchParams.get('oauth')).toBe('connected');
      } finally {
        await prisma.client.membership.deleteMany({
          where: { organizationId: owner.orgId, userId: other.userId },
        });
      }
    });

    it('requires a signed-in session, and leaves the state usable', async () => {
      const started = await start('x');
      const { code, state } = consent(
        (started.json() as { authorizationUrl: string }).authorizationUrl,
      );
      const anonymous = await callback('x', { code, state });
      expect(anonymous.searchParams.get('oauth')).toBe('session_required');
      const signedIn = await callback('x', { code, state }, owner.cookie);
      expect(signedIn.searchParams.get('oauth')).toBe('connected');
    });
  });

  describe('failures', () => {
    it('records a declined consent and never reflects provider text', async () => {
      const started = await start('x');
      const { state } = consent((started.json() as { authorizationUrl: string }).authorizationUrl);
      const exchanges = provider.tokenRequests.length;
      const res = await callback(
        'x',
        { state, error: 'access_denied', error_description: '<script>alert(1)</script>' },
        owner.cookie,
      );
      expect(res.searchParams.get('oauth')).toBe('access_denied');
      expect(res.toString()).not.toContain('script');
      expect(provider.tokenRequests.length).toBe(exchanges);
      const attempt = await prisma.client.socialOAuthAttempt.findFirst({
        where: {
          organizationId: owner.orgId,
          stateHash: createHash('sha256').update(state).digest('hex'),
        },
      });
      expect(attempt?.outcome).toBe('DENIED');
    });

    it('stores nothing when the code exchange fails (PKCE mismatch)', async () => {
      const before = await prisma.client.socialConnection.count({
        where: { organizationId: owner.orgId },
      });
      const started = await start('x');
      const { code, state } = consent(
        (started.json() as { authorizationUrl: string }).authorizationUrl,
        { challenge: 'a-different-challenge-the-verifier-cannot-match' },
      );
      const res = await callback('x', { code, state }, owner.cookie);
      expect(res.searchParams.get('oauth')).toBe('token_exchange_failed');
      expect(
        await prisma.client.socialConnection.count({ where: { organizationId: owner.orgId } }),
      ).toBe(before);
      const attempt = await prisma.client.socialOAuthAttempt.findFirst({
        where: {
          organizationId: owner.orgId,
          stateHash: createHash('sha256').update(state).digest('hex'),
        },
      });
      expect(attempt?.failureCode).toBe('token_invalid_grant');
    });

    it('re-checks the permission at the callback', async () => {
      await prisma.client.membership.create({
        data: {
          organizationId: owner.orgId,
          userId: other.userId,
          role: 'ORG_ADMIN',
          status: 'ACTIVE',
        },
      });
      try {
        const started = await start('x', other.cookie, owner.workspaceId);
        expect(started.statusCode).toBe(201);
        const { code, state } = consent(
          (started.json() as { authorizationUrl: string }).authorizationUrl,
        );
        // Permission removed while the user was away at the platform.
        await prisma.client.membership.updateMany({
          where: { organizationId: owner.orgId, userId: other.userId },
          data: { role: 'READ_ONLY' },
        });
        const exchanges = provider.tokenRequests.length;
        const res = await callback('x', { code, state }, other.cookie);
        expect(res.searchParams.get('oauth')).toBe('forbidden');
        expect(provider.tokenRequests.length).toBe(exchanges);
      } finally {
        await prisma.client.membership.deleteMany({
          where: { organizationId: owner.orgId, userId: other.userId },
        });
      }
    });

    it('answers an unknown platform with a redirect, not an error page', async () => {
      const res = await callback('myspace', { code: 'c', state: 's' });
      expect(res.searchParams.get('oauth')).toBe('unknown_platform');
    });
  });

  describe('refresh and reconnect', () => {
    it('refreshes, rotating the refresh token and re-sealing the bundle', async () => {
      const before = await prisma.client.socialConnection.findFirst({
        where: { id: xConnectionId, organizationId: owner.orgId },
      });
      const oldBundle = JSON.parse(decryptSecret(before?.encryptedCredential as string, RING)) as {
        refreshToken: string;
      };

      const res = await inject().inject({
        method: 'POST',
        url: `${ws()}/connections/${xConnectionId}/refresh`,
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'REFRESHED', connectionId: xConnectionId });
      expect(res.body).not.toContain(LEAK);
      expect(provider.tokenRequests.at(-1)?.form.get('refresh_token')).toBe(oldBundle.refreshToken);

      const after = await prisma.client.socialConnection.findFirst({
        where: { id: xConnectionId, organizationId: owner.orgId },
      });
      const newBundle = JSON.parse(decryptSecret(after?.encryptedCredential as string, RING)) as {
        refreshToken: string;
      };
      expect(newBundle.refreshToken).not.toBe(oldBundle.refreshToken);
      expect(after?.lastRefreshedAt).not.toBeNull();
    });

    it('marks the connection REAUTH_REQUIRED when the platform rejects the refresh', async () => {
      provider.rejectRefresh = true;
      try {
        const res = await inject().inject({
          method: 'POST',
          url: `${ws()}/connections/${xConnectionId}/refresh`,
          headers: { cookie: owner.cookie },
        });
        expect(res.json()).toMatchObject({ status: 'REAUTH_REQUIRED' });
        const row = await prisma.client.socialConnection.findFirst({
          where: { id: xConnectionId, organizationId: owner.orgId },
        });
        expect(row?.status).toBe('REAUTH_REQUIRED');
        expect(row?.lastErrorCode).toBe('invalid_grant');
      } finally {
        provider.rejectRefresh = false;
      }
    });

    it('reports NOT_SUPPORTED, without a request, when no refresh token was issued', async () => {
      const exchanges = provider.tokenRequests.length;
      const res = await inject().inject({
        method: 'POST',
        url: `${ws()}/connections/${linkedInConnectionId}/refresh`,
        headers: { cookie: owner.cookie },
      });
      expect(res.json()).toMatchObject({ status: 'NOT_SUPPORTED' });
      expect(provider.tokenRequests.length).toBe(exchanges);
    });

    it('reconnects in place rather than creating a duplicate', async () => {
      const before = await prisma.client.socialConnection.count({
        where: { organizationId: owner.orgId, platform: 'X', disconnectedAt: null },
      });
      const started = await inject().inject({
        method: 'POST',
        url: `${ws()}/connections/${xConnectionId}/reconnect`,
        headers: { cookie: owner.cookie },
        payload: {},
      });
      expect(started.statusCode).toBe(201);
      const { code, state } = consent(
        (started.json() as { authorizationUrl: string }).authorizationUrl,
      );
      const res = await callback('x', { code, state }, owner.cookie);
      expect(res.searchParams.get('oauth')).toBe('reconnected');
      expect(res.searchParams.get('connection')).toBe(xConnectionId);
      expect(
        await prisma.client.socialConnection.count({
          where: { organizationId: owner.orgId, platform: 'X', disconnectedAt: null },
        }),
      ).toBe(before);
      const row = await prisma.client.socialConnection.findFirst({
        where: { id: xConnectionId, organizationId: owner.orgId },
      });
      expect(row?.status).toBe('CONNECTED');
    });
  });

  describe('capabilities and discovery', () => {
    it('reports granted scopes and adapter wiring separately — never "can publish"', async () => {
      const res = await inject().inject({
        method: 'GET',
        url: `${ws()}/connections/${xConnectionId}/capabilities`,
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        capabilities: Array<{
          capability: string;
          scopesGranted: boolean | null;
          adapterWired: boolean;
          available: boolean;
        }>;
      };
      const publish = body.capabilities.find((c) => c.capability === 'publish');
      // Scopes granted AND an adapter wired is what makes a capability available.
      expect(publish).toMatchObject({ scopesGranted: true, adapterWired: true, available: true });

      const linkedIn = await inject().inject({
        method: 'GET',
        url: `${ws()}/connections/${linkedInConnectionId}/capabilities`,
        headers: { cookie: owner.cookie },
      });
      const liPublish = (linkedIn.json() as typeof body).capabilities.find(
        (c) => c.capability === 'publish',
      );
      // LinkedIn reported no scopes: unknown, not assumed.
      expect(liPublish?.scopesGranted).toBeNull();
    });

    it('stores discovered accounts tenant-scoped, with sanitized metadata', async () => {
      const adapter: AccountDiscoveryPort = {
        platform: 'TIKTOK',
        adapterVersion: 'integration-test',
        discoverIdentity: async (context) => {
          expect(context.accessToken).toContain('tt-at-');
          return {
            externalId: 'tt-open-id-1',
            displayName: 'Acme on TikTok',
            kind: 'PROFILE',
            // An adapter that ignores the type at runtime and hands back a raw
            // payload: the nested object must be dropped before anything is stored.
            metadata: {
              followers: 1200,
              raw: { access_token: 'nested-leak' },
            } as unknown as DiscoveryMetadata,
          };
        },
        discoverDestinations: async () => [],
        discoverCapabilities: async () => ({
          grantedScopes: null,
          capabilityVersion: 't',
          notes: [],
        }),
      };
      accountDiscoveryRegistry.register(adapter);
      try {
        const location = await connect('tiktok');
        const connectionId = location.searchParams.get('connection') as string;
        const connection = await prisma.client.socialConnection.findFirst({
          where: { id: connectionId, organizationId: owner.orgId },
        });
        expect(connection?.discoveryStatus).toBe('COMPLETE');
        expect(connection?.externalSubjectId).toBe('tt-open-id-1');

        const accounts = await prisma.client.socialAccount.findMany({
          where: { organizationId: owner.orgId, connectionId },
        });
        expect(accounts).toHaveLength(1);
        expect(accounts[0]).toMatchObject({
          workspaceId: owner.workspaceId,
          externalAccountId: 'tt-open-id-1',
          status: 'CONNECTED',
          encryptedToken: null,
        });
        expect(accounts[0]?.discoveryMetadata).toEqual({ followers: 1200 });

        // Disconnecting the grant retires what it discovered.
        const res = await inject().inject({
          method: 'DELETE',
          url: `${ws()}/connections/${connectionId}`,
          headers: { cookie: owner.cookie },
        });
        expect(res.json()).toMatchObject({ providerRevocation: 'REVOKED' });
        const retired = await prisma.client.socialAccount.findMany({
          where: { organizationId: owner.orgId, connectionId },
        });
        expect(retired.every((a) => a.status === 'REVOKED' && a.deletedAt !== null)).toBe(true);
      } finally {
        accountDiscoveryRegistry.unregister('TIKTOK');
      }
    });
  });

  describe('tenant isolation and permissions', () => {
    it('another tenant can neither see nor act on a connection', async () => {
      const list = await inject().inject({
        method: 'GET',
        url: `${ws(other.workspaceId)}/connections`,
        headers: { cookie: other.cookie },
      });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual([]);

      const base = `${ws(other.workspaceId)}/connections/${xConnectionId}`;
      const attempts = [
        { method: 'POST' as const, url: `${base}/refresh` },
        { method: 'POST' as const, url: `${base}/reconnect`, payload: {} },
        { method: 'GET' as const, url: `${base}/capabilities` },
        { method: 'DELETE' as const, url: base },
      ];
      for (const attempt of attempts) {
        const res = await inject().inject({ ...attempt, headers: { cookie: other.cookie } });
        expect(res.statusCode, attempt.url).toBe(404);
      }
      // And through the owner's workspace path, a non-member is refused outright.
      const direct = await inject().inject({
        method: 'DELETE',
        url: `${ws()}/connections/${xConnectionId}`,
        headers: { cookie: other.cookie },
      });
      expect(direct.statusCode).toBe(404);
    });

    it('requires social:connect for every OAuth route', async () => {
      await prisma.client.membership.create({
        data: {
          organizationId: owner.orgId,
          userId: other.userId,
          role: 'READ_ONLY',
          status: 'ACTIVE',
        },
      });
      try {
        const routes = [
          { method: 'GET' as const, url: `${ws()}/oauth/platforms` },
          { method: 'POST' as const, url: `${ws()}/oauth/x/start`, payload: {} },
          { method: 'GET' as const, url: `${ws()}/connections` },
          { method: 'POST' as const, url: `${ws()}/connections/${xConnectionId}/refresh` },
          { method: 'DELETE' as const, url: `${ws()}/connections/${xConnectionId}` },
        ];
        for (const route of routes) {
          const res = await inject().inject({ ...route, headers: { cookie: other.cookie } });
          expect(res.statusCode, route.url).toBe(403);
        }
      } finally {
        await prisma.client.membership.deleteMany({
          where: { organizationId: owner.orgId, userId: other.userId },
        });
      }
    });
  });

  describe('disconnect', () => {
    it('asks the platform to revoke, then purges the credential', async () => {
      const revocations = provider.revocations.length;
      const res = await inject().inject({
        method: 'DELETE',
        url: `${ws()}/connections/${xConnectionId}`,
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ disconnected: true, providerRevocation: 'REVOKED' });
      expect(provider.revocations.length).toBe(revocations + 1);
      expect(provider.revocations.at(-1)?.form.get('token_type_hint')).toBe('refresh_token');

      const row = await prisma.client.socialConnection.findFirst({
        where: { id: xConnectionId, organizationId: owner.orgId },
      });
      expect(row).toMatchObject({
        status: 'REVOKED',
        encryptedCredential: null,
        credentialKeyId: null,
        hasRefreshToken: false,
      });
      expect(row?.disconnectedAt).not.toBeNull();

      const list = await inject().inject({
        method: 'GET',
        url: `${ws()}/connections`,
        headers: { cookie: owner.cookie },
      });
      expect((list.json() as Array<{ id: string }>).some((c) => c.id === xConnectionId)).toBe(
        false,
      );
    });

    it('says so when the platform has no revocation endpoint, and still purges', async () => {
      const res = await inject().inject({
        method: 'DELETE',
        url: `${ws()}/connections/${linkedInConnectionId}`,
        headers: { cookie: owner.cookie },
      });
      const body = res.json() as { providerRevocation: string; note: string };
      expect(body.providerRevocation).toBe('NOT_SUPPORTED');
      expect(body.note).toMatch(/account settings/);
      const row = await prisma.client.socialConnection.findFirst({
        where: { id: linkedInConnectionId, organizationId: owner.orgId },
      });
      expect(row?.encryptedCredential).toBeNull();
    });

    it('returns the same 404 for a connection that never existed', async () => {
      const res = await inject().inject({
        method: 'DELETE',
        url: `${ws()}/connections/00000000-0000-4000-8000-000000000000`,
        headers: { cookie: owner.cookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
