/**
 * Shared Brave Search HTTP client.
 *
 * Honesty contract: without BRAVE_SEARCH_API_KEY the providers are UNAVAILABLE
 * (`isConfigured === false`) and throw `SearchProviderUnavailableError` — the
 * pipeline records that a query could not run rather than inventing sources.
 * A failed request is an error, never an empty result set masquerading as
 * "nothing found".
 */

export const BRAVE_WEB_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
export const BRAVE_NEWS_ENDPOINT = 'https://api.search.brave.com/res/v1/news/search';

const DEFAULT_TIMEOUT_MS = 15_000;

export class SearchProviderUnavailableError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `Web search is unavailable: provider "${providerId}" is not configured. ` +
        'Set BRAVE_SEARCH_API_KEY to enable live search discovery.',
    );
    this.name = 'SearchProviderUnavailableError';
    this.providerId = providerId;
  }
}

export class SearchRequestError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'SearchRequestError';
    this.status = status;
  }
}

export interface BraveClientConfig {
  /** Absent or empty => providers are unavailable (honest, not fabricated). */
  apiKey?: string | undefined;
  timeoutMs?: number;
  /** Injectable for tests — no network in unit tests. */
  fetch?: typeof fetch;
}

export class BraveClient {
  private readonly apiKey: string | undefined;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: BraveClientConfig = {}) {
    this.apiKey = config.apiKey?.trim() || undefined;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetch ?? globalThis.fetch;
  }

  get isConfigured(): boolean {
    return this.apiKey !== undefined;
  }

  async get<T>(endpoint: string, params: Record<string, string>, providerId: string): Promise<T> {
    if (!this.apiKey) throw new SearchProviderUnavailableError(providerId);
    const url = `${endpoint}?${new URLSearchParams(params).toString()}`;

    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'accept-encoding': 'gzip',
          // Key travels in a header only — never in the query string, which
          // would leak it into logs and referrers.
          'x-subscription-token': this.apiKey,
        },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new SearchRequestError(
        `Brave search request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new SearchRequestError(
        `Brave responded ${res.status} ${res.statusText}: ${truncate(detail)}`,
        res.status,
      );
    }

    try {
      return (await res.json()) as T;
    } catch (error) {
      throw new SearchRequestError(
        `Brave returned an unreadable response: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function truncate(detail: string): string {
  const flat = detail.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}…` : flat;
}

/**
 * Brave accepts a coarse freshness bucket (pd/pw/pm/py). A `publishedAfter`
 * instant is mapped to the tightest bucket that still contains it — narrower
 * would silently drop results the caller asked for.
 */
export function freshnessFor(publishedAfter: string | undefined, now: Date): string | undefined {
  if (!publishedAfter) return undefined;
  const after = new Date(publishedAfter);
  if (Number.isNaN(after.getTime())) return undefined;
  const days = (now.getTime() - after.getTime()) / 86_400_000;
  if (days <= 0) return 'pd';
  if (days <= 1) return 'pd';
  if (days <= 7) return 'pw';
  if (days <= 31) return 'pm';
  if (days <= 365) return 'py';
  return undefined; // older than a year: no bucket, let Brave return everything
}

/** Brave caps `count` at 20 (web). Clamp rather than error on an over-ask. */
export function clampCount(maxResults: number | undefined, ceiling: number): number {
  if (!maxResults || maxResults < 1) return Math.min(10, ceiling);
  return Math.min(maxResults, ceiling);
}
