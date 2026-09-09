import { describe, expect, it } from 'vitest';

import { normalizeUrl, titleKey, urlHash } from './hashing';

describe('normalizeUrl / urlHash', () => {
  it('strips tracking params and fragments so shares dedupe', () => {
    const a = 'https://Example.com/post?utm_source=x&utm_campaign=y&id=7#section';
    const b = 'https://example.com/post?id=7';
    expect(normalizeUrl(a)).toBe(normalizeUrl(b));
    expect(urlHash(a)).toBe(urlHash(b));
  });

  it('sorts remaining query params deterministically', () => {
    expect(normalizeUrl('https://e.com/p?b=2&a=1')).toBe(normalizeUrl('https://e.com/p?a=1&b=2'));
  });

  it('keeps distinct URLs distinct', () => {
    expect(urlHash('https://e.com/one')).not.toBe(urlHash('https://e.com/two'));
  });
});

describe('titleKey', () => {
  it('normalizes case, punctuation and diacritics', () => {
    expect(titleKey('  AI—Testing: What’s Next?! ')).toBe(titleKey('ai testing what s next'));
  });

  it('preserves Bengali text', () => {
    expect(titleKey('নতুন অ্যালবাম!')).toContain('নতুন');
  });
});

describe('normalizeUrl — 5F canonicalization (ADR-0030)', () => {
  it('collapses http and https of the same page', () => {
    expect(normalizeUrl('http://example.com/a')).toBe(normalizeUrl('https://example.com/a'));
  });

  it('collapses www, m and amp host variants', () => {
    const canonical = normalizeUrl('https://example.com/a');
    expect(normalizeUrl('https://www.example.com/a')).toBe(canonical);
    expect(normalizeUrl('https://m.example.com/a')).toBe(canonical);
    expect(normalizeUrl('https://amp.example.com/a')).toBe(canonical);
  });

  it('collapses AMP and index paths onto the canonical page', () => {
    const canonical = normalizeUrl('https://example.com/story');
    expect(normalizeUrl('https://example.com/story/amp')).toBe(canonical);
    expect(normalizeUrl('https://example.com/story/')).toBe(canonical);
    expect(normalizeUrl('https://example.com/story/index.html')).toBe(canonical);
  });

  it('drops default ports and duplicate slashes', () => {
    expect(normalizeUrl('https://example.com:443//a//b')).toBe(
      normalizeUrl('https://example.com/a/b'),
    );
  });

  it('strips the broadened tracking-param set so one story is one source', () => {
    const canonical = normalizeUrl('https://example.com/a?id=7');
    // The same article from a newsletter, a social share and a search result.
    expect(normalizeUrl('https://example.com/a?id=7&mc_cid=1&utm_source=news')).toBe(canonical);
    expect(normalizeUrl('https://example.com/a?id=7&fbclid=abc&igshid=z')).toBe(canonical);
    expect(normalizeUrl('https://example.com/a?id=7&ref=twitter&spm=x')).toBe(canonical);
  });

  it('keeps meaningful query params', () => {
    expect(normalizeUrl('https://example.com/a?page=2')).toContain('page=2');
  });
});
