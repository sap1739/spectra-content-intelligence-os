import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { loadEnv, storageEnvSchema } from '@spectra/config';
import type { TenantScope } from '@spectra/contracts';
import { createPrismaClient, type SpectraPrismaClient } from '@spectra/database';
import { createLogger } from '@spectra/logging';
import {
  ResearchProviderRegistry,
  type DiscoveredSource,
  type SearchQueryInput,
  type WebSearchProvider,
} from '@spectra/research-core';
import { S3ObjectStorageProvider } from '@spectra/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { executeResearchRun } from '../src/executor';

/**
 * Phase 5C: search-driven research runs. A stub WebSearchProvider stands in for
 * Brave (no network, no API key); the pages it points at are served by a local
 * fixture server so the full fetch → extract → finding path runs for real.
 */

process.env['DATABASE_URL'] ??=
  'postgresql://spectra:spectra_local_dev@localhost:5432/spectra?schema=public';
process.env['STORAGE_ENDPOINT'] ??= 'http://localhost:9000';
process.env['STORAGE_REGION'] ??= 'us-east-1';
process.env['STORAGE_ACCESS_KEY'] ??= 'spectra-local';
process.env['STORAGE_SECRET_KEY'] ??= 'spectra_local_dev';
process.env['STORAGE_BUCKET'] ??= 'spectra-dev';
process.env['STORAGE_FORCE_PATH_STYLE'] ??= 'true';

const logger = createLogger({ name: 'search-it', level: 'silent' });
// Fixture pages live on 127.0.0.1 — the documented test-only SSRF escape hatch.
const FETCH_OPTIONS = { allowPrivateHosts: true } as const;

/** Stub search provider returning fixture URLs; records the queries it saw. */
class StubWebSearch implements WebSearchProvider {
  readonly id = 'stub-web';
  readonly kind = 'web-search' as const;
  readonly displayName = 'Stub web search';
  readonly seen: string[] = [];

  constructor(
    private readonly results: (base: string) => DiscoveredSource[],
    private readonly base: string,
    private readonly failOn?: string,
  ) {}

  async search(query: SearchQueryInput, _tenant: TenantScope): Promise<DiscoveredSource[]> {
    this.seen.push(query.queryText);
    if (this.failOn && query.queryText === this.failOn) {
      throw new Error('upstream search quota exceeded');
    }
    return this.results(this.base);
  }
}

