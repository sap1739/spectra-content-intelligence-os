import type { SourceCategory, TenantScope } from '@spectra/contracts';
import type {
  DiscoveredSource,
  NewsSearchProvider,
  ResearchProviderRegistry,
  WebSearchProvider,
} from '@spectra/research-core';
import type { Logger } from '@spectra/logging';
import type { UsageRecorder } from '@spectra/metering';

import type { FirstPartyRssProvider } from './rss';
import { safeFetch, type SafeFetchOptions } from './safe-fetch';

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
        run: () => p.search(input, tenant),
      })),
      ...news.map((p) => ({
        label: p.id,
        providerName: providerNameOf(p.id),
        kind: 'NEWS_SEARCH' as const,
        run: () => p.searchNews(input, tenant),
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

  if (options.fetchPages === false) return base;

  // Fetch the page for real text. The snippet is a fallback, not a substitute:
  // a failure downgrades the candidate honestly rather than dropping it.
  try {
    const result = await safeFetch(source.url, options.fetchOptions);
    const contentType = result.contentType.toLowerCase();
    if (!contentType.includes('html') && !contentType.includes('text')) {
      return base; // binary/PDF — snippet stands until a document extractor exists
    }
    const html = result.body.toString('utf8');
    if (html.trim().length === 0) return base;
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
    options.logger?.debug(
      { url: source.url, err: error instanceof Error ? error.message : String(error) },
      'Page fetch failed — falling back to search snippet',
    );
    return base;
  }
}

/** "brave-web-search" => "brave"; keeps ledger provider names vendor-level. */
function providerNameOf(providerId: string): string {
  return providerId.split('-')[0] ?? providerId;
}
