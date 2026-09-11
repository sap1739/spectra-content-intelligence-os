import type { OAuthPlatform } from '@spectra/contracts';

/**
 * Declared OAuth 2.0 endpoints and requirements per platform (ADR-0034).
 *
 * Honesty: compiled from each platform's public developer documentation on
 * DEFINITIONS_RECORDED_AT — NOT fetched from, or verified against, a live API.
 * Platforms change these, so every URL and the scope list can be overridden
 * per deployment (SOCIAL_OAUTH_<PLATFORM>_AUTHORIZATION_URL / _TOKEN_URL /
 * _REVOCATION_URL / _SCOPES) without a code change.
 *
 * A definition describes how to OBTAIN a token. It says nothing about whether
 * Spectra can USE one: that needs a platform adapter, and none is wired for
 * any OAuth platform yet.
 */

export const DEFINITIONS_RECORDED_AT = '2026-09-10';

/** Meta versions its Graph endpoints; override the URLs to move to a newer one. */
const META_GRAPH_VERSION = 'v23.0';

/**
 * `required`: the platform rejects a flow without PKCE.
 * `supported`: the platform accepts PKCE, so Spectra always sends it.
 * `none`: the platform's web flow does not use PKCE; state alone binds the flow.
 */
export type PkceMode = 'required' | 'supported' | 'none';
export type ClientAuthMethod = 'client_secret_basic' | 'client_secret_post';
/** `none` = no standard refresh_token grant; the user reconnects instead. */
export type RefreshStyle = 'standard' | 'none';

/** What a connection may be used for, each gated by granted scopes. */
export const CONNECTION_CAPABILITIES = [
  'read_profile',
  'list_destinations',
  'publish',
  'analytics',
] as const;
export type ConnectionCapability = (typeof CONNECTION_CAPABILITIES)[number];

export interface OAuthPlatformDefinition {
  platform: OAuthPlatform;
  displayName: string;
  authorizationUrl: string;
  tokenUrl: string;
  /** RFC 7009 revocation endpoint, when the platform offers a standard one. */
  revocationUrl: string | null;
  defaultScopes: readonly string[];
  scopeSeparator: ' ' | ',';
  pkce: PkceMode;
  clientAuth: ClientAuthMethod;
  /** Name of the client-id parameter. TikTok calls it `client_key`. */
  clientIdParam: 'client_id' | 'client_key';
  /** Platform-specific authorization parameters. Can never override protocol ones. */
  extraAuthorizationParams: Readonly<Record<string, string>>;
  refresh: RefreshStyle;
  /** Scopes that must ALL be granted for each capability. Absent = no scope grants it. */
  capabilityScopes: Readonly<Partial<Record<ConnectionCapability, readonly string[]>>>;
  /** Platform-side approvals needed before real users can connect or publish. */
  approval: { required: boolean; notes: readonly string[] };
  docsUrl: string;
}

