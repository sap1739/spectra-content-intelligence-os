import type { BillingInterval, BillingMode, SubscriptionStatus } from '@spectra/contracts';

/**
 * Provider-neutral billing port.
 *
 * Stripe is the implementation (ADR-0044), but nothing above this interface
 * knows that. Two rules the port exists to enforce:
 *
 *  1. **Spectra never holds payment instruments.** No card number, no bank
 *     detail, no token that can move money crosses this boundary — only
 *     opaque provider ids (`cus_…`, `sub_…`, `price_…`) and statuses.
 *  2. **The provider is the authority on subscription state.** Spectra mirrors
 *     it; it never computes it, and never trusts a browser's word for it.
 */

export class BillingProviderError extends Error {
  readonly code: string;
  /** True when retrying could plausibly succeed. */
  readonly retryable: boolean;
  /** HTTP status, when the failure came from the provider's API. */
  readonly status: number | null;

  constructor(
    code: string,
    message: string,
    options: { retryable?: boolean; status?: number | null } = {},
  ) {
    super(message);
    this.name = 'BillingProviderError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? null;
  }
}

export interface BillingProviderCapability {
  available: boolean;
  /** Always a sentence an operator can act on. */
  reason: string;
  providerId: string;
  mode: BillingMode | null;
  /** The env vars that would turn it on, when that is the gap. */
  requiredEnv: string[];
  /** True when webhook signatures can actually be verified. */
  webhooksVerifiable: boolean;
}

export interface EnsureCustomerInput {
  organizationId: string;
  organizationName: string;
  email: string | null;
}

export interface CheckoutSessionInput {
  customerId: string;
  priceId: string;
  organizationId: string;
  successUrl: string;
  cancelUrl: string;
  /** Passed to the provider so the webhook can be attributed to a tenant. */
  metadata: Record<string, string>;
  /** Replayed safely by the provider if the request is retried. */
  idempotencyKey: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

export interface PortalSessionInput {
  customerId: string;
  returnUrl: string;
}

/** A subscription as the provider reports it. Spectra mirrors, never invents. */
export interface ProviderSubscription {
  id: string;
  customerId: string;
  status: SubscriptionStatus;
  priceId: string | null;
  currentPeriodStart: Date | null;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  trialEndsAt: Date | null;
}

/** A verified webhook, after the signature has been checked. */
export interface VerifiedWebhook {
  id: string;
  type: string;
  mode: BillingMode;
  createdAt: Date;
  /** The event's `data.object`, already parsed. */
  object: Record<string, unknown>;
}

export interface BillingProvider {
  readonly id: string;
  capabilities(): BillingProviderCapability;
  ensureCustomer(input: EnsureCustomerInput): Promise<{ customerId: string }>;
  createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession>;
  createPortalSession(input: PortalSessionInput): Promise<{ url: string }>;
  getSubscription(subscriptionId: string): Promise<ProviderSubscription>;
  /**
   * Verifies a webhook's signature against the raw request body.
   *
   * Takes the raw bytes deliberately: a re-serialized JSON body will not match
   * the signature, and accepting a parsed object here would make that mistake
   * easy to introduce later.
   */
  verifyWebhook(rawBody: Buffer, signatureHeader: string, now?: Date): VerifiedWebhook;
}

export const BILLING_INTERVAL_LABEL: Record<BillingInterval, string> = {
  MONTH: 'monthly',
  YEAR: 'yearly',
};
