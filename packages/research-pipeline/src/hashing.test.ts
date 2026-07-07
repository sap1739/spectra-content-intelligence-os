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
