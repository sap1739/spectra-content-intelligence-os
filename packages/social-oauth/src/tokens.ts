import { z } from 'zod';

import { parseScopeList, type ResolvedOAuthConfig } from './config';

/**
 * Token endpoint client: authorization-code exchange, refresh and revocation.
 *
 * Every request carries the client secret, and the exchange carries a
 * single-use code and PKCE verifier, so three rules hold throughout:
 * - errors name the platform, HTTP status and the provider's error CODE only —
 *   never the request, and never the response body or error_description;
 * - redirects are refused (`redirect: 'error'`): following one would re-send
 *   the secret and code to wherever it pointed;
 * - every call has a timeout.
 */

const DEFAULT_TIMEOUT_MS = 10_000;

export type OAuthTokenErrorCode =
  | 'invalid_grant'
  | 'invalid_client'
  | 'provider_error'
  | 'invalid_response'
  | 'network_error'
  | 'timeout';

export class OAuthTokenError extends Error {
  constructor(
    public readonly code: OAuthTokenErrorCode,
    public readonly httpStatus: number | null,
    /** The provider's `error` field, only when it is a plain token such as `invalid_grant`. */
    public readonly providerError: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'OAuthTokenError';
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string | null;
  /** As the platform reported them. null = not reported — never assumed to equal what was requested. */
  grantedScopes: string[] | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenExpiresAt: Date | null;
  /** The platform's subject id when the response carries one (TikTok open_id, Threads user_id). */
  subjectId: string | null;
}

export interface TokenRequestOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().positive().optional(),
  refresh_expires_in: z.coerce.number().positive().optional(),
  refresh_token_expires_in: z.coerce.number().positive().optional(),
  scope: z.union([z.string(), z.array(z.string())]).optional(),
  permissions: z.union([z.string(), z.array(z.string())]).optional(),
  open_id: z.string().min(1).optional(),
  user_id: z.union([z.string().min(1), z.number()]).optional(),
});

const PROVIDER_ERROR_TOKEN = /^[A-Za-z0-9_.-]{1,64}$/;

function providerErrorOf(body: unknown): string | null {
  const value = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  return typeof value === 'string' && PROVIDER_ERROR_TOKEN.test(value) ? value : null;
}

/** Instagram Login wraps the token as `{ data: [ { access_token, ... } ] }`. */
function unwrap(body: unknown): unknown {
  if (body && typeof body === 'object') {
    const data = (body as { data?: unknown }).data;
    if (
      Array.isArray(data) &&
      data[0] &&
      typeof data[0] === 'object' &&
      'access_token' in data[0]
    ) {
      return data[0];
    }
  }
  return body;
}

function scopesFrom(value: string | string[] | undefined): string[] | null {
  if (value === undefined) return null;
  return Array.isArray(value) ? parseScopeList(value.join(' ')) : parseScopeList(value);
}

export function parseTokenResponse(body: unknown, now: Date): TokenSet {
  const parsed = tokenResponseSchema.safeParse(unwrap(body));
  if (!parsed.success) {
    throw new OAuthTokenError(
      'invalid_response',
      null,
      providerErrorOf(body),
      'The token endpoint returned no usable access token',
    );
  }
  const token = parsed.data;
  const inSeconds = (seconds: number | undefined) =>
    seconds ? new Date(now.getTime() + seconds * 1000) : null;
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? null,
    tokenType: token.token_type ?? null,
    grantedScopes: scopesFrom(token.scope ?? token.permissions),
    accessTokenExpiresAt: inSeconds(token.expires_in),
    refreshTokenExpiresAt: inSeconds(token.refresh_expires_in ?? token.refresh_token_expires_in),
    subjectId: token.open_id ?? (token.user_id !== undefined ? String(token.user_id) : null),
  };
}

/** RFC 6749 section 2.3.1: Basic credentials are form-encoded, then base64. */
function clientAuthentication(config: ResolvedOAuthConfig): {
  form: Record<string, string>;
  headers: Record<string, string>;
} {
  if (config.definition.clientAuth === 'client_secret_basic') {
    const credentials = `${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`;
    return {
      form: {},
      headers: { authorization: `Basic ${Buffer.from(credentials).toString('base64')}` },
    };
  }
  return {
    form: {
      [config.definition.clientIdParam]: config.clientId,
      client_secret: config.clientSecret,
    },
    headers: {},
  };
}

