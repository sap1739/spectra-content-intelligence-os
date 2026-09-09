import { DEFAULT_VOYAGE_MODEL } from '@spectra/ai-voyage';
import { apiEnvSchema } from '@spectra/config';
import { describe, expect, it } from 'vitest';

import { COUNTER_ONLY_KINDS, estimateCost, type UnpricedReason } from './rates';

/**
 * Rate-table coverage for the providers this repository actually configures BY
 * DEFAULT.
 *
 * This exists because of a real defect it would have caught: `voyage-4` is the
 * default embedding model and had no rate entry, so every embedding on a
 * default deployment priced to `null` and contributed nothing to any budget
 * ceiling. The previous tests passed because they asserted an explicitly-named
 * model (`voyage-3.5`) rather than the default the repo ships with.
 *
 * The rule under test: a default PAID provider must never silently contribute
 * zero. It resolves either to a real estimate, or to an explicit reason.
 */

/** Defaults read from the repo's own config, not hard-coded here. */
const env = apiEnvSchema.parse({
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_REGION: 'us-east-1',
  STORAGE_ACCESS_KEY: 'k',
  STORAGE_SECRET_KEY: 's',
  STORAGE_BUCKET: 'b',
});

describe('rate coverage for repository defaults', () => {
  it('prices the DEFAULT Anthropic generation model', () => {
    const result = estimateCost({
      provider: 'anthropic',
      model: env.ANTHROPIC_MODEL,
      inputTokens: 1000,
      outputTokens: 100,
    });
    expect(result.micros).not.toBeNull();
    expect(result.micros).toBeGreaterThan(0);
    expect(result.rateSource).toBe('EXACT');
  });

  it('prices the DEFAULT Voyage embedding model — the regression this test exists for', () => {
    const result = estimateCost({
      provider: 'voyage',
      model: env.VOYAGE_EMBEDDING_MODEL,
      totalTokens: 1_000_000,
    });
    // Before 5E.1 this was null: an entire paid category invisible to budgets.
    expect(result.micros).not.toBeNull();
    expect(result.micros).toBeGreaterThan(0);
    expect(result.unpricedReason).toBeUndefined();
  });

  it('agrees with the adapter default as well as the env default', () => {
    // Two sources of "the default" — both must be priced.
    const result = estimateCost({
      provider: 'voyage',
      model: DEFAULT_VOYAGE_MODEL,
      totalTokens: 500_000,
    });
    expect(result.micros).not.toBeNull();
  });

  it('labels a fallback-priced model as conservative rather than exact', () => {
    const result = estimateCost({
      provider: 'voyage',
      model: 'voyage-some-unreleased-model',
      totalTokens: 1_000_000,
    });
    expect(result.micros).not.toBeNull();
    // Over-stated on purpose, and said so — never silently invisible.
    expect(result.rateSource).toBe('FAMILY_FALLBACK_CONSERVATIVE');
  });

  it('prices Brave web search', () => {
    const r = estimateCost({ provider: 'brave', model: 'web-search', requests: 2 });
    expect(r.micros).toBe(10_000);
    expect(r.rateSource).toBe('EXACT');
  });

  it('prices Brave news search', () => {
    const r = estimateCost({ provider: 'brave', model: 'news-search', requests: 1 });
    expect(r.micros).toBe(5_000);
    expect(r.rateSource).toBe('EXACT');
  });

  it('reports the local lexical embedder as FREE_LOCAL, not as zero cost', () => {
    const r = estimateCost({ provider: 'spectra-local', model: 'lexical-hash', totalTokens: 10 });
    expect(r.micros).toBeNull();
    expect(r.unpricedReason).toBe('FREE_LOCAL');
  });

  it('reports first-party page fetches as NOT_VENDOR_BILLED', () => {
    const r = estimateCost({ provider: 'first-party', kind: 'PAGE_FETCH', requests: 1 });
    expect(r.micros).toBeNull();
    expect(r.unpricedReason).toBe('NOT_VENDOR_BILLED');
  });

  it('reports counter-only kinds as COUNTER_ONLY so spend is not double-counted', () => {
    for (const kind of COUNTER_ONLY_KINDS) {
      const r = estimateCost({
        provider: 'anthropic',
        model: 'claude-opus-4-8',
        kind,
        inputTokens: 5,
      });
      expect(r.micros).toBeNull();
      expect(r.unpricedReason).toBe('COUNTER_ONLY');
    }
  });

  it('never returns a null estimate without a reason', () => {
    const cases: Array<Parameters<typeof estimateCost>[0]> = [
      { provider: 'anthropic', model: env.ANTHROPIC_MODEL },
      { provider: 'voyage', model: env.VOYAGE_EMBEDDING_MODEL },
      { provider: 'brave', model: 'web-search' },
      { provider: 'spectra-local', model: 'lexical-hash' },
      { provider: 'first-party' },
      { provider: 'totally-unknown-vendor', model: 'x', inputTokens: 10 },
      { provider: 'anthropic', model: 'claude-opus-4-8', kind: 'RESEARCH_RUN' },
    ];
    for (const input of cases) {
      const r = estimateCost(input);
      if (r.micros === null) {
        expect(r.unpricedReason, `missing reason for ${JSON.stringify(input)}`).toBeDefined();
      } else {
        expect(r.rateSource, `missing rateSource for ${JSON.stringify(input)}`).toBeDefined();
      }
    }
  });

  it('an unknown vendor is NO_RATE_FOR_MODEL — not treated as free', () => {
    const r = estimateCost({ provider: 'mystery-ai', model: 'm1', inputTokens: 1000 });
    expect(r.micros).toBeNull();
    const reason: UnpricedReason | undefined = r.unpricedReason;
    expect(reason).toBe('NO_RATE_FOR_MODEL');
  });
});
