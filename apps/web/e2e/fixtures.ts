import type { Page, Route } from '@playwright/test';

/**
 * API stubbing for authenticated UI journeys.
 *
 * These are FRONTEND tests: they run the real production build against a
 * stubbed `/v1` API. That boundary is deliberate — the API's own behaviour is
 * covered by the integration suite against a real database, and duplicating it
 * here would make the frontend suite slow and flaky without testing anything
 * new. What these DO test is what only the browser can show: routing, rendering,
 * permission gating, form validation and honest empty/error states.
 */

export const ORG_ID = '00000000-0000-4000-8000-000000000001';
export const WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';

/** Every permission the UI gates on, for the "full access" default. */
export const ALL_PERMISSIONS = [
  'org:manage',
  'org:members:manage',
  'workspace:manage',
  'brand:read',
  'brand:write',
  'vertical:read',
  'vertical:write',
  'research:read',
  'research:run',
  'research:review',
  'trend:read',
  'knowledge:read',
  'knowledge:write',
  'strategy:read',
  'strategy:write',
  'content:read',
  'content:write',
  'content:review',
  'content:approve',
  'campaign:read',
  'campaign:write',
  'media:read',
  'media:write',
  'social:connect',
  'social:publish',
  'analytics:read',
  'audit:read',
  'ops:read',
  'ops:retry',
];

/** A failed job as the operations dashboard receives it. */
export function failedJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 'job-1',
    name: 'research.run.execute',
    category: 'Research runs',
    attemptsMade: 3,
    maxAttempts: 3,
    reason: 'Brave Search returned 429 (rate limited)',
    failedAt: '2026-09-10T09:15:00.000Z',
    correlationId: 'corr-abc123',
    organizationId: ORG_ID,
    workspaceId: WORKSPACE_ID,
    resourceId: 'run-9',
    ...overrides,
  };
}

export const CONNECTION_ID = '00000000-0000-4000-8000-0000000000c1';

const limitation = (name: string) =>
  `Connecting stores an authorization only. No ${name} publishing adapter is wired, so a post to ${name} resolves to UNSUPPORTED and nothing is posted.`;

/** GET /social/oauth/platforms: X configured, Facebook not. */
export function oauthPlatforms(options: { credentialStorageConfigured?: boolean } = {}) {
  const storage = options.credentialStorageConfigured ?? true;
  return {
    credentialStorageConfigured: storage,
    stateTtlSeconds: 600,
    definitionsRecordedAt: '2026-09-10',
    platforms: [
      {
        platform: 'X',
        displayName: 'X',
        configured: true,
        missingConfiguration: [],
        redirectUri: 'http://localhost:4000/v1/social/oauth/x/callback',
        scopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
        pkce: 'required',
        refresh: 'standard',
        approval: {
          required: true,
          notes: ['Posting requires an X developer account; volume depends on the paid API tier.'],
        },
        docsUrl: 'https://docs.x.com',
        adapters: { publishing: false, discovery: false },
        canConnect: storage,
        limitation: limitation('X'),
      },
      {
        platform: 'FACEBOOK',
        displayName: 'Facebook Pages',
        configured: false,
        missingConfiguration: [
          'SOCIAL_OAUTH_FACEBOOK_CLIENT_ID',
          'SOCIAL_OAUTH_FACEBOOK_CLIENT_SECRET',
        ],
        redirectUri: 'http://localhost:4000/v1/social/oauth/facebook/callback',
        scopes: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
        pkce: 'none',
        refresh: 'none',
        approval: {
          required: true,
          notes: ['Meta App Review is required for pages_manage_posts.'],
        },
        docsUrl: 'https://developers.facebook.com',
        adapters: { publishing: false, discovery: false },
        canConnect: false,
        limitation: limitation('Facebook Pages'),
      },
    ],
  };
}