async function tokenRequest(
  config: ResolvedOAuthConfig,
  url: string,
  form: Record<string, string>,
  options: TokenRequestOptions,
): Promise<{ status: number; body: unknown }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const auth = clientAuthentication(config);
  const name = config.definition.displayName;
  const params = new URLSearchParams({ ...form, ...auth.form });
  // Meta documents its token endpoint as GET with query parameters; every
  // other platform takes an RFC 6749 form POST. The URL is never logged.
  const get = config.definition.tokenRequestMethod === 'GET';
  let target = url;
  if (get) {
    const withQuery = new URL(url);
    for (const [key, value] of params) withQuery.searchParams.set(key, value);
    target = withQuery.toString();
  }
  let response: Response;
  try {
    response = await fetchImpl(target, {
      method: get ? 'GET' : 'POST',
      headers: {
        accept: 'application/json',
        ...(get ? {} : { 'content-type': 'application/x-www-form-urlencoded' }),
        ...auth.headers,
      },
      ...(get ? {} : { body: params.toString() }),
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new OAuthTokenError(
      timedOut ? 'timeout' : 'network_error',
      null,
      null,
      timedOut ? `${name} did not respond in time` : `${name} could not be reached`,
    );
  }
  const text = await response.text().catch(() => '');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function tokenSetOrThrow(
  config: ResolvedOAuthConfig,
  status: number,
  body: unknown,
  now: Date,
): TokenSet {
  const providerError = providerErrorOf(body);
  if (status < 200 || status >= 300) {
    const code: OAuthTokenErrorCode =
      providerError === 'invalid_grant'
        ? 'invalid_grant'
        : providerError === 'invalid_client' || providerError === 'unauthorized_client'
          ? 'invalid_client'
          : 'provider_error';
    throw new OAuthTokenError(
      code,
      status,
      providerError,
      `${config.definition.displayName} rejected the token request (HTTP ${status}${providerError ? `, ${providerError}` : ''})`,
    );
  }
  try {
    return parseTokenResponse(body, now);
  } catch (error) {
    // A 2xx carrying an `error` is a rejection some platforms send that way.
    if (providerError) {
      throw new OAuthTokenError(
        providerError === 'invalid_grant' ? 'invalid_grant' : 'provider_error',
        status,
        providerError,
        `${config.definition.displayName} rejected the token request (${providerError})`,
      );
    }
    throw error;
  }
}

/** Exchanges an authorization code for tokens (RFC 6749 section 4.1.3). */
export async function exchangeAuthorizationCode(
  config: ResolvedOAuthConfig,
  input: { code: string; codeVerifier: string | null },
  options: TokenRequestOptions = {},
): Promise<TokenSet> {
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code: input.code,
    redirect_uri: config.redirectUri,
  };
  if (input.codeVerifier) form['code_verifier'] = input.codeVerifier;
  const { status, body } = await tokenRequest(config, config.tokenUrl, form, options);
  return tokenSetOrThrow(config, status, body, (options.now ?? (() => new Date()))());
}

/**
 * Uses a refresh token (RFC 6749 section 6). A response without a new refresh
 * token means "keep the old one" — the caller must not discard it.
 */
export async function refreshAccessToken(
  config: ResolvedOAuthConfig,
  refreshToken: string,
  options: TokenRequestOptions = {},
): Promise<TokenSet> {
  if (config.definition.refresh !== 'standard') {
    throw new Error(`${config.definition.displayName} has no standard refresh grant`);
  }
  const { status, body } = await tokenRequest(
    config,
    config.tokenUrl,
    { grant_type: 'refresh_token', refresh_token: refreshToken },
    options,
  );
  return tokenSetOrThrow(config, status, body, (options.now ?? (() => new Date()))());
}

/**
 * Meta's short-lived user token lasts about an hour; its documented
 * `fb_exchange_token` grant trades it for one lasting about 60 days (the Page
 * tokens derived from that do not expire). Applied right after the code
 * exchange; a no-op for every other platform.
 */
export async function upgradeToLongLivedToken(
  config: ResolvedOAuthConfig,
  tokens: TokenSet,
  options: TokenRequestOptions = {},
): Promise<TokenSet> {
  if (config.definition.longLivedExchange !== 'fb_exchange_token') return tokens;
  const { status, body } = await tokenRequest(
    config,
    config.tokenUrl,
    { grant_type: 'fb_exchange_token', fb_exchange_token: tokens.accessToken },
    options,
  );
  const upgraded = tokenSetOrThrow(config, status, body, (options.now ?? (() => new Date()))());
  // The exchange reports no scopes: the grant itself is unchanged.
  return {
    ...upgraded,
    grantedScopes: upgraded.grantedScopes ?? tokens.grantedScopes,
    refreshToken: upgraded.refreshToken ?? tokens.refreshToken,
    subjectId: upgraded.subjectId ?? tokens.subjectId,
  };
}

export type RevocationOutcome = 'REVOKED' | 'NOT_SUPPORTED' | 'FAILED';

/**
 * Asks the platform to revoke a token (RFC 7009). Best-effort and never
 * throws: a disconnect must purge the local credential whether or not the
 * platform answered, and the outcome is reported rather than assumed.
 */
export async function revokeToken(
  config: ResolvedOAuthConfig,
  token: string,
  tokenTypeHint: 'access_token' | 'refresh_token',
  options: TokenRequestOptions = {},
): Promise<RevocationOutcome> {
  if (!config.revocationUrl) return 'NOT_SUPPORTED';
  try {
    const { status } = await tokenRequest(
      config,
      config.revocationUrl,
      { token, token_type_hint: tokenTypeHint },
      options,
    );
    return status >= 200 && status < 300 ? 'REVOKED' : 'FAILED';
  } catch {
    return 'FAILED';
  }
}
