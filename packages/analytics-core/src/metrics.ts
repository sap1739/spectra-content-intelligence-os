import {
  ANALYTICS_METRIC_DEFINITIONS,
  ANALYTICS_METRIC_KEYS,
  type AnalyticsMetric,
  type AnalyticsMetricCompleteness,
  type AnalyticsMetricKey,
  type AnalyticsSnapshotCompleteness,
  type AnalyticsUnavailableReason,
} from '@spectra/contracts';

/**
 * Building normalized metrics. Every helper here returns either a value or a
 * reason: there is deliberately no way to "default" a metric to 0.
 */

/** Reasons that describe the platform or the adapter, not this fetch. */
const STRUCTURAL_REASONS: ReadonlySet<AnalyticsUnavailableReason> = new Set([
  'NOT_EXPOSED_BY_PLATFORM',
  'DEPRECATED_BY_PLATFORM',
  'NOT_IMPLEMENTED',
  'CONTENT_TYPE_UNSUPPORTED',
  'ACCOUNT_KIND_UNSUPPORTED',
]);

export function isStructuralReason(reason: AnalyticsUnavailableReason): boolean {
  return STRUCTURAL_REASONS.has(reason);
}

const DETAIL_MAX = 500;
const clip = (text: string | null | undefined): string | null =>
  text ? (text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text) : null;

/** A value the platform reported. */
export function measured(
  key: AnalyticsMetricKey,
  value: number,
  options: {
    sourceMetricName: string | null;
    completeness?: Exclude<AnalyticsMetricCompleteness, 'UNAVAILABLE'>;
    detail?: string | null;
  },
): AnalyticsMetric {
  if (!Number.isFinite(value)) {
    return unavailable(key, 'NOT_REPORTED', 'The platform returned a value that is not a number.', {
      sourceMetricName: options.sourceMetricName,
    });
  }
  return {
    key,
    sourceMetricName: options.sourceMetricName,
    value,
    unit: ANALYTICS_METRIC_DEFINITIONS[key].unit,
    completeness: options.completeness ?? 'EXACT',
    unavailableReason: null,
    detail: clip(options.detail),
  };
}

/** No value, and why. */
export function unavailable(
  key: AnalyticsMetricKey,
  reason: AnalyticsUnavailableReason,
  detail: string,
  options: { sourceMetricName?: string | null } = {},
): AnalyticsMetric {
  return {
    key,
    sourceMetricName: options.sourceMetricName ?? null,
    value: null,
    unit: ANALYTICS_METRIC_DEFINITIONS[key].unit,
    completeness: 'UNAVAILABLE',
    unavailableReason: reason,
    detail: clip(detail),
  };
}

/**
 * Reads a count a platform sent. Google sends counts as decimal strings
 * ("1234"); others send numbers. Anything else — absent, null, malformed,
 * negative where negatives are impossible — is NOT a number, and the caller
 * gets null to turn into NOT_REPORTED. Never 0.
 */
export function readCount(raw: unknown, options: { allowNegative?: boolean } = {}): number | null {
  let value: number | null = null;
  if (typeof raw === 'number') value = raw;
  else if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) value = Number(raw);
  if (value === null || !Number.isFinite(value)) return null;
  if (value < 0 && !options.allowNegative) return null;
  return value;
}

/** A reported count, or NOT_REPORTED when the platform left it out. */
export function countOrNotReported(
  key: AnalyticsMetricKey,
  raw: unknown,
  sourceMetricName: string,
  options: {
    completeness?: Exclude<AnalyticsMetricCompleteness, 'UNAVAILABLE'>;
    detail?: string | null;
    allowNegative?: boolean;
  } = {},
): AnalyticsMetric {
  const value = readCount(raw, { allowNegative: options.allowNegative ?? false });
  if (value === null) {
    return unavailable(
      key,
      'NOT_REPORTED',
      `The platform's response did not include ${sourceMetricName}.`,
      { sourceMetricName },
    );
  }
  return measured(key, value, {
    sourceMetricName,
    ...(options.completeness ? { completeness: options.completeness } : {}),
    ...(options.detail !== undefined ? { detail: options.detail } : {}),
  });
}

/** The keys a level carries (followers is account-only). */
export function metricKeysFor(level: 'ACCOUNT' | 'CONTENT'): AnalyticsMetricKey[] {
  return ANALYTICS_METRIC_KEYS.filter((key) =>
    ANALYTICS_METRIC_DEFINITIONS[key].levels.includes(level),
  );
}

export function metricValue(metrics: readonly AnalyticsMetric[], key: AnalyticsMetricKey) {
  return metrics.find((metric) => metric.key === key) ?? null;
}

const available = (metric: AnalyticsMetric | null): metric is AnalyticsMetric & { value: number } =>
  metric !== null && metric.value !== null;