/** One row of GET /social/connections, as the API presents it. */
export function connectionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: CONNECTION_ID,
    platform: 'X',
    platformDisplayName: 'X',
    status: 'CONNECTED',
    label: 'Acme on X',
    externalSubjectId: null,
    requestedScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    grantedScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
    hasRefreshToken: true,
    accessTokenExpiresAt: '2099-01-01T00:00:00.000Z',
    accessTokenExpired: false,
    lastRefreshedAt: null,
    lastErrorCode: null,
    connectedAt: '2026-09-10T09:00:00.000Z',
    refresh: { available: true, reason: 'The access token can be refreshed.' },
    discovery: {
      status: 'NOT_AVAILABLE',
      note: 'No X account-discovery adapter is wired, so no profiles, pages or channels were looked up.',
    },
    publishing: {
      wired: false,
      note: 'No X publishing adapter is wired — nothing is posted from this connection.',
    },
    accounts: [],
    ...overrides,
  };
}

/** A LinkedIn account capability snapshot, as discovery stores it. */
export function linkedInCapabilities(
  image: 'AVAILABLE' | 'MISSING_PERMISSION' = 'AVAILABLE',
): Record<string, unknown> {
  return {
    adapterVersion: 'linkedin-posts-1.0.0',
    checkedAt: '2026-09-11T10:00:00.000Z',
    postTypes: {
      TEXT: {
        status: 'AVAILABLE',
        reason: 'Text posts are published.',
        requiredScopes: ['w_member_social'],
      },
      IMAGE: {
        status: image,
        reason:
          image === 'AVAILABLE'
            ? 'Single-image posts are published.'
            : 'Needs w_organization_social (Community Management API).',
        requiredScopes: ['w_member_social'],
      },
      VIDEO: {
        status: 'NOT_IMPLEMENTED',
        reason:
          "LinkedIn supports video posts (Videos API); Spectra's LinkedIn adapter does not upload video yet.",
        requiredScopes: ['w_member_social'],
      },
      DOCUMENT: {
        status: 'NOT_IMPLEMENTED',
        reason:
          "LinkedIn supports document posts; Spectra's LinkedIn adapter does not upload documents yet.",
        requiredScopes: ['w_member_social'],
      },
    },
    limits: {
      maxCharacters: 3000,
      maxImages: 1,
      imageMimeTypes: ['image/jpeg', 'image/png', 'image/gif'],
    },
    notes: [],
  };
}

/** A LinkedIn member discovered through a connection. */
export function linkedInAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000d1',
    platform: 'LINKEDIN',
    externalAccountId: 'urn:li:person:782bbtaQ',
    displayName: 'Jane Doe',
    kind: 'PROFILE',
    status: 'CONNECTED',
    scopes: ['openid', 'profile', 'w_member_social'],
    tokenRef: null,
    connectionId: '00000000-0000-4000-8000-0000000000c2',
    capabilities: linkedInCapabilities(),
    connectedAt: '2026-09-11T09:00:00.000Z',
    createdAt: '2026-09-11T09:00:00.000Z',
    ...overrides,
  };
}

/** A LinkedIn connection from a self-serve app: page products missing. */
export function linkedInConnectionRow() {
  return connectionRow({
    id: '00000000-0000-4000-8000-0000000000c2',
    platform: 'LINKEDIN',
    platformDisplayName: 'LinkedIn',
    label: 'Acme on LinkedIn',
    hasRefreshToken: false,
    refresh: {
      available: false,
      reason: 'LinkedIn did not issue a refresh token for this connection; reconnect to renew it.',
    },
    discovery: { status: 'COMPLETE', note: '1 account(s) discovered.' },
    publishing: {
      wired: true,
      note: 'Text posts and single-image posts (JPG, PNG, GIF). Video, document, multi-image, article and poll posts are not implemented.',
    },
    permissions: [
      {
        id: 'share-on-linkedin',
        name: 'Share on LinkedIn',
        scopes: ['w_member_social'],
        anyOf: false,
        reviewRequired: false,
        enables: 'Posting text and images as the member.',
        status: 'GRANTED',
        missingScopes: [],
      },
      {
        id: 'community-management-posting',
        name: 'Community Management API — page posting',
        scopes: ['w_organization_social'],
        anyOf: false,
        reviewRequired: true,
        enables: 'Posting text and images as those pages.',
        status: 'MISSING',
        missingScopes: ['w_organization_social'],
      },
    ],
    accounts: [linkedInAccount()],
  });
}

