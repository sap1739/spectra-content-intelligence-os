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
  'design:read',
  'design:write',
  'social:connect',
  'social:publish',
  'analytics:read',
  'analytics:sync',
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

// ---------------------------------------------------------------------------
// External analytics (Phase 6H)
// ---------------------------------------------------------------------------

const freshness = (state: 'FRESH' | 'STALE' | 'NEVER_SYNCED') => ({
  state,
  retrievedAt: state === 'NEVER_SYNCED' ? null : new Date(Date.now() - 20 * 60_000).toISOString(),
  staleAfter: null,
  dataAsOf: null,
  note: null,
});

export function analyticsOverview(externalAvailable: boolean) {
  return {
    source: 'FIRST_PARTY_MEASURED',
    content: {
      total: 4,
      byLifecycleState: { PUBLISHED: 3, DRAFT: 1 },
      published: 3,
      awaitingReview: 0,
    },
    drafts: { total: 2, byStatus: { READY: 2 } },
    publications: { total: 3, byStatus: { PUBLISHED: 3 }, unsupported: 0 },
    research: { runs: 1, runsByStatus: { SUCCEEDED: 1 }, findings: 5, evidencePacksReady: 1 },
    trends: { total: 0, byState: {} },
    engagement: { externalAvailable, note: 'n/a' },
    generatedAt: '2026-09-14T10:00:00.000Z',
  };
}

const aggregate = (key: string, value: number | null, extra: Record<string, unknown> = {}) => ({
  key,
  unit: key === 'engagementRate' ? 'RATIO' : 'COUNT',
  value,
  completeness: value === null ? 'UNAVAILABLE' : 'EXACT',
  contributing: value === null ? 0 : 2,
  unavailable: value === null ? 3 : 1,
  unavailableReason: value === null ? 'NOT_EXPOSED_BY_PLATFORM' : null,
  detail: value === null ? 'No snapshot reported likes.' : null,
  ...extra,
});

export function analyticsSummary(externalAvailable: boolean) {
  return {
    source: 'EXTERNAL_MEASURED',
    externalAvailable,
    publishedPosts: 3,
    postsWithSnapshots: externalAvailable ? 2 : 0,
    postsWithMeasuredValues: externalAvailable ? 2 : 0,
    postsWithoutAnalytics: externalAvailable ? 1 : 3,
    accountsWithSnapshots: externalAvailable ? 1 : 0,
    content: externalAvailable
      ? [
          aggregate('views', 5200),
          aggregate('impressions', null, {
            unavailableReason: 'NOT_IMPLEMENTED',
            detail: 'No snapshot reported impressions.',
          }),
          aggregate('likes', null),
          aggregate('comments', 0),
          aggregate('shares', 17),
          aggregate('engagementRate', 0.0431, { completeness: 'DERIVED' }),
        ]
      : [aggregate('views', null), aggregate('likes', null)],
    followers: aggregate(
      'followers',
      externalAvailable ? 12300 : null,
      externalAvailable ? { completeness: 'APPROXIMATE' } : {},
    ),
    byPlatform: [],
    freshness: freshness(externalAvailable ? 'FRESH' : 'NEVER_SYNCED'),
    lastRun: null,
    note: 'No external analytics yet. Connect a platform with an analytics adapter and run a sync — nothing is estimated in their place.',
  };
}

export function analyticsAvailability() {
  const capability = { metrics: [], summary: 's' };
  return {
    note: 'n/a',
    accounts: [
      {
        socialAccountId: 'a1',
        platform: 'YOUTUBE',
        kind: 'CHANNEL',
        displayName: 'Acme Coffee',
        availability: 'PARTIAL',
        reason:
          'Some metrics are readable. Missing: https://www.googleapis.com/auth/yt-analytics.readonly.',
        capability,
        freshness: freshness('FRESH'),
      },
      {
        socialAccountId: 'a2',
        platform: 'TIKTOK',
        kind: 'PROFILE',
        displayName: '@acme',
        availability: 'NOT_IMPLEMENTED',
        reason: 'Not implemented. No TikTok analytics adapter exists yet.',
        capability,
        freshness: freshness('NEVER_SYNCED'),
      },
    ],
  };
}

