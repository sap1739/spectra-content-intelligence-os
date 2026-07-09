import { describe, expect, it } from 'vitest';

import { validateCitations } from './citations';

describe('validateCitations', () => {
  const sources = ['finding-1', 'citation-1']; // 2 grounded sources → valid range [1..2]

  it('maps supported markers to source ids and flags dangling ones', () => {
    const result = validateCitations('Claim one [1]. Claim two [2]. Fabricated [3].', sources);
    expect(result.markersFound).toBe(3);
    expect(result.distinctMarkers).toEqual([1, 2, 3]);
    expect(result.supportedMarkers).toEqual([1, 2]);
    expect(result.unsupportedMarkers).toEqual([3]);
    expect(result.citedSourceIds).toEqual(['finding-1', 'citation-1']);
    expect(result.allCitedSupported).toBe(false);
  });

  it('is clean when every marker is backed and reports uncited sources', () => {
    const result = validateCitations('Only cites the first source [1].', sources);
    expect(result.allCitedSupported).toBe(true);
    expect(result.unsupportedMarkers).toEqual([]);
    expect(result.uncitedSourceIds).toEqual(['citation-1']);
  });

  it('handles a draft with no markers', () => {
    const result = validateCitations('No citations at all here.', sources);
    expect(result.markersFound).toBe(0);
    expect(result.supportedMarkers).toEqual([]);
    expect(result.allCitedSupported).toBe(true);
    expect(result.uncitedSourceIds).toEqual(sources);
  });

  it('deduplicates repeated markers', () => {
    const result = validateCitations('[1] and again [1] and [2] and [1].', sources);
    expect(result.markersFound).toBe(4);
    expect(result.distinctMarkers).toEqual([1, 2]);
  });

  it('treats every marker as unsupported when nothing was grounded', () => {
    const result = validateCitations('Says [1] but had no sources.', []);
    expect(result.sourceCount).toBe(0);
    expect(result.unsupportedMarkers).toEqual([1]);
    expect(result.allCitedSupported).toBe(false);
  });
});