/**
 * Spectra's engagement rate: (reactions or likes) + comments + shares + saves,
 * over impressions — or views where a platform reports no impressions.
 *
 * Computed ONLY when the denominator was reported and is above zero, and at
 * least one interaction count was. When some interaction counts were missing
 * the detail says which were left out, so the rate is read as a lower bound
 * rather than mistaken for the whole picture. Reactions include likes, so the
 * two are never added together.
 */
export function deriveEngagementRate(metrics: readonly AnalyticsMetric[]): AnalyticsMetric {
  const impressions = metricValue(metrics, 'impressions');
  const views = metricValue(metrics, 'views');
  const denominator = available(impressions) ? impressions : available(views) ? views : null;
  if (!denominator) {
    return unavailable(
      'engagementRate',
      'DENOMINATOR_UNKNOWN',
      'Neither impressions nor views were reported, so no engagement rate is calculated.',
    );
  }
  if (denominator.value <= 0) {
    return unavailable(
      'engagementRate',
      'DENOMINATOR_UNKNOWN',
      `${denominator.key} was reported as ${denominator.value}, so a rate is undefined.`,
    );
  }

  const reactions = metricValue(metrics, 'reactions');
  const likes = metricValue(metrics, 'likes');
  const parts: Array<{ label: string; metric: AnalyticsMetric | null }> = [
    {
      label: available(reactions) ? 'reactions' : 'likes',
      metric: available(reactions) ? reactions : likes,
    },
    { label: 'comments', metric: metricValue(metrics, 'comments') },
    { label: 'shares', metric: metricValue(metrics, 'shares') },
    { label: 'saves', metric: metricValue(metrics, 'saves') },
  ];
  const included = parts.filter((part) => available(part.metric));
  if (included.length === 0) {
    return unavailable(
      'engagementRate',
      'NOT_REPORTED',
      'No interaction counts were reported, so no engagement rate is calculated.',
    );
  }
  const numerator = included.reduce((sum, part) => sum + (part.metric?.value ?? 0), 0);
  const missing = parts.filter((part) => !available(part.metric)).map((part) => part.label);
  const approximate = [denominator, ...included.map((part) => part.metric)].some(
    (metric) => metric?.completeness === 'APPROXIMATE',
  );
  return measured('engagementRate', numerator / denominator.value, {
    sourceMetricName: null,
    completeness: 'DERIVED',
    detail: `(${included.map((part) => part.label).join(' + ')}) / ${denominator.key}.${
      missing.length > 0 ? ` Not reported, so not included: ${missing.join(', ')}.` : ''
    }${approximate ? ' Built from approximate platform values.' : ''}`,
  });
}

/** Gaps nobody can act on: the platform simply did not include the value. */
const NOT_ACTIONABLE: ReadonlySet<AnalyticsUnavailableReason> = new Set([
  'DENOMINATOR_UNKNOWN',
  'NOT_REPORTED',
]);

/**
 * COMPLETE: nothing is missing except what the platform or adapter never
 * offers, or what the platform left out of its answer. PARTIAL: at least one
 * metric that could have come back did not for a reason someone can act on or
 * wait out (a scope, an approval, a rate limit, a reporting delay).
 * UNAVAILABLE: not a single value. Every gap is still stored with its reason.
 */
export function snapshotCompleteness(
  metrics: readonly AnalyticsMetric[],
): AnalyticsSnapshotCompleteness {
  if (!metrics.some((metric) => metric.value !== null)) return 'UNAVAILABLE';
  const fixable = metrics.some(
    (metric) =>
      metric.unavailableReason !== null &&
      !isStructuralReason(metric.unavailableReason) &&
      !NOT_ACTIONABLE.has(metric.unavailableReason),
  );
  return fixable ? 'PARTIAL' : 'COMPLETE';
}

/**
 * Guards the contract an adapter must keep: exactly one entry per key the
 * level carries, each either a value or a reason. Throws on a violation — a
 * silently dropped key would later look like "never measured" at best and a
 * zero at worst.
 */
export function assertCompleteMetricSet(
  level: 'ACCOUNT' | 'CONTENT',
  metrics: readonly AnalyticsMetric[],
): void {
  const expected = metricKeysFor(level);
  const seen = new Set<string>();
  for (const metric of metrics) {
    if (seen.has(metric.key)) throw new Error(`Duplicate analytics metric ${metric.key}`);
    seen.add(metric.key);
    if ((metric.value === null) !== (metric.unavailableReason !== null)) {
      throw new Error(`Analytics metric ${metric.key} must be a value or a reason`);
    }
  }
  const missing = expected.filter((key) => !seen.has(key));
  if (missing.length > 0) {
    throw new Error(`Analytics ${level} metrics missing: ${missing.join(', ')}`);
  }
}
