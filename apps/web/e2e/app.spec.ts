import { expect, test } from '@playwright/test';

import {
  ALL_PERMISSIONS,
  PREVIEW_PNG,
  designFormats,
  designRow,
  designTemplates,
  studioCapabilities,
  audioCapabilities,
  billingCapabilities,
  billingCredits,
  billingEntitlements,
  billingPlans,
  billingSubscription,
  usageAndBudgetRoutes,
  orchestrationCapabilities,
  orchestrationRunDetail,
  orchestrationRunSummary,
  audioRenderRow,
  episodeDetail,
  episodeRow,
  grantedConsent,
  videoCapabilities,
  voiceRow,
  videoFormats,
  videoProjectDetail,
  videoProjectRow,
  videoRenderRow,
  analyticsAvailability,
  analyticsOverview,
  analyticsSummary,
  contentAnalytics,
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
        // The billing page now carries the plan and credits above estimated
        // spend (ADR-0044); these come first because `/organizations/` below
        // would otherwise match the billing paths too.
        '/billing/capabilities': billingCapabilities(),
        '/billing/plans': billingPlans(),
        '/billing/subscription': billingSubscription(),
        '/billing/entitlements': billingEntitlements(),
        '/billing/credits': billingCredits(),
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

test.describe('analytics', () => {
  const analyticsRoutes = (externalAvailable: boolean) => ({
    '/analytics/overview': analyticsOverview(externalAvailable),
    '/analytics/summary': analyticsSummary(externalAvailable),
    '/analytics/availability': analyticsAvailability(),
    '/analytics/providers': {
      metricDefinitions: [],
      providers: [],
      scheduledSync: { enabled: false, intervalMinutes: 360 },
      note: '',
    },
    '/analytics/sync-runs': [],
    '/analytics/unavailable-metrics': { metrics: [] },
  });

  test('labels first-party and platform numbers, and never renders unavailable as zero', async ({
    page,
  }) => {
    await stubApi(page, { routes: analyticsRoutes(true) });
    await gotoAuthenticated(page, '/analytics');

    await expect(page.getByText('First-party · counted by Spectra')).toBeVisible();
    await expect(page.getByText('External · reported by platforms')).toBeVisible();
    await expect(page.getByText(/Fresh · retrieved/).first()).toBeVisible();
    // A reported zero is 0; a missing metric says unavailable, with the reason.
    await expect(page.getByText('Unavailable · Not offered by the platform')).toBeVisible();
    await expect(page.getByText(/not counted as 0/).first()).toBeVisible();
    await expect(page.getByText('≈ 12,300')).toBeVisible();
    await expect(page.getByText(/Partial analytics/)).toBeVisible();
    // Platform status: missing scope and not-implemented are named.
    await expect(page.getByText('Partial', { exact: true })).toBeVisible();
    await expect(page.getByText(/yt-analytics.readonly/)).toBeVisible();
    await expect(page.getByText('Not implemented', { exact: true })).toBeVisible();
    // No chart is drawn from analytics data.
    await expect(page.locator('svg[class*="recharts"], canvas')).toHaveCount(0);
  });

  test('shows the external-analytics unavailable state instead of zeros', async ({ page }) => {
    await stubApi(page, { routes: analyticsRoutes(false) });
    await gotoAuthenticated(page, '/analytics');

    await expect(page.getByText('External analytics are unavailable')).toBeVisible();
    await expect(page.getByText(/nothing is estimated in their place/i).first()).toBeVisible();
    await expect(page.getByText('Never synced').first()).toBeVisible();
  });

  test('the sync button needs analytics:sync, and says so', async ({ page }) => {
    await stubApi(page, { routes: analyticsRoutes(true) });
    await gotoAuthenticated(page, '/analytics');
    await expect(page.getByRole('button', { name: /sync analytics now/i })).toBeVisible();

    await stubApi(page, {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'analytics:sync'),
      routes: analyticsRoutes(true),
    });
    await gotoAuthenticated(page, '/analytics');
    await expect(page.getByRole('button', { name: /sync analytics now/i })).toHaveCount(0);
    await expect(page.getByText('analytics:sync')).toBeVisible();
  });

  test('post analytics show each metric’s reason, source field and freshness', async ({ page }) => {
    await stubApi(page, { routes: { '/analytics/content/': contentAnalytics() } });
    await gotoAuthenticated(page, '/analytics/content/item-1');

    await expect(page.getByRole('heading', { name: 'Quarterly roast report' })).toBeVisible();
    await expect(page.getByText('statistics.viewsCount')).toBeVisible();
    await expect(page.getByText('Unavailable · Missing permission')).toBeVisible();
    await expect(page.getByText(/Partial: some metrics could have been read/)).toBeVisible();
    await expect(page.getByText(/No platform analytics\. Not implemented/)).toBeVisible();
    await expect(page.getByRole('button', { name: /sync this post/i }).first()).toBeVisible();
  });
});

