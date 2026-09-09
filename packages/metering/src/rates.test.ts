import { describe, expect, it } from 'vitest';

import { RATE_VERSION, estimateCost, estimateCostMicros, formatMicros } from './rates';

describe('estimateCostMicros', () => {
  it('prices generation from separate input and output rates', () => {
    // Opus 4.8: $5/1M in, $25/1M out => 5 and 25 micros per token.
    const micros = estimateCostMicros({
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      inputTokens: 1000,
      outputTokens: 500,
    });
    expect(micros).toBe(1000 * 5 + 500 * 25);
  });

  it('prices embeddings from the reported total at the input rate', () => {
    const micros = estimateCostMicros({
      provider: 'voyage',
      model: 'voyage-3.5',
      totalTokens: 1_000_000,
    });
    expect(micros).toBe(60_000); // $0.06 per 1M tokens
  });

  it('prices search per request', () => {
    expect(estimateCostMicros({ provider: 'brave', model: 'web-search', requests: 3 })).toBe(
      15_000,
    );
  });

  it('returns null for an unknown provider/model rather than zero', () => {
    // Unknown cost must read as unknown — zero would claim it was free.
    expect(estimateCostMicros({ provider: 'mystery', model: 'x', inputTokens: 100 })).toBeNull();
  });

  it('reports NO_MEASURED_QUANTITY distinctly from NO_RATE_FOR_MODEL', () => {
    // Same null micros, different facts — they must not collapse together.
    expect(estimateCost({ provider: 'anthropic', model: 'claude-opus-4-8' }).unpricedReason).toBe(
      'NO_MEASURED_QUANTITY',
    );
    expect(estimateCost({ provider: 'mystery', model: 'x', inputTokens: 1 }).unpricedReason).toBe(
      'NO_RATE_FOR_MODEL',
    );
  });

  it('returns null when nothing was actually measured', () => {
    expect(estimateCostMicros({ provider: 'anthropic', model: 'claude-opus-4-8' })).toBeNull();
    expect(
      estimateCostMicros({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        inputTokens: null,
        outputTokens: null,
      }),
    ).toBeNull();
  });

  it('conservatively prices an unknown model from a KNOWN PAID provider', () => {
    // Behaviour change in 5E.1: this used to return null, which meant an
    // unrecognised model from a provider we definitely pay silently contributed
    // zero to every budget. It is now over-stated at the provider's most
    // expensive known rate and labelled as a fallback.
    const result = estimateCost({
      provider: 'anthropic',
      model: 'not-a-real-model',
      inputTokens: 10,
    });
    expect(result.micros).toBe(50);
    expect(result.rateSource).toBe('FAMILY_FALLBACK_CONSERVATIVE');
  });

  it('still returns null for a provider we have no relationship with', () => {
    const result = estimateCost({ provider: 'mystery', model: 'x', inputTokens: 100 });
    expect(result.micros).toBeNull();
    expect(result.unpricedReason).toBe('NO_RATE_FOR_MODEL');
  });

  it('carries a stable rate version for stored rows', () => {
    expect(RATE_VERSION).toMatch(/^rates-\d{4}-\d{2}-\d{2}$/);
  });
});

describe('formatMicros', () => {
  it('renders micros as a currency amount', () => {
    expect(formatMicros(1_234_567)).toBe('$1.234567');
    expect(formatMicros(0)).toBe('$0.000000');
  });
});
