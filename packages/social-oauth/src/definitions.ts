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
const META_GRAPH_VERSION = 'v26.0';

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

/**
 * A platform product (in its developer console) that grants a set of scopes.
 * Products are how platforms gate access, so "missing scope" is reported as
 * "missing product" — the thing an operator actually has to go and request.
 */
export interface OAuthProduct {
  id: string;
  name: string;
  scopes: readonly string[];
  /** true = any ONE of `scopes` satisfies the product (e.g. r_ or rw_ admin). */
  anyOf?: boolean;
  /** true = the platform reviews the application before granting it. */
  reviewRequired: boolean;
  enables: string;
}

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
  /** Products that grant this platform's scopes, where they matter to Spectra. */
  products?: readonly OAuthProduct[];
  /**
   * How the token endpoint is called. Default POST (RFC 6749). Meta documents
   * GET with query parameters, so its requests follow that.
   */
  tokenRequestMethod?: 'GET' | 'POST';
  /** A platform-specific upgrade applied right after the code exchange. */
  longLivedExchange?: 'fb_exchange_token';
  /** How this platform's tokens live and die, in one or two sentences. */
  tokenNote?: string;
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
    products: [
      {
        id: 'sign-in-oidc',
        name: 'Sign In with LinkedIn using OpenID Connect',
        scopes: ['openid', 'profile'],
        reviewRequired: false,
        enables: 'Identifying the member who connected, so posts can be authored as them.',
      },
      {
        id: 'share-on-linkedin',
        name: 'Share on LinkedIn',
        scopes: ['w_member_social'],
        reviewRequired: false,
        enables: 'Posting text and images as the member.',
      },
      {
        id: 'community-management-pages',
        name: 'Community Management API — page access',
        scopes: ['r_organization_admin', 'rw_organization_admin'],
        anyOf: true,
        reviewRequired: true,
        enables: 'Finding the LinkedIn pages the member administers.',
      },
      {
        id: 'community-management-posting',
        name: 'Community Management API — page posting',
        scopes: ['w_organization_social'],
        reviewRequired: true,
        enables: 'Posting text and images as those pages.',
      },
    ],
    docsUrl:
      'https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow',
  },
  FACEBOOK: {
    platform: 'FACEBOOK',
    displayName: 'Meta — Facebook Pages & Instagram',
    authorizationUrl: `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${META_GRAPH_VERSION}/oauth/access_token`,
    revocationUrl: null,
    // Pages publishing plus Instagram professional accounts linked to them
    // (Instagram API with Facebook Login).
    defaultScopes: [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'instagram_basic',
      'instagram_content_publish',
    ],
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
        "Meta App Review (Advanced Access) is required for pages_manage_posts, pages_read_engagement, instagram_basic and instagram_content_publish before anyone outside the app's own roles can connect.",
        'Advanced access may also require Meta Business Verification. Pages or Instagram accounts owned through a Business portfolio may also need business_management.',
        'Instagram publishing works only for professional (Business or Creator) accounts linked to a Facebook Page.',
      ],
    },
    products: [
      {
        id: 'pages-access',
        name: 'Pages API — Page access',
        scopes: ['pages_show_list', 'pages_read_engagement'],
        reviewRequired: true,
        enables: 'Listing the Pages you manage and reading their metadata.',
      },
      {
        id: 'pages-publishing',
        name: 'Pages API — Page publishing',
        scopes: ['pages_manage_posts'],
        reviewRequired: true,
        enables: 'Publishing text and photo posts to those Pages.',
      },
      {
        id: 'instagram-publishing',
        name: 'Instagram API with Facebook Login — content publishing',
        scopes: ['instagram_basic', 'instagram_content_publish'],
        reviewRequired: true,
        enables:
          'Finding Instagram professional accounts linked to your Pages and publishing to them.',
      },
    ],
    tokenRequestMethod: 'GET',
    longLivedExchange: 'fb_exchange_token',
    tokenNote:
      'Meta issues no refresh tokens. The user token is exchanged for a long-lived one (about 60 days); Page tokens obtained with it do not expire, so publishing to Pages and Instagram continues after it lapses. Reconnect to find new Pages or after permissions change.',
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
        'Spectra publishes to Instagram through a Facebook connection: connect Meta (Facebook) and the professional Instagram accounts linked to your Pages are found. A direct Instagram Login connection stores an authorization only.',
        'Only Instagram professional accounts (Business or Creator) can publish through the API.',
        'Meta App Review is required for instagram_business_content_publish.',
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
        'Meta App Review is required for threads_content_publish. Until advanced access is granted, "you can only post to Threads for your account and your app\'s tester accounts."',
        'Threads limits a profile to 250 API-published posts per 24 hours.',
      ],
    },
    products: [
      {
        id: 'threads-publishing',
        name: 'Threads API — content publishing',
        scopes: ['threads_basic', 'threads_content_publish'],
        reviewRequired: true,
        enables: 'Publishing text and image posts to the connected Threads profile.',
      },
    ],
    tokenNote:
      "Threads has no standard refresh grant here, so reconnect before the authorization expires. Images are fetched by Threads from a short-lived link to this deployment's storage.",
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
    // video.upload only sends a draft to the creator's inbox, which this
    // deployment does not use, so it is not requested.
    defaultScopes: ['user.info.basic', 'video.publish'],
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
        'TikTok must audit the API client before it can post publicly: "All content posted by unaudited clients will be restricted to private viewing mode."',
        'video.publish must be approved for the app, and Direct Post enabled in the app settings, before it can be requested.',
        'Which privacy levels a creator may use comes from TikTok at publish time, never from Spectra.',
      ],
    },
    products: [
      {
        id: 'content-posting-direct-post',
        name: 'Content Posting API — Direct Post',
        scopes: ['video.publish'],
        reviewRequired: true,
        enables: "Publishing a video directly to the creator's TikTok account.",
      },
    ],
    tokenNote:
      'A TikTok access token lasts 24 hours and its refresh token 365 days, so the worker refreshes before publishing; reconnect once the refresh token lapses.',
    docsUrl: 'https://developers.tiktok.com/doc/oauth-user-access-token-management',
  },
  X: {
    platform: 'X',
    displayName: 'X',
    authorizationUrl: 'https://x.com/i/oauth2/authorize',
    tokenUrl: 'https://api.x.com/2/oauth2/token',
    revocationUrl: 'https://api.x.com/2/oauth2/revoke',
    // media.write is needed to upload an image through the v2 endpoints.
    defaultScopes: ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'],
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
        'Posting requires an X developer account with API access that covers writes. X API v2 is pay-per-usage: credits are deducted per request, and a post costs more when it contains a link.',
        'X documents 100 posts per user per 15 minutes and 10,000 per app per 24 hours.',
        "X's API reference states no character limit for a post, so Spectra caps one at 280 characters — a verified account may be allowed more.",
      ],
    },
    products: [
      {
        id: 'x-api-write',
        name: 'X API v2 — post and media write',
        scopes: ['tweet.write', 'media.write'],
        reviewRequired: false,
        enables: 'Creating posts with up to four images, billed per request by X.',
      },
    ],
    tokenNote:
      'An X access token lasts about two hours, so offline.access is requested and the worker refreshes before publishing.',
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
        "New apps start with Trial access: the app can act only for accounts you have granted it, and Standard access needs Pinterest's app review before wider use.",
        'Pinterest does not document image formats, a maximum file size or text limits for a pin; it refuses what it will not take and Spectra reports that refusal as it came.',
      ],
    },
    products: [
      {
        id: 'pins-write',
        name: 'Pinterest API v5 — pin creation',
        scopes: ['pins:write', 'boards:read'],
        reviewRequired: true,
        enables: 'Creating an image pin on a board of the connected account.',
      },
    ],
    tokenNote:
      "Pinterest issues refresh tokens, so the worker renews the access token before publishing. Pinterest fetches a pin's image from a short-lived link to this deployment's storage.",
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

export interface ProductAccess {
  product: OAuthProduct;
  /** GRANTED / MISSING, or UNKNOWN when the platform did not report scopes. */
  status: 'GRANTED' | 'MISSING' | 'UNKNOWN';
  missingScopes: string[];
}

/** Which of a platform's products a grant actually carries. */
export function resolveProductAccess(
  definition: OAuthPlatformDefinition,
  grantedScopes: readonly string[] | null,
): ProductAccess[] {
  return (definition.products ?? []).map((product) => {
    if (grantedScopes === null) {
      return { product, status: 'UNKNOWN' as const, missingScopes: [] };
    }
    const missing = product.scopes.filter((scope) => !grantedScopes.includes(scope));
    const granted = product.anyOf ? missing.length < product.scopes.length : missing.length === 0;
    return {
      product,
      status: granted ? ('GRANTED' as const) : ('MISSING' as const),
      missingScopes: granted ? [] : missing,
    };
  });
}
