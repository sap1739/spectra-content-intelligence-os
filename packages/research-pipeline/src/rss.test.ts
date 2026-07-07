import { describe, expect, it } from 'vitest';

import { parseFeed } from './rss';

const RSS_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <channel>
    <title>QA Weekly</title>
    <language>en</language>
    <item>
      <title>AI test generation ships in CI pipelines</title>
      <link>https://example.com/articles/ai-test-generation?utm_source=rss</link>
      <description>Short summary &amp; teaser.</description>
      <content:encoded><![CDATA[<p>Full <b>article</b> body about AI testing.</p>]]></content:encoded>
      <pubDate>Mon, 06 Jul 2026 10:00:00 GMT</pubDate>
      <dc:creator>Jane Author</dc:creator>
    </item>
    <item>
      <title>Item without a link is skipped</title>
    </item>
  </channel>
</rss>`;

const ATOM_FIXTURE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="bn">
  <title>Bengali Music Blog</title>
  <entry>
    <title>নতুন অ্যালবাম প্রকাশিত</title>
    <link rel="alternate" href="https://example.org/albums/new-release"/>
    <summary>A new album drops.</summary>
    <published>2026-07-05T08:30:00Z</published>
    <author><name>Blogger</name></author>
  </entry>
</feed>`;

describe('parseFeed', () => {
  it('parses RSS 2.0 with content:encoded, dates and authors', () => {
    const { feedTitle, items } = parseFeed(RSS_FIXTURE);
    expect(feedTitle).toBe('QA Weekly');
    expect(items).toHaveLength(1); // link-less item dropped
    const item = items[0]!;
    expect(item.url).toContain('https://example.com/articles/ai-test-generation');
    expect(item.title).toBe('AI test generation ships in CI pipelines');
    expect(item.contentHtml).toContain('<b>article</b>');
    expect(item.publishedAt).toBe('2026-07-06T10:00:00.000Z');
    expect(item.author).toBe('Jane Author');
    expect(item.language).toBe('en');
  });

  it('parses Atom feeds including non-Latin titles', () => {
    const { feedTitle, items } = parseFeed(ATOM_FIXTURE);
    expect(feedTitle).toBe('Bengali Music Blog');
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe('https://example.org/albums/new-release');
    expect(items[0]!.title).toBe('নতুন অ্যালবাম প্রকাশিত');
    expect(items[0]!.publishedAt).toBe('2026-07-05T08:30:00.000Z');
  });

  it('rejects unrecognized documents', () => {
    expect(() => parseFeed('<html><body>not a feed</body></html>')).toThrow(
      /Unrecognized feed format/,
    );
  });
});