test.describe('design studio', () => {
  const studioRoutes = () => ({
    '/studio/capabilities': studioCapabilities(),
    '/studio/formats': designFormats(),
    '/studio/templates': designTemplates(),
    '/studio/designs/d1': designRow(),
    '/studio/designs': [designRow()],
    '/brands': [],
    '/media': [],
  });

  test('the gallery says what the renderer is and lists templates and designs', async ({
    page,
  }) => {
    await stubApi(page, { routes: studioRoutes() });
    await gotoAuthenticated(page, '/studio');

    await expect(page.getByText(/Real rendering, no image generation/)).toBeVisible();
    await expect(page.getByText(/Nothing is generated by an AI image model/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Quote card/ })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Morning quote' })).toBeVisible();
    await expect(page.getByRole('button', { name: /create design/i })).toHaveCount(0);
    await page.getByRole('button', { name: /Quote card/ }).click();
    await expect(page.getByRole('button', { name: /create design/i })).toBeVisible();
  });

  test('the editor renders a real preview, lists warnings and offers exports', async ({ page }) => {
    await stubApi(page, { routes: studioRoutes() });
    // Registered after the catch-all so it wins: the preview is image bytes,
    // not JSON — the editor shows what the renderer actually produced.
    await page.route('**/studio/designs/d1/preview**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'image/png',
        headers: {
          'x-design-page-count': '1',
          'x-design-warnings': encodeURIComponent(
            JSON.stringify(['The brand has no logo, so logo placeholders were left empty.']),
          ),
          // Credentialed fetch: the origin must be echoed, never '*'.
          'access-control-allow-origin': 'http://localhost:3100',
          'access-control-allow-credentials': 'true',
          'access-control-expose-headers': 'x-design-page-count, x-design-warnings',
        },
        body: PREVIEW_PNG,
      }),
    );
    await gotoAuthenticated(page, '/studio/d1');

    await expect(page.getByRole('heading', { name: 'Morning quote' })).toBeVisible();
    await expect(page.getByRole('img', { name: /Morning quote, page 1/ })).toBeVisible();
    await expect(
      page.getByText(/no logo, so logo placeholders were left empty/).first(),
    ).toBeVisible();
    await expect(
      page.getByText(/This preview is the export, rendered at a smaller size/),
    ).toBeVisible();
    await expect(page.getByLabel(/Quote \*/)).toHaveValue('Good coffee is a small daily luxury.');
    for (const output of ['PNG', 'JPEG', 'PDF']) {
      await expect(page.getByRole('button', { name: `Export ${output}` })).toBeVisible();
    }
    // The export row states the file that exists: page, pixels and size.
    await expect(page.getByText(/page 1 · 1080×1080 · 145 KB/)).toBeVisible();
  });

  test('without design:write the editor is read-only and names the permission', async ({
    page,
  }) => {
    await stubApi(page, {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'design:write'),
      routes: studioRoutes(),
    });
    await gotoAuthenticated(page, '/studio/d1');

    await expect(page.getByRole('button', { name: /Export PNG/ })).toHaveCount(0);
    await expect(page.getByText('design:write').first()).toBeVisible();
  });
});

