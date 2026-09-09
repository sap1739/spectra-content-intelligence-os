/**
 * Cost ESTIMATION rates, and the reasons an operation carries no estimate.
 *
 * These are local, operator-maintained figures used to turn measured usage into
 * an approximate spend. They are NOT vendor invoices and must never be presented
 * as an amount charged.
 *
 * The governing rule (ADR-0028): **unknown cost never silently becomes zero.**
 * Every estimate is either a number with a `rateSource`, or `null` with an
 * explicit `unpricedReason` saying which kind of "no cost" this is:
 * genuinely free, not vendor-billed, nothing measured, or simply not priced.
 * Those are different facts and collapsing them loses real information.
 */

export const RATE_VERSION = 'rates-2026-09-09';

/** Why an operation carries no cost estimate. */
export type UnpricedReason =
  | 'NO_RATE_FOR_MODEL'
  | 'FREE_LOCAL'
  | 'NOT_VENDOR_BILLED'
  | 'NO_MEASURED_QUANTITY'
  | 'COUNTER_ONLY';

/** How much to trust a produced estimate. */
export type RateSource = 'EXACT' | 'FAMILY_FALLBACK_CONSERVATIVE';

export const UNPRICED_REASON_TEXT: Record<UnpricedReason, string> = {
  NO_RATE_FOR_MODEL:
    'No rate is configured for this provider/model, so its spend is not included in cost estimates.',
  FREE_LOCAL: 'Runs locally with no vendor charge.',
  NOT_VENDOR_BILLED: 'Real external work, but not billed per-unit by a vendor.',
  NO_MEASURED_QUANTITY: 'A rate exists, but the provider reported no quantity to price this call.',
  COUNTER_ONLY:
    'Counted for per-operation limits only; its spend is metered on the underlying operations.',
};

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
 * Published list prices at RATE_VERSION, in micros, per provider:model.
 * Update RATE_VERSION whenever these change.
 */
