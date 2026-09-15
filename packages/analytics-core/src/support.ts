import {
  ANALYTICS_METRIC_DEFINITIONS,
  type AnalyticsAggregateMetric,
  type AnalyticsFreshness,
  type AnalyticsMetric,
  type AnalyticsMetricKey,
  type AnalyticsUnavailableReason,
} from '@spectra/contracts';

import type { ProviderMetadata } from './provider';

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/** How long a snapshot is shown as current before it is labelled stale. */
export const DEFAULT_ANALYTICS_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function staleAfterFrom(retrievedAt: Date, staleAfterMs = DEFAULT_ANALYTICS_STALE_AFTER_MS) {
  return new Date(retrievedAt.getTime() + staleAfterMs);
}

/** FRESH / STALE from the snapshot's own timestamps; NEVER_SYNCED when there is none. */
export function freshnessOf(
  snapshot: { retrievedAt: Date; staleAfter: Date; dataAsOf?: Date | null } | null,
  now: Date,
  note: string | null = null,
): AnalyticsFreshness {
  if (!snapshot) {
    return {
      state: 'NEVER_SYNCED',
      retrievedAt: null,
      staleAfter: null,
      dataAsOf: null,
      note: note ?? 'No analytics have been retrieved for this yet.',
    };
  }
  const stale = now.getTime() >= snapshot.staleAfter.getTime();
  return {
    state: stale ? 'STALE' : 'FRESH',
    retrievedAt: snapshot.retrievedAt.toISOString(),
    staleAfter: snapshot.staleAfter.toISOString(),
    dataAsOf: snapshot.dataAsOf ? snapshot.dataAsOf.toISOString() : null,
    note,
  };
}

// ---------------------------------------------------------------------------
// Aggregation (campaign and workspace summaries)
// ---------------------------------------------------------------------------

