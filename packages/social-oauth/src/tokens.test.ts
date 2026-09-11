import type { OAuthPlatform } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { resolveOAuthPlatform, type ResolvedOAuthConfig } from './config';
import {
  OAuthTokenError,
  exchangeAuthorizationCode,
  parseTokenResponse,
  refreshAccessToken,
  revokeToken,
} from './tokens';

const env = {
  SOCIAL_OAUTH_REDIRECT_BASE_URL: 'https://api.example.com',
  SOCIAL_OAUTH_X_CLIENT_ID: 'x-client-id',
  SOCIAL_OAUTH_X_CLIENT_SECRET: 'x-client-secret-value',
  SOCIAL_OAUTH_LINKEDIN_CLIENT_ID: 'li-client-id',
  SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET: 'li-client-secret-value',
  SOCIAL_OAUTH_TIKTOK_CLIENT_ID: 'tt-client-key',
  SOCIAL_OAUTH_TIKTOK_CLIENT_SECRET: 'tt-client-secret-value',
  SOCIAL_OAUTH_INSTAGRAM_CLIENT_ID: 'ig-client-id',
  SOCIAL_OAUTH_INSTAGRAM_CLIENT_SECRET: 'ig-client-secret-value',
  SOCIAL_OAUTH_FACEBOOK_CLIENT_ID: 'fb-client-id',
  SOCIAL_OAUTH_FACEBOOK_CLIENT_SECRET: 'fb-client-secret-value',
};

function configured(platform: OAuthPlatform): ResolvedOAuthConfig {
  const status = resolveOAuthPlatform(env, platform);
  if (!status.configured) throw new Error(`${platform} should be configured`);
  return status.config;
}

interface Captured {
  url: string;
  headers: Record<string, string>;
  form: URLSearchParams;
  redirect: string | undefined;
}

function fakeFetch(respond: () => Response) {
  const calls: Captured[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      form: new URLSearchParams(String(init?.body ?? '')),
      redirect: init?.redirect,
    });
    return respond();
  }) as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const NOW = new Date('2026-09-10T12:00:00.000Z');

function first(calls: Captured[]): Captured {
  const call = calls[0];
  if (!call) throw new Error('expected a request');
  return call;
}