export const TOKEN_RATES: Record<string, TokenRate> = {
  // Anthropic (per 1M tokens): Opus $5 in / $25 out.
  'anthropic:claude-opus-4-8': { inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
  'anthropic:claude-opus-4-7': { inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
  'anthropic:claude-opus-4-6': { inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
  'anthropic:claude-sonnet-5': { inputMicrosPerToken: 3, outputMicrosPerToken: 15 },
  'anthropic:claude-sonnet-4-6': { inputMicrosPerToken: 3, outputMicrosPerToken: 15 },
  'anthropic:claude-haiku-4-5': { inputMicrosPerToken: 1, outputMicrosPerToken: 5 },
  // Voyage embeddings (per 1M tokens).
  'voyage:voyage-3.5': { inputMicrosPerToken: 0.06, outputMicrosPerToken: 0 },
  'voyage:voyage-3.5-lite': { inputMicrosPerToken: 0.02, outputMicrosPerToken: 0 },
  'voyage:voyage-3-large': { inputMicrosPerToken: 0.18, outputMicrosPerToken: 0 },
};

export const REQUEST_RATES: Record<string, RequestRate> = {
  // Brave Search API paid tier: ~$5 per 1000 queries => 5000 micros/query.
  'brave:web-search': { microsPerRequest: 5000 },
  'brave:news-search': { microsPerRequest: 5000 },
};

/**
 * Conservative per-provider fallback, used when a paid provider is configured
 * with a model we have no exact rate for.
 *
 * This exists because of a real defect: `voyage-4` is the repository's DEFAULT
 * embedding model and had no rate entry, so on a default deployment every
 * embedding priced to `null` and contributed NOTHING to a budget ceiling — an
 * entire paid category was invisible to enforcement.
 *
 * We do not have verified list pricing for every future model, and inventing a
 * precise figure would be a different kind of dishonesty. So an unknown model
 * from a known PAID provider is priced at the most expensive rate we know for
 * that provider and flagged `FAMILY_FALLBACK_CONSERVATIVE`: spend is
 * over-stated rather than invisible, and the over-statement is labelled.
 */
export const PROVIDER_FALLBACK_TOKEN_RATES: Record<string, TokenRate> = {
  // Most expensive known Voyage rate (voyage-3-large).
  voyage: { inputMicrosPerToken: 0.18, outputMicrosPerToken: 0 },
  // Most expensive known Anthropic rate (Opus tier).
  anthropic: { inputMicrosPerToken: 5, outputMicrosPerToken: 25 },
};

export const PROVIDER_FALLBACK_REQUEST_RATES: Record<string, RequestRate> = {
  brave: { microsPerRequest: 5000 },
};

/** Providers that are first-party/local and genuinely cost nothing. */
export const FREE_LOCAL_PROVIDERS = new Set(['spectra-local', 'sharp']);

/** Providers that do real external work we are not billed per-unit for. */
export const NOT_VENDOR_BILLED_PROVIDERS = new Set(['first-party']);

/** Kinds that only ever count toward per-operation limits. */
export const COUNTER_ONLY_KINDS = new Set([
  'RESEARCH_RUN',
  'CONTENT_DRAFT',
  'MEDIA_RENDER',
  'PUBLISH_ATTEMPT',
  'DOCUMENT_EXTRACTION',
]);

export interface EstimateInput {
  provider: string;
  model?: string | null;
  kind?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  totalTokens?: number | null;
  requests?: number;
}

export interface EstimateResult {
  /** Null ⇒ no estimate. `unpricedReason` then always says why. */
  micros: number | null;
  rateSource?: RateSource;
  unpricedReason?: UnpricedReason;
}

/**
 * Estimates cost in micros, or explains why it cannot.
 *
 * Never returns `{ micros: 0 }` to mean "unknown" — a zero here asserts the
 * operation genuinely cost nothing.
 */
export function estimateCost(input: EstimateInput): EstimateResult {
  const provider = input.provider;

  if (input.kind !== undefined && COUNTER_ONLY_KINDS.has(input.kind)) {
    return { micros: null, unpricedReason: 'COUNTER_ONLY' };
  }
  if (FREE_LOCAL_PROVIDERS.has(provider)) {
    return { micros: null, unpricedReason: 'FREE_LOCAL' };
  }
  if (NOT_VENDOR_BILLED_PROVIDERS.has(provider)) {
    return { micros: null, unpricedReason: 'NOT_VENDOR_BILLED' };
  }

  const key = `${provider}:${input.model ?? ''}`;
  const exactToken = TOKEN_RATES[key];
  const fallbackToken = PROVIDER_FALLBACK_TOKEN_RATES[provider];
  const tokenRate = exactToken ?? fallbackToken;

  if (tokenRate) {
    // Embedding providers report only a total; charge it at the input rate.
    const inTokens = input.inputTokens ?? input.totalTokens ?? 0;
    const outTokens = input.outputTokens ?? 0;
    if (inTokens === 0 && outTokens === 0) {
      return { micros: null, unpricedReason: 'NO_MEASURED_QUANTITY' };
    }
    return {
      micros: Math.round(
        inTokens * tokenRate.inputMicrosPerToken + outTokens * tokenRate.outputMicrosPerToken,
      ),
      rateSource: exactToken ? 'EXACT' : 'FAMILY_FALLBACK_CONSERVATIVE',
    };
  }

  const exactRequest = REQUEST_RATES[key];
  const fallbackRequest = PROVIDER_FALLBACK_REQUEST_RATES[provider];
  const requestRate = exactRequest ?? fallbackRequest;
  if (requestRate) {
    return {
      micros: Math.round((input.requests ?? 1) * requestRate.microsPerRequest),
      rateSource: exactRequest ? 'EXACT' : 'FAMILY_FALLBACK_CONSERVATIVE',
    };
  }

  return { micros: null, unpricedReason: 'NO_RATE_FOR_MODEL' };
}

/** Back-compatible shim: the micros only. Prefer `estimateCost`. */
export function estimateCostMicros(input: EstimateInput): number | null {
  return estimateCost(input).micros;
}

/** Formats micros as a display string, e.g. 1234567 => "$1.234567". */
export function formatMicros(micros: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${(micros / 1_000_000).toFixed(6)}`;
}
