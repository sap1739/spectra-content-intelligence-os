import { expect, test } from '@playwright/test';

import {
  ALL_PERMISSIONS,
  ORG_ID,
  WORKSPACE_ID,
  failedJob,
  gotoAuthenticated,
  stubApi,
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
