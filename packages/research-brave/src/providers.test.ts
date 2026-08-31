import type { TenantScope } from '@spectra/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  BraveNewsSearchProvider,
  BraveWebSearchProvider,
  SearchProviderUnavailableError,
  SearchRequestError,
  freshnessFor,
} from './index';

const TENANT: TenantScope = {
  organizationId: '00000000-0000-4000-8000-000000000001',
  workspaceId: '00000000-0000-4000-8000-000000000002',
};
const NOW = new Date('2026-08-30T00:00:00Z');

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function queryOf(fetchMock: { mock: { calls: unknown[][] } }): URLSearchParams {
  const url = fetchMock.mock.calls[0]?.[0] as string;
  return new URL(url).searchParams;
}

describe('BraveWebSearchProvider', () => {
  it('is unavailable without a key and never fabricates sources', async () => {
    const provider = new BraveWebSearchProvider();
    expect(provider.isConfigured).toBe(false);
    await expect(provider.search({ queryText: 'ai' }, TENANT)).rejects.toBeInstanceOf(
      SearchProviderUnavailableError,
    );
  });

  it('sends the key as a header, never in the query string', async () => {
    const fetchMock = vi.fn(async () => ok({ web: { results: [] } }));
    const provider = new BraveWebSearchProvider({
      apiKey: 'secret-key',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await provider.search({ queryText: 'ai' }, TENANT);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-subscription-token']).toBe('secret-key');
    expect(url).not.toContain('secret-key');
  });

  it('maps results to DiscoveredSource with rank, publisher and clean snippet', async () => {
    const fetchMock = vi.fn(async () =>
      ok({
        web: {
          results: [
            {
              url: 'https://example.com/a',
              title: 'Alpha',
              description: 'A <strong>match</strong> here',
              page_age: '2026-08-01T10:00:00',
              language: 'en',
              profile: { long_name: 'Example Publisher' },
            },
          ],
        },
      }),
    );
    const provider = new BraveWebSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [source] = await provider.search({ queryText: 'alpha' }, TENANT);

    expect(source).toMatchObject({
      url: 'https://example.com/a',
      title: 'Alpha',
      snippet: 'A match here', // markup stripped
      publisher: 'Example Publisher',
      language: 'en',
      category: 'WEB',
      providerRank: 0,
    });
    expect(source?.publishedAt).toBe('2026-08-01T10:00:00.000Z');
  });

  it('drops results with a missing or non-http URL rather than inventing one', async () => {
    const fetchMock = vi.fn(async () =>
      ok({
        web: {
          results: [
            { title: 'no url' },
            { url: 'javascript:alert(1)', title: 'hostile' },
            { url: 'not a url', title: 'broken' },
            { url: 'https://good.example/x', title: 'kept' },
          ],
        },
      }),
    );
    const provider = new BraveWebSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const sources = await provider.search({ queryText: 'q' }, TENANT);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.url).toBe('https://good.example/x');
  });

  it('omits an unparseable date rather than defaulting it to now', async () => {
    const fetchMock = vi.fn(async () =>
      ok({ web: { results: [{ url: 'https://e.test/a', page_age: 'not-a-date' }] } }),
    );
    const provider = new BraveWebSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [source] = await provider.search({ queryText: 'q' }, TENANT);
    expect(source?.publishedAt).toBeUndefined();
  });

  it('treats a timezone-less date as UTC, not server-local time', async () => {
    const fetchMock = vi.fn(async () =>
      ok({
        web: {
          results: [
            { url: 'https://e.test/bare', page_age: '2026-08-01T10:00:00' },
            { url: 'https://e.test/zulu', page_age: '2026-08-01T10:00:00Z' },
            { url: 'https://e.test/offset', page_age: '2026-08-01T12:00:00+02:00' },
          ],
        },
      }),
    );
    const provider = new BraveWebSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const sources = await provider.search({ queryText: 'q' }, TENANT);
    // All three denote the same instant; none may drift with the host timezone.
    expect(sources.map((s) => s.publishedAt)).toEqual([
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:00:00.000Z',
      '2026-08-01T10:00:00.000Z',
    ]);
  });

  it('falls back to the hostname when no publisher is given', async () => {
    const fetchMock = vi.fn(async () => ok({ web: { results: [{ url: 'https://news.site/x' }] } }));
    const provider = new BraveWebSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const [source] = await provider.search({ queryText: 'q' }, TENANT);
    expect(source?.publisher).toBe('news.site');
  });

  it('clamps count to the web ceiling of 20', async () => {
    const fetchMock = vi.fn(async () => ok({ web: { results: [] } }));
    const provider = new BraveWebSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await provider.search({ queryText: 'q', maxResults: 500 }, TENANT);
    expect(queryOf(fetchMock).get('count')).toBe('20');
  });

  it('passes language and country through', async () => {
    const fetchMock = vi.fn(async () => ok({ web: { results: [] } }));
    const provider = new BraveWebSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await provider.search({ queryText: 'q', language: 'de', geography: 'de' }, TENANT);
    const params = queryOf(fetchMock);
    expect(params.get('search_lang')).toBe('de');
    expect(params.get('country')).toBe('DE');
  });

  it('surfaces an API error truthfully instead of returning no results', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response('{"error":"quota"}', { status: 429, statusText: 'Too Many Requests' }),
    );
    const provider = new BraveWebSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await expect(provider.search({ queryText: 'q' }, TENANT)).rejects.toBeInstanceOf(
      SearchRequestError,
    );
  });
});