describe('authorization-code exchange', () => {
  it('uses HTTP Basic client auth for X and sends the PKCE verifier', async () => {
    const { impl, calls } = fakeFetch(() =>
      json(200, {
        access_token: 'at-1',
        refresh_token: 'rt-1',
        token_type: 'bearer',
        expires_in: 7200,
        scope: 'tweet.read users.read',
      }),
    );
    const tokens = await exchangeAuthorizationCode(
      configured('X'),
      { code: 'code-1', codeVerifier: 'verifier-1' },
      { fetchImpl: impl, now: () => NOW },
    );
    const call = first(calls);
    expect(call.url).toBe('https://api.x.com/2/oauth2/token');
    expect(call.headers['authorization']).toBe(
      `Basic ${Buffer.from('x-client-id:x-client-secret-value').toString('base64')}`,
    );
    expect(call.form.get('grant_type')).toBe('authorization_code');
    expect(call.form.get('code')).toBe('code-1');
    expect(call.form.get('code_verifier')).toBe('verifier-1');
    expect(call.form.get('redirect_uri')).toBe(
      'https://api.example.com/v1/social/oauth/x/callback',
    );
    expect(call.form.has('client_secret')).toBe(false);
    // A token endpoint must not redirect the secret and code elsewhere.
    expect(call.redirect).toBe('error');
    expect(tokens).toEqual({
      accessToken: 'at-1',
      refreshToken: 'rt-1',
      tokenType: 'bearer',
      grantedScopes: ['tweet.read', 'users.read'],
      accessTokenExpiresAt: new Date('2026-09-10T14:00:00.000Z'),
      refreshTokenExpiresAt: null,
      subjectId: null,
    });
  });

  it('sends client credentials in the body for client_secret_post platforms', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { access_token: 'at', expires_in: 5184000 }));
    await exchangeAuthorizationCode(
      configured('LINKEDIN'),
      { code: 'c', codeVerifier: null },
      { fetchImpl: impl },
    );
    const call = first(calls);
    expect(call.form.get('client_id')).toBe('li-client-id');
    expect(call.form.get('client_secret')).toBe('li-client-secret-value');
    expect(call.form.has('code_verifier')).toBe(false);
    expect(call.headers['authorization']).toBeUndefined();
  });

  it('uses client_key for TikTok and records open_id and the refresh expiry', async () => {
    const { impl, calls } = fakeFetch(() =>
      json(200, {
        access_token: 'at',
        refresh_token: 'rt',
        expires_in: 86400,
        refresh_expires_in: 31536000,
        open_id: 'open-123',
        scope: 'user.info.basic,video.publish',
      }),
    );
    const tokens = await exchangeAuthorizationCode(
      configured('TIKTOK'),
      { code: 'c', codeVerifier: null },
      { fetchImpl: impl, now: () => NOW },
    );
    expect(first(calls).form.get('client_key')).toBe('tt-client-key');
    expect(first(calls).form.has('client_id')).toBe(false);
    expect(tokens.subjectId).toBe('open-123');
    expect(tokens.grantedScopes).toEqual(['user.info.basic', 'video.publish']);
    expect(tokens.refreshTokenExpiresAt).toEqual(new Date('2027-09-10T12:00:00.000Z'));
  });

  it('unwraps the Instagram data[] response and reads permissions as scopes', async () => {
    const { impl } = fakeFetch(() =>
      json(200, {
        data: [
          {
            access_token: 'ig-at',
            user_id: 17841400000,
            permissions: 'instagram_business_basic,instagram_business_content_publish',
          },
        ],
      }),
    );
    const tokens = await exchangeAuthorizationCode(
      configured('INSTAGRAM'),
      { code: 'c', codeVerifier: null },
      { fetchImpl: impl },
    );
    expect(tokens.accessToken).toBe('ig-at');
    expect(tokens.subjectId).toBe('17841400000');
    expect(tokens.grantedScopes).toEqual([
      'instagram_business_basic',
      'instagram_business_content_publish',
    ]);
  });

  it('reports granted scopes as unknown when the platform does not report them', async () => {
    const { impl } = fakeFetch(() => json(200, { access_token: 'fb', token_type: 'bearer' }));
    const tokens = await exchangeAuthorizationCode(
      configured('FACEBOOK'),
      { code: 'c', codeVerifier: null },
      { fetchImpl: impl },
    );
    // null, not the requested scopes: we do not claim what was not reported.
    expect(tokens.grantedScopes).toBeNull();
    expect(tokens.accessTokenExpiresAt).toBeNull();
  });
});

