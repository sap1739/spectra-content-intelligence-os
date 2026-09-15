import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema } from './common';
import { socialPlatformSchema } from './social';

/**
 * External analytics contracts (Phase 6H, ADR-0039).
 *
 * The one rule every schema here enforces: a metric the platform did not give
 * us is UNAVAILABLE, with a reason — never zero. `value: null` always travels
 * with an `unavailableReason`, and a number always travels without one, so the
 * two can never be confused downstream (summaries, trend scoring, the UI).
 *
 * Provider metric names are kept beside the normalized key, so an operator can
 * always see exactly which platform field a number came from.
 */

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Normalized metric keys. A provider maps its own names onto these. */
export const ANALYTICS_METRIC_KEYS = [
  'impressions',
  'reach',
  'views',
  'videoViews',
  'watchTimeMinutes',
  'averageViewDurationSeconds',
  'likes',
  'reactions',
  'comments',
  'shares',
  'saves',
  'clicks',
  'linkClicks',
  'engagementRate',
  'followers',
  'profileVisits',
] as const;
export const analyticsMetricKeySchema = z.enum(ANALYTICS_METRIC_KEYS);
export type AnalyticsMetricKey = z.infer<typeof analyticsMetricKeySchema>;

export const ANALYTICS_METRIC_UNITS = ['COUNT', 'MINUTES', 'SECONDS', 'RATIO'] as const;
export const analyticsMetricUnitSchema = z.enum(ANALYTICS_METRIC_UNITS);
export type AnalyticsMetricUnit = z.infer<typeof analyticsMetricUnitSchema>;

/** What an analytics row describes. CAMPAIGN and WORKSPACE are Spectra aggregates. */
export const ANALYTICS_LEVELS = ['ACCOUNT', 'CONTENT', 'CAMPAIGN', 'WORKSPACE'] as const;
export const analyticsLevelSchema = z.enum(ANALYTICS_LEVELS);
export type AnalyticsLevel = z.infer<typeof analyticsLevelSchema>;

/**
 * How far one metric value can be trusted.
 * EXACT — the platform's own count, as reported.
 * APPROXIMATE — the platform documents it as rounded, estimated, best-effort or
 *   still in development (YouTube subscriber counts, Meta "estimated" metrics).
 * DERIVED — computed by Spectra from platform values with a known denominator.
 * UNAVAILABLE — no value; `unavailableReason` says why.
 */
export const ANALYTICS_METRIC_COMPLETENESS = [
  'EXACT',
  'APPROXIMATE',
  'DERIVED',
  'UNAVAILABLE',
] as const;
export const analyticsMetricCompletenessSchema = z.enum(ANALYTICS_METRIC_COMPLETENESS);
export type AnalyticsMetricCompleteness = z.infer<typeof analyticsMetricCompletenessSchema>;

/** Whether a snapshot carries everything its provider could have given. */
export const ANALYTICS_SNAPSHOT_COMPLETENESS = ['COMPLETE', 'PARTIAL', 'UNAVAILABLE'] as const;
export const analyticsSnapshotCompletenessSchema = z.enum(ANALYTICS_SNAPSHOT_COMPLETENESS);
export type AnalyticsSnapshotCompleteness = z.infer<typeof analyticsSnapshotCompletenessSchema>;

/** Why a metric has no value. Stored beside the null — never inferred later. */
export const ANALYTICS_UNAVAILABLE_REASONS = [
  /** The platform's API has no such metric for this object. */
  'NOT_EXPOSED_BY_PLATFORM',
  /** The platform removed it (e.g. Meta's post_impressions above Graph v25). */
  'DEPRECATED_BY_PLATFORM',
  /** The platform exposes it; Spectra's adapter does not read it yet. */
  'NOT_IMPLEMENTED',
  /** Needs a scope this connection was not granted. */
  'MISSING_SCOPE',
  /** Needs a product or permission the platform reviews first. */
  'APPROVAL_REQUIRED',
  /** This deployment has no configuration for the provider. */
  'PROVIDER_UNCONFIGURED',
  'NOT_CONNECTED',
  'REAUTH_REQUIRED',
  /** The platform does not report analytics for this kind of account. */
  'ACCOUNT_KIND_UNSUPPORTED',
  /** Not published (yet), or published without a platform id to ask about. */
  'CONTENT_NOT_PUBLISHED',
  /** The platform does not report this metric for this kind of post. */
  'CONTENT_TYPE_UNSUPPORTED',
  /** Older than the platform keeps analytics for. */
  'OUTSIDE_RETENTION_WINDOW',
  /** The platform reports it with a delay; not in yet. */
  'NOT_YET_AVAILABLE',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'PROVIDER_ERROR',
  /** A rate whose denominator the platform did not give us. */
  'DENOMINATOR_UNKNOWN',
  /** Summing it across posts would be wrong (unique reach, averages, rates). */
  'NOT_ADDITIVE',
  'BUDGET_BLOCKED',
  /** The platform answered but left this field out. */
  'NOT_REPORTED',
] as const;
export const analyticsUnavailableReasonSchema = z.enum(ANALYTICS_UNAVAILABLE_REASONS);
export type AnalyticsUnavailableReason = z.infer<typeof analyticsUnavailableReasonSchema>;

