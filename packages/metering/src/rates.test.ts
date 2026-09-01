import { describe, expect, it } from 'vitest';

import { RATE_VERSION, estimateCostMicros, formatMicros } from './rates';

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

  it('does not confuse a known provider with an unknown model', () => {
    expect(
      estimateCostMicros({ provider: 'anthropic', model: 'not-a-real-model', inputTokens: 10 }),
    ).toBeNull();
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
