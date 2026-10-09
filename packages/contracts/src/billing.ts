import { z } from 'zod';

import { isoDateTimeSchema, uuidSchema } from './common';

/**
 * Billing, plans, credits and entitlements (Phase 8A, ADR-0044).
 *
 * One distinction governs this entire file, and the UI that renders it:
 *
 *   **An estimate is not an invoice.**
 *
 * `UsageEvent.estimatedCostMicros` (ADR-0026) is Spectra's own guess at what a
 * provider will charge. A Stripe invoice is what a customer is actually billed.
 * They are different numbers, from different systems, with different authority,
 * and this codebase never adds them together, never substitutes one for the
 * other, and never labels one as the other.
 *
 * Likewise: a **budget** caps estimated spend; an **entitlement** caps plan
 * usage. A workspace can be inside its budget and out of entitlement, or the
 * reverse, and both answers are reported separately.
 */

// ---------------------------------------------------------------------------
// Plans and prices
// ---------------------------------------------------------------------------

export const BILLING_INTERVALS = ['MONTH', 'YEAR'] as const;
export const billingIntervalSchema = z.enum(BILLING_INTERVALS);
export type BillingInterval = z.infer<typeof billingIntervalSchema>;

/** Where a price lives. Test and live are never mixed (ADR-0044). */
export const BILLING_MODES = ['TEST', 'LIVE'] as const;
export const billingModeSchema = z.enum(BILLING_MODES);
export type BillingMode = z.infer<typeof billingModeSchema>;

export const PLAN_TIERS = ['FREE', 'STARTER', 'GROWTH', 'SCALE', 'ENTERPRISE'] as const;
export const planTierSchema = z.enum(PLAN_TIERS);
export type PlanTier = z.infer<typeof planTierSchema>;

// ---------------------------------------------------------------------------
// Entitlements
// ---------------------------------------------------------------------------

/**
 * What a plan allows. Two shapes, deliberately distinguished:
 *
 *  - **COUNT** limits a standing quantity (workspaces that exist right now).
 *  - **PERIOD** limits a flow per billing period (research runs this month).
 *
 * Enforcing a flow limit against a standing count — or the reverse — is the
 * classic entitlement bug, so the kind is part of the key's definition rather
 * than something each call site decides.
 */
export const ENTITLEMENT_KINDS = ['COUNT', 'PERIOD', 'BYTES', 'INTERVAL'] as const;
export const entitlementKindSchema = z.enum(ENTITLEMENT_KINDS);
export type EntitlementKind = z.infer<typeof entitlementKindSchema>;

export const ENTITLEMENT_KEYS = [
  'WORKSPACE_COUNT',
  'USER_COUNT',
  'CUSTOM_VERTICAL_COUNT',
  'SOCIAL_CONNECTION_COUNT',
  'RESEARCH_RUNS_PER_PERIOD',
  'CONTENT_GENERATIONS_PER_PERIOD',
  'MEDIA_RENDERS_PER_PERIOD',
  'PUBLISHING_ATTEMPTS_PER_PERIOD',
  'STORAGE_BYTES',
  'ANALYTICS_SYNC_MIN_INTERVAL_MINUTES',
] as const;
export const entitlementKeySchema = z.enum(ENTITLEMENT_KEYS);
export type EntitlementKey = z.infer<typeof entitlementKeySchema>;

export interface EntitlementDefinition {
  key: EntitlementKey;
  kind: EntitlementKind;
  label: string;
  /** What exceeding it means for the operator, in their words. */
  description: string;
  /**
   * True when a bigger number is more permissive. False for
   * `ANALYTICS_SYNC_MIN_INTERVAL_MINUTES`, where a *smaller* interval is the
   * better plan — a detail that silently inverts enforcement if ignored.
   */
  higherIsMorePermissive: boolean;
}