/** A provider's availability for one account (or one metric on it). */
export const ANALYTICS_AVAILABILITY = [
  'AVAILABLE',
  /** Some metrics work, others need scopes, approval or are not exposed. */
  'PARTIAL',
  'MISSING_SCOPE',
  'APPROVAL_REQUIRED',
  'NOT_CONNECTED',
  'REAUTH_REQUIRED',
  'UNCONFIGURED',
  'NOT_IMPLEMENTED',
  'UNSUPPORTED',
] as const;
export const analyticsAvailabilitySchema = z.enum(ANALYTICS_AVAILABILITY);
export type AnalyticsAvailability = z.infer<typeof analyticsAvailabilitySchema>;

export const ANALYTICS_SYNC_STATUSES = [
  'QUEUED',
  'RUNNING',
  /** Every fetchable target returned what its provider could give. */
  'SUCCEEDED',
  /** Some targets or metrics came back, others did not. */
  'PARTIAL',
  'FAILED',
  /** Nothing to fetch: no provider is implemented, configured or connected. A no-op, said plainly. */
  'UNAVAILABLE',
] as const;
export const analyticsSyncStatusSchema = z.enum(ANALYTICS_SYNC_STATUSES);
export type AnalyticsSyncStatus = z.infer<typeof analyticsSyncStatusSchema>;

export const ANALYTICS_SYNC_TRIGGERS = ['MANUAL', 'SCHEDULED'] as const;
export const analyticsSyncTriggerSchema = z.enum(ANALYTICS_SYNC_TRIGGERS);
export type AnalyticsSyncTrigger = z.infer<typeof analyticsSyncTriggerSchema>;

export const ANALYTICS_SYNC_TARGETS = ['WORKSPACE', 'SOCIAL_ACCOUNT', 'SCHEDULE_ENTRY'] as const;
export const analyticsSyncTargetSchema = z.enum(ANALYTICS_SYNC_TARGETS);
export type AnalyticsSyncTarget = z.infer<typeof analyticsSyncTargetSchema>;

/** The outcome for one account or post inside a sync run. */
export const ANALYTICS_TARGET_OUTCOMES = [
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'UNAVAILABLE',
  'SKIPPED',
] as const;
export const analyticsTargetOutcomeSchema = z.enum(ANALYTICS_TARGET_OUTCOMES);
export type AnalyticsTargetOutcome = z.infer<typeof analyticsTargetOutcomeSchema>;

export const ANALYTICS_ERROR_CODES = [
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'REAUTH_REQUIRED',
  'MISSING_SCOPE',
  'APPROVAL_REQUIRED',
  'NOT_FOUND',
  'TRANSIENT',
  'PROVIDER_ERROR',
  'UNSUPPORTED',
  'UNCONFIGURED',
  'NOT_CONNECTED',
  'BUDGET',
  'VALIDATION',
] as const;
export const analyticsErrorCodeSchema = z.enum(ANALYTICS_ERROR_CODES);
export type AnalyticsErrorCode = z.infer<typeof analyticsErrorCodeSchema>;

export const ANALYTICS_FRESHNESS_STATES = ['FRESH', 'STALE', 'NEVER_SYNCED'] as const;
export const analyticsFreshnessStateSchema = z.enum(ANALYTICS_FRESHNESS_STATES);
export type AnalyticsFreshnessState = z.infer<typeof analyticsFreshnessStateSchema>;

