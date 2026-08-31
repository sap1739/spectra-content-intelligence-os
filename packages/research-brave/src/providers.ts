import type { TenantScope } from '@spectra/contracts';
import type {
  DiscoveredSource,
  NewsSearchProvider,
  SearchQueryInput,
  WebSearchProvider,
} from '@spectra/research-core';

import {
  BRAVE_NEWS_ENDPOINT,
  BRAVE_WEB_ENDPOINT,
  BraveClient,
  type BraveClientConfig,
  clampCount,
  freshnessFor,
} from './brave-client';

/**
 * Brave Search adapters for the research-core discovery ports (ADR-0024).
 *
 * Brave runs its own index rather than reselling Google/Bing, which keeps the
 * legal posture clean for a commercial product and gives genuinely independent
 * coverage.
 *
 * Result mapping is deliberately defensive: Brave's published news schema does
 * not document every field, so both the documented (`{results:[]}`) and the
 * web-style (`{news:{results:[]}}`) envelopes are accepted and every optional
 * field is treated as absent-until-proven-present. A result without a usable
 * absolute http(s) URL is DROPPED rather than guessed at — a fabricated source
 * URL would poison the evidence chain.
 */

/** Brave caps web `count` at 20 and news `count` at 50. */
const WEB_COUNT_CEILING = 20;
const NEWS_COUNT_CEILING = 50;

interface BraveResult {
  url?: string;
  title?: string;
  description?: string;
  age?: string;
  page_age?: string;
  language?: string;
  meta_url?: { hostname?: string };
  profile?: { name?: string; long_name?: string };
}

export interface BraveProviderConfig extends BraveClientConfig {
  /** Injectable clock so freshness mapping is deterministic in tests. */
  now?: () => Date;
}

abstract class BraveProviderBase {
  protected readonly client: BraveClient;
  protected readonly now: () => Date;

  constructor(config: BraveProviderConfig = {}) {
    this.client = new BraveClient(config);
    this.now = config.now ?? (() => new Date());
  }

  get isConfigured(): boolean {
    return this.client.isConfigured;
  }

  protected params(query: SearchQueryInput, ceiling: number): Record<string, string> {
    const params: Record<string, string> = {
      q: query.queryText,
      count: String(clampCount(query.maxResults, ceiling)),
      safesearch: 'moderate',
    };
    if (query.language) params['search_lang'] = query.language;
    if (query.geography) params['country'] = query.geography.toUpperCase();
    const freshness = freshnessFor(query.publishedAfter, this.now());
    if (freshness) params['freshness'] = freshness;
    return params;
  }
}

/** Maps one Brave result to a DiscoveredSource, or null when unusable. */
function toDiscoveredSource(
  raw: BraveResult,
  category: DiscoveredSource['category'],
  rank: number,
): DiscoveredSource | null {
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!url) return null;
  // Only absolute http(s) URLs are ingestible; anything else is dropped rather
  // than coerced into something that looks real.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

  const publisher =
    raw.profile?.long_name?.trim() ||
    raw.profile?.name?.trim() ||
    raw.meta_url?.hostname?.trim() ||
    parsed.hostname;

  const publishedAt = normalizeDate(raw.page_age);

  return {
    url,
    category,
    providerRank: rank,
    ...(raw.title?.trim() ? { title: raw.title.trim() } : {}),
    ...(raw.description?.trim() ? { snippet: stripTags(raw.description) } : {}),
    ...(publisher ? { publisher } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(raw.language?.trim() ? { language: raw.language.trim() } : {}),
  };
}

/** Brave marks matched terms with <strong>; snippets are plain text for us. */
function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, '').trim();
}

/**
 * `page_age` is an ISO-ish timestamp when present, and Brave may omit the
 * timezone designator. JS parses a bare `YYYY-MM-DDTHH:mm:ss` as SERVER-LOCAL
 * time, which would silently shift every source date by the deploy region's
 * offset — so a timezone-less value is pinned to UTC (this codebase stores UTC
 * everywhere). An unparseable date is omitted rather than defaulted to "now",
 * which would misdate the source.
 */
function normalizeDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const isBareDateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?$/.test(trimmed);
  const candidate = !hasZone && isBareDateTime ? `${trimmed.replace(' ', 'T')}Z` : trimmed;
  const date = new Date(candidate);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function extractResults(body: unknown, key: 'web' | 'news'): BraveResult[] {
  const envelope = body as Record<string, unknown> | null;
  if (!envelope) return [];
  const nested = envelope[key] as { results?: unknown } | undefined;
  const candidate = nested?.results ?? (envelope as { results?: unknown }).results;
  return Array.isArray(candidate) ? (candidate as BraveResult[]) : [];
}

export class BraveWebSearchProvider extends BraveProviderBase implements WebSearchProvider {
  readonly id = 'brave-web';
  readonly kind = 'web-search' as const;
  readonly displayName = 'Brave Search (web)';

  async search(query: SearchQueryInput, _tenant: TenantScope): Promise<DiscoveredSource[]> {
    const body = await this.client.get<unknown>(
      BRAVE_WEB_ENDPOINT,
      this.params(query, WEB_COUNT_CEILING),
      this.id,
    );
    return extractResults(body, 'web')
      .map((raw, i) => toDiscoveredSource(raw, 'WEB', i))
      .filter((s): s is DiscoveredSource => s !== null);
  }
}

export class BraveNewsSearchProvider extends BraveProviderBase implements NewsSearchProvider {
  readonly id = 'brave-news';
  readonly kind = 'news-search' as const;
  readonly displayName = 'Brave Search (news)';

  async searchNews(query: SearchQueryInput, _tenant: TenantScope): Promise<DiscoveredSource[]> {
    const body = await this.client.get<unknown>(
      BRAVE_NEWS_ENDPOINT,
      this.params(query, NEWS_COUNT_CEILING),
      this.id,
    );
    return extractResults(body, 'news')
      .map((raw, i) => toDiscoveredSource(raw, 'NEWS', i))
      .filter((s): s is DiscoveredSource => s !== null);
  }
}
