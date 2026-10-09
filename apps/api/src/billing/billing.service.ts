import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import {
  BUILT_IN_PLANS,
  BillingProviderError,
  EntitlementExceededError,
  FALLBACK_PLAN_KEY,
  assertEntitled,
  availableCredits,
  checkEntitlement,
  effectivePlan,
  expiringBy,
  planDeduction,
  planReversal,
  type EntitlementContext,
  type LedgerGrant,
  type ResolvedPlan,
  type VerifiedWebhook,
} from '@spectra/billing-core';
import { StripeBillingProvider } from '@spectra/billing-stripe';
import {
  ENTITLEMENT_DEFINITIONS,
  ENTITLEMENT_KEYS,
  type CreateCheckoutSessionInput,
  type EntitlementDecision,
  type EntitlementKey,
  type GrantCreditsInput,
  type PlanEntitlements,
} from '@spectra/contracts';
import { Prisma } from '@spectra/database';
import { TenantIsolationError } from '@spectra/security';

import { getApiEnv } from '../config/env';
import { AuditService } from '../infra/audit.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Principal, TenantContext } from '../auth/types';

/**
 * Billing, plans, credits and entitlements.
 *
 * The invariant this whole service protects: **an estimate is not an invoice.**
 * Budgets cap estimated provider spend (ADR-0026); entitlements cap what a plan
 * includes; Stripe decides what a customer is actually charged. Three different
 * numbers from three different authorities, never conflated.
 */