/**
 * Where a signal came from. Kept on trend-score components and on every
 * analytics surface, so an estimate is never presented as a measurement.
 */
export const ANALYTICS_SIGNAL_SOURCES = [
  /** Inferred from research (e.g. engagementPotential). Not measured. */
  'ESTIMATED',
  /** Counted by Spectra from its own records (content funnel, publications). */
  'FIRST_PARTY_MEASURED',
  /** Reported by a platform's analytics API. */
  'EXTERNAL_MEASURED',
  /** No signal exists; the reason says why. */
  'UNAVAILABLE',
] as const;
export const analyticsSignalSourceSchema = z.enum(ANALYTICS_SIGNAL_SOURCES);
export type AnalyticsSignalSource = z.infer<typeof analyticsSignalSourceSchema>;

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

export const analyticsMetricDefinitionSchema = z.object({
  key: analyticsMetricKeySchema,
  label: z.string().min(1).max(80),
  unit: analyticsMetricUnitSchema,
  description: z.string().max(500),
  /** Summing it across posts or accounts means something. */
  additive: z.boolean(),
  levels: z.array(analyticsLevelSchema).min(1),
});
export type AnalyticsMetricDefinition = z.infer<typeof analyticsMetricDefinitionSchema>;

const definition = (
  key: AnalyticsMetricKey,
  label: string,
  unit: AnalyticsMetricUnit,
  description: string,
  additive: boolean,
  levels: AnalyticsLevel[],
): AnalyticsMetricDefinition => ({ key, label, unit, description, additive, levels });

const POST_AND_ACCOUNT: AnalyticsLevel[] = ['ACCOUNT', 'CONTENT'];

/** The normalized catalog. Descriptions say what the key MEANS, not how a platform computes it. */
export const ANALYTICS_METRIC_DEFINITIONS: Readonly<
  Record<AnalyticsMetricKey, AnalyticsMetricDefinition>
> = {
  impressions: definition(
    'impressions',
    'Impressions',
    'COUNT',
    'Times the content was shown. The same person can count more than once.',
    true,
    POST_AND_ACCOUNT,
  ),
  reach: definition(
    'reach',
    'Reach',
    'COUNT',
    'Distinct people (or accounts) the content was shown to. Not additive: one person reached by two posts is one person.',
    false,
    POST_AND_ACCOUNT,
  ),
  views: definition(
    'views',
    'Views',
    'COUNT',
    'Views as the platform counts them. Platforms define a view differently; the source metric name says which definition applies.',
    true,
    POST_AND_ACCOUNT,
  ),
  videoViews: definition(
    'videoViews',
    'Video views',
    'COUNT',
    'Video plays meeting the platform’s own view threshold.',
    true,
    POST_AND_ACCOUNT,
  ),
  watchTimeMinutes: definition(
    'watchTimeMinutes',
    'Watch time',
    'MINUTES',
    'Minutes people spent watching.',
    true,
    POST_AND_ACCOUNT,
  ),
  averageViewDurationSeconds: definition(
    'averageViewDurationSeconds',
    'Average view duration',
    'SECONDS',
    'Average length of a playback, in seconds. Not additive.',
    false,
    POST_AND_ACCOUNT,
  ),
  likes: definition('likes', 'Likes', 'COUNT', 'Likes on the content.', true, POST_AND_ACCOUNT),
  reactions: definition(
    'reactions',
    'Reactions',
    'COUNT',
    'All reaction types together, where the platform has more than a like.',
    true,
    POST_AND_ACCOUNT,
  ),
  comments: definition(
    'comments',
    'Comments',
    'COUNT',
    'Comments on the content. Counts only — comment text is not ingested.',
    true,
    POST_AND_ACCOUNT,
  ),
  shares: definition(
    'shares',
    'Shares',
    'COUNT',
    'Shares, reposts or reshares.',
    true,
    POST_AND_ACCOUNT,
  ),
  saves: definition('saves', 'Saves', 'COUNT', 'Times the content was saved.', true, [
    'ACCOUNT',
    'CONTENT',
  ]),
  clicks: definition(
    'clicks',
    'Clicks',
    'COUNT',
    'Clicks anywhere on the content.',
    true,
    POST_AND_ACCOUNT,
  ),
  linkClicks: definition(
    'linkClicks',
    'Link clicks',
    'COUNT',
    'Clicks on a link in the content.',
    true,
    POST_AND_ACCOUNT,
  ),
  engagementRate: definition(
    'engagementRate',
    'Engagement rate',
    'RATIO',
    'Interactions divided by impressions (or views). Only ever computed when the denominator is known; not additive.',
    false,
    POST_AND_ACCOUNT,
  ),
  followers: definition(
    'followers',
    'Followers',
    'COUNT',
    'Followers or subscribers of the account at retrieval time.',
    true,
    ['ACCOUNT'],
  ),
  profileVisits: definition(
    'profileVisits',
    'Profile visits',
    'COUNT',
    'Visits to the account profile driven by the content.',
    true,
    POST_AND_ACCOUNT,
  ),
};

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * One metric value. `value` null ⇔ `unavailableReason` set ⇔ completeness
 * UNAVAILABLE. A zero is a real zero the platform reported.
 */
