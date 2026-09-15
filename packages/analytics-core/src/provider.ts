import {
  type AnalyticsAvailability,
  type AnalyticsErrorCode,
  type AnalyticsMetric,
  type AnalyticsMetricCapability,
  type AnalyticsMetricKey,
  type AnalyticsProviderCapability,
  type AnalyticsUnavailableReason,
  type SocialPlatform,
} from '@spectra/contracts';

import { assertCompleteMetricSet, deriveEngagementRate, unavailable } from './metrics';

/**
 * AnalyticsProvider — the provider-neutral analytics port (ADR-0039).
 *
 * An adapter is built per account at sync time, from that account's own
 * opened token (like publishers). It answers two questions — what it can read
 * (`capability`) and what the platform says now (`fetch*`) — and in both, a
 * metric it cannot give is reported with a reason, never omitted and never 0.
 *
 * Campaign analytics are not a provider call: organic platform APIs have no
 * campaign object, so Spectra sums a campaign's post snapshots itself and
 * labels the result as that sum.
 */

export type ProviderMetadata = Record<string, string | number | boolean | null>;

export interface AnalyticsFetchResult {
  /** One entry per metric key the level carries — value or reason. */
  metrics: AnalyticsMetric[];
  notes: string[];
  /** The last day the platform's data covers, when it reports with a delay. */
  dataAsOf: Date | null;
  /** Allow-listed primitives worth keeping (e.g. `hiddenSubscriberCount`). Redacted again before storage. */
  providerMetadata: ProviderMetadata;
}

export interface AnalyticsContentTarget {
  /** The platform's own id for the post/video, as publishing recorded it. */
  externalContentId: string;
  publishedAt: Date | null;
}

export interface AnalyticsProvider {
  readonly platform: SocialPlatform;
  readonly providerId: string;
  /** What this provider can read for this account and grant. */
  capability(): AnalyticsProviderCapability;
  fetchAccountAnalytics(): Promise<AnalyticsFetchResult>;
  fetchContentAnalytics(target: AnalyticsContentTarget): Promise<AnalyticsFetchResult>;
}

/**
 * A whole-request failure: the platform refused or could not be reached, so
 * nothing from this call can be trusted. Per-metric gaps are NOT errors — they
 * are unavailable metrics in a successful result.
 */
export class AnalyticsProviderError extends Error {
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | null;