/** An Instagram account capability snapshot, as Meta discovery stores it. */
export function instagramCapabilities(eligible = true): Record<string, unknown> {
  const notSupported = (reason: string) => ({
    status: 'NOT_SUPPORTED',
    reason,
    requiredScopes: [],
  });
  const personal =
    'Instagram only allows publishing through its API to professional (Business or Creator) accounts linked to a Facebook Page.';
  return {
    adapterVersion: 'meta-graph-1.0.0',
    checkedAt: '2026-09-11T10:00:00.000Z',
    postTypes: eligible
      ? {
          TEXT: notSupported('Instagram posts need an image; Instagram has no text-only posts.'),
          IMAGE: {
            status: 'AVAILABLE',
            reason: 'Single-image JPEG posts are published through Instagram content publishing.',
            requiredScopes: ['instagram_basic', 'instagram_content_publish'],
          },
          VIDEO: {
            status: 'NOT_IMPLEMENTED',
            reason:
              "Instagram supports video and Reels; Spectra's Meta adapter does not publish them yet.",
            requiredScopes: ['instagram_basic', 'instagram_content_publish'],
          },
          DOCUMENT: notSupported('Instagram has no document posts.'),
        }
      : {
          TEXT: notSupported(personal),
          IMAGE: notSupported(personal),
          VIDEO: notSupported(personal),
          DOCUMENT: notSupported(personal),
        },
    limits: { maxCharacters: 2200, maxImages: 1, imageMimeTypes: ['image/jpeg'] },
    notes: [],
  };
}

/** An Instagram professional account found through a Meta (Facebook) connection. */
export function instagramAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000d3',
    platform: 'INSTAGRAM',
    externalAccountId: '17841400000000001',
    displayName: '@acmecoffee',
    kind: 'BUSINESS_ACCOUNT',
    status: 'CONNECTED',
    scopes: ['pages_show_list', 'instagram_basic', 'instagram_content_publish'],
    tokenRef: null,
    connectionId: '00000000-0000-4000-8000-0000000000c3',
    capabilities: instagramCapabilities(),
    connectedAt: '2026-09-11T09:00:00.000Z',
    createdAt: '2026-09-11T09:00:00.000Z',
    ...overrides,
  };
}

/** A YouTube channel capability snapshot, as discovery stores it. */
export function youtubeCapabilities(canUpload = true): Record<string, unknown> {
  const notSupported = (reason: string) => ({
    status: 'NOT_SUPPORTED',
    reason,
    requiredScopes: [],
  });
  return {
    adapterVersion: 'youtube-data-v3-1.0.0',
    checkedAt: '2026-09-12T10:00:00.000Z',
    postTypes: {
      TEXT: notSupported('YouTube publishes videos; text-only community posts have no public API.'),
      IMAGE: notSupported(
        'YouTube has no public API for image posts. An image can only be a custom thumbnail on a video.',
      ),
      VIDEO: canUpload
        ? {
            status: 'AVAILABLE',
            reason: 'Videos are uploaded through the YouTube Data API with a resumable upload.',
            requiredScopes: ['https://www.googleapis.com/auth/youtube.upload'],
          }
        : {
            status: 'MISSING_PERMISSION',
            reason:
              'Uploading needs the https://www.googleapis.com/auth/youtube.upload scope, which this connection was not granted.',
            requiredScopes: ['https://www.googleapis.com/auth/youtube.upload'],
          },
      DOCUMENT: notSupported('YouTube has no document posts.'),
    },
    limits: { maxCharacters: 5000, maxImages: 1, imageMimeTypes: ['image/jpeg', 'image/png'] },
    notes: [
      'Google restricts videos uploaded through the API by unverified projects: "All videos uploaded via the videos.insert endpoint from unverified API projects created after 28 July 2020 will be restricted to private viewing mode."',
      'The YouTube Data API has a daily quota, and uploads are limited per project and per channel; a refusal is reported with what YouTube said.',
    ],
  };
}

