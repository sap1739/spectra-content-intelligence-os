import { OAUTH_PLATFORMS } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { redirectUriFor, resolveOAuthPlatform, resolveOAuthPlatforms } from './config';

const BASE = 'https://api.example.com';

describe('OAuth platform configuration', () => {
  it('reports an unconfigured platform by the NAMES of the missing variables', () => {
    const status = resolveOAuthPlatform({}, 'LINKEDIN');
    expect(status.configured).toBe(false);
    if (status.configured) return;
    expect(status.missing).toEqual([
      'SOCIAL_OAUTH_LINKEDIN_CLIENT_ID',
      'SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET',
      'SOCIAL_OAUTH_REDIRECT_BASE_URL',
    ]);
    expect(status.redirectUri).toBeNull();
  });

  it('needs the redirect base URL even when client credentials are set', () => {
    const status = resolveOAuthPlatform(
      { SOCIAL_OAUTH_X_CLIENT_ID: 'id-value', SOCIAL_OAUTH_X_CLIENT_SECRET: 'secret-value' },
      'X',
    );
    expect(status.configured).toBe(false);
    if (status.configured) return;
    expect(status.missing).toEqual(['SOCIAL_OAUTH_REDIRECT_BASE_URL']);
    expect(JSON.stringify(status)).not.toContain('secret-value');
  });

  it('resolves declared defaults and a fixed per-platform redirect URI', () => {
    const status = resolveOAuthPlatform(
      {
        SOCIAL_OAUTH_REDIRECT_BASE_URL: BASE,
        SOCIAL_OAUTH_X_CLIENT_ID: 'x-id',
        SOCIAL_OAUTH_X_CLIENT_SECRET: 'x-secret',
      },
      'X',
    );
    expect(status.configured).toBe(true);
    if (!status.configured) return;
    expect(status.config.redirectUri).toBe('https://api.example.com/v1/social/oauth/x/callback');
    expect(status.config.tokenUrl).toBe('https://api.x.com/2/oauth2/token');
    expect(status.config.scopes).toEqual([
      'tweet.read',
      'tweet.write',
      'users.read',
      'media.write',
      'offline.access',
    ]);
  });

  it('honours per-deployment endpoint and scope overrides', () => {
    const status = resolveOAuthPlatform(
      {
        SOCIAL_OAUTH_REDIRECT_BASE_URL: BASE,
        SOCIAL_OAUTH_LINKEDIN_CLIENT_ID: 'li-id',
        SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET: 'li-secret',
        SOCIAL_OAUTH_LINKEDIN_SCOPES: 'openid, profile  w_member_social,openid',
        SOCIAL_OAUTH_LINKEDIN_TOKEN_URL: 'http://127.0.0.1:9999/token',
        SOCIAL_OAUTH_LINKEDIN_REVOCATION_URL: 'http://127.0.0.1:9999/revoke',
      },
      'LINKEDIN',
    );
    if (!status.configured) throw new Error('expected LinkedIn to be configured');
    expect(status.config.scopes).toEqual(['openid', 'profile', 'w_member_social']);
    expect(status.config.tokenUrl).toBe('http://127.0.0.1:9999/token');
    expect(status.config.revocationUrl).toBe('http://127.0.0.1:9999/revoke');
    expect(status.config.authorizationUrl).toBe(status.definition.authorizationUrl);
  });

  it('keeps a path prefix on the redirect base URL', () => {
    expect(redirectUriFor('https://example.com/api/', 'TIKTOK')).toBe(
      'https://example.com/api/v1/social/oauth/tiktok/callback',
    );
  });

  it('resolves every OAuth platform', () => {
    expect(resolveOAuthPlatforms({}).map((s) => s.platform)).toEqual([...OAUTH_PLATFORMS]);
  });
});
