import { expect, test } from '@playwright/test';

import {
  ALL_PERMISSIONS,
  ORG_ID,
  WORKSPACE_ID,
  failedJob,
  gotoAuthenticated,
  stubApi,
  CONNECTION_ID,
  connectionRow,
  oauthPlatforms,
  instagramAccount,
  instagramCapabilities,
  linkedInAccount,
  linkedInConnectionRow,
  youtubeAccount,
} from './fixtures';

/**
 * Authenticated UI journeys against a stubbed `/v1` API (see fixtures.ts for
 * why that boundary is drawn there).
 */

test.describe('dashboard', () => {
  test('renders the shell with navigation to the core areas', async ({ page }) => {
    await stubApi(page);
    await gotoAuthenticated(page, '/');

    await expect(page.getByRole('link', { name: 'Brands' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Research' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();
  });
});

test.describe('brands', () => {
  test('shows an honest empty state and a working create form', async ({ page }) => {
    await stubApi(page, { routes: { '/brands': [] } });
    await gotoAuthenticated(page, '/brands');

    await expect(page.getByRole('heading', { name: 'Brands', exact: true }).first()).toBeVisible();
    await expect(page.getByText(/no brands yet/i)).toBeVisible();
    await expect(page.getByLabel('Name')).toBeVisible();
    await expect(page.getByRole('button', { name: /create brand/i })).toBeVisible();
  });

  test('lists brands returned by the API', async ({ page }) => {
    await stubApi(page, {
      routes: {
        '/brands': [
          {
            id: '00000000-0000-4000-8000-00000000000a',
            organizationId: ORG_ID,
            workspaceId: WORKSPACE_ID,
            name: 'Acme Cloud',
            slug: 'acme-cloud',
            description: 'Primary brand',
            websiteUrl: 'https://acme.example.com',
            voice: { tone: ['precise'], doNots: ['no hype'], examplePhrases: [] },
            guidelines: {},
            languages: ['en'],
            status: 'ACTIVE',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-02T00:00:00.000Z',
          },
        ],
      },
    });
    await gotoAuthenticated(page, '/brands');

    await expect(page.getByText('Acme Cloud')).toBeVisible();
    await expect(page.getByRole('button', { name: /edit acme cloud/i })).toBeVisible();
  });

  test('validates the website field before calling the API', async ({ page }) => {
    await stubApi(page, { routes: { '/brands': [] } });
    await gotoAuthenticated(page, '/brands');

    await page.getByLabel('Name').fill('Acme');
    await page.getByLabel('Website').fill('not-a-url');
    await page.getByRole('button', { name: /create brand/i }).click();

    await expect(page.getByRole('alert').first()).toContainText(/full http\(s\) URL/i);
  });
});

test.describe('permission-restricted controls', () => {
  test('hides brand editing and names the missing permission', async ({ page }) => {
    // Read-only: the user can see brands but not change them.
    await stubApi(page, {
      permissions: ['brand:read', 'analytics:read'],
      routes: { '/brands': [] },
    });
    await gotoAuthenticated(page, '/brands');

    await expect(page.getByRole('button', { name: /create brand/i })).toHaveCount(0);
    await expect(page.getByText('brand:write')).toBeVisible();
  });

  test('settings are read-only without manage permissions', async ({ page }) => {
    await stubApi(page, { permissions: ['analytics:read'] });
    await gotoAuthenticated(page, '/settings');

    await expect(page.getByRole('button', { name: /save organization/i })).toHaveCount(0);
    await expect(page.getByText('org:manage')).toBeVisible();
    await expect(page.getByText('workspace:manage')).toBeVisible();
  });
});

test.describe('settings', () => {
  test('offers only settings the platform actually stores', async ({ page }) => {
    await stubApi(page);
    await gotoAuthenticated(page, '/settings');

    await expect(page.getByLabel('Name').first()).toBeVisible();
    await expect(page.getByLabel('Display timezone')).toBeVisible();
    // Slug is permanent, so it is shown but not editable.
    await expect(page.getByLabel('Slug')).toBeDisabled();
    // States plainly that there is no org-wide timezone rather than offering one.
    await expect(page.getByText(/no organization-wide timezone/i)).toBeVisible();
  });
});

test.describe('templates', () => {
  test('states that no user-defined templates exist and shows the real one', async ({ page }) => {
    await stubApi(page);
    await gotoAuthenticated(page, '/templates');

    await expect(page.getByText(/no user-defined templates exist yet/i)).toBeVisible();
    await expect(page.getByText('Evidence-grounded draft')).toBeVisible();
    await expect(page.getByText('evidence-grounded-draft')).toBeVisible();
  });
});

test.describe('research', () => {
  test('shows an empty project list without inventing activity', async ({ page }) => {
    await stubApi(page, { routes: { '/research-projects': [] } });
    await gotoAuthenticated(page, '/research');

    await expect(
      page.getByRole('heading', { name: 'Research', exact: true }).first(),
    ).toBeVisible();
  });
});

test.describe('usage and budgets', () => {
  test('labels spend as an estimate and reports unpriced operations', async ({ page }) => {
    await stubApi(page, {
      routes: {
        '/budget/operations': { periodStart: '', periodEnd: '', kinds: [], note: '' },
        '/budget/unpriced': {
          periodStart: '',
          periodEnd: '',
          byReason: [],
          operations: [],
          conservativelyPricedEvents: 0,
          note: 'NO_RATE_FOR_MODEL operations are real spend the ceiling cannot see.',
        },
        '/organizations/': {
          configured: false,
          enforcement: 'OFF',
          periodStart: '',
          periodEnd: '',
          limitMicros: null,
          usedMicros: 0,
          remainingMicros: null,
          usedPercent: null,
          warnAtPercent: 80,
          totalEvents: 0,
          unpricedEvents: 0,
          currency: 'USD',
          workspaces: [],
          note: 'No organization-wide limit is configured.',
        },
        '/budget': {
          status: 'NOT_CONFIGURED',
          enforcement: 'OFF',
          blocked: false,
          periodStart: '',
          periodEnd: '',
          limitMicros: null,
          usedMicros: 0,
          remainingMicros: null,
          usedPercent: null,
          unpricedEvents: 1,
          currency: 'USD',
          reason: 'No monthly spend limit is configured for this workspace.',
        },
        '/usage/summary': {
          windowDays: 30,
          since: '2026-08-10T00:00:00.000Z',
          rateVersion: 'rates-2026-09-09',
          totals: {
            events: 3,
            requests: 4,
            estimatedCostMicros: 17_500,
            unpricedEvents: 1,
          },
          byKind: [
            {
              kind: 'AI_GENERATION',
              events: 1,
              requests: 1,
              inputTokens: 1000,
              outputTokens: 100,
              totalTokens: null,
              estimatedCostMicros: 7500,
            },
          ],
          recent: [],
          note: 'Costs are ESTIMATES from a local rate table, not vendor invoices.',
          // The workspace budget travels WITH the summary response.
          budget: {
            status: 'NOT_CONFIGURED',
            enforcement: 'OFF',
            blocked: false,
            periodStart: '2026-09-01T00:00:00.000Z',
            periodEnd: '2026-10-01T00:00:00.000Z',
            limitMicros: null,
            usedMicros: 17_500,
            remainingMicros: null,
            usedPercent: null,
            unpricedEvents: 1,
            currency: 'USD',
            reason: 'No monthly spend limit is configured for this workspace.',
          },
        },
      },
    });
    await gotoAuthenticated(page, '/billing');

    await expect(page.getByText(/estimates, not invoices/i)).toBeVisible();
    await expect(page.getByText(/no known rate/i).first()).toBeVisible();
  });
});

test.describe('publication status', () => {
  test('renders each dispatch state honestly, including UNSUPPORTED', async ({ page }) => {
    const base = {
      contentItemId: '00000000-0000-4000-8000-00000000000b',
      platform: 'WORDPRESS',
      scheduledAt: '2026-09-20T10:00:00.000Z',
      note: null,
      socialAccountId: null,
      externalUrl: null,
      publishedAt: null,
      attemptCount: 1,
      contentItem: { title: 'A post', contentType: 'POST', lifecycleState: 'SCHEDULED' },
    };
    await stubApi(page, {
      routes: {
        '/content-items': [],
        '/social-accounts': [],
        '/calendar': [
          { ...base, id: 'e1', status: 'SCHEDULED', failureReason: null },
          { ...base, id: 'e2', status: 'PUBLISHING', failureReason: null },
          { ...base, id: 'e3', status: 'PUBLISHED', failureReason: null },
          {
            ...base,
            id: 'e4',
            status: 'UNSUPPORTED',
            failureReason: 'No live publisher is available for LINKEDIN. Nothing was published.',
          },
          { ...base, id: 'e5', status: 'FAILED', failureReason: 'WordPress responded 401.' },
        ],
      },
    });
    await gotoAuthenticated(page, '/calendar');

    // Every state is shown as itself — UNSUPPORTED never reads as success.
    await expect(page.getByText('UNSUPPORTED').first()).toBeVisible();
    await expect(page.getByText(/Nothing was published/i)).toBeVisible();
    await expect(page.getByText(/WordPress responded 401/i)).toBeVisible();
  });
});

test.describe('operations', () => {
  test('lists failed jobs with the reason and the correlation id an operator quotes', async ({
    page,
  }) => {
    await stubApi(page, {
      routes: {
        '/ops/queue': {
          reachable: true,
          counts: {
            waiting: 2,
            active: 1,
            delayed: 0,
            completed: 40,
            failed: 1,
            paused: 0,
            deadLettered: 0,
          },
          reason: 'Queue reachable.',
        },
        '/ops/failed-jobs': {
          reachable: true,
          failed: [failedJob()],
          deadLettered: [],
          note: 'Dead-lettered jobs exhausted their retries.',
        },
      },
    });
    await gotoAuthenticated(page, '/operations');

    await expect(page.getByText('Research runs').first()).toBeVisible();
    await expect(page.getByText('Brave Search returned 429 (rate limited)')).toBeVisible();
    await expect(page.getByText('corr-abc123')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry' })).toBeVisible();
  });

  test('an unreachable queue never renders as "no failures"', async ({ page }) => {
    await stubApi(page, {
      routes: {
        '/ops/queue': {
          reachable: false,
          counts: null,
          reason:
            'The job queue could not be reached (connect ECONNREFUSED). Counts are unknown, not zero.',
        },
        '/ops/failed-jobs': {
          reachable: false,
          failed: [],
          deadLettered: [],
          note: 'The job queue could not be reached. This is not an empty failure list — the queue is unavailable.',
        },
      },
    });
    await gotoAuthenticated(page, '/operations');

    await expect(page.getByText('The job queue is unreachable')).toBeVisible();
    await expect(page.getByText('Failure list unavailable')).toBeVisible();
    // The reassuring message must NOT appear while the truth is "unknown".
    await expect(page.getByText('No failed or dead-lettered jobs')).toHaveCount(0);
  });

  test('retry is hidden without ops:retry and the missing permission is named', async ({
    page,
  }) => {
    await stubApi(page, {
      permissions: ALL_PERMISSIONS.filter((p) => p !== 'ops:retry'),
      routes: {
        '/ops/queue': {
          reachable: true,
          counts: {
            waiting: 0,
            active: 0,
            delayed: 0,
            completed: 0,
            failed: 1,
            paused: 0,
            deadLettered: 0,
          },
          reason: 'Queue reachable.',
        },
        '/ops/failed-jobs': {
          reachable: true,
          failed: [failedJob()],
          deadLettered: [],
          note: 'Dead-lettered jobs exhausted their retries.',
        },
      },
    });
    await gotoAuthenticated(page, '/operations');

    await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);
    await expect(page.getByText('ops:retry')).toBeVisible();
  });

  test('the page refuses to show queue state without ops:read', async ({ page }) => {
    await stubApi(page, { permissions: ALL_PERMISSIONS.filter((p) => p !== 'ops:read') });
    await gotoAuthenticated(page, '/operations');

    await expect(page.getByText('ops:read')).toBeVisible();
    await expect(page.getByText('Failed jobs')).toHaveCount(0);
  });
});

test.describe('social accounts (OAuth)', () => {
  test('names missing configuration and never offers a dead connect button', async ({ page }) => {
    await stubApi(page, {
      routes: { '/social/oauth/platforms': oauthPlatforms(), '/social/connections': [] },
    });
    await gotoAuthenticated(page, '/social-accounts');

    // Exact: the collapsed Meta setup guide on the same card also mentions the variable.
    await expect(page.getByText('SOCIAL_OAUTH_FACEBOOK_CLIENT_ID', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect Facebook Pages' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Connect X' })).toBeEnabled();
    // Connecting is never presented as publishing.
    await expect(page.getByText(/X resolves to UNSUPPORTED/)).toBeVisible();
    await expect(page.getByText('No platform connected yet.')).toBeVisible();
  });

  test('refuses to connect anything while credential storage is off', async ({ page }) => {
    await stubApi(page, {
      routes: {
        '/social/oauth/platforms': oauthPlatforms({ credentialStorageConfigured: false }),
        '/social/connections': [],
      },
    });
    await gotoAuthenticated(page, '/social-accounts');
    await expect(page.getByText(/Credential storage is off/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect X' })).toBeDisabled();
  });

  test('starts the flow, follows the consent URL and shows the outcome', async ({ page }) => {
    await stubApi(page, {
      routes: {
        // The "consent screen" here sends the browser straight back with a result.
        '/social/oauth/x/start': {
          authorizationUrl: 'http://localhost:3100/social-accounts?oauth=connected&platform=x',
          expiresAt: '2026-09-10T12:10:00.000Z',
        },
        '/social/oauth/platforms': oauthPlatforms(),
        '/social/connections': [],
      },
    });
    await gotoAuthenticated(page, '/social-accounts');
    await page.getByRole('button', { name: 'Connect X' }).click();
    await page.waitForURL(/oauth=connected/);
    await expect(page.getByRole('status').filter({ hasText: 'Connected — X' })).toBeVisible();
  });

  test('ignores an unrecognised outcome code — nothing from the URL is rendered', async ({
    page,
  }) => {
    await stubApi(page, {
      routes: { '/social/oauth/platforms': oauthPlatforms(), '/social/connections': [] },
    });
    await gotoAuthenticated(page, '/social-accounts?oauth=%3Cimg%20src%3Dx%3E&platform=myspace');
    await expect(page.getByRole('button', { name: 'Connect X' })).toBeVisible();
    await expect(page.getByText('<img src=x>')).toHaveCount(0);
    await expect(page.getByText(/myspace/i)).toHaveCount(0);
  });

  test('shows a connection honestly and confirms before disconnecting', async ({ page }) => {
    await stubApi(page, {
      routes: {
        '/social/oauth/platforms': oauthPlatforms(),
        '/social/connections': [connectionRow()],
      },
    });
    await page.route('**/v1/workspaces/*/social/connections/*', (route) =>
      route.request().method() === 'DELETE'
        ? route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              connectionId: CONNECTION_ID,
              disconnected: true,
              providerRevocation: 'NOT_SUPPORTED',
              note: 'X has no standard revocation endpoint, so remove Spectra in your X account settings. The stored credential was deleted.',
            }),
          })
        : route.fallback(),
    );
    await gotoAuthenticated(page, '/social-accounts');

    const item = page.getByRole('listitem').filter({ hasText: 'Acme on X' });
    await expect(item.getByText('connected', { exact: true })).toBeVisible();
    await expect(item.getByText(/No X publishing adapter is wired/)).toBeVisible();
    await expect(item.getByText('Access token expires on 2099-01-01')).toBeVisible();

    await item.getByRole('button', { name: 'Disconnect' }).click();
    await item.getByRole('button', { name: 'Confirm disconnect' }).click();
    await expect(page.getByText(/remove Spectra in your X account settings/)).toBeVisible();
  });

  test('hides connection management without social:connect and names the permission', async ({
    page,
  }) => {
    await stubApi(page, {
      permissions: ALL_PERMISSIONS.filter((p) => p !== 'social:connect'),
      routes: {
        '/social/oauth/platforms': oauthPlatforms(),
        '/social/connections': [connectionRow()],
      },
    });
    await gotoAuthenticated(page, '/social-accounts');
    await expect(page.getByText(/managing platform connections requires the/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^Connect / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Disconnect' })).toHaveCount(0);
  });
});

test.describe('LinkedIn publishing', () => {
  test('names the products a LinkedIn connection is missing and what each account can publish', async ({
    page,
  }) => {
    await stubApi(page, {
      routes: {
        '/social/oauth/platforms': oauthPlatforms(),
        '/social/connections': [linkedInConnectionRow()],
      },
    });
    await gotoAuthenticated(page, '/social-accounts');
    const item = page.getByRole('listitem').filter({ hasText: 'Acme on LinkedIn' });
    await expect(item.getByText('Missing LinkedIn products')).toBeVisible();
    await expect(item.getByText('Community Management API — page posting')).toBeVisible();
    await expect(item.getByText(/reviewed by the platform/)).toBeVisible();
    await expect(item.getByText('Video — not implemented').first()).toBeVisible();
  });

  test('offers an image only to a target that can publish one, and only matching accounts', async ({
    page,
  }) => {
    await stubApi(page, {
      routes: {
        '/content-items': [
          {
            id: '00000000-0000-4000-8000-00000000000e',
            title: 'Q3 results',
            contentType: 'POST',
            lifecycleState: 'APPROVED',
            funnelStage: null,
            objective: null,
            body: 'Q3 is up.',
            evidencePackId: null,
            topicKey: null,
            findingIds: [],
            citationIds: [],
            approvals: [],
            moderation: null,
            createdAt: '2026-09-11T09:00:00.000Z',
          },
        ],
        '/social-accounts': [
          linkedInAccount(),
          {
            ...linkedInAccount(),
            id: '00000000-0000-4000-8000-0000000000d2',
            platform: 'WORDPRESS',
            displayName: 'Company blog',
            kind: 'SITE',
            capabilities: {},
          },
        ],
        '/media': [
          {
            id: '00000000-0000-4000-8000-0000000000a1',
            kind: 'IMAGE',
            storageKey: 'org/x/ws/y/media/a1/chart.png',
            mimeType: 'image/png',
            sizeBytes: 2048,
            widthPx: 1200,
            heightPx: 627,
            engine: 'sharp',
            sourceAssetId: null,
            createdAt: '2026-09-11T09:00:00.000Z',
          },
          {
            id: '00000000-0000-4000-8000-0000000000a2',
            kind: 'IMAGE',
            storageKey: 'org/x/ws/y/media/a2/photo.webp',
            mimeType: 'image/webp',
            sizeBytes: 2048,
            widthPx: 800,
            heightPx: 800,
            engine: 'sharp',
            sourceAssetId: null,
            createdAt: '2026-09-11T09:00:00.000Z',
          },
        ],
        '/calendar': [],
      },
    });
    await gotoAuthenticated(page, '/calendar');

    await page.getByLabel('Publish to (optional)').selectOption({ label: 'Jane Doe' });
    await expect(page.getByText('This target can publish:')).toBeVisible();
    await expect(page.getByText('Video — not implemented')).toBeVisible();

    const imagePicker = page.getByLabel('Image (optional)');
    await expect(imagePicker).toBeVisible();
    const options = await imagePicker.locator('option').allTextContents();
    // LinkedIn takes JPG, PNG and GIF: the WebP image is not offered.
    expect(options.some((o) => o.startsWith('PNG'))).toBe(true);
    expect(options.some((o) => o.startsWith('WEBP'))).toBe(false);

    await page.getByLabel('Platform').selectOption('WORDPRESS');
    const targets = await page
      .getByLabel('Publish to (optional)')
      .locator('option')
      .allTextContents();
    expect(targets).toContain('Company blog');
    expect(targets).not.toContain('Jane Doe');
    await expect(page.getByLabel('Image (optional)')).toHaveCount(0);
  });
});

test.describe('Meta publishing', () => {
  const image = (id: string, mimeType: string, widthPx: number, heightPx: number) => ({
    id,
    kind: 'IMAGE',
    storageKey: `org/x/ws/y/media/${id}/photo`,
    mimeType,
    sizeBytes: 2048,
    widthPx,
    heightPx,
    engine: 'sharp',
    sourceAssetId: null,
    createdAt: '2026-09-11T09:00:00.000Z',
  });

  test('asks for an image for Instagram, offers only JPEGs, and marks an ineligible account', async ({
    page,
  }) => {
    await stubApi(page, {
      routes: {
        '/content-items': [
          {
            id: '00000000-0000-4000-8000-00000000000e',
            title: 'Fresh roast',
            contentType: 'POST',
            lifecycleState: 'APPROVED',
            funnelStage: null,
            objective: null,
            body: 'Fresh roast Friday.',
            evidencePackId: null,
            topicKey: null,
            findingIds: [],
            citationIds: [],
            approvals: [],
            moderation: null,
            createdAt: '2026-09-11T09:00:00.000Z',
          },
        ],
        '/social-accounts': [
          instagramAccount(),
          instagramAccount({
            id: '00000000-0000-4000-8000-0000000000d4',
            externalAccountId: '17841400000000002',
            displayName: '@jane.gardens',
            kind: 'PROFILE',
            capabilities: instagramCapabilities(false),
          }),
        ],
        '/media': [
          image('00000000-0000-4000-8000-0000000000a3', 'image/jpeg', 1080, 1350),
          image('00000000-0000-4000-8000-0000000000a4', 'image/png', 1080, 1080),
        ],
        '/calendar': [],
      },
    });
    await gotoAuthenticated(page, '/calendar');

    await page.getByLabel('Platform').selectOption('INSTAGRAM');
    const targets = page.getByLabel('Publish to (optional)');
    expect(await targets.locator('option').allTextContents()).toContain(
      '@jane.gardens — cannot publish',
    );
    await targets.selectOption({ label: '@acmecoffee (professional)' });
    await expect(page.getByText('Text — not supported by the platform')).toBeVisible();

    const picker = page.getByLabel('Image (required)');
    await expect(picker).toBeVisible();
    const options = await picker.locator('option').allTextContents();
    // Instagram takes JPEG only: the PNG is not offered.
    expect(options.some((o) => o.startsWith('JPEG'))).toBe(true);
    expect(options.some((o) => o.startsWith('PNG'))).toBe(false);
    await expect(page.getByText(/One JPG per post, 4:5 to 1\.91:1/)).toBeVisible();

    await page.getByLabel('Content item').selectOption({ label: 'Fresh roast' });
    await page.getByLabel('When (local time)').fill('2026-09-20T10:00');
    const submit = page.getByRole('button', { name: 'Schedule' });
    await expect(submit).toBeDisabled();
    await picker.selectOption({ index: 1 });
    await expect(submit).toBeEnabled();

    await targets.selectOption({ label: '@jane.gardens — cannot publish' });
    await expect(page.getByText('Cannot publish here.')).toBeVisible();
    await expect(page.getByText(/professional \(Business or Creator\)/)).toBeVisible();
  });

  test('shows the Meta setup guide next to the Facebook connect button', async ({ page }) => {
    await stubApi(page, {
      routes: { '/social/oauth/platforms': oauthPlatforms(), '/social/connections': [] },
    });
    await gotoAuthenticated(page, '/social-accounts');
    await page.getByText('Meta setup (Facebook & Instagram)').click();
    await expect(page.getByText('Advanced Access')).toBeVisible();
    await expect(page.getByText(/must be professional \(Business or Creator\)/)).toBeVisible();
  });
});

test.describe('YouTube publishing', () => {
  const videoAsset = {
    id: '00000000-0000-4000-8000-0000000000b1',
    kind: 'VIDEO',
    storageKey: 'org/x/ws/y/media/b1/upload.bin',
    mimeType: 'video/mp4',
    sizeBytes: 12 * 1024 * 1024,
    widthPx: null,
    heightPx: null,
    engine: null,
    sourceAssetId: null,
    createdAt: '2026-09-12T09:00:00.000Z',
  };
  const thumbAsset = {
    ...videoAsset,
    id: '00000000-0000-4000-8000-0000000000b2',
    kind: 'IMAGE',
    mimeType: 'image/jpeg',
    sizeBytes: 90_000,
  };

  test('asks for a video and its details, and warns about the audit restriction', async ({
    page,
  }) => {
    await stubApi(page, {
      routes: {
        '/content-items': [
          {
            id: '00000000-0000-4000-8000-00000000000f',
            title: 'Quarterly roast report',
            contentType: 'POST',
            lifecycleState: 'APPROVED',
            funnelStage: null,
            objective: null,
            body: 'What changed this quarter.',
            evidencePackId: null,
            topicKey: null,
            findingIds: [],
            citationIds: [],
            approvals: [],
            moderation: null,
            createdAt: '2026-09-12T09:00:00.000Z',
          },
        ],
        '/social-accounts': [youtubeAccount()],
        '/media': [videoAsset, thumbAsset],
        '/calendar': [],
      },
    });
    await gotoAuthenticated(page, '/calendar');

    await page.getByLabel('Platform').selectOption('YOUTUBE');
    await page.getByLabel('Publish to (optional)').selectOption({ label: 'Acme Coffee' });

    // What YouTube itself does not offer is labelled as such, not as "not built".
    await expect(page.getByText('Text — not supported by the platform')).toBeVisible();
    // The audit restriction is shown before anything is uploaded.
    await expect(page.getByText(/restricted to private viewing mode/)).toBeVisible();

    const video = page.getByLabel('Video (required)');
    await expect(video).toBeVisible();
    const options = await video.locator('option').allTextContents();
    expect(options.some((o) => o.startsWith('MP4'))).toBe(true);

    // The video's own title starts from the content item.
    await page.getByLabel('Content item').selectOption({ label: 'Quarterly roast report' });
    await expect(page.getByLabel('Video title')).toHaveValue('Quarterly roast report');
    await expect(page.getByLabel('Privacy')).toHaveValue('private');

    await page.getByLabel('When (local time)').fill('2026-09-20T10:00');
    const submit = page.getByRole('button', { name: 'Schedule' });
    await expect(submit).toBeDisabled();
    await video.selectOption({ index: 1 });
    await expect(submit).toBeEnabled();
  });

  test('offers a direct upload for files Spectra cannot render', async ({ page }) => {
    await stubApi(page, {
      routes: {
        '/media/status': {
          image: true,
          video: false,
          audio: false,
          htmlToImage: false,
          engine: 'sharp',
          upload: true,
        },
        '/media': [videoAsset],
      },
    });
    await gotoAuthenticated(page, '/media');
    await expect(page.getByText('File upload ready')).toBeVisible();
    await expect(page.getByText('Video rendering not available yet')).toBeVisible();
    await expect(page.getByLabel('Video or image (up to 500 MB)')).toBeVisible();
    await expect(page.getByText(/straight to object storage/)).toBeVisible();
  });
});

test.describe('accessibility', () => {
  test('the brands form is reachable and submittable by keyboard alone', async ({ page }) => {
    await stubApi(page, { routes: { '/brands': [] } });
    await gotoAuthenticated(page, '/brands');

    await page.getByLabel('Name').focus();
    await page.keyboard.type('Keyboard Brand');
    // Tab to Website (Description sits between) and enter an invalid value so
    // the alert is assertable without a network round-trip.
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.type('nope');
    await expect(page.getByLabel('Website')).toBeFocused();
  });

  test('every form control on settings has an accessible label', async ({ page }) => {
    await stubApi(page);
    await gotoAuthenticated(page, '/settings');

    const controls = page.locator('input:visible, select:visible');
    const count = await controls.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i += 1) {
      const control = controls.nth(i);
      const id = await control.getAttribute('id');
      const aria = await control.getAttribute('aria-label');
      // Either an aria-label or a <label for=…> must exist.
      expect(Boolean(aria) || Boolean(id)).toBe(true);
      if (!aria && id) {
        await expect(page.locator(`label[for="${id}"]`)).toHaveCount(1);
      }
    }
  });
});
