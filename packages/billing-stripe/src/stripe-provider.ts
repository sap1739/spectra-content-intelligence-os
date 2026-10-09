import {
  BillingProviderError,
  type BillingProvider,
  type BillingProviderCapability,
  type CheckoutSession,
  type CheckoutSessionInput,
  type EnsureCustomerInput,
  type PortalSessionInput,
  type ProviderSubscription,
  type VerifiedWebhook,
} from '@spectra/billing-core';
import type { BillingMode, SubscriptionStatus } from '@spectra/contracts';

import { WebhookSignatureError, verifyStripeSignature } from './signature';

/**
 * Stripe Billing adapter.
 *
 * Talks to Stripe's REST API directly with `fetch` and form encoding — the
 * surface Spectra needs is six calls, and a direct implementation keeps the
 * request shapes visible and testable against a local stand-in.
 *
 * **No payment instrument is ever handled here.** Card entry happens on
 * Stripe's own Checkout and Portal pages; this adapter only ever sees
 * identifiers (`cus_…`, `sub_…`) and statuses.
 */

export interface StripeOptions {
  secretKey: string | null;
  webhookSecret: string | null;
  /** Overridable for tests; defaults to Stripe's API. */
  baseUrl?: string;
  apiVersion?: string;
  timeoutMs?: number;
  /** Seconds a webhook signature stays valid. */
  toleranceSeconds?: number;
}

/**
 * Stripe keys carry their mode. `sk_test_…` and `sk_live_…` are different
 * worlds, and conflating them is how test subscriptions end up entitling real
 * customers — so the mode is derived from the key, never configured
 * separately where the two could disagree.
 */
export function modeFromKey(secretKey: string | null): BillingMode | null {
  if (!secretKey) return null;
  if (secretKey.startsWith('sk_live_') || secretKey.startsWith('rk_live_')) return 'LIVE';
  if (secretKey.startsWith('sk_test_') || secretKey.startsWith('rk_test_')) return 'TEST';
  return null;
}

/** Stripe's subscription states → Spectra's enum. Unknown states are not guessed. */
const STATUS_MAP: Record<string, SubscriptionStatus> = {
  incomplete: 'INCOMPLETE',
  incomplete_expired: 'INCOMPLETE_EXPIRED',
  trialing: 'TRIALING',
  active: 'ACTIVE',
  past_due: 'PAST_DUE',
  canceled: 'CANCELED',
  unpaid: 'UNPAID',
  paused: 'PAUSED',
};

export function mapSubscriptionStatus(raw: unknown): SubscriptionStatus {
  const status = typeof raw === 'string' ? STATUS_MAP[raw] : undefined;
  if (!status) {
    // Fail closed: an unrecognised state must not read as entitled.
    throw new BillingProviderError(
      'UNKNOWN_SUBSCRIPTION_STATUS',
      `Stripe reported subscription status "${String(raw)}", which this adapter does not recognise.`,
    );
  }
  return status;
}

function toDate(value: unknown): Date | null {
  return typeof value === 'number' && Number.isFinite(value) ? new Date(value * 1000) : null;
}

/** Stripe takes form-encoded bodies, including bracketed nesting for objects. */
export function formEncode(input: Record<string, unknown>, prefix = ''): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = formEncode(value as Record<string, unknown>, name);
      if (nested) parts.push(nested);
    } else if (Array.isArray(value)) {
      value.forEach((entry, index) => {
        if (typeof entry === 'object' && entry !== null) {
          parts.push(formEncode(entry as Record<string, unknown>, `${name}[${index}]`));
        } else {
          parts.push(
            `${encodeURIComponent(`${name}[${index}]`)}=${encodeURIComponent(String(entry))}`,
          );
        }
      });
    } else {
      parts.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
    }
  }
  return parts.filter(Boolean).join('&');
}

export class StripeBillingProvider implements BillingProvider {
  readonly id = 'stripe';

  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly timeoutMs: number;

