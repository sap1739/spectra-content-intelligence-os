import { describe, expect, it } from 'vitest';

import { extractClaims, splitSentences } from './claims';

describe('splitSentences', () => {
  it('splits on terminal punctuation and normalizes whitespace', () => {
    expect(splitSentences('One sentence.  Two!   Three? Four')).toEqual([
      'One sentence.',
      'Two!',
      'Three?',
      'Four',
    ]);
  });
});

describe('extractClaims', () => {
  const text =
    'AI testing tools matured this year. Adoption grew 40% in 2026 across large enterprises in India. ' +
    'Vendors will expand agentic capabilities by 2027. The company announced a partnership with three universities. ' +
    'Nice weather today though. Tiny.';

  it('extracts statistic, prediction and factual claims with stable keys', () => {
    const claims = extractClaims(text);
    expect(claims).toHaveLength(3);
    expect(claims[0]).toMatchObject({
      claimType: 'STATISTIC',
      text: 'Adoption grew 40% in 2026 across large enterprises in India.',
    });
    expect(claims[1]?.claimType).toBe('PREDICTION');
    expect(claims[2]?.claimType).toBe('FACTUAL');
    expect(claims[0]?.normalizedKey).toBe(
      'adoption grew 40 in 2026 across large enterprises in india',
    );
  });

  it('is deterministic and deduplicates identical sentences', () => {
    const doubled = `${text} Adoption grew 40% in 2026 across large enterprises in India.`;
    expect(extractClaims(doubled)).toEqual(extractClaims(text));
  });

  it('ignores short, long and marker-free sentences', () => {
    expect(
      extractClaims('Nothing interesting here at all, just plain prose without markers.'),
    ).toEqual([]);
    expect(extractClaims('Grew 40%.')).toEqual([]); // below min length
  });

  it('respects the max cap', () => {
    const many =
      'Revenue grew 10% in Q1 this year overall. Revenue grew 20% in Q2 this year overall. ' +
      'Revenue grew 30% in Q3 this year overall. Revenue grew 40% in Q4 this year overall.';
    expect(extractClaims(many, 2)).toHaveLength(2);
  });
});
