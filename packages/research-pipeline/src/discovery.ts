import type { SourceCategory, TenantScope } from '@spectra/contracts';
import type {
  DocumentCitationAnchor,
  DocumentExtractionFailureCode,
  DocumentExtractionProvider,
  ExtractableDocumentType,
  DiscoveredSource,
  NewsSearchProvider,
  ResearchProviderRegistry,
  WebSearchProvider,
} from '@spectra/research-core';
import type { Logger } from '@spectra/logging';
import type { UsageRecorder } from '@spectra/metering';

import type { FirstPartyRssProvider } from './rss';
import type { FetchScheduler } from './fetch-scheduler';
import type { RobotsDecision, RobotsGateway } from './robots';
import { safeFetch, type SafeFetchOptions } from './safe-fetch';
import { METRICS, metrics } from '@spectra/telemetry';

/**
 * Source discovery, normalized.
 *
 * RSS feeds and search results arrive in different shapes but must be ingested
 * identically — same SSRF guard, dedup, extraction, scoring and provenance. Both
 * are converted to `CandidateItem` here so the pipeline has ONE ingest path
 * rather than two that can drift apart.
 */

export interface CandidateItem {
  url: string;
  title: string | null;
  author: string | null;
  /** ISO-8601 UTC, or null when the source did not state one. */
  publishedAt: string | null;
  language: string | null;
  publisher: string | null;
  category: SourceCategory;
  /** Content already in hand: feed body, fetched page HTML, or search snippet. */
  rawHtml: string;
  /** How this candidate was obtained — persisted for provenance. */
  provenance: { providerId: string; providerKind: string; requestRef: string };
  /**
   * True when `rawHtml` is only a search snippet because the page could not be
   * fetched. Recorded so a finding built from a snippet is never mistaken for
   * one built from the full article.
   */
  snippetOnly: boolean;
  /** Outcome of the robots.txt check, when one was performed (ADR-0030). */
  robotsDecision: RobotsDecision;
  /** Set when the fetched bytes were a document we extracted (ADR-0031). */
  document?: ExtractedDocumentInfo;
  /** Why this candidate is snippet-only / was not fetched. Always specific. */
  fetchNote: string | null;
}

/** What a successful (or failed) document extraction contributed. */
export interface ExtractedDocumentInfo {
  documentType: ExtractableDocumentType;
  pageCount: number | null;
  anchors: DocumentCitationAnchor[];
  warnings: string[];
  /** Set only when extraction was attempted and failed. */
  failureCode?: DocumentExtractionFailureCode;
}

export interface DiscoveryOutcome {
  candidates: CandidateItem[];
  /** Queries/feeds that actually executed (for run stats). */
  executed: number;
  /** Human-readable failures — surfaced, never swallowed. */
  errors: string[];
}

const MAX_ITEMS_PER_FEED = 50;

/** Expands one RSS feed into candidates. */
export async function candidatesFromFeed(
  rss: FirstPartyRssProvider,
  feedUrl: string,
): Promise<CandidateItem[]> {
  const { feedTitle, items } = await rss.fetchFeedWithMeta(feedUrl);
  return items.slice(0, MAX_ITEMS_PER_FEED).map((item) => ({
    url: item.url,
    title: item.title ?? null,
    author: item.author ?? null,
    publishedAt: item.publishedAt ?? null,
    language: item.language ?? null,
    publisher: feedTitle ?? null,
    // Feeds are publisher timelines; the historical pipeline classified them as NEWS.
    category: 'NEWS' as SourceCategory,
    rawHtml: item.contentHtml ?? item.summary ?? item.title ?? '',
    provenance: { providerId: rss.id, providerKind: rss.kind, requestRef: feedUrl },
    snippetOnly: false,
    // Feed bodies are supplied BY the publisher through their own feed, so no
    // crawl happens and robots.txt does not apply.
    robotsDecision: 'NOT_CHECKED' as RobotsDecision,
    fetchNote: null,
  }));
}

export interface SearchDiscoveryOptions {
  registry: ResearchProviderRegistry;
  queries: readonly string[];
  tenant: TenantScope;
  maxResultsPerQuery?: number;
  /** Fetch each discovered URL for full text. Off => snippet-only candidates. */
  fetchPages?: boolean;
  fetchOptions?: SafeFetchOptions;
  logger?: Logger;
  signal?: AbortSignal;
  /** Checks robots.txt before any page fetch. Omitted => no fetching at all. */
  robots?: RobotsGateway;
  /** Bounds concurrency and spaces requests per host. */
  scheduler?: FetchScheduler;
  /** Turns PDF/DOCX/TXT bytes into anchored text (ADR-0031). */
  documentExtractor?: DocumentExtractionProvider;
  /** Records real provider spend; omitted means no ledger. */
  usage?: UsageRecorder;
  /** Stamped on ledger rows so spend is attributable to the run. */
  resourceId?: string;
  /**
   * Hard ceiling on pages fetched in one run. Discovery is otherwise unbounded
   * (queries x results-per-query), which is the pipeline's real runaway-cost
   * risk. Candidates past the cap are still ingested — as snippet-only, and the
   * cap is reported — rather than silently dropped.
   */
  maxPageFetches?: number;
}