export const ENTITLEMENT_DEFINITIONS: Record<EntitlementKey, EntitlementDefinition> = {
  WORKSPACE_COUNT: {
    key: 'WORKSPACE_COUNT',
    kind: 'COUNT',
    label: 'Workspaces',
    description: 'How many workspaces this organization may have at once.',
    higherIsMorePermissive: true,
  },
  USER_COUNT: {
    key: 'USER_COUNT',
    kind: 'COUNT',
    label: 'Members',
    description: 'How many people may belong to this organization at once.',
    higherIsMorePermissive: true,
  },
  CUSTOM_VERTICAL_COUNT: {
    key: 'CUSTOM_VERTICAL_COUNT',
    kind: 'COUNT',
    label: 'Custom verticals',
    description: 'How many custom verticals may exist at once.',
    higherIsMorePermissive: true,
  },
  SOCIAL_CONNECTION_COUNT: {
    key: 'SOCIAL_CONNECTION_COUNT',
    kind: 'COUNT',
    label: 'Connected accounts',
    description: 'How many social accounts may be connected at once.',
    higherIsMorePermissive: true,
  },
  RESEARCH_RUNS_PER_PERIOD: {
    key: 'RESEARCH_RUNS_PER_PERIOD',
    kind: 'PERIOD',
    label: 'Research runs',
    description: 'Research runs that may be started in one billing period.',
    higherIsMorePermissive: true,
  },
  CONTENT_GENERATIONS_PER_PERIOD: {
    key: 'CONTENT_GENERATIONS_PER_PERIOD',
    kind: 'PERIOD',
    label: 'Content generations',
    description: 'Drafts that may be generated in one billing period.',
    higherIsMorePermissive: true,
  },
  MEDIA_RENDERS_PER_PERIOD: {
    key: 'MEDIA_RENDERS_PER_PERIOD',
    kind: 'PERIOD',
    label: 'Media renders',
    description: 'Design, video and audio renders in one billing period.',
    higherIsMorePermissive: true,
  },
  PUBLISHING_ATTEMPTS_PER_PERIOD: {
    key: 'PUBLISHING_ATTEMPTS_PER_PERIOD',
    kind: 'PERIOD',
    label: 'Publishing attempts',
    description: 'Posts that may be sent to a platform in one billing period.',
    higherIsMorePermissive: true,
  },
  STORAGE_BYTES: {
    key: 'STORAGE_BYTES',
    kind: 'BYTES',
    label: 'Storage',
    description: 'Total bytes of stored media and documents.',
    higherIsMorePermissive: true,
  },
  ANALYTICS_SYNC_MIN_INTERVAL_MINUTES: {
    key: 'ANALYTICS_SYNC_MIN_INTERVAL_MINUTES',
    kind: 'INTERVAL',
    label: 'Analytics sync frequency',
    description:
      'The shortest gap allowed between scheduled analytics syncs. A lower number is a more generous plan.',
    higherIsMorePermissive: false,
  },
};

/** `null` means unlimited. Absent means the plan does not grant it at all. */
export const entitlementLimitSchema = z.number().int().nonnegative().nullable();

export const planEntitlementsSchema = z.record(entitlementKeySchema, entitlementLimitSchema);
export type PlanEntitlements = z.infer<typeof planEntitlementsSchema>;

export const planSchema = z.object({
  id: uuidSchema,
  key: z.string().min(1).max(64),
  tier: planTierSchema,
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullish(),
  /** Credits granted at the start of each billing period. */
  monthlyCredits: z.number().int().nonnegative().default(0),
  entitlements: planEntitlementsSchema,
  /** A plan nobody can self-serve onto (enterprise, legacy). */
  selfServe: z.boolean().default(true),
  active: z.boolean().default(true),
  sortOrder: z.number().int().default(0),
});
export type Plan = z.infer<typeof planSchema>;

export const productPriceSchema = z.object({
  id: uuidSchema,
  planId: uuidSchema,
  mode: billingModeSchema,
  /** The provider's price id. An opaque identifier, never payment data. */
  providerPriceId: z.string().min(1).max(200),
  currency: z.string().length(3),
  /** Minor units (cents/paise), as the provider reports them. */
  unitAmount: z.number().int().nonnegative(),
  interval: billingIntervalSchema,
  active: z.boolean().default(true),
});
export type ProductPrice = z.infer<typeof productPriceSchema>;

// ---------------------------------------------------------------------------
// Customers and subscriptions
// ---------------------------------------------------------------------------