export const analyticsMetricSchema = z
  .object({
    key: analyticsMetricKeySchema,
    /** The platform's own field name (e.g. `statistics.viewCount`), when there is one. */
    sourceMetricName: z.string().max(200).nullable(),
    value: z.number().finite().nullable(),
    unit: analyticsMetricUnitSchema,
    completeness: analyticsMetricCompletenessSchema,
    unavailableReason: analyticsUnavailableReasonSchema.nullable(),
    /** Why, in words, for the operator — a scope name, a deprecation, a retention window. */
    detail: z.string().max(500).nullable(),
  })
  .superRefine((metric, ctx) => {
    const missing = metric.value === null;
    if (missing !== (metric.unavailableReason !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A metric is either a value or an unavailable reason — never both, never neither.',
      });
    }
    if (missing !== (metric.completeness === 'UNAVAILABLE')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'completeness must be UNAVAILABLE exactly when value is null.',
      });
    }
  });
export type AnalyticsMetric = z.infer<typeof analyticsMetricSchema>;

export const analyticsRateLimitSchema = z.object({
  limited: z.boolean(),
  /** Seconds the platform asked us to wait, when it said. */
  retryAfterSeconds: z.number().int().min(0).nullable(),
  /** When Spectra will try again (backoff), when a retry is scheduled. */
  nextAttemptAt: isoDateTimeSchema.nullable(),
  note: z.string().max(500).nullable(),
});
export type AnalyticsRateLimit = z.infer<typeof analyticsRateLimitSchema>;

export const analyticsFreshnessSchema = z.object({
  state: analyticsFreshnessStateSchema,
  /** When Spectra last asked the platform. */
  retrievedAt: isoDateTimeSchema.nullable(),
  /** After this, the numbers are labelled stale. */
  staleAfter: isoDateTimeSchema.nullable(),
  /** The last day the platform's data covers, when it reports with a delay. */
  dataAsOf: isoDateTimeSchema.nullable(),
  note: z.string().max(500).nullable(),
});
export type AnalyticsFreshness = z.infer<typeof analyticsFreshnessSchema>;

export const analyticsErrorSchema = z.object({
  code: analyticsErrorCodeSchema,
  message: z.string().max(1000),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().min(0).nullable(),
});
export type AnalyticsError = z.infer<typeof analyticsErrorSchema>;

// ---------------------------------------------------------------------------
// What analytics are about
// ---------------------------------------------------------------------------

export const analyticsConnectionSchema = z.object({
  connectionId: uuidSchema.nullable(),
  platform: socialPlatformSchema,
  /** null = the platform did not report granted scopes (unknown, not none). */
  grantedScopes: z.array(z.string()).nullable(),
  status: z.string().max(40),
});
export type AnalyticsConnection = z.infer<typeof analyticsConnectionSchema>;

export const analyticsAccountSchema = z.object({
  socialAccountId: uuidSchema,
  platform: socialPlatformSchema,
  kind: z.string().max(40),
  externalAccountId: z.string().max(300),
  displayName: z.string().max(300),
});
export type AnalyticsAccount = z.infer<typeof analyticsAccountSchema>;