const DEFINITIONS: Record<OAuthPlatform, OAuthPlatformDefinition> = {
  LINKEDIN: {
    platform: 'LINKEDIN',
    displayName: 'LinkedIn',
    authorizationUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    revocationUrl: null,
    defaultScopes: ['openid', 'profile', 'w_member_social'],
    scopeSeparator: ' ',
    pkce: 'none',
    clientAuth: 'client_secret_post',
    clientIdParam: 'client_id',
    extraAuthorizationParams: {},
    refresh: 'standard',
    capabilityScopes: {
      read_profile: ['profile'],
      list_destinations: ['r_organization_admin'],
      publish: ['w_member_social'],
    },
    approval: {
      required: true,
      notes: [
        'Posting as a member uses the self-serve "Share on LinkedIn" product (w_member_social).',
        'Posting to organization pages needs Community Management API access, which LinkedIn grants by application.',
        'Refresh tokens are issued only to approved partners; otherwise a token lasts about 60 days and the connection must be reconnected.',
      ],
    },
    docsUrl:
      'https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow',
  },
  FACEBOOK: {
    platform: 'FACEBOOK',
    displayName: 'Facebook Pages',
    authorizationUrl: `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`,
    revocationUrl: null,
    defaultScopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
    scopeSeparator: ',',
    pkce: 'none',
    clientAuth: 'client_secret_post',
    clientIdParam: 'client_id',
    extraAuthorizationParams: {},
    refresh: 'none',
    capabilityScopes: {
      list_destinations: ['pages_show_list'],
      publish: ['pages_manage_posts'],
      analytics: ['pages_read_engagement'],
    },
    approval: {
      required: true,
      notes: [
        "Meta App Review is required for pages_manage_posts and pages_read_engagement before anyone outside the app's own roles can connect.",
        'Advanced access may also require Meta Business Verification.',
        'The token issued here is short-lived. Exchanging it for a long-lived token and per-Page tokens is Meta-specific and arrives with the Facebook adapter.',
      ],
    },
    docsUrl: 'https://developers.facebook.com/docs/facebook-login/guides/advanced/manual-flow',
  },
  INSTAGRAM: {
    platform: 'INSTAGRAM',
    displayName: 'Instagram',
    authorizationUrl: 'https://www.instagram.com/oauth/authorize',
    tokenUrl: 'https://api.instagram.com/oauth/access_token',
    revocationUrl: null,
    defaultScopes: ['instagram_business_basic', 'instagram_business_content_publish'],
    scopeSeparator: ',',
    pkce: 'none',
    clientAuth: 'client_secret_post',
    clientIdParam: 'client_id',
    extraAuthorizationParams: {},
    refresh: 'none',
    capabilityScopes: {
      read_profile: ['instagram_business_basic'],
      publish: ['instagram_business_content_publish'],
    },
    approval: {
      required: true,
      notes: [
        'Only Instagram professional accounts (Business or Creator) can publish through the API.',
        'Meta App Review is required for instagram_business_content_publish.',
        'Long-lived token exchange and refresh use Instagram-specific endpoints and arrive with the Instagram adapter.',
      ],
    },
    docsUrl:
      'https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login',
  },
  THREADS: {
    platform: 'THREADS',
    displayName: 'Threads',
    authorizationUrl: 'https://threads.net/oauth/authorize',
    tokenUrl: 'https://graph.threads.net/oauth/access_token',
    revocationUrl: null,
    defaultScopes: ['threads_basic', 'threads_content_publish'],
    scopeSeparator: ',',
    pkce: 'none',
    clientAuth: 'client_secret_post',
    clientIdParam: 'client_id',
    extraAuthorizationParams: {},
    refresh: 'none',
    capabilityScopes: {
      read_profile: ['threads_basic'],
      publish: ['threads_content_publish'],
    },
    approval: {
      required: true,
      notes: [
        'Meta App Review is required for threads_content_publish.',
        'Long-lived token exchange uses Threads-specific endpoints and arrives with the Threads adapter.',
      ],
    },
    docsUrl:
      'https://developers.facebook.com/docs/threads/get-started/get-access-tokens-and-permissions',
  },
  YOUTUBE: {
    platform: 'YOUTUBE',
    displayName: 'YouTube',
    authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    revocationUrl: 'https://oauth2.googleapis.com/revoke',
    defaultScopes: [
      'https://www.googleapis.com/auth/youtube.upload',
      'https://www.googleapis.com/auth/youtube.readonly',
    ],
    scopeSeparator: ' ',
    pkce: 'supported',
    clientAuth: 'client_secret_post',
    clientIdParam: 'client_id',
    // Without offline access + consent Google issues no refresh token, and the
    // connection would silently die after an hour.
    extraAuthorizationParams: {
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    },
    refresh: 'standard',
    capabilityScopes: {
      list_destinations: ['https://www.googleapis.com/auth/youtube.readonly'],
      publish: ['https://www.googleapis.com/auth/youtube.upload'],
      analytics: ['https://www.googleapis.com/auth/yt-analytics.readonly'],
    },
    approval: {
      required: true,
      notes: [
        'YouTube scopes are sensitive: Google OAuth verification is required before users outside your test-user list can connect, and unverified apps show a warning screen.',
        'Videos uploaded through an unaudited API project are restricted to private viewing until the project passes a YouTube API Services compliance audit.',
        'The YouTube Data API has a daily quota, and uploads are expensive against it.',
      ],
    },
    docsUrl: 'https://developers.google.com/youtube/v3/guides/authentication',
  },
  TIKTOK: {
    platform: 'TIKTOK',
    displayName: 'TikTok',
    authorizationUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    revocationUrl: 'https://open.tiktokapis.com/v2/oauth/revoke/',
    defaultScopes: ['user.info.basic', 'video.upload', 'video.publish'],
    scopeSeparator: ',',
    pkce: 'none',
    clientAuth: 'client_secret_post',
    clientIdParam: 'client_key',
    extraAuthorizationParams: {},
    refresh: 'standard',
    capabilityScopes: {
      read_profile: ['user.info.basic'],
      publish: ['video.publish'],
    },
    approval: {
      required: true,
      notes: [
        'The Content Posting API requires TikTok to audit the app; until then, posts can only be published with private (SELF_ONLY) visibility.',
        'video.publish must be approved for the app before it can be requested.',
      ],
    },
    docsUrl: 'https://developers.tiktok.com/doc/oauth-user-access-token-management',
  },
  X: {
    platform: 'X',
    displayName: 'X',
    authorizationUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    revocationUrl: 'https://api.x.com/2/oauth2/revoke',
    defaultScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    scopeSeparator: ' ',
    pkce: 'required',
    clientAuth: 'client_secret_basic',
    clientIdParam: 'client_id',
    extraAuthorizationParams: {},
    refresh: 'standard',
    capabilityScopes: {
      read_profile: ['users.read'],
      publish: ['tweet.write'],
    },
    approval: {
      required: true,
      notes: [
        'Posting requires an X developer account; how much you can post depends on the paid API access tier.',
        'Access tokens expire after about two hours, so offline.access is requested to allow refresh.',
      ],
    },
    docsUrl:
      'https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code',
  },
  PINTEREST: {
    platform: 'PINTEREST',
    displayName: 'Pinterest',
    authorizationUrl: 'https://www.pinterest.com/oauth/',
    tokenUrl: 'https://api.pinterest.com/v5/oauth/token',
    revocationUrl: null,
    defaultScopes: ['user_accounts:read', 'boards:read', 'pins:read', 'pins:write'],
    scopeSeparator: ',',
    pkce: 'none',
    clientAuth: 'client_secret_basic',
    clientIdParam: 'client_id',
    extraAuthorizationParams: {},
    refresh: 'standard',
    capabilityScopes: {
      read_profile: ['user_accounts:read'],
      list_destinations: ['boards:read'],
      publish: ['pins:write'],
    },
    approval: {
      required: true,
      notes: [
        "New apps start with Trial access; Standard access needs Pinterest's app review before production use.",
      ],
    },
    docsUrl:
      'https://developers.pinterest.com/docs/getting-started/set-up-authentication-and-authorization/',
  },
};

export function getOAuthDefinition(platform: OAuthPlatform): OAuthPlatformDefinition {
  return DEFINITIONS[platform];
}

export function allOAuthDefinitions(): OAuthPlatformDefinition[] {
  return Object.values(DEFINITIONS);
}