function mostCommonReason(metrics: readonly AnalyticsMetric[]): AnalyticsUnavailableReason | null {
  const counts = new Map<AnalyticsUnavailableReason, number>();
  for (const metric of metrics) {
    if (metric.unavailableReason) {
      counts.set(metric.unavailableReason, (counts.get(metric.unavailableReason) ?? 0) + 1);
    }
  }
  let best: AnalyticsUnavailableReason | null = null;
  let bestCount = 0;
  for (const [reason, count] of counts) {
    if (count > bestCount) {
      best = reason;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Sums additive metrics across snapshots, counting how many contributed a
 * value and how many could not. A metric no snapshot reported stays null with
 * the most common reason — a workspace with no measured likes shows "not
 * reported", never "0 likes".
 *
 * Non-additive metrics are refused rather than faked: unique reach cannot be
 * summed, nor can averages. Engagement rate is recomputed from the summed
 * interactions and denominators of the snapshots that reported both.
 */
export function aggregateMetrics(
  snapshots: ReadonlyArray<{ metrics: readonly AnalyticsMetric[] }>,
  keys: readonly AnalyticsMetricKey[],
): AnalyticsAggregateMetric[] {
  return keys.map((key) => {
    const definition = ANALYTICS_METRIC_DEFINITIONS[key];
    const values = snapshots
      .map((snapshot) => snapshot.metrics.find((metric) => metric.key === key))
      .filter((metric): metric is AnalyticsMetric => metric !== undefined);
    const present = values.filter((metric) => metric.value !== null);
    const missing = values.filter((metric) => metric.value === null);
    const base = {
      key,
      unit: definition.unit,
      contributing: present.length,
      unavailable: snapshots.length - present.length,
    };

    if (key === 'engagementRate') return aggregateEngagementRate(snapshots, base);

    if (!definition.additive) {
      return {
        ...base,
        contributing: 0,
        value: null,
        completeness: 'UNAVAILABLE' as const,
        unavailableReason: 'NOT_ADDITIVE' as const,
        detail: `${definition.label} cannot be added up across posts or accounts; see each post.`,
      };
    }
    if (present.length === 0) {
      return {
        ...base,
        value: null,
        completeness: 'UNAVAILABLE' as const,
        unavailableReason: mostCommonReason(missing) ?? 'NOT_REPORTED',
        detail:
          snapshots.length === 0
            ? 'No analytics snapshots yet.'
            : `No snapshot reported ${definition.label.toLowerCase()}.`,
      };
    }
    const value = present.reduce((sum, metric) => sum + (metric.value ?? 0), 0);
    const approximate = present.some((metric) => metric.completeness === 'APPROXIMATE');
    return {
      ...base,
      value,
      completeness: approximate ? ('APPROXIMATE' as const) : ('EXACT' as const),
      unavailableReason: null,
      detail:
        base.unavailable > 0
          ? `Sum of ${present.length} of ${snapshots.length} snapshots; ${base.unavailable} did not report it and are not counted as zero.`
          : null,
    };
  });
}

function aggregateEngagementRate(
  snapshots: ReadonlyArray<{ metrics: readonly AnalyticsMetric[] }>,
  base: { key: AnalyticsMetricKey; unit: AnalyticsAggregateMetric['unit'] },
): AnalyticsAggregateMetric {
  let numerator = 0;
  let denominator = 0;
  let contributing = 0;
  for (const snapshot of snapshots) {
    const get = (key: AnalyticsMetricKey) =>
      snapshot.metrics.find((metric) => metric.key === key)?.value ?? null;
    const den = get('impressions') ?? get('views');
    const interactions = [
      get('reactions') ?? get('likes'),
      get('comments'),
      get('shares'),
      get('saves'),
    ];
    if (den === null || den <= 0 || interactions.every((value) => value === null)) continue;
    numerator += interactions.reduce<number>((sum, value) => sum + (value ?? 0), 0);
    denominator += den;
    contributing += 1;
  }
  if (contributing === 0) {
    return {
      ...base,
      value: null,
      completeness: 'UNAVAILABLE',
      contributing: 0,
      unavailable: snapshots.length,
      unavailableReason: 'DENOMINATOR_UNKNOWN',
      detail: 'No snapshot reported both interactions and impressions or views.',
    };
  }
  return {
    ...base,
    value: numerator / denominator,
    completeness: 'DERIVED',
    contributing,
    unavailable: snapshots.length - contributing,
    unavailableReason: null,
    detail: `Interactions over impressions (or views) across the ${contributing} snapshot(s) that reported both.`,
  };
}

// ---------------------------------------------------------------------------
// Provider metadata redaction
// ---------------------------------------------------------------------------

const SAFE_KEY = /^[A-Za-z][A-Za-z0-9_.]{0,63}$/;
const SENSITIVE_KEY =
  /token|secret|password|passwd|authorization|cookie|session|signature|credential|email|phone|url|uri|href|link|address/i;
/** Long unbroken strings look like tokens or signed values; they are not kept. */
const OPAQUE_VALUE = /^[A-Za-z0-9_\-+/=.]{32,}$/;
const MAX_KEYS = 30;
const MAX_STRING = 120;

/**
 * Keeps only small, primitive, obviously harmless provider fields. Anything
 * that could carry a credential, a personal detail or a signed link is dropped
 * — and the whole object is bounded — before it can reach the database.
 */
export function sanitizeProviderMetadata(input: unknown): ProviderMetadata {
  const out: ProviderMetadata = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return out;
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (Object.keys(out).length >= MAX_KEYS) break;
    if (!SAFE_KEY.test(key) || SENSITIVE_KEY.test(key)) continue;
    if (value === null || typeof value === 'boolean') {
      out[key] = value;
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed || trimmed.length > MAX_STRING || OPAQUE_VALUE.test(trimmed)) continue;
      if (/bearer\s|https?:\/\//i.test(trimmed)) continue;
      out[key] = trimmed;
    }
  }
  return out;
}

/** Scrubs a message before it is stored: bounded, single-line, secrets removed. */
export function sanitizeErrorMessage(message: string, secrets: readonly string[] = []): string {
  let text = message;
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('[redacted]');
  }
  text = text
    .replace(/bearer\s+[^\s]+/gi, 'Bearer [redacted]')
    .replace(/access_token=[^&\s]+/gi, 'access_token=[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 500 ? `${text.slice(0, 499)}…` : text;
}

// ---------------------------------------------------------------------------
// Retry backoff
// ---------------------------------------------------------------------------

export const ANALYTICS_RETRY_BASE_MS = 60_000;
export const ANALYTICS_RETRY_MAX_MS = 6 * 60 * 60 * 1000;

/**
 * Exponential backoff for a failed attempt (1-based), never sooner than the
 * platform asked. Deterministic — a retry time can be shown to the operator.
 */
export function analyticsRetryDelayMs(
  attempt: number,
  retryAfterSeconds: number | null,
  options: { baseMs?: number; maxMs?: number } = {},
): number {
  const base = options.baseMs ?? ANALYTICS_RETRY_BASE_MS;
  const max = options.maxMs ?? ANALYTICS_RETRY_MAX_MS;
  const exponential = Math.min(max, base * 2 ** Math.max(0, attempt - 1));
  const asked = retryAfterSeconds !== null ? retryAfterSeconds * 1000 : 0;
  // What the platform asked for wins even past the cap: retrying earlier
  // would only be refused again.
  return Math.max(exponential, asked);
}