export const analyticsContentRefSchema = z.object({
  scheduleEntryId: uuidSchema,
  contentItemId: uuidSchema,
  campaignId: uuidSchema.nullable(),
  platform: socialPlatformSchema,
  /** The platform's own post/video/pin id, as publishing recorded it. */
  externalContentId: z.string().max(300),
  publishedAt: isoDateTimeSchema.nullable(),
});
export type AnalyticsContentRef = z.infer<typeof analyticsContentRefSchema>;

/** Which Spectra objects a snapshot belongs to. */
export const analyticsAttributionSchema = z.object({
  platform: socialPlatformSchema,
  socialAccountId: uuidSchema.nullable(),
  externalAccountId: z.string().max(300).nullable(),
  scheduleEntryId: uuidSchema.nullable(),
  contentItemId: uuidSchema.nullable(),
  campaignId: uuidSchema.nullable(),
  externalContentId: z.string().max(300).nullable(),
  publishedAt: isoDateTimeSchema.nullable(),
});
export type AnalyticsAttribution = z.infer<typeof analyticsAttributionSchema>;

// ---------------------------------------------------------------------------
// Provider capability
// ---------------------------------------------------------------------------

export const analyticsLevelSupportSchema = z.object({
  supported: z.boolean(),
  reason: z.string().max(500),
});

export const analyticsMetricCapabilitySchema = z.object({
  key: analyticsMetricKeySchema,
  level: analyticsLevelSchema,
  availability: analyticsAvailabilitySchema,
  sourceMetricName: z.string().max(200).nullable(),
  requiredScopes: z.array(z.string()),
  /** What a returned value will be: EXACT or APPROXIMATE (or DERIVED). */
  expectedCompleteness: analyticsMetricCompletenessSchema,
  /** Set whenever availability is not AVAILABLE, or the value is approximate. */
  reason: z.string().max(500).nullable(),
  unavailableReason: analyticsUnavailableReasonSchema.nullable(),
});
export type AnalyticsMetricCapability = z.infer<typeof analyticsMetricCapabilitySchema>;

export const analyticsProviderCapabilitySchema = z.object({
  platform: socialPlatformSchema,
  providerId: z.string().min(1).max(80),
  providerName: z.string().min(1).max(120),
  /** A real adapter exists in this codebase. */
  implemented: z.boolean(),
  availability: analyticsAvailabilitySchema,
  summary: z.string().max(1000),
  levels: z.object({
    account: analyticsLevelSupportSchema,
    content: analyticsLevelSupportSchema,
    campaign: analyticsLevelSupportSchema,
    comments: analyticsLevelSupportSchema,
  }),
  metrics: z.array(analyticsMetricCapabilitySchema),
  requiredScopes: z.array(z.string()),
  approval: z.object({ required: z.boolean(), notes: z.array(z.string().max(1000)) }),
  freshnessNote: z.string().max(1000),
  rateLimitNote: z.string().max(1000),
  /** Does the provider cost money per call (budget pre-flight applies)? */
  paidApi: z.boolean(),
  docsUrls: z.array(z.string().url()),
});
export type AnalyticsProviderCapability = z.infer<typeof analyticsProviderCapabilitySchema>;

// ---------------------------------------------------------------------------
// Snapshots, sync runs and normalized views
// ---------------------------------------------------------------------------

export const analyticsSnapshotSchema = z.object({
  id: uuidSchema,
  level: z.enum(['ACCOUNT', 'CONTENT']),
  providerId: z.string().max(80),
  attribution: analyticsAttributionSchema,
  completeness: analyticsSnapshotCompletenessSchema,
  retrievedAt: isoDateTimeSchema,
  freshness: analyticsFreshnessSchema,
  metrics: z.array(analyticsMetricSchema),
  notes: z.array(z.string().max(1000)),
  syncRunId: uuidSchema.nullable(),
});
export type AnalyticsSnapshot = z.infer<typeof analyticsSnapshotSchema>;

export const analyticsTargetResultSchema = z.object({
  level: z.enum(['ACCOUNT', 'CONTENT']),
  platform: socialPlatformSchema,
  socialAccountId: uuidSchema.nullable(),
  scheduleEntryId: uuidSchema.nullable(),
  outcome: analyticsTargetOutcomeSchema,
  errorCode: analyticsErrorCodeSchema.nullable(),
  message: z.string().max(1000).nullable(),
  snapshotId: uuidSchema.nullable(),
});
export type AnalyticsTargetResult = z.infer<typeof analyticsTargetResultSchema>;