describe('search-driven research runs (integration)', () => {
  let server: Server;
  let baseUrl = '';
  let prisma: SpectraPrismaClient;
  let orgId = '';
  let workspaceId = '';
  let projectId = '';

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
      if (path === '/robots.txt') {
        res.setHeader('content-type', 'text/plain');
        res.end('User-agent: *\nDisallow: /private\n');
        return;
      }
      if (path === '/private/secret') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end('<html><body><article><p>Should never be fetched.</p></article></body></html>');
        return;
      }
      if (path === '/article-1') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          '<html><body><article><h1>Full article one</h1>' +
            '<p>Enterprise adoption of AI testing grew 40% in 2026 across large organisations.</p>' +
            '</article></body></html>',
        );
        return;
      }
      if (path === '/article-3') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          '<html><body><article><h1>Full article three</h1>' +
            '<p>Enterprise adoption of AI testing grew 40% in 2026 according to a third report.</p>' +
            '</article></body></html>',
        );
        return;
      }
      if (path === '/article-2') {
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(
          '<html><body><article><h1>Full article two</h1>' +
            '<p>A separate benchmark reports 25% higher accuracy for agentic evaluation.</p>' +
            '</article></body></html>',
        );
        return;
      }
      res.statusCode = 404;
      res.end('not found');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    prisma = createPrismaClient({ tenantGuard: true });
    await new S3ObjectStorageProvider(loadEnv(storageEnvSchema)).ensureBucket();

    const org = await prisma.organization.create({
      data: { name: 'Search IT Org', slug: `search-it-${Date.now()}`, status: 'ACTIVE' },
    });
    orgId = org.id;
    const workspace = await prisma.workspace.create({
      data: { organizationId: orgId, name: 'S WS', slug: 's-ws', status: 'ACTIVE' },
    });
    workspaceId = workspace.id;
    const vertical = await prisma.customVertical.create({
      data: {
        organizationId: orgId,
        workspaceId,
        name: 'AI testing',
        slug: 'ai-testing-search',
        keywords: ['AI testing', 'benchmark'],
        status: 'ACTIVE',
      },
    });
    const project = await prisma.researchProject.create({
      data: {
        organizationId: orgId,
        workspaceId,
        verticalId: vertical.id,
        name: 'Search IT project',
        status: 'ACTIVE',
      },
    });
    projectId = project.id;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (orgId) {
      await prisma.$executeRaw`DELETE FROM "document_chunks" WHERE "organizationId" = ${orgId}::uuid`.catch(
        () => undefined,
      );
      await prisma.organization.delete({ where: { id: orgId } }).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  const storage = () => new S3ObjectStorageProvider(loadEnv(storageEnvSchema));

  async function newRun(queryPlan: Record<string, unknown>): Promise<string> {
    const run = await prisma.researchRun.create({
      data: {
        organizationId: orgId,
        workspaceId,
        projectId,
        status: 'QUEUED',
        trigger: 'API',
        queryPlan: queryPlan as never,
      },
    });
    return run.id;
  }

  it('ingests real sources discovered by search, with the query as provenance', async () => {
    const stub = new StubWebSearch(
      (base) => [
        {
          url: `${base}/article-1`,
          title: 'Full article one',
          snippet: 'short snippet',
          category: 'WEB',
        },
        {
          url: `${base}/article-2`,
          title: 'Full article two',
          snippet: 'short snippet',
          category: 'WEB',
        },
      ],
      baseUrl,
    );
    const registry = new ResearchProviderRegistry();
    registry.register(stub);

    const runId = await newRun({ feedUrls: [], searchQueries: ['AI testing adoption'] });
    const outcome = await executeResearchRun(
      {
        prisma,
        storage: storage(),
        logger,
        providerRegistry: registry,
        fetchOptions: FETCH_OPTIONS,
      },
      { runId },
    );

    expect(outcome.status).not.toBe('FAILED');
    expect(stub.seen).toEqual(['AI testing adoption']);
    expect(outcome.stats.queriesPlanned).toBe(1);
    expect(outcome.stats.sourcesDiscovered).toBe(2);

    const sources = await prisma.researchSource.findMany({
      where: { organizationId: orgId, workspaceId, runId },
      orderBy: { url: 'asc' },
    });
    expect(sources).toHaveLength(2);
    expect(sources[0]?.category).toBe('WEB');
    const provenance = sources[0]?.provenance as Record<string, unknown>;
    // The query that found it — not a feed URL — is the request reference.
    expect(provenance['requestRef']).toBe('AI testing adoption');
    expect(provenance['providerId']).toBe('stub-web');
    expect(provenance['providerKind']).toBe('web-search');
  }, 30_000);

  it('fetches the discovered page for full text rather than storing the snippet', async () => {
    const stub = new StubWebSearch(
      (base) => [
        {
          url: `${base}/article-3`,
          title: 'Full article three',
          snippet: 'short snippet',
          category: 'WEB',
        },
      ],
      baseUrl,
    );
    const registry = new ResearchProviderRegistry();
    registry.register(stub);

    const runId = await newRun({ feedUrls: [], searchQueries: ['fetch me'] });
    await executeResearchRun(
      {
        prisma,
        storage: storage(),
        logger,
        providerRegistry: registry,
        fetchOptions: FETCH_OPTIONS,
      },
      { runId },
    );

    const finding = await prisma.researchFinding.findFirst({
      where: { organizationId: orgId, workspaceId, runId },
    });
    expect(finding).toBeTruthy();
    // Body came from the fetched page, not the 'short snippet' string.
    expect(finding?.excerpt ?? '').toMatch(/40%|Enterprise adoption/);

    const source = await prisma.researchSource.findFirst({
      where: { organizationId: orgId, workspaceId, runId },
    });
    expect((source?.provenance as Record<string, unknown>)['snippetOnly']).toBe(false);
  }, 30_000);

  it('falls back to the snippet and records snippetOnly when the page cannot be fetched', async () => {
    const stub = new StubWebSearch(
      (base) => [
        {
          url: `${base}/gone-404`,
          title: 'Unreachable page',
          snippet: 'The only text we actually have about AI testing.',
          category: 'WEB',
        },
      ],
      baseUrl,
    );
    const registry = new ResearchProviderRegistry();
    registry.register(stub);

    const runId = await newRun({ feedUrls: [], searchQueries: ['unreachable'] });
    await executeResearchRun(
      {
        prisma,
        storage: storage(),
        logger,
        providerRegistry: registry,
        fetchOptions: FETCH_OPTIONS,
      },
      { runId },
    );

    const source = await prisma.researchSource.findFirst({
      where: { organizationId: orgId, workspaceId, runId },
    });
    expect(source).toBeTruthy();
    // Ingested, but explicitly marked as snippet-derived — never passed off as
    // the full article.
    expect((source?.provenance as Record<string, unknown>)['snippetOnly']).toBe(true);
  }, 30_000);

  it('surfaces a search failure instead of reporting an empty but successful run', async () => {
    const stub = new StubWebSearch(() => [], baseUrl, 'boom');
    const registry = new ResearchProviderRegistry();
    registry.register(stub);

    const runId = await newRun({ feedUrls: [], searchQueries: ['boom'] });
    const outcome = await executeResearchRun(
      {
        prisma,
        storage: storage(),
        logger,
        providerRegistry: registry,
        fetchOptions: FETCH_OPTIONS,
      },
      { runId },
    );

    expect(outcome.stats.sourcesDiscovered).toBe(0);
    const run = await prisma.researchRun.findUnique({ where: { id: runId } });
    // The failure is recorded, not silently swallowed into "found nothing".
    expect(run?.failureReason ?? '').toMatch(/quota exceeded/);
    // Nothing ingested and the only query errored => the run failed. Reporting
    // SUCCEEDED here would be the dishonest outcome.
    expect(outcome.status).toBe('FAILED');
  }, 30_000);

  it('caps page fetches per run and says so instead of failing silently', async () => {
    const stub = new StubWebSearch(
      (base) => [
        { url: `${base}/article-1?a=1`, title: 'One', snippet: 'snippet one', category: 'WEB' },
        { url: `${base}/article-2?a=2`, title: 'Two', snippet: 'snippet two', category: 'WEB' },
        { url: `${base}/article-3?a=3`, title: 'Three', snippet: 'snippet three', category: 'WEB' },
      ],
      baseUrl,
    );
    const registry = new ResearchProviderRegistry();
    registry.register(stub);

    const runId = await newRun({ feedUrls: [], searchQueries: ['budget test'] });
    await executeResearchRun(
      {
        prisma,
        storage: storage(),
        logger,
        providerRegistry: registry,
        fetchOptions: FETCH_OPTIONS,
        maxPageFetchesPerRun: 1,
      },
      { runId },
    );

    const sources = await prisma.researchSource.findMany({
      where: { organizationId: orgId, workspaceId, runId },
    });
    // All three still ingested — the budget degrades quality, it does not drop
    // real results.
    expect(sources).toHaveLength(3);
    const snippetOnly = sources.filter(
      (s) => (s.provenance as Record<string, unknown>)['snippetOnly'] === true,
    );
    expect(snippetOnly).toHaveLength(2);

    const run = await prisma.researchRun.findUnique({ where: { id: runId } });
    expect(run?.failureReason ?? '').toMatch(/budget of 1 reached/);
  }, 30_000);

  it('refuses at execution time when the workspace budget is exhausted', async () => {
    // A job can be queued BEFORE the ceiling is hit and run after it. The
    // executor must re-check rather than trusting the API's pre-flight guard.
    await prisma.workspaceBudget.create({
      data: {
        organizationId: orgId,
        workspaceId,
        monthlyLimitMicros: 1_000,
        enforcement: 'ENFORCE',
      },
    });
    await prisma.usageEvent.create({
      data: {
        organizationId: orgId,
        workspaceId,
        kind: 'WEB_SEARCH',
        provider: 'brave',
        model: 'web-search',
        estimatedCostMicros: 500_000,
        rateVersion: 'rates-2026-08-31',
      },
    });

    const stub = new StubWebSearch(
      (base) => [{ url: `${base}/article-1?z=9`, title: 'x', snippet: 's', category: 'WEB' }],
      baseUrl,
    );
    const registry = new ResearchProviderRegistry();
    registry.register(stub);

    const runId = await newRun({ feedUrls: [], searchQueries: ['over budget'] });
    const outcome = await executeResearchRun(
      {
        prisma,
        storage: storage(),
        logger,
        providerRegistry: registry,
        fetchOptions: FETCH_OPTIONS,
      },
      { runId },
    );

    expect(outcome.status).toBe('FAILED');
    // Refused before spending: the provider was never called.
    expect(stub.seen).toEqual([]);
    const run = await prisma.researchRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('FAILED');
    expect(run?.failureReason ?? '').toMatch(/monthly limit/);

    // Clean up so later assertions in this file are unaffected.
    await prisma.workspaceBudget.deleteMany({ where: { organizationId: orgId, workspaceId } });
    await prisma.usageEvent.deleteMany({ where: { organizationId: orgId, workspaceId } });
  }, 30_000);

  it('respects robots.txt: a disallowed page is never fetched and stays snippet-only', async () => {
    const stub = new StubWebSearch(
      (base) => [
        {
          url: `${base}/private/secret`,
          title: 'Disallowed page',
          snippet: 'Only the snippet about AI testing is available.',
          category: 'WEB',
        },
      ],
      baseUrl,
    );
    const registry = new ResearchProviderRegistry();
    registry.register(stub);

    const runId = await newRun({ feedUrls: [], searchQueries: ['robots test'] });
    const outcome = await executeResearchRun(
      {
        prisma,
        storage: storage(),
        logger,
        providerRegistry: registry,
        fetchOptions: FETCH_OPTIONS,
      },
      { runId },
    );

    const source = await prisma.researchSource.findFirst({
      where: { organizationId: orgId, workspaceId, runId },
    });
    expect(source).toBeTruthy();
    expect(source?.robotsDecision).toBe('DISALLOWED');
    expect(source?.snippetOnly).toBe(true);
    expect(source?.processingStatus).toBe('ROBOTS_BLOCKED');
    // Kept with a truthful reason rather than dropped or pretended fetched.
    expect(String((source?.metadata as Record<string, unknown>)['fetchNote'])).toMatch(
      /disallows \/private\/secret/,
    );
    expect(outcome.stats.robotsBlocked).toBe(1);
    expect(outcome.stats.snippetOnly).toBe(1);

    await prisma.robotsCacheEntry.deleteMany({ where: { origin: baseUrl } });
  }, 30_000);

  it('rejects a blocked domain instead of ingesting it as evidence', async () => {
    await prisma.customVertical.updateMany({
      where: { organizationId: orgId, workspaceId },
      data: { blockedDomains: ['127.0.0.1'] },
    });

    const stub = new StubWebSearch(
      (base) => [{ url: `${base}/article-1?b=1`, title: 'Blocked', snippet: 's', category: 'WEB' }],
      baseUrl,
    );
    const registry = new ResearchProviderRegistry();
    registry.register(stub);

    const runId = await newRun({ feedUrls: [], searchQueries: ['blocked domain'] });
    const outcome = await executeResearchRun(
      {
        prisma,
        storage: storage(),
        logger,
        providerRegistry: registry,
        fetchOptions: FETCH_OPTIONS,
      },
      { runId },
    );

    // Counted and reported — not silently dropped.
    expect(outcome.stats.blockedDomainRejected).toBe(1);
    const sources = await prisma.researchSource.findMany({
      where: { organizationId: orgId, workspaceId, runId },
    });
    expect(sources).toHaveLength(0);

    await prisma.customVertical.updateMany({
      where: { organizationId: orgId, workspaceId },
      data: { blockedDomains: [] },
    });
  }, 30_000);

  it('refuses a search-only plan when no provider is configured', async () => {
    const runId = await newRun({ feedUrls: [], searchQueries: ['anything'] });
    // Recorded on the run, then re-thrown so the queue sees a real failure.
    await expect(
      executeResearchRun(
        { prisma, storage: storage(), logger, providerRegistry: new ResearchProviderRegistry() },
        { runId },
      ),
    ).rejects.toThrow(/no live search provider is configured/i);

    const run = await prisma.researchRun.findUnique({ where: { id: runId } });
    expect(run?.status).toBe('FAILED');
    expect(run?.failureReason ?? '').toMatch(/no live search provider is configured/i);
  }, 30_000);
});