@Injectable()
export class BillingService {
  private readonly stripe = new StripeBillingProvider({
    secretKey: getApiEnv().STRIPE_SECRET_KEY ?? null,
    webhookSecret: getApiEnv().STRIPE_WEBHOOK_SECRET ?? null,
    baseUrl: getApiEnv().STRIPE_API_BASE_URL,
    toleranceSeconds: getApiEnv().STRIPE_WEBHOOK_TOLERANCE_SECONDS,
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The provider's mode, or null when billing is off. */
  private get mode() {
    return this.stripe.capabilities().mode;
  }

  // -------------------------------------------------------------------------
  // Plans and capability
  // -------------------------------------------------------------------------

  async capabilities() {
    const capability = this.stripe.capabilities();
    return {
      provider: capability,
      /**
       * Said plainly, because it is the single most dangerous thing to get
       * wrong in a billing UI.
       */
      estimatesAreNotInvoices:
        'Usage figures in Spectra are ESTIMATES of provider spend, computed from Spectra’s own rate table. They are not invoices and will not match what you are charged. Stripe is the only authority on amounts billed.',
      fallbackPlanKey: FALLBACK_PLAN_KEY,
      entitlementDefinitions: ENTITLEMENT_DEFINITIONS,
    };
  }

  /** Plans a customer can see. Non-self-serve plans are listed, not purchasable. */
  async listPlans() {
    const mode = this.mode;
    const plans = await this.prisma.client.plan.findMany({
      where: { active: true },
      include: {
        prices: mode ? { where: { mode, active: true } } : { where: { id: '' } },
      },
      orderBy: { sortOrder: 'asc' },
    });
    return {
      plans: plans.map((plan) => ({
        ...plan,
        // A plan with no price in the active mode cannot be bought, and the UI
        // must not offer a checkout button that would 422.
        purchasable: plan.selfServe && plan.prices.length > 0,
      })),
      mode,
    };
  }

  // -------------------------------------------------------------------------
  // Subscription state
  // -------------------------------------------------------------------------

  /**
   * The organization's billing state. Read from Spectra's mirror of the
   * provider — never from anything the browser sent.
   */
  async getSubscription(tenant: TenantContext) {
    const organizationId = tenant.organizationId;
    const mode = this.mode;
    const subscription = mode
      ? await this.prisma.client.subscription.findFirst({
          where: { organizationId, mode },
          include: { plan: true },
          orderBy: { updatedAt: 'desc' },
        })
      : null;

    const fallback = await this.fallbackPlan();
    const context = this.contextFor(subscription, fallback);
    const applied = effectivePlan(context);

    return {
      subscription: subscription
        ? {
            id: subscription.id,
            status: subscription.status,
            planKey: subscription.plan.key,
            planName: subscription.plan.name,
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
            cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
            trialEndsAt: subscription.trialEndsAt,
            lastPaymentFailedAt: subscription.lastPaymentFailedAt,
            lastPaymentFailureMessage: subscription.lastPaymentFailureMessage,
            mode: subscription.mode,
          }
        : null,
      /** The plan whose limits actually apply right now. */
      effectivePlanKey: applied.key,
      /** True when a lapsed subscription has dropped the org to the fallback. */
      downgradedToFallback: Boolean(subscription) && applied.key === fallback.key,
      paymentFailed: Boolean(subscription?.lastPaymentFailedAt),
    };
  }

  // -------------------------------------------------------------------------
  // Entitlements
  // -------------------------------------------------------------------------

  /** Every entitlement, with its current usage. What the UI's limits page shows. */
  async entitlements(tenant: TenantContext): Promise<{
    decisions: EntitlementDecision[];
    planKey: string;
  }> {
    const context = await this.entitlementContext(tenant.organizationId);
    const plan = effectivePlan(context);
    const usage = await this.currentUsage(tenant.organizationId, context);

    return {
      planKey: plan.key,
      decisions: ENTITLEMENT_KEYS.map((key) =>
        checkEntitlement({ key, used: usage[key] ?? 0, requested: 0, context }),
      ),
    };
  }

  /**
   * Enforces one entitlement. Called by the features themselves, so the limit
   * is applied where the work happens rather than only in a dashboard.
   */
  async assertEntitlement(
    organizationId: string,
    key: EntitlementKey,
    requested = 1,
  ): Promise<EntitlementDecision> {
    const context = await this.entitlementContext(organizationId);
    const usage = await this.currentUsage(organizationId, context, key);
    return assertEntitled({ key, used: usage[key] ?? 0, requested, context });
  }

  // -------------------------------------------------------------------------
  // Checkout and portal
  // -------------------------------------------------------------------------

  async createCheckoutSession(
    tenant: TenantContext,
    principal: Principal,
    input: CreateCheckoutSessionInput,
  ) {
    const capability = this.stripe.capabilities();
    if (!capability.available || !capability.mode) {
      throw new UnprocessableEntityException(capability.reason);
    }
    const organizationId = tenant.organizationId;

    const plan = await this.prisma.client.plan.findFirst({
      where: { key: input.planKey, active: true },
      include: {
        prices: { where: { mode: capability.mode, active: true, interval: input.interval } },
      },
    });
    if (!plan) throw new TenantIsolationError('Plan not found');
    if (!plan.selfServe) {
      throw new UnprocessableEntityException(
        `The ${plan.name} plan is not self-serve. Contact sales to change to it.`,
      );
    }
    const price = plan.prices[0];
    if (!price) {
      throw new UnprocessableEntityException(
        `The ${plan.name} plan has no ${input.interval.toLowerCase()}ly price configured in ${capability.mode} mode, so it cannot be purchased.`,
      );
    }

    const organization = await this.prisma.client.organization.findFirst({
      where: { id: organizationId },
      select: { id: true, name: true },
    });
    if (!organization) throw new TenantIsolationError('Organization not found');

    const customerId = await this.ensureCustomer(
      organizationId,
      organization.name,
      capability.mode,
    );

    // Return URLs are built from a configured origin, never from the request:
    // a caller-supplied absolute URL would let someone send a paying customer
    // anywhere after checkout.
    const origin = getApiEnv().BILLING_RETURN_ORIGIN.replace(/\/$/, '');
    const safePath = (path: string) => (path.startsWith('/') ? path : `/${path}`);

    let session;
    try {
      session = await this.stripe.createCheckoutSession({
        customerId,
        priceId: price.providerPriceId,
        organizationId,
        successUrl: `${origin}${safePath(input.successPath)}`,
        cancelUrl: `${origin}${safePath(input.cancelPath)}`,
        metadata: { organizationId, planKey: plan.key },
        // The same org asking for the same plan twice replays rather than
        // creating a second subscription.
        idempotencyKey: `checkout-${organizationId}-${plan.key}-${input.interval}`,
      });
    } catch (error: unknown) {
      throw this.providerProblem(error);
    }

    await this.audit.record({
      organizationId,
      workspaceId: tenant.workspaceId ?? null,
      actorUserId: principal.userId,
      action: 'billing.checkout.created',
      resourceType: 'Plan',
      resourceId: plan.id,
      changes: { planKey: plan.key, interval: input.interval, mode: capability.mode },
    });

    // The URL is returned, not followed. Card entry happens on Stripe's page.
    return { url: session.url, sessionId: session.id };
  }

  async createPortalSession(tenant: TenantContext, principal: Principal) {
    const capability = this.stripe.capabilities();
    if (!capability.available || !capability.mode) {
      throw new UnprocessableEntityException(capability.reason);
    }
    const customer = await this.prisma.client.billingCustomer.findFirst({
      where: { organizationId: tenant.organizationId, mode: capability.mode },
      select: { providerCustomerId: true },
    });
    if (!customer) {
      throw new UnprocessableEntityException(
        'This organization has no billing customer yet. Start a checkout first.',
      );
    }
    const origin = getApiEnv().BILLING_RETURN_ORIGIN.replace(/\/$/, '');
    try {
      const session = await this.stripe.createPortalSession({
        customerId: customer.providerCustomerId,
        returnUrl: `${origin}/billing`,
      });
      await this.audit.record({
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId ?? null,
        actorUserId: principal.userId,
        action: 'billing.portal.opened',
        resourceType: 'BillingCustomer',
        resourceId: customer.providerCustomerId,
        changes: {},
      });
      return { url: session.url };
    } catch (error: unknown) {
      throw this.providerProblem(error);
    }
  }

  // -------------------------------------------------------------------------
  // Webhooks
  // -------------------------------------------------------------------------

  /**
   * Handles one webhook. The signature is verified against the RAW body before
   * anything is read from it, and the provider's event id makes processing
   * idempotent — providers retry, and a replay must not grant a second month
   * of credits or re-activate a cancelled plan.
   */
  async handleWebhook(rawBody: Buffer, signature: string) {
    let event: VerifiedWebhook;
    try {
      event = this.stripe.verifyWebhook(rawBody, signature);
    } catch (error: unknown) {
      // Deliberately terse to the caller: a verbose signature error is a
      // forgery oracle. The detail is logged, not returned.
      throw new BillingProviderError(
        'INVALID_SIGNATURE',
        error instanceof Error ? error.message : 'The webhook signature could not be verified.',
      );
    }

    const capability = this.stripe.capabilities();
    if (capability.mode && event.mode !== capability.mode) {
      // A live event arriving at a test deployment (or the reverse) is stored
      // and ignored, never applied: test subscriptions must not entitle real
      // customers.
      await this.recordEvent(
        event,
        'IGNORED',
        null,
        `Event mode ${event.mode} does not match this deployment's ${capability.mode} mode.`,
      );
      return { received: true, status: 'IGNORED' as const, duplicate: false };
    }

    // Idempotency: the unique (mode, providerEventId) is the gate.
    const existing = await this.prisma.client.billingWebhookEvent.findFirst({
      where: { mode: event.mode, providerEventId: event.id },
      select: { id: true, status: true },
    });
    if (existing && existing.status !== 'FAILED') {
      return { received: true, status: existing.status, duplicate: true };
    }

    const organizationId = this.organizationFromEvent(event);
    const record = await this.prisma.client.billingWebhookEvent.upsert({
      where: { mode_providerEventId: { mode: event.mode, providerEventId: event.id } },
      create: {
        mode: event.mode,
        providerEventId: event.id,
        type: event.type,
        status: 'RECEIVED',
        organizationId,
        attempts: 1,
      },
      update: { attempts: { increment: 1 }, status: 'RECEIVED' },
      select: { id: true },
    });

    try {
      const applied = await this.applyEvent(event);
      await this.prisma.client.billingWebhookEvent.update({
        where: { id: record.id },
        data: { status: applied ? 'PROCESSED' : 'IGNORED', processedAt: new Date(), error: null },
      });
      return {
        received: true,
        status: applied ? ('PROCESSED' as const) : ('IGNORED' as const),
        duplicate: false,
      };
    } catch (error: unknown) {
      await this.prisma.client.billingWebhookEvent.update({
        where: { id: record.id },
        data: {
          status: 'FAILED',
          // Bounded and scrubbed — never the raw payload.
          error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
        },
      });
      throw error;
    }
  }

  /** Applies one verified event. Returns false for events with no handler. */
  private async applyEvent(event: VerifiedWebhook): Promise<boolean> {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
        return this.syncSubscriptionFromEvent(event);
      case 'invoice.payment_failed':
        return this.markPaymentFailed(event);
      case 'invoice.payment_succeeded':
      case 'invoice.paid':
        return this.clearPaymentFailure(event);
      default:
        // Recorded as IGNORED rather than dropped: an unhandled event is a
        // known gap, not a silent one.
        return false;
    }
  }

  private async syncSubscriptionFromEvent(event: VerifiedWebhook): Promise<boolean> {
    const subscriptionId =
      event.type === 'checkout.session.completed'
        ? (event.object['subscription'] as string | null)
        : (event.object['id'] as string | null);
    if (!subscriptionId) return false;

    // Read the subscription back from the provider rather than trusting the
    // event body: the event may be out of order, and the provider is the
    // authority on current state.
    const remote = await this.stripe.getSubscription(subscriptionId);
    const resolvedOrg =
      this.organizationFromEvent(event) ??
      (await this.organizationForCustomer(event.mode, remote.customerId));
    if (!resolvedOrg) {
      throw new Error(`Subscription ${subscriptionId} could not be attributed to an organization.`);
    }

    const price = remote.priceId
      ? await this.prisma.client.productPrice.findFirst({
          where: { mode: event.mode, providerPriceId: remote.priceId },
          select: { planId: true },
        })
      : null;
    if (!price) {
      throw new Error(
        `Subscription ${subscriptionId} is on price ${remote.priceId ?? 'unknown'}, which maps to no plan in this deployment.`,
      );
    }

    await this.prisma.client.subscription.upsert({
      where: {
        mode_providerSubscriptionId: { mode: event.mode, providerSubscriptionId: remote.id },
      },
      create: {
        organizationId: resolvedOrg,
        planId: price.planId,
        mode: event.mode,
        providerSubscriptionId: remote.id,
        status: remote.status,
        currentPeriodStart: remote.currentPeriodStart,
        currentPeriodEnd: remote.currentPeriodEnd,
        cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
        canceledAt: remote.canceledAt,
        trialEndsAt: remote.trialEndsAt,
        lastEventId: event.id,
      },
      update: {
        planId: price.planId,
        status: remote.status,
        currentPeriodStart: remote.currentPeriodStart,
        currentPeriodEnd: remote.currentPeriodEnd,
        cancelAtPeriodEnd: remote.cancelAtPeriodEnd,
        canceledAt: remote.canceledAt,
        trialEndsAt: remote.trialEndsAt,
        lastEventId: event.id,
      },
    });

    // A newly-active period grants its monthly credits, once.
    if (
      (remote.status === 'ACTIVE' || remote.status === 'TRIALING') &&
      remote.currentPeriodStart &&
      remote.currentPeriodEnd
    ) {
      await this.grantMonthlyAllowance(
        resolvedOrg,
        price.planId,
        remote.currentPeriodStart,
        remote.currentPeriodEnd,
      );
    }
    return true;
  }

  /**
   * Maps a provider customer id to an organization.
   *
   * This is the one lookup that genuinely cannot be tenant-scoped: a webhook
   * arrives with no tenant, and resolving which tenant it belongs to is the
   * whole question. The tenant guard rightly refuses an unscoped `findFirst`,
   * so this uses the same escape hatch as the analytics dispatcher — a narrow
   * raw query returning **only an id**, never a row of tenant data. Every
   * write that follows is tenant-scoped with the result.
   */
  private async organizationForCustomer(
    mode: 'TEST' | 'LIVE',
    providerCustomerId: string,
  ): Promise<string | null> {
    const rows = await this.prisma.client.$queryRaw<Array<{ organizationId: string }>>`
      SELECT "organizationId"
      FROM billing_customers
      WHERE "mode" = ${mode}::"BillingMode"
        AND "providerCustomerId" = ${providerCustomerId}
      LIMIT 1
    `;
    return rows[0]?.organizationId ?? null;
  }

  /**
   * Maps a provider subscription id to an organization — the same unavoidable
   * cross-tenant lookup as `organizationForCustomer`, and the same narrow
   * raw query returning only an id.
   */
  private async organizationForSubscription(
    mode: 'TEST' | 'LIVE',
    providerSubscriptionId: string,
  ): Promise<string | null> {
    const rows = await this.prisma.client.$queryRaw<Array<{ organizationId: string }>>`
      SELECT "organizationId"
      FROM subscriptions
      WHERE "mode" = ${mode}::"BillingMode"
        AND "providerSubscriptionId" = ${providerSubscriptionId}
      LIMIT 1
    `;
    return rows[0]?.organizationId ?? null;
  }

  private async markPaymentFailed(event: VerifiedWebhook): Promise<boolean> {
    const subscriptionId = event.object['subscription'] as string | null;
    if (!subscriptionId) return false;
    // Stripe's own description of the failure. It describes the charge, never
    // the instrument, so it is safe to show an operator.
    const message = ((event.object['last_finalization_error'] as { message?: string } | undefined)
      ?.message ?? 'The most recent payment attempt failed.') as string;
    const organizationId = await this.organizationForSubscription(event.mode, subscriptionId);
    if (!organizationId) return false;
    const updated = await this.prisma.client.subscription.updateMany({
      where: { organizationId, mode: event.mode, providerSubscriptionId: subscriptionId },
      data: {
        lastPaymentFailedAt: new Date(),
        lastPaymentFailureMessage: message.slice(0, 500),
        lastEventId: event.id,
      },
    });
    return updated.count > 0;
  }

  private async clearPaymentFailure(event: VerifiedWebhook): Promise<boolean> {
    const subscriptionId = event.object['subscription'] as string | null;
    if (!subscriptionId) return false;
    const organizationId = await this.organizationForSubscription(event.mode, subscriptionId);
    if (!organizationId) return false;
    const updated = await this.prisma.client.subscription.updateMany({
      where: { organizationId, mode: event.mode, providerSubscriptionId: subscriptionId },
      data: { lastPaymentFailedAt: null, lastPaymentFailureMessage: null, lastEventId: event.id },
    });
    return updated.count > 0;
  }

  // -------------------------------------------------------------------------
  // Credits
  // -------------------------------------------------------------------------

  async creditBalance(tenant: TenantContext) {
    const organizationId = tenant.organizationId;
    const now = new Date();
    const grants = await this.loadGrants(organizationId);
    const subscription = await this.currentSubscription(organizationId);
    const periodEnd = subscription?.currentPeriodEnd ?? null;
    const periodStart = subscription?.currentPeriodStart ?? null;

    const consumed = await this.prisma.client.creditLedgerEntry.aggregate({
      where: {
        organizationId,
        kind: 'CONSUMPTION',
        ...(periodStart ? { createdAt: { gte: periodStart } } : {}),
      },
      _sum: { amount: true },
    });

    return {
      balance: {
        organizationId,
        available: availableCredits(grants, now),
        consumedThisPeriod: Math.abs(consumed._sum.amount ?? 0),
        expiringAtPeriodEnd: expiringBy(grants, periodEnd, now),
        asOf: now.toISOString(),
      },
      grants: grants.map((grant) => ({
        id: grant.id,
        source: grant.source,
        remaining: grant.remaining,
        expiresAt: grant.expiresAt,
      })),
    };
  }

  /** An operator grants credits by hand — goodwill, or an enterprise agreement. */
  async grantCredits(tenant: TenantContext, principal: Principal, input: GrantCreditsInput) {
    const organizationId = tenant.organizationId;
    const grant = await this.prisma.client.creditGrant.create({
      data: {
        organizationId,
        source: 'MANUAL',
        amount: input.amount,
        remaining: input.amount,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        grantedByUserId: principal.userId,
        reason: input.reason,
      },
      select: { id: true },
    });
    await this.prisma.client.creditLedgerEntry.create({
      data: {
        organizationId,
        grantId: grant.id,
        kind: 'GRANT',
        amount: input.amount,
        note: input.reason,
      },
    });
    await this.audit.record({
      organizationId,
      workspaceId: tenant.workspaceId ?? null,
      actorUserId: principal.userId,
      action: 'billing.credits.granted',
      resourceType: 'CreditGrant',
      resourceId: grant.id,
      changes: { amount: input.amount, reason: input.reason },
    });
    return this.creditBalance(tenant);
  }

  /**
   * Deducts credits for a unit of work. Idempotent by key, so a retried job
   * never charges twice, and honest about a shortfall rather than going
   * negative.
   */
  async consumeCredits(
    organizationId: string,
    amount: number,
    options: { idempotencyKey: string; resourceType?: string; resourceId?: string },
  ): Promise<{ consumed: number; shortfall: number }> {
    const existing = await this.prisma.client.creditLedgerEntry.findFirst({
      where: { organizationId, idempotencyKey: options.idempotencyKey },
      select: { amount: true },
    });
    if (existing) return { consumed: Math.abs(existing.amount), shortfall: 0 };

    const now = new Date();
    const grants = await this.loadGrants(organizationId);
    const plan = planDeduction(grants, amount, now);

    await this.prisma.client.$transaction(async (tx) => {
      for (const deduction of plan.deductions) {
        await tx.creditGrant.update({
          where: { id: deduction.grantId },
          data: { remaining: { decrement: deduction.amount } },
        });
      }
      const spent = amount - plan.shortfall;
      if (spent > 0) {
        await tx.creditLedgerEntry.create({
          data: {
            organizationId,
            kind: 'CONSUMPTION',
            amount: -spent,
            idempotencyKey: options.idempotencyKey,
            resourceType: options.resourceType ?? null,
            resourceId: options.resourceId ?? null,
          },
        });
      }
    });

    return { consumed: amount - plan.shortfall, shortfall: plan.shortfall };
  }

  /** Returns credits when work was refunded or reversed. */
  async reverseCredits(
    organizationId: string,
    idempotencyKey: string,
    reason: string,
  ): Promise<{ restored: number; reissued: number }> {
    const original = await this.prisma.client.creditLedgerEntry.findFirst({
      where: { organizationId, idempotencyKey, kind: 'CONSUMPTION' },
      select: { id: true, amount: true, grantId: true },
    });
    if (!original) return { restored: 0, reissued: 0 };

    const amount = Math.abs(original.amount);
    const grants = await this.loadGrants(organizationId, { includeExpired: true });
    const { restorations, unrestorable } = planReversal(
      original.grantId ? [{ grantId: original.grantId, amount }] : [],
      grants,
      new Date(),
    );

    let reissued = 0;
    await this.prisma.client.$transaction(async (tx) => {
      for (const restoration of restorations) {
        await tx.creditGrant.update({
          where: { id: restoration.grantId },
          data: { remaining: { increment: restoration.amount } },
        });
      }
      // Credits whose original grant has lapsed are reissued as a fresh
      // REVERSAL grant rather than reviving an expired one.
      const toReissue = unrestorable + (original.grantId ? 0 : amount);
      if (toReissue > 0) {
        const grant = await tx.creditGrant.create({
          data: {
            organizationId,
            source: 'REVERSAL',
            amount: toReissue,
            remaining: toReissue,
            reason,
          },
          select: { id: true },
        });
        reissued = toReissue;
        await tx.creditLedgerEntry.create({
          data: {
            organizationId,
            grantId: grant.id,
            kind: 'REVERSAL',
            amount: toReissue,
            note: reason,
          },
        });
      }
      const restored = restorations.reduce((sum, entry) => sum + entry.amount, 0);
      if (restored > 0) {
        await tx.creditLedgerEntry.create({
          data: { organizationId, kind: 'REVERSAL', amount: restored, note: reason },
        });
      }
    });

    return {
      restored: restorations.reduce((sum, entry) => sum + entry.amount, 0),
      reissued,
    };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private providerProblem(error: unknown): UnprocessableEntityException {
    if (error instanceof BillingProviderError) {
      return new UnprocessableEntityException(`Stripe refused the request: ${error.message}`);
    }
    throw error;
  }

  private async ensureCustomer(
    organizationId: string,
    organizationName: string,
    mode: 'TEST' | 'LIVE',
  ): Promise<string> {
    const existing = await this.prisma.client.billingCustomer.findFirst({
      where: { organizationId, mode },
      select: { providerCustomerId: true },
    });
    if (existing) return existing.providerCustomerId;

    const created = await this.stripe.ensureCustomer({
      organizationId,
      organizationName,
      email: null,
    });
    await this.prisma.client.billingCustomer.create({
      data: { organizationId, mode, providerCustomerId: created.customerId },
    });
    return created.customerId;
  }

  private organizationFromEvent(event: VerifiedWebhook): string | null {
    const metadata = event.object['metadata'] as Record<string, string> | undefined;
    return (
      metadata?.['organizationId'] ??
      (event.object['client_reference_id'] as string | undefined) ??
      null
    );
  }

  private async recordEvent(
    event: VerifiedWebhook,
    status: 'IGNORED' | 'FAILED',
    organizationId: string | null,
    error: string | null,
  ) {
    await this.prisma.client.billingWebhookEvent.upsert({
      where: { mode_providerEventId: { mode: event.mode, providerEventId: event.id } },
      create: {
        mode: event.mode,
        providerEventId: event.id,
        type: event.type,
        status,
        organizationId,
        error,
        attempts: 1,
        processedAt: new Date(),
      },
      update: { status, error, attempts: { increment: 1 }, processedAt: new Date() },
    });
  }

  private async fallbackPlan(): Promise<ResolvedPlan> {
    const plan = await this.prisma.client.plan.findFirst({
      where: { key: FALLBACK_PLAN_KEY },
      select: { key: true, entitlements: true },
    });
    if (plan) {
      return { key: plan.key, entitlements: plan.entitlements as PlanEntitlements };
    }
    // The catalog guarantees a free plan even before anything is seeded, so
    // "no subscription" can never mean "no limits".
    const builtIn = BUILT_IN_PLANS.find((candidate) => candidate.key === FALLBACK_PLAN_KEY)!;
    return { key: builtIn.key, entitlements: builtIn.entitlements };
  }

  private contextFor(
    subscription: { status: string; plan: { key: string; entitlements: unknown } } | null,
    fallback: ResolvedPlan,
  ): EntitlementContext {
    return {
      plan: subscription
        ? {
            key: subscription.plan.key,
            entitlements: subscription.plan.entitlements as PlanEntitlements,
          }
        : null,
      status: (subscription?.status as EntitlementContext['status']) ?? null,
      fallbackPlan: fallback,
    };
  }

  private async currentSubscription(organizationId: string) {
    const mode = this.mode;
    if (!mode) return null;
    return this.prisma.client.subscription.findFirst({
      where: { organizationId, mode },
      include: { plan: true },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async entitlementContext(organizationId: string): Promise<EntitlementContext> {
    const [subscription, fallback] = await Promise.all([
      this.currentSubscription(organizationId),
      this.fallbackPlan(),
    ]);
    return this.contextFor(subscription, fallback);
  }

  /**
   * What the organization currently holds or has used this period. COUNT keys
   * read live counts; PERIOD keys read usage since the period began.
   */
  private async currentUsage(
    organizationId: string,
    context: EntitlementContext,
    only?: EntitlementKey,
  ): Promise<Partial<Record<EntitlementKey, number>>> {
    const subscription = await this.currentSubscription(organizationId);
    // With no subscription the period is the calendar month, matching how
    // budgets already window usage (ADR-0026).
    const periodStart =
      subscription?.currentPeriodStart ??
      new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
    const want = (key: EntitlementKey) => !only || only === key;
    const usage: Partial<Record<EntitlementKey, number>> = {};
    const scope = { organizationId };

    if (want('WORKSPACE_COUNT')) {
      usage.WORKSPACE_COUNT = await this.prisma.client.workspace.count({
        where: { ...scope, deletedAt: null },
      });
    }
    if (want('USER_COUNT')) {
      usage.USER_COUNT = await this.prisma.client.membership.count({ where: scope });
    }
    if (want('CUSTOM_VERTICAL_COUNT')) {
      usage.CUSTOM_VERTICAL_COUNT = await this.prisma.client.customVertical.count({
        where: { ...scope, deletedAt: null },
      });
    }
    if (want('SOCIAL_CONNECTION_COUNT')) {
      usage.SOCIAL_CONNECTION_COUNT = await this.prisma.client.socialAccount.count({
        where: { ...scope, deletedAt: null },
      });
    }

    const periodCount = async (kind: Prisma.UsageEventWhereInput['kind']) =>
      this.prisma.client.usageEvent.count({
        where: { ...scope, kind, occurredAt: { gte: periodStart } },
      });

    if (want('RESEARCH_RUNS_PER_PERIOD')) {
      usage.RESEARCH_RUNS_PER_PERIOD = await periodCount('RESEARCH_RUN');
    }
    if (want('CONTENT_GENERATIONS_PER_PERIOD')) {
      usage.CONTENT_GENERATIONS_PER_PERIOD = await periodCount('CONTENT_DRAFT');
    }
    if (want('MEDIA_RENDERS_PER_PERIOD')) {
      usage.MEDIA_RENDERS_PER_PERIOD = await periodCount('MEDIA_RENDER');
    }
    if (want('PUBLISHING_ATTEMPTS_PER_PERIOD')) {
      usage.PUBLISHING_ATTEMPTS_PER_PERIOD = await periodCount('PUBLISH_ATTEMPT');
    }
    if (want('STORAGE_BYTES')) {
      const stored = await this.prisma.client.mediaAsset.aggregate({
        where: scope,
        _sum: { sizeBytes: true },
      });
      usage.STORAGE_BYTES = stored._sum.sizeBytes ?? 0;
    }
    if (want('ANALYTICS_SYNC_MIN_INTERVAL_MINUTES')) {
      usage.ANALYTICS_SYNC_MIN_INTERVAL_MINUTES = 0;
    }
    void context;
    return usage;
  }

  private async loadGrants(
    organizationId: string,
    options: { includeExpired?: boolean } = {},
  ): Promise<LedgerGrant[]> {
    const rows = await this.prisma.client.creditGrant.findMany({
      where: {
        organizationId,
        ...(options.includeExpired ? {} : { remaining: { gt: 0 } }),
      },
      select: { id: true, source: true, remaining: true, expiresAt: true, grantedAt: true },
      orderBy: { grantedAt: 'asc' },
      take: 500,
    });
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      remaining: row.remaining,
      expiresAt: row.expiresAt,
      grantedAt: row.grantedAt,
    }));
  }

  /** One allowance per organization per billing period, enforced by grantKey. */
  private async grantMonthlyAllowance(
    organizationId: string,
    planId: string,
    periodStart: Date,
    periodEnd: Date,
  ): Promise<void> {
    const plan = await this.prisma.client.plan.findFirst({
      where: { id: planId },
      select: { monthlyCredits: true, key: true },
    });
    if (!plan || plan.monthlyCredits <= 0) return;

    const grantKey = `allowance-${organizationId}-${plan.key}-${periodStart.toISOString()}`;
    const existing = await this.prisma.client.creditGrant.findFirst({
      where: { organizationId, grantKey },
      select: { id: true },
    });
    if (existing) return;

    const grant = await this.prisma.client.creditGrant.create({
      data: {
        organizationId,
        source: 'MONTHLY_ALLOWANCE',
        amount: plan.monthlyCredits,
        remaining: plan.monthlyCredits,
        // Use it or lose it: an allowance lapses with its period.
        expiresAt: periodEnd,
        grantKey,
        reason: `Monthly allowance for the ${plan.key} plan.`,
      },
      select: { id: true },
    });
    await this.prisma.client.creditLedgerEntry.create({
      data: {
        organizationId,
        grantId: grant.id,
        kind: 'GRANT',
        amount: plan.monthlyCredits,
        note: `Monthly allowance for the ${plan.key} plan.`,
      },
    });
  }
}

export { EntitlementExceededError };