  constructor(
    public readonly code: AnalyticsErrorCode,
    message: string,
    options: { retryable?: boolean; retryAfterSeconds?: number | null } = {},
  ) {
    super(message);
    this.name = 'AnalyticsProviderError';
    this.retryable =
      options.retryable ??
      (code === 'RATE_LIMITED' || code === 'TRANSIENT' || code === 'QUOTA_EXCEEDED');
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

// ---------------------------------------------------------------------------
// Declarative metric specs
// ---------------------------------------------------------------------------

/**
 * One metric at one level, as an adapter declares it. Every key a level
 * carries gets a spec — including the ones the platform does not expose — so
 * each "unavailable" is an explicit statement about that platform rather than
 * a gap.
 */
export interface MetricSpec {
  key: AnalyticsMetricKey;
  level: 'ACCOUNT' | 'CONTENT';
  /** The platform's field or metric name. */
  sourceMetricName: string | null;
  /** Scopes that must all be granted to read it. */
  requiredScopes?: readonly string[];
  /** The platform reviews the scope/product before granting it. */
  reviewRequired?: boolean;
  expectedCompleteness?: 'EXACT' | 'APPROXIMATE' | 'DERIVED';
  /** Set = never fetched; the reason and detail are the statement about the platform. */
  unavailable?: { reason: AnalyticsUnavailableReason; detail: string };
  /** A caveat shown even when available (rounding, a definition change). */
  note?: string;
}

export type SpecResolution =
  | { fetch: true; spec: MetricSpec }
  | {
      fetch: false;
      spec: MetricSpec;
      reason: AnalyticsUnavailableReason;
      detail: string;
      availability: AnalyticsAvailability;
    };

function availabilityFor(reason: AnalyticsUnavailableReason): AnalyticsAvailability {
  switch (reason) {
    case 'NOT_IMPLEMENTED':
      return 'NOT_IMPLEMENTED';
    case 'MISSING_SCOPE':
      return 'MISSING_SCOPE';
    case 'APPROVAL_REQUIRED':
      return 'APPROVAL_REQUIRED';
    case 'NOT_CONNECTED':
      return 'NOT_CONNECTED';
    case 'REAUTH_REQUIRED':
      return 'REAUTH_REQUIRED';
    case 'PROVIDER_UNCONFIGURED':
      return 'UNCONFIGURED';
    default:
      return 'UNSUPPORTED';
  }
}

/**
 * Whether a metric can be fetched with this grant. `grantedScopes` null means
 * the platform did not report what it granted: the metric is attempted and the
 * platform's own refusal decides.
 */
export function resolveSpec(
  spec: MetricSpec,
  grantedScopes: readonly string[] | null,
): SpecResolution {
  if (spec.unavailable) {
    return {
      fetch: false,
      spec,
      reason: spec.unavailable.reason,
      detail: spec.unavailable.detail,
      availability: availabilityFor(spec.unavailable.reason),
    };
  }
  const missing =
    grantedScopes === null
      ? []
      : (spec.requiredScopes ?? []).filter((scope) => !grantedScopes.includes(scope));
  if (missing.length > 0) {
    return {
      fetch: false,
      spec,
      reason: 'MISSING_SCOPE',
      detail: `Needs ${missing.join(', ')}, which this connection was not granted${
        spec.reviewRequired ? ' (the platform reviews this permission before granting it)' : ''
      }. Add it to the requested scopes and reconnect.`,
      availability: 'MISSING_SCOPE',
    };
  }
  return { fetch: true, spec };
}

export function specsFor(specs: readonly MetricSpec[], level: 'ACCOUNT' | 'CONTENT') {
  return specs.filter((spec) => spec.level === level);
}

/** Unavailable metrics for every spec at this level that will not be fetched. */
export function unavailableFromSpecs(
  specs: readonly MetricSpec[],
  level: 'ACCOUNT' | 'CONTENT',
  grantedScopes: readonly string[] | null,
): AnalyticsMetric[] {
  return specsFor(specs, level)
    .map((spec) => resolveSpec(spec, grantedScopes))
    .filter(
      (resolution): resolution is Extract<SpecResolution, { fetch: false }> => !resolution.fetch,
    )
    .map((resolution) =>
      unavailable(resolution.spec.key, resolution.reason, resolution.detail, {
        sourceMetricName: resolution.spec.sourceMetricName,
      }),
    );
}

/** Keys that will be fetched at this level with this grant. */
export function fetchableKeys(
  specs: readonly MetricSpec[],
  level: 'ACCOUNT' | 'CONTENT',
  grantedScopes: readonly string[] | null,
): Set<AnalyticsMetricKey> {
  return new Set(
    specsFor(specs, level)
      .filter((spec) => resolveSpec(spec, grantedScopes).fetch)
      .map((spec) => spec.key),
  );
}

/**
 * Closes a fetch: adds Spectra's derived engagement rate when the adapter
 * declared it DERIVED and did not supply one, then checks that every key the
 * level carries is present exactly once.
 */
export function finalizeMetrics(
  specs: readonly MetricSpec[],
  level: 'ACCOUNT' | 'CONTENT',
  metrics: AnalyticsMetric[],
): AnalyticsMetric[] {
  const out = [...metrics];
  const rateSpec = specsFor(specs, level).find((spec) => spec.key === 'engagementRate');
  if (
    rateSpec &&
    !rateSpec.unavailable &&
    rateSpec.expectedCompleteness === 'DERIVED' &&
    !out.some((metric) => metric.key === 'engagementRate')
  ) {
    out.push(deriveEngagementRate(out));
  }
  assertCompleteMetricSet(level, out);
  return out;
}

export interface CapabilityInput {
  platform: SocialPlatform;
  providerId: string;
  providerName: string;
  summary: string;
  implemented: boolean;
  /** Deployment configuration the provider needs is present. */
  configured: boolean;
  specs: readonly MetricSpec[];
  grantedScopes: readonly string[] | null;
  levels: AnalyticsProviderCapability['levels'];
  approval: AnalyticsProviderCapability['approval'];
  freshnessNote: string;
  rateLimitNote: string;
  paidApi: boolean;
  docsUrls: string[];
}

/** A capability record from specs and a grant, with an overall availability. */
export function describeCapability(input: CapabilityInput): AnalyticsProviderCapability {
  const metrics: AnalyticsMetricCapability[] = input.specs.map((spec) => {
    const resolution = resolveSpec(spec, input.grantedScopes);
    const availability: AnalyticsAvailability = !input.configured
      ? 'UNCONFIGURED'
      : resolution.fetch
        ? 'AVAILABLE'
        : resolution.availability;
    return {
      key: spec.key,
      level: spec.level,
      availability,
      sourceMetricName: spec.sourceMetricName,
      requiredScopes: [...(spec.requiredScopes ?? [])],
      expectedCompleteness:
        input.configured && resolution.fetch
          ? (spec.expectedCompleteness ?? 'EXACT')
          : 'UNAVAILABLE',
      reason: !input.configured
        ? `${input.providerName} is not configured on this deployment (OAuth client or credential storage is missing), so nothing can be connected or read.`
        : resolution.fetch
          ? (spec.note ??
            (spec.expectedCompleteness === 'DERIVED'
              ? 'Calculated by Spectra only when the platform reports a denominator.'
              : null))
          : resolution.detail,
      unavailableReason: !input.configured
        ? 'PROVIDER_UNCONFIGURED'
        : resolution.fetch
          ? null
          : resolution.reason,
    };
  });

  const requiredScopes = [...new Set(input.specs.flatMap((spec) => spec.requiredScopes ?? []))];
  let availability: AnalyticsAvailability;
  if (!input.implemented) {
    availability = 'NOT_IMPLEMENTED';
  } else if (!input.configured) {
    availability = 'UNCONFIGURED';
  } else {
    const measurable = metrics.filter((metric) => metric.expectedCompleteness !== 'DERIVED');
    const available = measurable.filter((metric) => metric.availability === 'AVAILABLE');
    const fixable = measurable.filter((metric) =>
      ['MISSING_SCOPE', 'APPROVAL_REQUIRED'].includes(metric.availability),
    );
    if (available.length === 0) {
      availability = fixable.length > 0 ? 'MISSING_SCOPE' : 'UNSUPPORTED';
    } else {
      availability = fixable.length > 0 ? 'PARTIAL' : 'AVAILABLE';
    }
  }

  return {
    platform: input.platform,
    providerId: input.providerId,
    providerName: input.providerName,
    implemented: input.implemented,
    availability,
    summary: input.summary,
    levels: input.levels,
    metrics,
    requiredScopes,
    approval: input.approval,
    freshnessNote: input.freshnessNote,
    rateLimitNote: input.rateLimitNote,
    paidApi: input.paidApi,
    docsUrls: input.docsUrls,
  };
}