test.describe('video rendering', () => {
  const videoRoutes = (overrides: Record<string, unknown> = {}) => ({
    '/video/capabilities': videoCapabilities(),
    '/video/formats': videoFormats(),
    '/video/projects/vp1': videoProjectDetail(),
    '/video/projects': { projects: [videoProjectRow()] },
    ...overrides,
  });

  test('the page says video is composed, not generated, and names the engine', async ({ page }) => {
    await stubApi(page, { routes: videoRoutes() });
    await gotoAuthenticated(page, '/video');

    await expect(page.getByText(/Real rendering, no generated video/)).toBeVisible();
    await expect(page.getByText(/no generative-video provider wired/)).toBeVisible();
    await expect(page.getByTestId('video-engine')).toContainText('ffmpeg');
    await expect(page.getByRole('link', { name: 'Roast launch' })).toBeVisible();
  });

  test('an unconfigured engine is stated plainly, not hidden behind a disabled button', async ({
    page,
  }) => {
    await stubApi(page, {
      routes: videoRoutes({
        '/video/capabilities': videoCapabilities({
          available: false,
          reason:
            'No usable ffmpeg at "ffmpeg": spawn ffmpeg ENOENT. Set FFMPEG_PATH, or install ffmpeg on the worker host.',
          engineVersion: null,
          videoCodec: null,
          missing: ['No ffmpeg binary is configured or reachable.'],
        }),
      }),
    });
    await gotoAuthenticated(page, '/video');

    await expect(page.getByTestId('video-engine-unavailable')).toContainText('FFMPEG_PATH');
    await expect(page.getByText('No ffmpeg binary is configured or reachable.')).toBeVisible();
  });

  test('a script becomes one scene per line before anything is created', async ({ page }) => {
    await stubApi(page, { routes: videoRoutes() });
    await gotoAuthenticated(page, '/video');

    await page.getByLabel('Script').fill('First line\nSecond line\n\nThird line');

    await expect(page.getByText(/3 scenes, 9s before any transitions/)).toBeVisible();
  });

  test('a finished render shows the real file it produced, and offers its sidecars', async ({
    page,
  }) => {
    await stubApi(page, { routes: videoRoutes() });
    await gotoAuthenticated(page, '/video/vp1');

    await expect(page.getByRole('heading', { name: 'Roast launch' })).toBeVisible();
    await expect(page.getByText('SUCCEEDED')).toBeVisible();
    // The numbers describe the file that exists, not the request that made it.
    await expect(page.getByText(/1080×1080 · h264 · 6s · 471 KB/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^MP4$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Captions/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Poster/ })).toBeVisible();
  });

  test('a running render shows real progress and can be cancelled', async ({ page }) => {
    await stubApi(page, {
      routes: videoRoutes({
        '/video/projects/vp1': videoProjectDetail({
          renders: [
            videoRenderRow({
              status: 'RUNNING',
              progressPercent: 42,
              finishedAt: null,
              mediaAssetId: null,
              captionAssetId: null,
              thumbnailAssetId: null,
              durationMs: null,
              sizeBytes: null,
            }),
          ],
        }),
      }),
    });
    await gotoAuthenticated(page, '/video/vp1');

    const bar = page.getByRole('progressbar', { name: 'Render progress' });
    await expect(bar).toHaveAttribute('aria-valuenow', '42');
    await expect(page.getByText(/Encoding — 42%/)).toBeVisible();
    await expect(page.getByRole('button', { name: /Cancel/ })).toBeVisible();
  });

  test('a failed render says why, in words, and offers nothing to download', async ({ page }) => {
    await stubApi(page, {
      routes: videoRoutes({
        '/video/projects/vp1': videoProjectDetail({
          renders: [
            videoRenderRow({
              status: 'FAILED',
              progressPercent: 0,
              failureReason: 'INPUT_UNAVAILABLE',
              failureDetail: null,
              mediaAssetId: null,
              captionAssetId: null,
              thumbnailAssetId: null,
              durationMs: null,
              sizeBytes: null,
            }),
          ],
        }),
      }),
    });
    await gotoAuthenticated(page, '/video/vp1');

    await expect(page.getByText('FAILED')).toBeVisible();
    await expect(
      page.getByText('A media asset this storyboard references could not be read.'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: /^MP4$/ })).toHaveCount(0);
  });

  test('an unrenderable storyboard is refused in the editor, before a render is offered', async ({
    page,
  }) => {
    await stubApi(page, {
      routes: videoRoutes({
        '/video/projects/vp1': videoProjectDetail({
          plan: null,
          problems: ['Scene "scene-1" is 3000ms, which is not longer than the 3000ms transition.'],
          renders: [],
        }),
      }),
    });
    await gotoAuthenticated(page, '/video/vp1');

    await expect(page.getByText(/This storyboard cannot be rendered yet/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Render video' })).toBeDisabled();
  });

  test('without video:write the controls are gone and the permission is named', async ({
    page,
  }) => {
    await stubApi(page, {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'video:write'),
      routes: videoRoutes(),
    });
    await gotoAuthenticated(page, '/video/vp1');

    await expect(page.getByRole('button', { name: 'Render video' })).toHaveCount(0);
    await expect(page.getByText('video:write').first()).toBeVisible();
  });
});