describe('token endpoint failures', () => {
  it('maps invalid_grant without leaking the request or the description', async () => {
    const { impl } = fakeFetch(() =>
      json(400, { error: 'invalid_grant', error_description: 'code SECRET-CODE-123 has expired' }),
    );
    const error = (await exchangeAuthorizationCode(
      configured('X'),
      { code: 'SECRET-CODE-123', codeVerifier: 'VERIFIER-XYZ' },
      { fetchImpl: impl },
    ).catch((e: unknown) => e)) as OAuthTokenError;
    expect(error).toBeInstanceOf(OAuthTokenError);
    expect(error.code).toBe('invalid_grant');
    expect(error.httpStatus).toBe(400);
    expect(error.providerError).toBe('invalid_grant');
    for (const secret of ['SECRET-CODE-123', 'VERIFIER-XYZ', 'x-client-secret-value', 'expired']) {
      expect(error.message).not.toContain(secret);
    }
  });

  it('discards a provider error that is not a plain token', async () => {
    const { impl } = fakeFetch(() => json(401, { error: '<script>alert(1)</script>' }));
    const error = (await exchangeAuthorizationCode(
      configured('X'),
      { code: 'c', codeVerifier: 'v' },
      { fetchImpl: impl },
    ).catch((e: unknown) => e)) as OAuthTokenError;
    expect(error.code).toBe('provider_error');
    expect(error.providerError).toBeNull();
    expect(error.message).not.toContain('script');
  });

  it('treats a 2xx without an access token as an invalid response', async () => {
    const { impl } = fakeFetch(() => json(200, { token_type: 'bearer' }));
    await expect(
      exchangeAuthorizationCode(
        configured('X'),
        { code: 'c', codeVerifier: 'v' },
        { fetchImpl: impl },
      ),
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('treats a 2xx carrying an error as a rejection', async () => {
    const { impl } = fakeFetch(() => json(200, { error: 'invalid_grant' }));
    await expect(
      exchangeAuthorizationCode(
        configured('TIKTOK'),
        { code: 'c', codeVerifier: null },
        { fetchImpl: impl },
      ),
    ).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('distinguishes an unreachable platform from a slow one', async () => {
    const unreachable = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await expect(
      exchangeAuthorizationCode(
        configured('X'),
        { code: 'c', codeVerifier: 'v' },
        { fetchImpl: unreachable },
      ),
    ).rejects.toMatchObject({ code: 'network_error' });

    const slow = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      });
    }) as typeof fetch;
    await expect(
      exchangeAuthorizationCode(
        configured('X'),
        { code: 'c', codeVerifier: 'v' },
        { fetchImpl: slow },
      ),
    ).rejects.toMatchObject({ code: 'timeout' });
  });

  it('coerces a numeric string expiry', () => {
    const tokens = parseTokenResponse({ access_token: 'a', expires_in: '3600' }, NOW);
    expect(tokens.accessTokenExpiresAt).toEqual(new Date('2026-09-10T13:00:00.000Z'));
  });
});

describe('refresh', () => {
  it('uses the refresh_token grant and reports a missing new refresh token as null', async () => {
    const { impl, calls } = fakeFetch(() => json(200, { access_token: 'at-2', expires_in: 7200 }));
    const tokens = await refreshAccessToken(configured('X'), 'rt-1', { fetchImpl: impl });
    expect(first(calls).form.get('grant_type')).toBe('refresh_token');
    expect(first(calls).form.get('refresh_token')).toBe('rt-1');
    // null means "keep the old one" — the caller must not discard it.
    expect(tokens.refreshToken).toBeNull();
  });

  it('refuses to refresh a platform without a standard refresh grant', async () => {
    await expect(refreshAccessToken(configured('FACEBOOK'), 'rt')).rejects.toThrow(
      /no standard refresh grant/,
    );
  });
});

describe('revocation', () => {
  it('reports NOT_SUPPORTED, without a request, when the platform has no revocation endpoint', async () => {
    const { impl, calls } = fakeFetch(() => json(200, {}));
    expect(
      await revokeToken(configured('LINKEDIN'), 't', 'access_token', { fetchImpl: impl }),
    ).toBe('NOT_SUPPORTED');
    expect(calls).toHaveLength(0);
  });

  it('reports REVOKED on success and sends an RFC 7009 request', async () => {
    const { impl, calls } = fakeFetch(() => json(200, {}));
    expect(await revokeToken(configured('X'), 'rt-1', 'refresh_token', { fetchImpl: impl })).toBe(
      'REVOKED',
    );
    expect(first(calls).url).toBe('https://api.x.com/2/oauth2/revoke');
    expect(first(calls).form.get('token')).toBe('rt-1');
    expect(first(calls).form.get('token_type_hint')).toBe('refresh_token');
  });

  it('reports FAILED, never throws, when the platform refuses or is unreachable', async () => {
    const refused = fakeFetch(() => json(400, { error: 'invalid_request' }));
    expect(
      await revokeToken(configured('X'), 't', 'access_token', { fetchImpl: refused.impl }),
    ).toBe('FAILED');
    const unreachable = (async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    expect(
      await revokeToken(configured('X'), 't', 'access_token', { fetchImpl: unreachable }),
    ).toBe('FAILED');
  });
});