  constructor(private readonly options: StripeOptions) {
    this.baseUrl = options.baseUrl ?? 'https://api.stripe.com';
    this.apiVersion = options.apiVersion ?? '2024-06-20';
    this.timeoutMs = options.timeoutMs ?? 20_000;
  }

  capabilities(): BillingProviderCapability {
    const mode = modeFromKey(this.options.secretKey);
    const missing: string[] = [];
    if (!this.options.secretKey) missing.push('STRIPE_SECRET_KEY');
    if (!this.options.webhookSecret) missing.push('STRIPE_WEBHOOK_SECRET');

    if (!this.options.secretKey) {
      return {
        available: false,
        reason:
          'No Stripe secret key is configured, so no plan can be purchased and no subscription is synced. Plans and entitlements still apply — every organization is on the free plan.',
        providerId: 'stripe',
        mode: null,
        requiredEnv: missing,
        webhooksVerifiable: false,
      };
    }
    if (!mode) {
      return {
        available: false,
        reason:
          'STRIPE_SECRET_KEY is set but is neither a test (sk_test_…) nor a live (sk_live_…) key, so Spectra cannot tell which mode it is in and refuses to use it.',
        providerId: 'stripe',
        mode: null,
        requiredEnv: missing,
        webhooksVerifiable: false,
      };
    }
    return {
      available: true,
      reason: `Stripe is configured in ${mode} mode.${
        this.options.webhookSecret
          ? ''
          : ' No webhook secret is set, so subscription changes will NOT be received — checkout will work but status will never update.'
      }`,
      providerId: 'stripe',
      mode,
      requiredEnv: missing,
      webhooksVerifiable: Boolean(this.options.webhookSecret),
    };
  }

  private requireKey(): string {
    const key = this.options.secretKey;
    if (!key || !modeFromKey(key)) {
      throw new BillingProviderError(
        'NOT_CONFIGURED',
        'Stripe is not configured in this deployment.',
      );
    }
    return key;
  }