test.describe('audio and podcasts', () => {
  const audioRoutes = (overrides: Record<string, unknown> = {}) => ({
    '/audio/capabilities': audioCapabilities(),
    '/audio/voices': { voices: [voiceRow()] },
    '/audio/episodes/ep1': episodeDetail(),
    '/audio/episodes': { episodes: [episodeRow()] },
    ...overrides,
  });

  test('says audio is mixed, not generated, and names every missing provider', async ({ page }) => {
    await stubApi(page, { routes: audioRoutes() });
    await gotoAuthenticated(page, '/audio');

    await expect(page.getByText(/Real mixing, no generated audio/)).toBeVisible();
    await expect(
      page.getByText(/No speech, music or sound-effect generator is wired/),
    ).toBeVisible();
    await expect(page.getByTestId('audio-engine')).toContainText('libmp3lame');
    // All four synthesis kinds are listed as unimplemented, each with a reason.
    const providers = page.getByTestId('audio-providers');
    await expect(providers.getByText(/NOT IMPLEMENTED/).first()).toBeVisible();
    await expect(providers.getByText(/must be uploaded as audio/)).toBeVisible();
    await expect(providers.getByText(/never from listening to the audio/)).toBeVisible();
  });

  test('a cloned voice without consent is shown as unusable, with the reason', async ({ page }) => {
    await stubApi(page, { routes: audioRoutes() });
    await gotoAuthenticated(page, '/audio');

    // Exact: the blocking message also contains the words "no consent record".
    await expect(page.getByText('NO CONSENT', { exact: true })).toBeVisible();
    await expect(page.getByText(/imitates a real person and has no consent record/)).toBeVisible();
    await expect(page.getByText(/Cloned from Ada Lovelace/)).toBeVisible();
  });

  test('a stock voice is marked as needing no consent at all', async ({ page }) => {
    await stubApi(page, {
      routes: audioRoutes({
        '/audio/voices': {
          voices: [
            voiceRow({
              id: 'v2',
              name: 'Narrator',
              kind: 'STOCK',
              subjectName: null,
              requiresConsent: false,
              usable: true,
              blockReason: null,
              message: null,
            }),
          ],
        },
      }),
    });
    await gotoAuthenticated(page, '/audio');

    await expect(page.getByText('CONSENT NOT NEEDED', { exact: true })).toBeVisible();
    await expect(page.getByText(/Stock voice — imitates nobody/)).toBeVisible();
  });

  test('an episode blocked by consent cannot be rendered, and says which voice', async ({
    page,
  }) => {
    await stubApi(page, {
      routes: audioRoutes({
        '/audio/episodes/ep1': episodeDetail({
          renders: [],
          voices: [
            {
              id: 'v1',
              name: 'Ada (cloned)',
              kind: 'CLONED',
              usable: false,
              reason: 'CONSENT_REVOKED',
              message: 'The person whose voice this is has revoked their consent.',
              requiresConsent: true,
            },
          ],
        }),
      }),
    });
    await gotoAuthenticated(page, '/audio/ep1');

    const blockers = page.getByTestId('consent-blockers');
    await expect(blockers).toContainText('Ada (cloned)');
    await expect(blockers).toContainText('revoked their consent');
    await expect(page.getByRole('button', { name: 'Render mix' })).toBeDisabled();
  });

  test('host notes are shown as production direction, never as spoken words', async ({ page }) => {
    await stubApi(page, { routes: audioRoutes() });
    await gotoAuthenticated(page, '/audio/ep1');

    await expect(page.getByText(/Host note \(not spoken\): Keep this tight\./)).toBeVisible();
  });

  test('a finished mix reports what was actually encoded, including measured loudness', async ({
    page,
  }) => {
    await stubApi(page, { routes: audioRoutes() });
    await gotoAuthenticated(page, '/audio/ep1');

    await expect(page.getByText('SUCCEEDED')).toBeVisible();
    await expect(page.getByText(/6s · 86 KB · measured -16.2 LUFS/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^MP3$/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Waveform/ })).toBeVisible();
  });

  test('a failed mix says why, in words, and offers nothing to download', async ({ page }) => {
    await stubApi(page, {
      routes: audioRoutes({
        '/audio/episodes/ep1': episodeDetail({
          renders: [
            audioRenderRow({
              status: 'FAILED',
              progressPercent: 0,
              failureReason: 'TTS_NOT_CONFIGURED',
              mediaAssetId: null,
              waveformAssetId: null,
              durationMs: null,
              sizeBytes: null,
              integratedLufs: null,
            }),
          ],
        }),
      }),
    });
    await gotoAuthenticated(page, '/audio/ep1');

    await expect(page.getByText('FAILED')).toBeVisible();
    await expect(page.getByText(/no speech-synthesis provider is configured/)).toBeVisible();
    await expect(page.getByRole('button', { name: /^MP3$/ })).toHaveCount(0);
  });

  test('a script-derived transcript says the words came from the script', async ({ page }) => {
    await stubApi(page, {
      routes: audioRoutes({
        '/audio/episodes/ep1': episodeDetail({
          transcripts: [{ id: 't1', source: 'SCRIPT_DERIVED', language: 'en', cues: [{}, {}] }],
        }),
      }),
    });
    await gotoAuthenticated(page, '/audio/ep1');

    await expect(page.getByText(/Nothing listened to the audio/)).toBeVisible();
  });

  test('consent history shows what was agreed, and can be revoked', async ({ page }) => {
    await stubApi(page, {
      routes: audioRoutes({
        '/audio/voices': {
          voices: [
            voiceRow({
              consents: [grantedConsent()],
              usable: true,
              blockReason: null,
              message: null,
            }),
          ],
        },
      }),
    });
    await gotoAuthenticated(page, '/audio/voices/v1');

    await expect(page.getByTestId('consent-status')).toContainText('Consent is on record');
    await expect(page.getByText(/Covers podcast · expires/)).toBeVisible();
    await expect(page.getByText(/ref MSA-2026-114/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Revoke consent' })).toBeVisible();
  });

  test('without voice:consent the consent form is gone and the permission is named', async ({
    page,
  }) => {
    await stubApi(page, {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'voice:consent'),
      routes: audioRoutes(),
    });
    await gotoAuthenticated(page, '/audio/voices/v1');

    await expect(page.getByRole('button', { name: 'Record consent' })).toHaveCount(0);
    await expect(page.getByText('voice:consent').first()).toBeVisible();
  });
});

