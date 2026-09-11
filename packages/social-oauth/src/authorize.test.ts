import type { OAuthPlatform } from '@spectra/contracts';
import { describe, expect, it } from 'vitest';

import { buildAuthorizationUrl, usesPkce } from './authorize';
import { resolveOAuthPlatform, type ResolvedOAuthConfig } from './config';
import { getOAuthDefinition } from './definitions';
import { codeChallengeS256, generateCodeVerifier } from './pkce';
import { generateState } from './state';

const env = {
  SOCIAL_OAUTH_REDIRECT_BASE_URL: 'https://api.example.com',
  SOCIAL_OAUTH_X_CLIENT_ID: 'x-client-id',
  SOCIAL_OAUTH_X_CLIENT_SECRET: 'x-client-secret-value',
  SOCIAL_OAUTH_LINKEDIN_CLIENT_ID: 'li-client-id',
  SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET: 'li-client-secret-value',
  SOCIAL_OAUTH_TIKTOK_CLIENT_ID: 'tt-client-key',
  SOCIAL_OAUTH_TIKTOK_CLIENT_SECRET: 'tt-client-secret-value',
  SOCIAL_OAUTH_YOUTUBE_CLIENT_ID: 'yt-client-id',
  SOCIAL_OAUTH_YOUTUBE_CLIENT_SECRET: 'yt-client-secret-value',
};

function configured(platform: OAuthPlatform): ResolvedOAuthConfig {
  const status = resolveOAuthPlatform(env, platform);
  if (!status.configured) throw new Error(`${platform} should be configured`);
  return status.config;
}

const challenge = () => codeChallengeS256(generateCodeVerifier());

describe('buildAuthorizationUrl', () => {
  it('builds an X consent URL carrying state and an S256 PKCE challenge', () => {
    const state = generateState();
    const codeChallenge = challenge();
    const url = new URL(buildAuthorizationUrl(configured('X'), { state, codeChallenge }));
    expect(`${url.origin}${url.pathname}`).toBe('https://x.com/i/oauth2/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('x-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/v1/social/oauth/x/callback',
    );
    expect(url.searchParams.get('scope')).toBe('tweet.read tweet.write users.read offline.access');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('code_challenge')).toBe(codeChallenge);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('encodes spaces as %20, which every platform accepts', () => {
    const raw = buildAuthorizationUrl(configured('X'), {
      state: generateState(),
      codeChallenge: challenge(),
    });
    expect(raw).toContain('scope=tweet.read%20tweet.write%20users.read%20offline.access');
    expect(raw).not.toContain('+');
  });

  it('never puts the client secret in the URL', () => {
    for (const platform of ['X', 'LINKEDIN', 'TIKTOK', 'YOUTUBE'] as const) {
      const config = configured(platform);
      const raw = buildAuthorizationUrl(config, {
        state: generateState(),
        codeChallenge: challenge(),
      });
      expect(raw).not.toContain(config.clientSecret);
    }
  });

  it('refuses to start an X flow without PKCE, because X requires it', () => {
    expect(() =>
      buildAuthorizationUrl(configured('X'), { state: generateState(), codeChallenge: null }),
    ).toThrow(/requires PKCE/);
  });

  it('omits PKCE for a platform whose web flow does not use it', () => {
    const url = new URL(
      buildAuthorizationUrl(configured('LINKEDIN'), {
        state: generateState(),
        codeChallenge: challenge(),
      }),
    );
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(usesPkce(getOAuthDefinition('LINKEDIN'))).toBe(false);
  });

  it('sends PKCE where it is supported but optional', () => {
    expect(usesPkce(getOAuthDefinition('YOUTUBE'))).toBe(true);
    const codeChallenge = challenge();
    const url = new URL(
      buildAuthorizationUrl(configured('YOUTUBE'), { state: generateState(), codeChallenge }),
    );
    expect(url.searchParams.get('code_challenge')).toBe(codeChallenge);
  });

  it('uses TikTok client_key and comma-separated scopes', () => {
    const url = new URL(
      buildAuthorizationUrl(configured('TIKTOK'), { state: generateState(), codeChallenge: null }),
    );
    expect(url.searchParams.get('client_key')).toBe('tt-client-key');
    expect(url.searchParams.has('client_id')).toBe(false);
    expect(url.searchParams.get('scope')).toBe('user.info.basic,video.upload,video.publish');
  });

  it('asks Google for offline access so a refresh token is issued', () => {
    const url = new URL(
      buildAuthorizationUrl(configured('YOUTUBE'), {
        state: generateState(),
        codeChallenge: challenge(),
      }),
    );
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('never lets platform extras override a protocol parameter', () => {
    const base = configured('LINKEDIN');
    const tampered: ResolvedOAuthConfig = {
      ...base,
      definition: {
        ...base.definition,
        extraAuthorizationParams: {
          state: 'attacker-state',
          redirect_uri: 'https://evil.example/callback',
          response_type: 'token',
        },
      },
    };
    const state = generateState();
    const url = new URL(buildAuthorizationUrl(tampered, { state, codeChallenge: null }));
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.example.com/v1/social/oauth/linkedin/callback',
    );
    expect(url.searchParams.get('response_type')).toBe('code');
  });
});
