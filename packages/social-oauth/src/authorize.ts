import type { ResolvedOAuthConfig } from './config';
import type { OAuthPlatformDefinition } from './definitions';

/** Spectra sends PKCE whenever the platform accepts it, not only when it insists. */
export function usesPkce(definition: OAuthPlatformDefinition): boolean {
  return definition.pkce !== 'none';
}

export interface AuthorizationRequest {
  state: string;
  /** S256 challenge. Ignored for platforms that do not use PKCE. */
  codeChallenge: string | null;
}

/**
 * Builds the platform consent URL. It carries the client id, fixed redirect
 * URI, scopes, state and PKCE challenge — never the client secret.
 */
export function buildAuthorizationUrl(
  config: ResolvedOAuthConfig,
  request: AuthorizationRequest,
): string {
  const { definition } = config;
  const challenge = definition.pkce === 'none' ? null : request.codeChallenge;
  if (definition.pkce === 'required' && !challenge) {
    throw new Error(
      `${definition.displayName} requires PKCE; refusing to build an authorization URL without a code challenge`,
    );
  }

  const url = new URL(config.authorizationUrl);
  // Platform extras first, so they can never override a protocol parameter.
  for (const [key, value] of Object.entries(definition.extraAuthorizationParams)) {
    url.searchParams.set(key, value);
  }
  url.searchParams.set('response_type', 'code');
  url.searchParams.set(definition.clientIdParam, config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  if (config.scopes.length > 0) {
    url.searchParams.set('scope', config.scopes.join(definition.scopeSeparator));
  }
  url.searchParams.set('state', request.state);
  if (challenge) {
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
  }
  // URLSearchParams writes a space as "+"; several platforms only accept %20.
  // A literal "+" in a value is already "%2B", so this touches spaces only.
  url.search = url.searchParams.toString().replace(/\+/g, '%20');
  return url.toString();
}
