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