describe('BraveNewsSearchProvider', () => {
  it('accepts the documented top-level {results} envelope', async () => {
    const fetchMock = vi.fn(async () =>
      ok({ results: [{ url: 'https://n.test/1', title: 'Story' }] }),
    );
    const provider = new BraveNewsSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const sources = await provider.searchNews({ queryText: 'q' }, TENANT);
    expect(sources).toHaveLength(1);
    expect(sources[0]?.category).toBe('NEWS');
  });

  it('also accepts a nested {news:{results}} envelope', async () => {
    const fetchMock = vi.fn(async () =>
      ok({ news: { results: [{ url: 'https://n.test/2', title: 'Nested' }] } }),
    );
    const provider = new BraveNewsSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const sources = await provider.searchNews({ queryText: 'q' }, TENANT);
    expect(sources[0]?.title).toBe('Nested');
  });

  it('returns nothing (not an error) when the envelope has no results', async () => {
    const fetchMock = vi.fn(async () => ok({ type: 'news' }));
    const provider = new BraveNewsSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    expect(await provider.searchNews({ queryText: 'q' }, TENANT)).toEqual([]);
  });

  it('allows the higher news count ceiling of 50', async () => {
    const fetchMock = vi.fn(async () => ok({ results: [] }));
    const provider = new BraveNewsSearchProvider({
      apiKey: 'k',
      fetch: fetchMock as unknown as typeof fetch,
    });
    await provider.searchNews({ queryText: 'q', maxResults: 50 }, TENANT);
    expect(queryOf(fetchMock).get('count')).toBe('50');
  });
});

describe('freshnessFor', () => {
  it('maps a recency window to the tightest bucket that still contains it', () => {
    expect(freshnessFor('2026-08-29T12:00:00Z', NOW)).toBe('pd');
    expect(freshnessFor('2026-08-25T00:00:00Z', NOW)).toBe('pw');
    expect(freshnessFor('2026-08-10T00:00:00Z', NOW)).toBe('pm');
    expect(freshnessFor('2026-03-01T00:00:00Z', NOW)).toBe('py');
  });

  it('is undefined for no bound, a bad date, or older than a year', () => {
    expect(freshnessFor(undefined, NOW)).toBeUndefined();
    expect(freshnessFor('nonsense', NOW)).toBeUndefined();
    expect(freshnessFor('2019-01-01T00:00:00Z', NOW)).toBeUndefined();
  });
});
