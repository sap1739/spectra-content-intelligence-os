/**
 * Cost ESTIMATION rates.
 *
 * These are local, operator-maintained figures used to turn measured usage into
 * an approximate spend. They are NOT vendor invoices and must never be presented
 * as an amount charged: vendors change prices, apply discounts, bill in tiers,
 * and meter some things we cannot see. Every estimate carries `RATE_VERSION` so
 * a stored row stays interpretable after rates change.
 *
 * A provider/model with no entry yields a NULL estimate — unknown cost is
 * reported as unknown, never as zero.
 */

export const RATE_VERSION = 'rates-2026-08-31';

/** Micros = millionths of a currency unit. $3.00 / 1M tokens => 3 micros/token. */
export interface TokenRate {
  inputMicrosPerToken: number;
  outputMicrosPerToken: number;
}

/** Per-request rate for call-metered APIs (search). */
export interface RequestRate {
  microsPerRequest: number;
}

/**
 * Published list prices at RATE_VERSION, in micros. Sourced from each vendor's
 * public pricing page; update RATE_VERSION whenever these change.
 */
export const TOKEN_RATES: Record<string, TokenRate> = {
  // Anthropic (per 1M tokens): Opus 4.8 $5 in / $25 out.
  'anthropic:claude-opus-4-8': { inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
  'anthropic:claude-opus-4-7': { inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
  'anthropic:claude-opus-4-6': { inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
  'anthropic:claude-sonnet-5': { inputMicrosPerToken: 3, outputMicrosPerToken: 15 },
  'anthropic:claude-sonnet-4-6': { inputMicrosPerToken: 3, outputMicrosPerToken: 15 },
  'anthropic:claude-haiku-4-5': { inputMicrosPerToken: 1, outputMicrosPerToken: 5 },
  // Voyage embeddings (per 1M tokens): voyage-3.5 $0.06, voyage-3-large $0.18.
  'voyage:voyage-3.5': { inputMicrosPerToken: 0.06, outputMicrosPerToken: 0 },
  'voyage:voyage-3.5-lite': { inputMicrosPerToken: 0.02, outputMicrosPerToken: 0 },
  'voyage:voyage-3-large': { inputMicrosPerToken: 0.18, outputMicrosPerToken: 0 },
};

export const REQUEST_RATES: Record<string, RequestRate> = {
  // Brave Search API paid tier: ~$5 per 1000 queries => 5000 micros/query.
  'brave:web-search': { microsPerRequest: 5000 },
  'brave:news-search': { microsPerRequest: 5000 },
};

export interface EstimateInput {
  provider: string;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  requests?: number;
}

/**
 * Estimates cost in micros, or null when no rate is known for this
 * provider/model. Null means "we did not price this", not "it was free".
 */
export function estimateCostMicros(input: EstimateInput): number | null {
  const key = `${input.provider}:${input.model ?? ''}`;
  const tokenRate = TOKEN_RATES[key];
  if (tokenRate) {
    // Embedding providers report only a total; charge it at the input rate.
    const inTokens = input.inputTokens ?? input.totalTokens ?? 0;
    const outTokens = input.outputTokens ?? 0;
    if (inTokens === 0 && outTokens === 0) return null; // nothing measured
    return Math.round(
      inTokens * tokenRate.inputMicrosPerToken + outTokens * tokenRate.outputMicrosPerToken,
    );
  }

  const requestRate = REQUEST_RATES[key];
  if (requestRate) {
    return Math.round((input.requests ?? 1) * requestRate.microsPerRequest);
  }

  return null;
}

/** Formats micros as a display string, e.g. 1234567 => "$1.234567". */
export function formatMicros(micros: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${(micros / 1_000_000).toFixed(6)}`;
}