export const billingCustomerSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  mode: billingModeSchema,
  /** `cus_…`. Safe to store: an identifier, not an instrument. */
  providerCustomerId: z.string().min(1).max(200),
  /** Billing email as the provider holds it. No card data is ever stored. */
  email: z.string().email().nullish(),
  createdAt: isoDateTimeSchema,
});
export type BillingCustomer = z.infer<typeof billingCustomerSchema>;

/**
 * Mirrors the provider's subscription states. Spectra never invents one, and
 * never infers "active" from a successful checkout — only a webhook, or a
 * direct read from the provider, moves this.
 */
export const SUBSCRIPTION_STATUSES = [
  'INCOMPLETE',
  'INCOMPLETE_EXPIRED',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'CANCELED',
  'UNPAID',
  'PAUSED',
] as const;
export const subscriptionStatusSchema = z.enum(SUBSCRIPTION_STATUSES);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/** The statuses under which a plan's entitlements actually apply. */
export const ENTITLED_SUBSCRIPTION_STATUSES = [
  'TRIALING',
  'ACTIVE',
  // Past due keeps working: dunning is the provider's job, and cutting a
  // customer off the instant a card retries is a support incident, not a
  // control. UNPAID and CANCELED do not.
  'PAST_DUE',
] as const satisfies readonly SubscriptionStatus[];

export const subscriptionSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  planId: uuidSchema,
  mode: billingModeSchema,
  providerSubscriptionId: z.string().min(1).max(200),
  status: subscriptionStatusSchema,
  currentPeriodStart: isoDateTimeSchema.nullish(),
  currentPeriodEnd: isoDateTimeSchema.nullish(),
  cancelAtPeriodEnd: z.boolean().default(false),
  canceledAt: isoDateTimeSchema.nullish(),
  trialEndsAt: isoDateTimeSchema.nullish(),
  /** Set when the last payment failed. Drives the UI's dunning banner. */
  lastPaymentFailedAt: isoDateTimeSchema.nullish(),
  /** The provider's own reason, passed through verbatim. */
  lastPaymentFailureMessage: z.string().max(500).nullish(),
});
export type Subscription = z.infer<typeof subscriptionSchema>;

// ---------------------------------------------------------------------------
// Credits
// ---------------------------------------------------------------------------

/**
 * Where credits came from. The source decides expiry and refundability, so it
 * is recorded rather than flattened into one balance.
 */
export const CREDIT_SOURCES = [
  /** Granted automatically at the start of each billing period. */
  'MONTHLY_ALLOWANCE',
  /** Bought as a one-off top-up. */
  'PURCHASED',
  /** Granted by an operator — a goodwill credit, or an enterprise agreement. */
  'MANUAL',
  /** Returned to the balance because work was refunded or reversed. */
  'REVERSAL',
] as const;
export const creditSourceSchema = z.enum(CREDIT_SOURCES);
export type CreditSource = z.infer<typeof creditSourceSchema>;

/**
 * Expiry is per grant, not per balance. Monthly allowances lapse at the end of
 * their period (use it or lose it); purchased and manual credits persist unless
 * an explicit date is set.
 */
export const CREDIT_EXPIRY_POLICY: Record<CreditSource, 'PERIOD_END' | 'EXPLICIT' | 'NEVER'> = {
  MONTHLY_ALLOWANCE: 'PERIOD_END',
  PURCHASED: 'EXPLICIT',
  MANUAL: 'EXPLICIT',
  REVERSAL: 'EXPLICIT',
};

export const creditGrantSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  source: creditSourceSchema,
  /** Credits granted, in whole credits. Never negative. */
  amount: z.number().int().positive(),
  /** How much of this grant is still unspent. */
  remaining: z.number().int().nonnegative(),
  /** Null means it does not expire. */
  expiresAt: isoDateTimeSchema.nullish(),
  grantedAt: isoDateTimeSchema,
  grantedByUserId: uuidSchema.nullish(),
  /** Why an operator granted it — required for MANUAL. */
  reason: z.string().max(500).nullish(),
  /** The provider invoice or payment this grant was bought with, if any. */
  providerReference: z.string().max(200).nullish(),
});
export type CreditGrant = z.infer<typeof creditGrantSchema>;

