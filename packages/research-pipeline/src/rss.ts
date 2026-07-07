import type { TenantScope } from '@spectra/contracts';
import type { FeedItem, RSSProvider } from '@spectra/research-core';
import { XMLParser } from 'fast-xml-parser';

import { safeFetch, type SafeFetchOptions } from './safe-fetch';

/**
 * First-party RSS/Atom provider — the first REAL research integration.
 * Open standard, no API key, ToS-clean. Parsing is defensive: feeds in the
 * wild are messy, so every field is optional and coerced.
 */

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true,
});

type Unknown = Record<string, unknown>;

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/** XML text nodes may parse as string, number, or { '#text': … }. */
function text(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.trim() || undefined;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const inner = (value as Unknown)['#text'];
    return inner === undefined ? undefined : text(inner);
  }
  return undefined;
}

function isoDate(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function atomLink(entry: Unknown): string | undefined {
  const links = asArray(entry['link'] as Unknown | Unknown[] | undefined);
  const alternate =
    links.find((l) => text(l['@_rel']) === 'alternate' || l['@_rel'] === undefined) ?? links[0];
  return alternate ? text(alternate['@_href']) : undefined;
}

export function parseFeed(xml: string): { feedTitle?: string; items: FeedItem[] } {
  const doc = parser.parse(xml) as Unknown;

  // RSS 2.0
  const rss = doc['rss'] as Unknown | undefined;
  const channel = rss?.['channel'] as Unknown | undefined;
  if (channel) {
    const language = text(channel['language']);
    const items = asArray(channel['item'] as Unknown | Unknown[] | undefined)
      .map((item): FeedItem | null => {
        const url = text(item['link']) ?? text((item['guid'] as Unknown) ?? item['guid']);
        if (!url || !/^https?:\/\//i.test(url)) return null;
        const summary = text(item['description']);
        const content = text(item['content:encoded']) ?? summary;
        return {
          url,
          ...(text(item['title']) ? { title: text(item['title']) } : {}),
          ...(summary ? { summary } : {}),
          ...(content ? { contentHtml: content } : {}),
          ...(isoDate(item['pubDate'] ?? item['dc:date'])
            ? { publishedAt: isoDate(item['pubDate'] ?? item['dc:date']) }
            : {}),
          ...(text(item['dc:creator'] ?? item['author'])
            ? { author: text(item['dc:creator'] ?? item['author']) }
            : {}),
          ...(language ? { language } : {}),
        };
      })
      .filter((item): item is FeedItem => item !== null);
    return { ...(text(channel['title']) ? { feedTitle: text(channel['title']) } : {}), items };
  }

  // Atom
  const feed = doc['feed'] as Unknown | undefined;
  if (feed) {
    const language = text(feed['@_xml:lang']);
    const items = asArray(feed['entry'] as Unknown | Unknown[] | undefined)
      .map((entry): FeedItem | null => {
        const url = atomLink(entry) ?? text(entry['id']);
        if (!url || !/^https?:\/\//i.test(url)) return null;
        const summary = text(entry['summary']);
        const content = text(entry['content']) ?? summary;
        const author = text((entry['author'] as Unknown | undefined)?.['name']);
        return {
          url,
          ...(text(entry['title']) ? { title: text(entry['title']) } : {}),
          ...(summary ? { summary } : {}),
          ...(content ? { contentHtml: content } : {}),
          ...(isoDate(entry['published'] ?? entry['updated'])
            ? { publishedAt: isoDate(entry['published'] ?? entry['updated']) }
            : {}),
          ...(author ? { author } : {}),
          ...(language ? { language } : {}),
        };
      })
      .filter((item): item is FeedItem => item !== null);
    return { ...(text(feed['title']) ? { feedTitle: text(feed['title']) } : {}), items };
  }

  throw new Error('Unrecognized feed format (expected RSS 2.0 or Atom)');
}

export class FirstPartyRssProvider implements RSSProvider {
  public readonly id = 'first-party-rss';
  public readonly kind = 'rss' as const;
  public readonly displayName = 'First-party RSS/Atom fetcher';

  constructor(private readonly fetchOptions: SafeFetchOptions = {}) {}

  async fetchFeed(feedUrl: string, _tenant: TenantScope): Promise<FeedItem[]> {
    const response = await safeFetch(feedUrl, this.fetchOptions);
    if (response.status !== 200) {
      throw new Error(`Feed responded with HTTP ${response.status}`);
    }
    return parseFeed(response.body.toString('utf8')).items;
  }

  /** Variant exposing the feed title (used for publisher attribution). */
  async fetchFeedWithMeta(feedUrl: string): Promise<{ feedTitle?: string; items: FeedItem[] }> {
    const response = await safeFetch(feedUrl, this.fetchOptions);
    if (response.status !== 200) {
      throw new Error(`Feed responded with HTTP ${response.status}`);
    }
    return parseFeed(response.body.toString('utf8'));
  }
}