/**
 * Runs each query against every registered discovery provider (web + news) and
 * returns normalized candidates.
 *
 * A provider that is not registered is simply absent — discovery then yields
 * nothing for that kind rather than erroring, because "no live search
 * configured" is a valid, honest state (ADR-0024). A provider that IS
 * registered but fails is recorded in `errors`: a failed search must never be
 * indistinguishable from a search that found nothing.
 */
export async function candidatesFromSearch(
  options: SearchDiscoveryOptions,
): Promise<DiscoveryOutcome> {
  const { registry, queries, tenant } = options;
  const candidates: CandidateItem[] = [];
  const errors: string[] = [];
  let executed = 0;

  const web = registry.listByKind('web-search') as WebSearchProvider[];
  const news = registry.listByKind('news-search') as NewsSearchProvider[];
  if (web.length === 0 && news.length === 0) {
    return { candidates: [], executed: 0, errors: [] };
  }

  const seenUrls = new Set<string>();
  let fetched = 0;

  for (const queryText of queries) {
    if (options.signal?.aborted) break;
    const input = {
      queryText,
      ...(options.maxResultsPerQuery ? { maxResults: options.maxResultsPerQuery } : {}),
    };

    const calls: Array<{
      label: string;
      providerName: string;
      kind: 'WEB_SEARCH' | 'NEWS_SEARCH';
      run: () => Promise<DiscoveredSource[]>;
    }> = [
      ...web.map((p) => ({
        label: p.id,
        providerName: providerNameOf(p.id),
        kind: 'WEB_SEARCH' as const,
        run: () =>
          metrics.time(
            METRICS.providerLatency,
            { provider: providerNameOf(p.id), op: 'search' },
            () => p.search(input, tenant),
          ),
      })),
      ...news.map((p) => ({
        label: p.id,
        providerName: providerNameOf(p.id),
        kind: 'NEWS_SEARCH' as const,
        run: () =>
          metrics.time(
            METRICS.providerLatency,
            { provider: providerNameOf(p.id), op: 'search_news' },
            () => p.searchNews(input, tenant),
          ),
      })),
    ];

    for (const call of calls) {
      if (options.signal?.aborted) break;
      let discovered: DiscoveredSource[];
      try {
        discovered = await call.run();
        executed += 1;
        // Search bills per query — meter the call that actually happened.
        await options.usage?.record(tenant, {
          kind: call.kind,
          provider: call.providerName,
          model: call.kind === 'NEWS_SEARCH' ? 'news-search' : 'web-search',
          requests: 1,
          resourceType: 'RESEARCH_RUN',
          ...(options.resourceId ? { resourceId: options.resourceId } : {}),
          metadata: { query: queryText, results: discovered.length },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`${call.label} "${queryText}": ${message}`);
        options.logger?.warn({ provider: call.label, err: message }, 'Search query failed');
        continue;
      }

      for (const source of discovered) {
        // De-duplicate within the run before any network work; the pipeline
        // de-duplicates against stored sources separately.
        if (seenUrls.has(source.url)) continue;
        seenUrls.add(source.url);
        const budgetLeft = options.maxPageFetches === undefined || fetched < options.maxPageFetches;
        const candidate = await toCandidate(source, queryText, call.label, {
          ...options,
          // Past the budget: keep ingesting, but as snippet-only rather than
          // dropping real results on the floor.
          ...(budgetLeft ? {} : { fetchPages: false }),
        });
        if (!candidate.snippetOnly) fetched += 1;
        candidates.push(candidate);
      }
    }
  }

  if (options.maxPageFetches !== undefined && fetched >= options.maxPageFetches) {
    // Surfaced, not silent: the operator must know results were degraded to
    // snippets by the budget rather than by unreachable pages.
    errors.push(
      `Page-fetch budget of ${options.maxPageFetches} reached — remaining sources kept as search snippets only`,
    );
  }
  return { candidates, executed, errors };
}

async function toCandidate(
  source: DiscoveredSource,
  queryText: string,
  providerId: string,
  options: SearchDiscoveryOptions,
): Promise<CandidateItem> {
  const base: CandidateItem = {
    robotsDecision: 'NOT_CHECKED',
    fetchNote: null,
    url: source.url,
    title: source.title ?? null,
    author: null,
    publishedAt: source.publishedAt ?? null,
    language: source.language ?? null,
    publisher: source.publisher ?? null,
    category: source.category,
    rawHtml: source.snippet ?? source.title ?? '',
    provenance: {
      providerId,
      providerKind: source.category === 'NEWS' ? 'news-search' : 'web-search',
      // The query is the request reference — this is how the source was found.
      requestRef: queryText,
    },
    snippetOnly: true,
  };

  if (options.fetchPages === false) {
    return {
      ...base,
      fetchNote: 'Page fetching is disabled for this run; the search snippet is all we hold.',
    };
  }

  // ASK BEFORE FETCHING. A disallowed page is never retrieved — it stays
  // snippet-only with the site's own rule as the reason (ADR-0030).
  let crawlDelaySeconds: number | null = null;
  if (options.robots) {
    const verdict = await options.robots.check(source.url);
    crawlDelaySeconds = verdict.crawlDelaySeconds;
    if (verdict.decision === 'DISALLOWED') {
      return { ...base, robotsDecision: 'DISALLOWED', fetchNote: verdict.reason };
    }
    base.robotsDecision = verdict.decision;
    base.fetchNote = verdict.decision === 'UNAVAILABLE' ? verdict.reason : null;
  }

  // Fetch the page for real text. The snippet is a fallback, not a substitute:
  // a failure downgrades the candidate honestly rather than dropping it.
  try {
    const run = () => safeFetch(source.url, options.fetchOptions);
    const result = options.scheduler
      ? await options.scheduler.run(source.url, run, crawlDelaySeconds)
      : await run();
    const contentType = result.contentType.toLowerCase();
    // A document rather than a web page: extract it properly (ADR-0031). This
    // is what stops PDFs/DOCX from being permanently snippet-only.
    if (options.documentExtractor?.supports(result.contentType, filenameFromUrl(source.url))) {
      const extraction = await options.documentExtractor.extract(
        {
          bytes: result.body,
          mimeType: result.contentType,
          sourceRef: source.url,
          ...(filenameFromUrl(source.url) ? { filename: filenameFromUrl(source.url) } : {}),
        },
        options.tenant,
      );
      if (extraction.ok) {
        const doc = extraction.document;
        return {
          ...base,
          // Real extracted text: no longer snippet-only.
          rawHtml: doc.text,
          snippetOnly: false,
          title: doc.metadata.title ?? base.title,
          author: doc.metadata.author ?? base.author,
          publishedAt: doc.metadata.createdAt ?? base.publishedAt,
          fetchNote: doc.warnings.length > 0 ? doc.warnings.join(' ') : null,
          document: {
            documentType: doc.documentType,
            pageCount: doc.metadata.pageCount ?? null,
            anchors: doc.anchors,
            warnings: doc.warnings,
          },
        };
      }
      // Extraction failed — keep the source with the specific reason. The
      // snippet stands, and the failure code is recorded so the UI can say
      // exactly why the document's text is absent.
      return {
        ...base,
        fetchNote: extraction.failure.message,
        document: {
          documentType: 'PDF',
          pageCount: null,
          anchors: [],
          warnings: [],
          failureCode: extraction.failure.code,
        },
      };
    }

    if (!contentType.includes('html') && !contentType.includes('text')) {
      return {
        ...base,
        fetchNote: `The page is ${result.contentType || 'a non-text document'}, which no extractor supports; only the search snippet is held.`,
      };
    }
    const html = result.body.toString('utf8');
    if (html.trim().length === 0) {
      return {
        ...base,
        fetchNote: 'The page returned no readable text; the search snippet is all we hold.',
      };
    }
    // Not vendor-billed, but metered: page fetches are the pipeline's main
    // rate-limit and bandwidth cost, and the thing a per-run budget caps.
    await options.usage?.record(
      { organizationId: options.tenant.organizationId, workspaceId: options.tenant.workspaceId },
      {
        kind: 'PAGE_FETCH',
        provider: 'first-party',
        requests: 1,
        bytes: result.body.byteLength,
        resourceType: 'RESEARCH_RUN',
        ...(options.resourceId ? { resourceId: options.resourceId } : {}),
      },
    );
    return { ...base, rawHtml: html, snippetOnly: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.logger?.debug({ url: source.url, err: message }, 'Page fetch failed — snippet only');
    return {
      ...base,
      fetchNote: `The page could not be fetched (${message}); the search snippet is all we hold.`,
    };
  }
}

/** "brave-web-search" => "brave"; keeps ledger provider names vendor-level. */
function providerNameOf(providerId: string): string {
  return providerId.split('-')[0] ?? providerId;
}

/** Filename from a URL path, used only for MIME fallback and labels. */
function filenameFromUrl(rawUrl: string): string | undefined {
  try {
    const last = new URL(rawUrl).pathname.split('/').filter(Boolean).pop();
    return last && last.includes('.') ? last : undefined;
  } catch {
    return undefined;
  }
}