export const creditBalanceSchema = z.object({
  organizationId: uuidSchema,
  /** Unexpired, unspent credits across all grants, as of `asOf`. */
  available: z.number().int().nonnegative(),
  /** Credits consumed in the current billing period. */
  consumedThisPeriod: z.number().int().nonnegative(),
  /** Available credits that lapse at the end of this period. */
  expiringAtPeriodEnd: z.number().int().nonnegative(),
  asOf: isoDateTimeSchema,
});
export type CreditBalance = z.infer<typeof creditBalanceSchema>;

/** A movement against the credit ledger. Deductions are negative. */
export const CREDIT_ENTRY_KINDS = ['GRANT', 'CONSUMPTION', 'REVERSAL', 'EXPIRY'] as const;
export const creditEntryKindSchema = z.enum(CREDIT_ENTRY_KINDS);
export type CreditEntryKind = z.infer<typeof creditEntryKindSchema>;

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export const WEBHOOK_PROCESSING_STATUSES = [
  'RECEIVED',
  'PROCESSED',
  /** Verified and stored, but Spectra has no handler — recorded, not dropped. */
  'IGNORED',
  'FAILED',
] as const;
export const webhookProcessingStatusSchema = z.enum(WEBHOOK_PROCESSING_STATUSES);
export type WebhookProcessingStatus = z.infer<typeof webhookProcessingStatusSchema>;

export const billingWebhookEventSchema = z.object({
  id: uuidSchema,
  mode: billingModeSchema,
  /** The provider's own event id — the idempotency key. */
  providerEventId: z.string().min(1).max(200),
  type: z.string().min(1).max(120),
  status: webhookProcessingStatusSchema,
  organizationId: uuidSchema.nullish(),
  receivedAt: isoDateTimeSchema,
  processedAt: isoDateTimeSchema.nullish(),
  /** Bounded, scrubbed. Never the raw payload, which may carry PII. */
  error: z.string().max(500).nullish(),
  attempts: z.number().int().nonnegative().default(0),
});
export type BillingWebhookEvent = z.infer<typeof billingWebhookEventSchema>;

// ---------------------------------------------------------------------------
// Entitlement decisions
// ---------------------------------------------------------------------------

export const ENTITLEMENT_OUTCOMES = [
  'ALLOWED',
  'AT_LIMIT',
  'NOT_IN_PLAN',
  'NO_SUBSCRIPTION',
] as const;
export const entitlementOutcomeSchema = z.enum(ENTITLEMENT_OUTCOMES);
export type EntitlementOutcome = z.infer<typeof entitlementOutcomeSchema>;

export const entitlementDecisionSchema = z.object({
  key: entitlementKeySchema,
  outcome: entitlementOutcomeSchema,
  allowed: z.boolean(),
  /** Null means unlimited. */
  limit: z.number().int().nullable(),
  used: z.number().int().nonnegative(),
  remaining: z.number().int().nullable(),
  /** The plan this decision came from, for the UI's upgrade prompt. */
  planKey: z.string().max(64).nullable(),
  /** Always a sentence an operator can act on. */
  reason: z.string().min(1),
});
export type EntitlementDecision = z.infer<typeof entitlementDecisionSchema>;

// ---------------------------------------------------------------------------
// API inputs
// ---------------------------------------------------------------------------

export const createCheckoutSessionInputSchema = z.object({
  planKey: z.string().min(1).max(64),
  interval: billingIntervalSchema.default('MONTH'),
  /** Where the provider returns the browser. Validated against an allow-list. */
  successPath: z.string().max(200).default('/billing?checkout=success'),
  cancelPath: z.string().max(200).default('/billing?checkout=cancelled'),
});
export type CreateCheckoutSessionInput = z.infer<typeof createCheckoutSessionInputSchema>;

export const grantCreditsInputSchema = z.object({
  amount: z.number().int().positive().max(10_000_000),
  reason: z.string().min(1).max(500),
  expiresAt: isoDateTimeSchema.nullish(),
});
export type GrantCreditsInput = z.infer<typeof grantCreditsInputSchema>;