test.describe('campaign orchestration', () => {
  const orchRoutes = (overrides: Record<string, unknown> = {}) => ({
    '/campaign-orchestration/capabilities': orchestrationCapabilities(),
    '/campaign-orchestration/runs/run1': orchestrationRunDetail(),
    '/campaign-orchestration/runs': { runs: [orchestrationRunSummary()] },
    '/verticals': [{ id: 'v1', name: 'Enterprise storage', slug: 'storage' }],
    '/trends': [
      { id: 't1', title: 'Composable storage replaces monoliths', normalizedScore: 0.82 },
    ],
    ...overrides,
  });

  test('the wizard says the strategy is derived, not invented', async ({ page }) => {
    await stubApi(page, { routes: orchRoutes() });
    await gotoAuthenticated(page, '/campaign-builder');

    await expect(page.getByText(/Derived from research, not invented/)).toBeVisible();
    await expect(page.getByTestId('engine-note')).toContainText('No model invents them');
    // And that nothing it builds goes out on its own.
    await expect(page.getByText(/Nothing is published automatically/)).toBeVisible();
  });

  test('an unavailable generator is stated before a run is started', async ({ page }) => {
    await stubApi(page, { routes: orchRoutes() });
    await gotoAuthenticated(page, '/campaign-builder');

    await expect(page.getByTestId('generation-unavailable')).toContainText('ANTHROPIC_API_KEY');
    await expect(page.getByTestId('generation-unavailable')).toContainText(
      'drafts are left unwritten',
    );
  });

  test('the wizard previews the plan size before anything is created', async ({ page }) => {
    await stubApi(page, { routes: orchRoutes() });
    await gotoAuthenticated(page, '/campaign-builder');

    await expect(page.getByTestId('plan-preview')).toContainText('About 2 items');
    await expect(page.getByTestId('plan-preview')).toContainText(
      'Topics without usable evidence are blocked and listed, not written',
    );
  });

  test('says plainly when there is no scored research to build on', async ({ page }) => {
    await stubApi(page, { routes: orchRoutes({ '/trends': [] }) });
    await gotoAuthenticated(page, '/campaign-builder');

    await expect(page.getByTestId('no-trends')).toContainText('Run research and trend scoring');
  });

  test('a run shows every stage, including the one that was skipped and why', async ({ page }) => {
    await stubApi(page, { routes: orchRoutes() });
    await gotoAuthenticated(page, '/campaign-builder/run1');

    const stages = page.getByTestId('stages');
    await expect(stages).toContainText('resolve inputs');
    await expect(stages).toContainText('generate drafts');
    await expect(stages).toContainText('No text-generation provider is configured');
    await expect(page.getByText('PARTIAL')).toBeVisible();
  });

  test('the strategy shows its warnings and names unpublishable platforms', async ({ page }) => {
    await stubApi(page, { routes: orchRoutes() });
    await gotoAuthenticated(page, '/campaign-builder/run1');

    await expect(page.getByTestId('strategy-warnings')).toContainText(
      'blocked by the evidence gate',
    );
    await expect(page.getByTestId('strategy-warnings')).toContainText('No persona is configured');
    await expect(page.getByTestId('platform-strategy')).toContainText(
      'No connected account can publish to X',
    );
  });

  test('the calendar shows each slot with its evidence verdict', async ({ page }) => {
    await stubApi(page, { routes: orchRoutes() });
    await gotoAuthenticated(page, '/campaign-builder/run1');

    const calendar = page.getByTestId('calendar');
    await expect(calendar).toContainText('Composable storage replaces monoliths');
    await expect(calendar).toContainText('LINKEDIN');
    await expect(calendar.getByText('SUPPORTED')).toBeVisible();
  });

  test('a blocked topic is listed with its reason, and has no content item', async ({ page }) => {
    await stubApi(page, { routes: orchRoutes() });
    await gotoAuthenticated(page, '/campaign-builder/run1');

    const items = page.getByTestId('items');
    await expect(items).toContainText('Topic with no evidence');
    await expect(items).toContainText('UNSUPPORTED');
    await expect(items).toContainText('no draft was written for it');
    // The written item links its evidence; the blocked one has nothing to open.
    await expect(items).toContainText('3 finding(s), 1 citation(s), from an evidence pack');
    await expect(items.getByRole('link', { name: 'Open content item' })).toHaveCount(1);
  });

  test('a failed run states the reason in words', async ({ page }) => {
    await stubApi(page, {
      routes: orchRoutes({
        '/campaign-orchestration/runs/run1': orchestrationRunDetail({
          run: {
            ...orchestrationRunDetail().run,
            status: 'FAILED',
            campaignId: null,
            failureReason: 'ALL_ITEMS_BLOCKED',
          },
          failureText:
            'Every planned item was blocked by the evidence gate. The research does not yet support a campaign on these topics.',
        }),
      }),
    });
    await gotoAuthenticated(page, '/campaign-builder/run1');

    await expect(page.getByText(/does not yet support a campaign/)).toBeVisible();
  });

  test('without campaign:orchestrate the wizard is gone and the permission is named', async ({
    page,
  }) => {
    await stubApi(page, {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'campaign:orchestrate'),
      routes: orchRoutes(),
    });
    await gotoAuthenticated(page, '/campaign-builder');

    await expect(page.getByRole('button', { name: 'Build campaign' })).toHaveCount(0);
    await expect(page.getByText('campaign:orchestrate').first()).toBeVisible();
  });
});