export function contentAnalytics() {
  const metric = (key: string, value: number | null, extra: Record<string, unknown> = {}) => ({
    key,
    sourceMetricName: value === null ? null : `statistics.${key}Count`,
    value,
    unit: key === 'watchTimeMinutes' ? 'MINUTES' : 'COUNT',
    completeness: value === null ? 'UNAVAILABLE' : 'EXACT',
    unavailableReason: value === null ? 'MISSING_SCOPE' : null,
    detail:
      value === null
        ? 'Needs https://www.googleapis.com/auth/yt-analytics.readonly, which this connection was not granted.'
        : null,
    ...extra,
  });
  return {
    item: {
      id: 'item-1',
      title: 'Quarterly roast report',
      lifecycleState: 'PUBLISHED',
      campaignId: null,
    },
    source: 'EXTERNAL_MEASURED',
    entries: [
      {
        scheduleEntryId: 'e1',
        platform: 'YOUTUBE',
        status: 'PUBLISHED',
        externalUrl: 'https://www.youtube.com/watch?v=vid_abcdefgh',
        publishedAt: '2026-09-10T10:00:00.000Z',
        latest: {
          id: 's1',
          level: 'CONTENT',
          providerId: 'youtube-data-v3+analytics-v2',
          attribution: {},
          completeness: 'PARTIAL',
          retrievedAt: new Date().toISOString(),
          freshness: freshness('FRESH'),
          metrics: [metric('views', 4200), metric('comments', 0), metric('watchTimeMinutes', null)],
          notes: [],
          syncRunId: 'r1',
        },
        history: [],
        freshness: freshness('FRESH'),
        unavailableReason: null,
      },
      {
        scheduleEntryId: 'e2',
        platform: 'TIKTOK',
        status: 'PUBLISHED',
        externalUrl: null,
        publishedAt: '2026-09-11T10:00:00.000Z',
        latest: null,
        history: [],
        freshness: freshness('NEVER_SYNCED'),
        unavailableReason: 'Not implemented. No TikTok analytics adapter exists yet.',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Design studio (Phase 7A)
// ---------------------------------------------------------------------------

export function studioCapabilities() {
  return {
    engine: 'sharp-design',
    engineVersion: '0.33.5',
    outputs: ['PNG', 'JPEG', 'PDF'],
    pdf: 'Raster PDF: each page is the rendered JPEG embedded at the format’s dpi — not editable vector text.',
    fonts: 'Brand fonts render from an uploaded TTF/OTF file.',
    aiImageGeneration: false,
    note: 'Designs are rendered locally from templates, brand kits and your own images. Nothing is generated by an AI image model.',
  };
}

export function designFormats() {
  return [
    {
      key: 'INSTAGRAM_SQUARE',
      label: 'Instagram square (1:1)',
      width: 1080,
      height: 1080,
      dpi: 72,
      platform: 'INSTAGRAM',
      note: 'Square feed post.',
      maxBytes: null,
    },
    {
      key: 'YOUTUBE_THUMBNAIL',
      label: 'YouTube thumbnail (16:9)',
      width: 1280,
      height: 720,
      dpi: 72,
      platform: 'YOUTUBE',
      note: 'YouTube custom thumbnail size.',
      maxBytes: 2097152,
    },
  ];
}

const quoteLayout = {
  schemaVersion: 1,
  fields: [
    {
      key: 'quote',
      label: 'Quote',
      kind: 'TEXT',
      required: true,
      maxLength: 280,
      defaultValue: null,
      help: null,
    },
    {
      key: 'attribution',
      label: 'Attribution',
      kind: 'TEXT',
      required: false,
      maxLength: 80,
      defaultValue: '— {{brand.name}}',
      help: null,
    },
  ],
  pages: [{ id: 'page1', background: { fill: { brand: 'primary' }, imageSlot: null }, layers: [] }],
};

export function designTemplates() {
  return {
    builtIn: [
      {
        key: 'quote-card',
        version: 1,
        name: 'Quote card',
        description: 'A large quote on the brand colour with attribution and the logo.',
        category: 'QUOTE',
        formats: ['INSTAGRAM_SQUARE'],
        defaultFormat: 'INSTAGRAM_SQUARE',
        layout: quoteLayout,
        source: 'BUILT_IN',
      },
    ],
    workspace: [],
  };
}

export function designRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'd1',
    name: 'Morning quote',
    status: 'DRAFT',
    category: 'QUOTE',
    formatKey: 'INSTAGRAM_SQUARE',
    templateBuiltInKey: 'quote-card',
    templateId: null,
    brandId: null,
    brand: null,
    contentItemId: null,
    campaignId: null,
    contentItem: null,
    campaign: null,
    values: { quote: 'Good coffee is a small daily luxury.' },
    images: {},
    layout: quoteLayout,
    reviewNote: null,
    approvedAt: null,
    publishedAt: null,
    updatedAt: '2026-09-15T10:00:00.000Z',
    renders: [
      {
        id: 'r1',
        outputFormat: 'PNG',
        pageIndex: 0,
        pageCount: 1,
        formatKey: 'INSTAGRAM_SQUARE',
        widthPx: 1080,
        heightPx: 1080,
        warnings: ['The brand has no logo, so logo placeholders were left empty.'],
        createdAt: '2026-09-15T10:00:00.000Z',
        mediaAsset: { id: 'a1', mimeType: 'image/png', sizeBytes: 148_000 },
      },
    ],
    ...overrides,
  };
}

/** A 1×1 PNG, so the preview route returns real image bytes. */
export const PREVIEW_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