  private async call<T>(
    path: string,
    init: { method: 'GET' | 'POST'; body?: Record<string, unknown>; idempotencyKey?: string },
  ): Promise<T> {
    const key = this.requireKey();
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      'stripe-version': this.apiVersion,
    };
    if (init.body) headers['content-type'] = 'application/x-www-form-urlencoded';
    // Stripe replays a POST with the same key instead of repeating the effect,
    // so a retried checkout cannot create two subscriptions.
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: init.method,
        headers,
        ...(init.body ? { body: formEncode(init.body) } : {}),
        signal: controller.signal,
      });
    } catch (error: unknown) {
      throw new BillingProviderError(
        'NETWORK',
        `Stripe could not be reached: ${error instanceof Error ? error.message : 'unknown error'}`,
        { retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }

    if (!response.ok) {
      const error = (
        parsed as { error?: { code?: string; message?: string; type?: string } } | null
      )?.error;
      throw new BillingProviderError(
        error?.code ?? error?.type ?? `HTTP_${response.status}`,
        // Stripe's message is safe to surface: it describes the request, not
        // the customer's instrument.
        error?.message ?? `Stripe returned ${response.status}.`,
        { retryable: response.status >= 500 || response.status === 429, status: response.status },
      );
    }
    return parsed as T;
  }

  async ensureCustomer(input: EnsureCustomerInput): Promise<{ customerId: string }> {
    const created = await this.call<{ id: string }>('/v1/customers', {
      method: 'POST',
      body: {
        ...(input.email ? { email: input.email } : {}),
        name: input.organizationName,
        // So a Stripe-side investigation can find the tenant, and the webhook
        // can attribute an event without a lookup table.
        metadata: { organizationId: input.organizationId },
      },
      idempotencyKey: `customer-${input.organizationId}`,
    });
    return { customerId: created.id };
  }

  async createCheckoutSession(input: CheckoutSessionInput): Promise<CheckoutSession> {
    const session = await this.call<{ id: string; url: string | null }>('/v1/checkout/sessions', {
      method: 'POST',
      body: {
        mode: 'subscription',
        customer: input.customerId,
        success_url: input.successUrl,
        cancel_url: input.cancelUrl,
        line_items: [{ price: input.priceId, quantity: 1 }],
        client_reference_id: input.organizationId,
        metadata: input.metadata,
        subscription_data: { metadata: input.metadata },
      },
      idempotencyKey: input.idempotencyKey,
    });
    if (!session.url) {
      throw new BillingProviderError(
        'NO_CHECKOUT_URL',
        'Stripe created a checkout session without a URL, so there is nowhere to send the customer.',
      );
    }
    return { id: session.id, url: session.url };
  }

  async createPortalSession(input: PortalSessionInput): Promise<{ url: string }> {
    const session = await this.call<{ url: string }>('/v1/billing_portal/sessions', {
      method: 'POST',
      body: { customer: input.customerId, return_url: input.returnUrl },
    });
    return { url: session.url };
  }

  async getSubscription(subscriptionId: string): Promise<ProviderSubscription> {
    const raw = await this.call<Record<string, unknown>>(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      { method: 'GET' },
    );
    return parseSubscription(raw);
  }

  verifyWebhook(rawBody: Buffer, signatureHeader: string, now?: Date): VerifiedWebhook {
    const secret = this.options.webhookSecret;
    if (!secret) {
      throw new BillingProviderError(
        'NO_WEBHOOK_SECRET',
        'No STRIPE_WEBHOOK_SECRET is configured, so webhook signatures cannot be verified. The request is refused rather than trusted.',
      );
    }
    let body: string;
    try {
      body = verifyStripeSignature(rawBody, signatureHeader, secret, {
        ...(this.options.toleranceSeconds !== undefined
          ? { toleranceSeconds: this.options.toleranceSeconds }
          : {}),
        ...(now ? { now } : {}),
      });
    } catch (error: unknown) {
      if (error instanceof WebhookSignatureError) {
        throw new BillingProviderError('INVALID_SIGNATURE', error.message);
      }
      throw error;
    }

    let event: {
      id?: string;
      type?: string;
      livemode?: boolean;
      created?: number;
      data?: { object?: Record<string, unknown> };
    };
    try {
      event = JSON.parse(body) as typeof event;
    } catch {
      throw new BillingProviderError('MALFORMED_EVENT', 'The webhook body is not valid JSON.');
    }
    if (!event.id || !event.type || !event.data?.object) {
      throw new BillingProviderError(
        'MALFORMED_EVENT',
        'The webhook body is missing an id, a type or a data object.',
      );
    }

    // The event's own livemode flag decides its mode. An event from the other
    // mode is still parsed here; the caller refuses to apply it.
    return {
      id: event.id,
      type: event.type,
      mode: event.livemode ? 'LIVE' : 'TEST',
      createdAt: toDate(event.created) ?? new Date(),
      object: event.data.object,
    };
  }
}

/** Parses Stripe's subscription object into the provider-neutral shape. */
export function parseSubscription(raw: Record<string, unknown>): ProviderSubscription {
  const items = raw['items'] as { data?: Array<{ price?: { id?: string } }> } | undefined;
  const customer = raw['customer'];
  return {
    id: String(raw['id'] ?? ''),
    customerId:
      typeof customer === 'string'
        ? customer
        : String((customer as { id?: string } | undefined)?.id ?? ''),
    status: mapSubscriptionStatus(raw['status']),
    priceId: items?.data?.[0]?.price?.id ?? null,
    currentPeriodStart: toDate(raw['current_period_start']),
    currentPeriodEnd: toDate(raw['current_period_end']),
    cancelAtPeriodEnd: raw['cancel_at_period_end'] === true,
    canceledAt: toDate(raw['canceled_at']),
    trialEndsAt: toDate(raw['trial_end']),
  };
}