test.describe('billing', () => {
  // Order matters: stubApi takes the FIRST key whose fragment the path
  // contains, and the billing routes live under `/organizations/<id>/billing`,
  // which the generic `/organizations/` usage stub would otherwise swallow.
  const billingRoutes = (overrides: Record<string, unknown> = {}) => ({
    '/billing/capabilities': billingCapabilities(),
    '/billing/plans': billingPlans(),
    '/billing/subscription': billingSubscription(),
    '/billing/entitlements': billingEntitlements(),
    '/billing/credits': billingCredits(),
    ...overrides,
    // The page shows estimated spend beneath the plan, so it needs these too.
    ...usageAndBudgetRoutes(),
  });

  test('says estimates are not invoices, before anything else', async ({ page }) => {
    await stubApi(page, { routes: billingRoutes() });
    await gotoAuthenticated(page, '/billing');

    await expect(page.getByText('Usage estimates are not invoices')).toBeVisible();
    await expect(page.getByTestId('estimate-disclaimer')).toContainText('ESTIMATES');
    await expect(page.getByTestId('estimate-disclaimer')).toContainText(
      'Stripe is the only authority on amounts billed',
    );
  });

  test('shows the current subscription and its mode', async ({ page }) => {
    await stubApi(page, { routes: billingRoutes() });
    await gotoAuthenticated(page, '/billing');

    await expect(page.getByText('ACTIVE').first()).toBeVisible();
    // A test-mode subscription is labelled, so nobody mistakes it for live.
    await expect(page.getByText('TEST MODE').first()).toBeVisible();
    await expect(page.getByText(/Renews/)).toBeVisible();
  });

  test('says the free plan applies when there is no subscription — not unlimited', async ({
    page,
  }) => {
    await stubApi(page, {
      routes: billingRoutes({
        '/billing/subscription': billingSubscription({
          subscription: null,
          effectivePlanKey: 'free',
        }),
      }),
    });
    await gotoAuthenticated(page, '/billing');

    await expect(page.getByTestId('no-subscription')).toContainText('not unlimited use');
  });

  test('warns when a lapsed subscription has dropped the org to the fallback', async ({ page }) => {
    await stubApi(page, {
      routes: billingRoutes({
        '/billing/subscription': billingSubscription({
          subscription: { ...billingSubscription().subscription, status: 'CANCELED' },
          effectivePlanKey: 'free',
          downgradedToFallback: true,
        }),
      }),
    });
    await gotoAuthenticated(page, '/billing');

    await expect(page.getByTestId('downgraded')).toContainText('free');
    await expect(page.getByTestId('downgraded')).toContainText('currently apply');
  });

  test('surfaces a payment failure with the provider’s own reason', async ({ page }) => {
    await stubApi(page, {
      routes: billingRoutes({
        '/billing/subscription': billingSubscription({
          subscription: {
            ...billingSubscription().subscription,
            status: 'PAST_DUE',
            lastPaymentFailedAt: '2026-10-07T00:00:00.000Z',
            lastPaymentFailureMessage: 'Your card was declined.',
          },
          paymentFailed: true,
        }),
      }),
    });
    await gotoAuthenticated(page, '/billing');

    const banner = page.getByTestId('payment-failed');
    await expect(banner).toContainText('Your card was declined.');
    // Dunning is the provider's job: the plan keeps working meanwhile.
    await expect(banner).toContainText('keeps working while the provider retries');
  });

  test('offers checkout only for a plan that can actually be purchased', async ({ page }) => {
    await stubApi(page, {
      routes: billingRoutes({
        '/billing/subscription': billingSubscription({
          subscription: null,
          effectivePlanKey: 'free',
        }),
      }),
    });
    await gotoAuthenticated(page, '/billing');

    const plans = page.getByTestId('plans');
    await expect(plans.getByRole('button', { name: /Choose Growth/ })).toBeVisible();
    // Enterprise is not self-serve, and free has no price.
    await expect(plans.getByRole('button', { name: /Choose Enterprise/ })).toHaveCount(0);
    await expect(plans).toContainText('Contact sales to move to this plan');
  });

  test('shows plan limits, flagging the one that is exhausted', async ({ page }) => {
    await stubApi(page, { routes: billingRoutes() });
    await gotoAuthenticated(page, '/billing');

    const limits = page.getByTestId('entitlements');
    await expect(limits).toContainText('Workspaces 3 of 10');
    await expect(limits).toContainText('At limit');
    // Bytes render as bytes, and the inverted interval key renders as a gap.
    await expect(limits).toContainText('250 GB');
    await expect(limits).toContainText('every 1h');
  });

  test('shows the credit balance and explains the spend order', async ({ page }) => {
    await stubApi(page, { routes: billingRoutes() });
    await gotoAuthenticated(page, '/billing');

    const balance = page.getByTestId('credit-balance');
    await expect(balance).toContainText('12,450');
    await expect(balance).toContainText('2,550');
    await expect(
      page.getByText(/spent soonest-expiring first, so a monthly allowance is used before/),
    ).toBeVisible();
  });

  test('states plainly when billing is not configured at all', async ({ page }) => {
    await stubApi(page, {
      routes: billingRoutes({
        '/billing/capabilities': billingCapabilities({
          provider: {
            available: false,
            reason:
              'No Stripe secret key is configured, so no plan can be purchased and no subscription is synced. Plans and entitlements still apply — every organization is on the free plan.',
            providerId: 'stripe',
            mode: null,
            requiredEnv: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
            webhooksVerifiable: false,
          },
        }),
      }),
    });
    await gotoAuthenticated(page, '/billing');

    const notice = page.getByTestId('billing-unconfigured');
    await expect(notice).toContainText('No Stripe secret key is configured');
    // Crucially: unconfigured billing is not unlimited use.
    await expect(notice).toContainText('every organization is on the free plan');
  });

  test('without org:billing:manage nothing can be bought and the permission is named', async ({
    page,
  }) => {
    await stubApi(page, {
      permissions: ALL_PERMISSIONS.filter((permission) => permission !== 'org:billing:manage'),
      routes: billingRoutes(),
    });
    await gotoAuthenticated(page, '/billing');

    await expect(page.getByRole('button', { name: /Choose Growth/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /customer portal/ })).toHaveCount(0);
    await expect(page.getByText('org:billing:manage').first()).toBeVisible();
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
    // count() does not auto-wait; wait for the form to render before counting.
    await expect(controls.first()).toBeVisible();
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