/** A YouTube channel found through a connection. */
export function youtubeAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: '00000000-0000-4000-8000-0000000000e1',
    platform: 'YOUTUBE',
    externalAccountId: 'UC_x5XG1OV2P6uZZ5FSM9Ttw',
    displayName: 'Acme Coffee',
    kind: 'CHANNEL',
    status: 'CONNECTED',
    scopes: ['https://www.googleapis.com/auth/youtube.upload'],
    tokenRef: null,
    connectionId: '00000000-0000-4000-8000-0000000000c4',
    capabilities: youtubeCapabilities(),
    connectedAt: '2026-09-12T09:00:00.000Z',
    createdAt: '2026-09-12T09:00:00.000Z',
    ...overrides,
  };
}

export function meResponse(permissions: readonly string[] = ALL_PERMISSIONS) {
  return {
    user: {
      id: '00000000-0000-4000-8000-000000000003',
      email: 'demo@spectra.local',
      name: 'Demo Operator',
      timezone: 'UTC',
      locale: 'en',
    },
    memberships: [
      {
        organizationId: ORG_ID,
        organizationName: 'Demo Org',
        organizationSlug: 'demo-org',
        role: 'ORG_OWNER',
        extraPermissions: [],
        effectivePermissions: permissions,
        workspaceIds: [],
      },
    ],
    workspaces: [
      {
        id: WORKSPACE_ID,
        organizationId: ORG_ID,
        name: 'Demo Workspace',
        slug: 'demo-workspace',
        timezone: 'UTC',
        status: 'ACTIVE',
      },
    ],
  };
}

export interface StubOptions {
  permissions?: readonly string[];
  /** Extra path→payload overrides, matched as substrings of the URL. */
  routes?: Record<string, unknown>;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

/**
 * Installs a stub `/v1` API. Unmatched GETs resolve to an empty list rather
 * than hanging, so a page under test renders its genuine empty state instead of
 * an indefinite spinner.
 */
export async function stubApi(page: Page, options: StubOptions = {}): Promise<void> {
  const overrides = options.routes ?? {};

  await page.route('**/v1/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;

    for (const [fragment, payload] of Object.entries(overrides)) {
      if (path.includes(fragment)) return json(route, payload);
    }

    if (path.endsWith('/auth/me')) return json(route, meResponse(options.permissions));
    if (path.endsWith('/meta/capabilities')) {
      return json(route, {
        generation: { configured: false, provider: 'anthropic', model: 'claude-opus-4-8' },
        retrieval: { semantic: false, note: 'Lexical retrieval — matches words, not meaning.' },
        discovery: { liveSearchConfigured: false, providers: [], note: 'No search provider.' },
        templates: {
          userEditable: false,
          builtIn: [
            {
              id: 'evidence-grounded-draft',
              version: '1.0.0',
              kind: 'PROMPT',
              displayName: 'Evidence-grounded draft',
              description: 'The prompt used for every generated draft.',
            },
          ],
          contentTypeFormats: { POST: 'a single concise social media post' },
          note: 'Visual and user-defined templates are not implemented.',
        },
        credentialStorage: { configured: false, note: 'Not configured.' },
      });
    }

    if (route.request().method() !== 'GET') return json(route, {}, 200);
    return json(route, []);
  });
}

/** Signs in by seeding the session the app checks, then loads a route. */
export async function gotoAuthenticated(page: Page, path: string): Promise<void> {
  await page.goto('/login');
  await page.evaluate(
    (workspaceId) => window.localStorage.setItem('spectra.activeWorkspaceId', workspaceId),
    WORKSPACE_ID,
  );
  await page.goto(path);
}
