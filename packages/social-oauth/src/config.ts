import { OAUTH_PLATFORMS, type OAuthPlatform } from '@spectra/contracts';
import {
  socialOAuthEnvKey,
  type SocialOAuthEnvKey,
  type SocialOAuthKeySuffix,
} from '@spectra/config';

import { getOAuthDefinition, type OAuthPlatformDefinition } from './definitions';

/** The slice of the validated API environment the broker reads. */
export type SocialOAuthEnv = Partial<Record<SocialOAuthEnvKey, string | undefined>> & {
  SOCIAL_OAUTH_REDIRECT_BASE_URL?: string | undefined;
};

/** A platform the deployment can actually run an OAuth flow for. */
export interface ResolvedOAuthConfig {
  platform: OAuthPlatform;
  definition: OAuthPlatformDefinition;
  clientId: string;
  /**
   * Secret. Never logged, never returned by the API, and never placed in a
   * URL — except in the token request itself where the platform documents
   * only GET (Meta), sent straight to the platform over TLS and not logged.
   */
  clientSecret: string;
  authorizationUrl: string;
  tokenUrl: string;
  revocationUrl: string | null;
  scopes: string[];
  /** Fixed per platform — computed here, never accepted from a caller. */
  redirectUri: string;
}

export type OAuthPlatformStatus =
  | {
      platform: OAuthPlatform;
      definition: OAuthPlatformDefinition;
      configured: true;
      config: ResolvedOAuthConfig;
    }
  | {
      platform: OAuthPlatform;
      definition: OAuthPlatformDefinition;
      configured: false;
      /** Environment variable NAMES that are unset. Never values. */
      missing: string[];
      /** The redirect URI to register, when the base URL is known. */
      redirectUri: string | null;
    };

export function oauthCallbackPath(platform: OAuthPlatform): string {
  return `/v1/social/oauth/${platform.toLowerCase()}/callback`;
}

export function redirectUriFor(baseUrl: string, platform: OAuthPlatform): string {
  // Concatenated, not resolved with `new URL(path, base)`, which would drop a
  // path prefix the API is served under.
  return `${baseUrl.replace(/\/+$/, '')}${oauthCallbackPath(platform)}`;
}

/** Splits a scope list written with spaces and/or commas. */
export function parseScopeList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\s,]+/)
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  ];
}

export function resolveOAuthPlatform(
  env: SocialOAuthEnv,
  platform: OAuthPlatform,
): OAuthPlatformStatus {
  const definition = getOAuthDefinition(platform);
  const read = (suffix: SocialOAuthKeySuffix) =>
    env[socialOAuthEnvKey(platform, suffix)] || undefined;

  const clientId = read('CLIENT_ID');
  const clientSecret = read('CLIENT_SECRET');
  const base = env.SOCIAL_OAUTH_REDIRECT_BASE_URL || undefined;
  const redirectUri = base ? redirectUriFor(base, platform) : null;

  if (!clientId || !clientSecret || !base) {
    const missing: string[] = [];
    if (!clientId) missing.push(socialOAuthEnvKey(platform, 'CLIENT_ID'));
    if (!clientSecret) missing.push(socialOAuthEnvKey(platform, 'CLIENT_SECRET'));
    if (!base) missing.push('SOCIAL_OAUTH_REDIRECT_BASE_URL');
    return { platform, definition, configured: false, missing, redirectUri };
  }

  const scopes = read('SCOPES');
  return {
    platform,
    definition,
    configured: true,
    config: {
      platform,
      definition,
      clientId,
      clientSecret,
      authorizationUrl: read('AUTHORIZATION_URL') ?? definition.authorizationUrl,
      tokenUrl: read('TOKEN_URL') ?? definition.tokenUrl,
      revocationUrl: read('REVOCATION_URL') ?? definition.revocationUrl,
      scopes: scopes ? parseScopeList(scopes) : [...definition.defaultScopes],
      redirectUri: redirectUriFor(base, platform),
    },
  };
}

export function resolveOAuthPlatforms(env: SocialOAuthEnv): OAuthPlatformStatus[] {
  return OAUTH_PLATFORMS.map((platform) => resolveOAuthPlatform(env, platform));
}