export const analyticsSyncRunSchema = z.object({
  id: uuidSchema,
  trigger: analyticsSyncTriggerSchema,
  target: analyticsSyncTargetSchema,
  socialAccountId: uuidSchema.nullable(),
  scheduleEntryId: uuidSchema.nullable(),
  status: analyticsSyncStatusSchema,
  attempt: z.number().int().min(0),
  maxAttempts: z.number().int().min(1),
  counts: z.object({
    succeeded: z.number().int().min(0),
    partial: z.number().int().min(0),
    failed: z.number().int().min(0),
    unavailable: z.number().int().min(0),
  }),
  error: analyticsErrorSchema.nullable(),
  rateLimit: analyticsRateLimitSchema.nullable(),
  results: z.array(analyticsTargetResultSchema),
  createdAt: isoDateTimeSchema,
  startedAt: isoDateTimeSchema.nullable(),
  finishedAt: isoDateTimeSchema.nullable(),
});
export type AnalyticsSyncRun = z.infer<typeof analyticsSyncRunSchema>;

/** A sum or recomputation over snapshots — with how many contributed and how many could not. */
export const analyticsAggregateMetricSchema = z.object({
  key: analyticsMetricKeySchema,
  unit: analyticsMetricUnitSchema,
  /** null when no snapshot reported it, or it cannot be aggregated. Never a stand-in zero. */
  value: z.number().finite().nullable(),
  completeness: analyticsMetricCompletenessSchema,
  contributing: z.number().int().min(0),
  unavailable: z.number().int().min(0),
  unavailableReason: analyticsUnavailableReasonSchema.nullable(),
  detail: z.string().max(500).nullable(),
});
export type AnalyticsAggregateMetric = z.infer<typeof analyticsAggregateMetricSchema>;

export const normalizedContentAnalyticsSchema = z.object({
  source: z.literal('EXTERNAL_MEASURED'),
  attribution: analyticsAttributionSchema,
  snapshotId: uuidSchema,
  completeness: analyticsSnapshotCompletenessSchema,
  freshness: analyticsFreshnessSchema,
  metrics: z.array(analyticsMetricSchema),
  notes: z.array(z.string()),
});
export type NormalizedContentAnalytics = z.infer<typeof normalizedContentAnalyticsSchema>;

export const normalizedAccountAnalyticsSchema = z.object({
  source: z.literal('EXTERNAL_MEASURED'),
  account: analyticsAccountSchema,
  snapshotId: uuidSchema.nullable(),
  completeness: analyticsSnapshotCompletenessSchema,
  freshness: analyticsFreshnessSchema,
  metrics: z.array(analyticsMetricSchema),
  notes: z.array(z.string()),
});
export type NormalizedAccountAnalytics = z.infer<typeof normalizedAccountAnalyticsSchema>;

export const normalizedCampaignAnalyticsSchema = z.object({
  source: z.literal('EXTERNAL_MEASURED'),
  campaignId: uuidSchema,
  /** Platforms' organic APIs have no campaign object; this is Spectra's sum over the campaign's posts. */
  aggregation: z.literal('SUM_OF_POST_SNAPSHOTS'),
  publishedPosts: z.number().int().min(0),
  postsWithAnalytics: z.number().int().min(0),
  postsWithoutAnalytics: z.number().int().min(0),
  metrics: z.array(analyticsAggregateMetricSchema),
  freshness: analyticsFreshnessSchema,
});
export type NormalizedCampaignAnalytics = z.infer<typeof normalizedCampaignAnalyticsSchema>;

// ---------------------------------------------------------------------------
// API input
// ---------------------------------------------------------------------------

export const analyticsSyncRequestSchema = z.discriminatedUnion('target', [
  z.object({ target: z.literal('WORKSPACE') }).strict(),
  z.object({ target: z.literal('SOCIAL_ACCOUNT'), socialAccountId: uuidSchema }).strict(),
  z.object({ target: z.literal('SCHEDULE_ENTRY'), scheduleEntryId: uuidSchema }).strict(),
]);
export type AnalyticsSyncRequest = z.infer<typeof analyticsSyncRequestSchema>;
