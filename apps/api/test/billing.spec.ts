import './setup-env';

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';

import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/bootstrap';
import { getApiEnv, resetApiEnvCache } from '../src/config/env';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * Phase 8A: billing, plans, credits and entitlements (ADR-0044).
 *
 * Stripe is exercised against a local stand-in that enforces what Stripe
 * documents — form-encoded bodies, idempotency keys, the object shapes — so
 * the adapter's requests are real requests. **Nothing here has been run
 * against Stripe itself** (`docs/BILLING_LIVE_VERIFICATION.md`).
 *
 * The webhook tests are the ones that matter most: a signature that is not
 * actually verified, or a replay that is not actually idempotent, is a
 * financial bug.
 */

const runId = randomBytes(4).toString('hex');
const PASSWORD = 'integration-test-password-1';
const WEBHOOK_SECRET = 'whsec_integration_secret';

interface Tenant {
  email: string;
  cookie: string;
  userId: string;
  orgId: string;
  workspaceId: string;
}

function problemText(body: unknown): string {
  const problem = body as { title?: string; detail?: string };
  return `${problem.title ?? ''} ${problem.detail ?? ''}`;
}

/** A Stripe stand-in: records requests and answers with documented shapes. */
interface StandIn {
  server: Server;
  url: string;
  requests: Array<{
    path: string;
    body: string;
    idempotencyKey: string | null;
    auth: string | null;
  }>;
  subscription: Record<string, unknown>;
}

async function startStandIn(): Promise<StandIn> {
  const state: StandIn = {
    server: null as unknown as Server,
    url: '',
    requests: [],
    subscription: {},
  };

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      state.requests.push({
        path,
        body,
        idempotencyKey: (req.headers['idempotency-key'] as string) ?? null,
        auth: (req.headers['authorization'] as string) ?? null,
      });
      const send = (payload: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (path === '/v1/customers') return send({ id: `cus_${randomUUID().slice(0, 8)}` });
      if (path === '/v1/checkout/sessions') {
        return send({ id: 'cs_test_1', url: 'https://checkout.stripe.test/c/cs_test_1' });
      }
      if (path === '/v1/billing_portal/sessions') {
        return send({ url: 'https://billing.stripe.test/p/session_1' });
      }
      if (path.startsWith('/v1/subscriptions/')) return send(state.subscription);
      return send({ error: { message: `unexpected path ${path}` } }, 404);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  state.server = server;
  state.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return state;
}

describe('API integration: billing, plans, credits and entitlements (ADR-0044)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let standIn: StandIn;
  const tenants: Tenant[] = [];
  let owner: Tenant;
  let other: Tenant;

  const inject = () => app.getHttpAdapter().getInstance();
  const base = (t: Tenant = owner) => `/v1/organizations/${t.orgId}/billing`;
  const get = (t: Tenant, url: string) =>
    inject().inject({ method: 'GET', url, headers: { cookie: t.cookie } });
  const send = (t: Tenant, method: 'POST', url: string, payload?: unknown) =>
    inject().inject({
      method,
      url,
      headers: { cookie: t.cookie },
      ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    });

  /** Posts a webhook with a correctly computed signature, as Stripe would. */
  function postWebhook(
    event: Record<string, unknown>,
    options: { secret?: string; at?: Date; signature?: string } = {},
  ) {
    const body = JSON.stringify(event);
    const timestamp = Math.floor((options.at ?? new Date()).getTime() / 1000);
    const signature =
      options.signature ??
      `t=${timestamp},v1=${createHmac('sha256', options.secret ?? WEBHOOK_SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex')}`;
    return inject().inject({
      method: 'POST',
      url: '/v1/billing/webhook/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      payload: body,
    });
  }

  async function registerTenant(label: string): Promise<Tenant> {
    const email = `billing-${label}-${runId}@itest.local`;
    const res = await inject().inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: PASSWORD, name: `Billing ${label}` },
    });
    const raw = res.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw[0] : raw)?.split(';')[0] as string;
    const me = res.json() as {
      user: { id: string };
      memberships: Array<{ organizationId: string }>;
      workspaces: Array<{ id: string }>;
    };
    const tenant = {
      email,
      cookie,
      userId: me.user.id,
      orgId: me.memberships[0]?.organizationId as string,
      workspaceId: me.workspaces[0]?.id as string,
    };
    tenants.push(tenant);
    return tenant;
  }

  async function planId(key: string) {
    const plan = await prisma.client.plan.findFirstOrThrow({ where: { key } });
    return plan.id;
  }

  beforeAll(async () => {
    standIn = await startStandIn();
    // The keys come from setup-env (before anything memoizes the env); only
    // the base URL has to be pointed at the stand-in, and the env cache is
    // reset so this spec's app picks it up.
    process.env['STRIPE_API_BASE_URL'] = standIn.url;
    resetApiEnvCache();

    app = await createApp(getApiEnv());
    await app.init();
    await inject().ready();
    prisma = app.get(PrismaService);

    // The catalog must exist; the seed normally provides it.
    const { BUILT_IN_PLANS } = await import('@spectra/billing-core');
    for (const plan of BUILT_IN_PLANS) {
      await prisma.client.plan.upsert({
        where: { key: plan.key },
        update: { entitlements: plan.entitlements as object, monthlyCredits: plan.monthlyCredits },
        create: {
          key: plan.key,
          tier: plan.tier,
          name: plan.name,
          monthlyCredits: plan.monthlyCredits,
          entitlements: plan.entitlements as object,
          selfServe: plan.selfServe,
          active: plan.active,
          sortOrder: plan.sortOrder,
        },
      });
    }
    await prisma.client.productPrice.upsert({
      where: { mode_providerPriceId: { mode: 'TEST', providerPriceId: 'price_growth_month' } },
      update: {},
      create: {
        planId: await planId('growth'),
        mode: 'TEST',
        providerPriceId: 'price_growth_month',
        currency: 'USD',
        unitAmount: 9900,
        interval: 'MONTH',
      },
    });

    owner = await registerTenant('owner');
    other = await registerTenant('other');
  }, 120_000);

  afterAll(async () => {
    for (const tenant of tenants) {
      await prisma.client.organization
        .deleteMany({ where: { id: tenant.orgId } })
        .catch(() => undefined);
      await prisma.client.user
        .deleteMany({ where: { email: tenant.email } })
        .catch(() => undefined);
    }
    await prisma.client.productPrice
      .deleteMany({ where: { providerPriceId: 'price_growth_month' } })
      .catch(() => undefined);
    await app.close();
    await new Promise<void>((resolve) => standIn.server.close(() => resolve()));
    delete process.env['STRIPE_API_BASE_URL'];
    resetApiEnvCache();
  });

  describe('estimates are not invoices', () => {
    it('says so in the capability response, in words', async () => {
      const res = await get(owner, `${base()}/capabilities`);

      expect(res.statusCode).toBe(200);
      const body = res.json() as { estimatesAreNotInvoices: string; provider: { mode: string } };
      expect(body.estimatesAreNotInvoices).toContain('ESTIMATES');
      expect(body.estimatesAreNotInvoices).toContain('not invoices');
      expect(body.provider.mode).toBe('TEST');
    });

    it('never reports a billed amount anywhere in the billing surface', async () => {
      // The acceptance criterion, checked structurally: no endpoint returns a
      // field that could be mistaken for money owed.
      const [subscription, credits, entitlements] = await Promise.all([
        get(owner, `${base()}/subscription`),
        get(owner, `${base()}/credits`),
        get(owner, `${base()}/entitlements`),
      ]);

      for (const res of [subscription, credits, entitlements]) {
        const text = JSON.stringify(res.json());
        expect(text).not.toMatch(/amountDue|amountPaid|invoiceTotal|estimatedCostMicros/);
      }
    });
  });

  describe('plans and entitlements', () => {
    it('lists plans and marks which can actually be purchased', async () => {
      const res = await get(owner, `${base()}/plans`);

      const body = res.json() as {
        plans: Array<{ key: string; purchasable: boolean }>;
        mode: string;
      };
      expect(body.mode).toBe('TEST');
      // Only growth has a TEST price configured above.
      expect(body.plans.find((p) => p.key === 'growth')!.purchasable).toBe(true);
      expect(body.plans.find((p) => p.key === 'starter')!.purchasable).toBe(false);
    });

    it('applies the free plan when there is no subscription — not unlimited use', async () => {
      const res = await get(owner, `${base()}/entitlements`);

      const body = res.json() as {
        planKey: string;
        decisions: Array<{ key: string; limit: number | null; used: number }>;
      };
      expect(body.planKey).toBe('free');
      const workspaces = body.decisions.find((d) => d.key === 'WORKSPACE_COUNT')!;
      expect(workspaces.limit).toBe(1);
      expect(workspaces.used).toBe(1);
    });

    it('reports a 402 with the decision when a plan limit refuses real work', async () => {
      // The free plan allows 5 research runs a period; fake 5 as already used.
      const project = await prisma.client.researchProject.create({
        data: {
          organizationId: owner.orgId,
          workspaceId: owner.workspaceId,
          name: 'Entitlement probe',
        },
        select: { id: true },
      });
      for (let i = 0; i < 5; i += 1) {
        await prisma.client.usageEvent.create({
          data: {
            organizationId: owner.orgId,
            workspaceId: owner.workspaceId,
            kind: 'RESEARCH_RUN',
            provider: 'spectra',
            requests: 1,
            occurredAt: new Date(),
          },
        });
      }

      const res = await send(
        owner,
        'POST',
        `/v1/workspaces/${owner.workspaceId}/research-projects/${project.id}/runs`,
        { searchQueries: ['entitlement probe'] },
      );

      // 402, not 403: a plan limit is resolved by paying, unlike a budget.
      expect(res.statusCode).toBe(402);
      const body = res.json() as {
        type: string;
        entitlement: { key: string; limit: number; outcome: string };
      };
      expect(body.type).toContain('entitlement-exceeded');
      expect(body.entitlement.key).toBe('RESEARCH_RUNS_PER_PERIOD');
      expect(body.entitlement.limit).toBe(5);
      expect(body.entitlement.outcome).toBe('AT_LIMIT');
      expect(problemText(body)).toContain('free plan');

      await prisma.client.usageEvent.deleteMany({
        where: { organizationId: owner.orgId, kind: 'RESEARCH_RUN' },
      });
    }, 60_000);
  });

  describe('checkout and portal', () => {
    it('creates a checkout session and never handles a card', async () => {
      const res = await send(owner, 'POST', `${base()}/checkout`, {
        planKey: 'growth',
        interval: 'MONTH',
      });

      expect(res.statusCode).toBe(201);
      const body = res.json() as { url: string; sessionId: string };
      // The customer is sent to Stripe; Spectra returns a URL, not a form.
      expect(body.url).toContain('checkout.stripe.test');

      const checkout = standIn.requests.find((r) => r.path === '/v1/checkout/sessions')!;
      expect(checkout.auth).toBe('Bearer sk_test_integration');
      // Form-encoded, with the tenant attached so the webhook can attribute it.
      expect(checkout.body).toContain('mode=subscription');
      expect(checkout.body).toContain(encodeURIComponent('metadata[organizationId]'));
      // Idempotency key: a retried checkout cannot create two subscriptions.
      expect(checkout.idempotencyKey).toContain('checkout-');
      // Return URLs come from configuration, never from the caller.
      expect(decodeURIComponent(checkout.body)).toContain('http://localhost:3000/billing');
    }, 60_000);

    it('stores only the customer id, never payment data', async () => {
      const customer = await prisma.client.billingCustomer.findFirstOrThrow({
        where: { organizationId: owner.orgId },
      });

      expect(customer.providerCustomerId).toMatch(/^cus_/);
      expect(customer.mode).toBe('TEST');
      expect(Object.keys(customer)).not.toContain('cardLast4');
      expect(JSON.stringify(customer)).not.toMatch(/pm_|card|cvc|iban/i);
    });

    it('opens the customer portal for an existing customer', async () => {
      const res = await send(owner, 'POST', `${base()}/portal`);

      expect(res.statusCode).toBe(201);
      expect((res.json() as { url: string }).url).toContain('billing.stripe.test');
    }, 60_000);

    it('refuses a plan with no price in this mode, rather than a broken checkout', async () => {
      const res = await send(owner, 'POST', `${base()}/checkout`, { planKey: 'starter' });

      expect(res.statusCode).toBe(422);
      expect(problemText(res.json())).toContain('no monthly price configured');
    }, 60_000);

    it('needs org:billing:manage to spend money — billing:read only looks', async () => {
      const reader = await registerTenant('reader');
      await prisma.client.membership.create({
        data: {
          organizationId: owner.orgId,
          userId: reader.userId,
          role: 'WORKSPACE_ADMIN',
          workspaceIds: [owner.workspaceId],
        },
      });
      const asReader = { ...reader, orgId: owner.orgId };

      const canRead = await get(asReader, `${base(owner)}/plans`);
      const cannotBuy = await send(asReader, 'POST', `${base(owner)}/checkout`, {
        planKey: 'growth',
      });

      expect(canRead.statusCode).toBe(200);
      expect(cannotBuy.statusCode).toBe(403);
      expect(problemText(cannotBuy.json())).toContain('org:billing:manage');
    }, 60_000);
  });

  describe('webhooks', () => {
    // Self-sufficient: a webhook arriving before anyone visited checkout is a
    // real scenario, so this block does not depend on the checkout tests.
    let customerId = '';
    beforeAll(async () => {
      const customer = await prisma.client.billingCustomer.upsert({
        where: { organizationId_mode: { organizationId: owner.orgId, mode: 'TEST' } },
        update: {},
        create: {
          organizationId: owner.orgId,
          mode: 'TEST',
          providerCustomerId: `cus_webhook_${runId}`,
        },
        select: { providerCustomerId: true },
      });
      customerId = customer.providerCustomerId;
    });

    function subscriptionEvent(id: string, overrides: Record<string, unknown> = {}) {
      return {
        id,
        type: 'customer.subscription.updated',
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: `sub_test_${runId}`,
            metadata: { organizationId: owner.orgId },
            ...overrides,
          },
        },
      };
    }

    it('rejects an unsigned request without touching the database', async () => {
      const before = await prisma.client.billingWebhookEvent.count();

      const res = await inject().inject({
        method: 'POST',
        url: '/v1/billing/webhook/stripe',
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(subscriptionEvent(`evt_unsigned-${runId}`)),
      });

      expect(res.statusCode).toBe(400);
      // Terse on purpose: a descriptive rejection is a forgery oracle.
      expect(problemText(res.json())).not.toContain('timestamp');
      expect(await prisma.client.billingWebhookEvent.count()).toBe(before);
    });

    it('rejects a signature computed with the wrong secret', async () => {
      const res = await postWebhook(subscriptionEvent(`evt_wrong_secret-${runId}`), {
        secret: 'whsec_not_ours',
      });

      expect(res.statusCode).toBe(400);
      const stored = await prisma.client.billingWebhookEvent.findFirst({
        where: { providerEventId: `evt_wrong_secret-${runId}` },
      });
      expect(stored).toBeNull();
    });

    it('rejects a replayed request whose timestamp is outside tolerance', async () => {
      const old = new Date(Date.now() - 60 * 60_000);

      const res = await postWebhook(subscriptionEvent(`evt_replayed-${runId}`), { at: old });

      expect(res.statusCode).toBe(400);
    });

    it('rejects a body modified after signing', async () => {
      const event = subscriptionEvent(`evt_tampered-${runId}`);
      const body = JSON.stringify(event);
      const timestamp = Math.floor(Date.now() / 1000);
      const signature = `t=${timestamp},v1=${createHmac('sha256', WEBHOOK_SECRET)
        .update(`${timestamp}.${body}`)
        .digest('hex')}`;

      const res = await inject().inject({
        method: 'POST',
        url: '/v1/billing/webhook/stripe',
        headers: { 'content-type': 'application/json', 'stripe-signature': signature },
        // Same signature, different body.
        payload: body.replace(`evt_tampered-${runId}`, `evt_swapped-${runId}`),
      });

      expect(res.statusCode).toBe(400);
    });

    it('applies a valid subscription event and mirrors the provider’s state', async () => {
      standIn.subscription = {
        id: `sub_test_${runId}`,
        customer: customerId,
        status: 'active',
        current_period_start: Math.floor(Date.now() / 1000),
        current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
        cancel_at_period_end: false,
        items: { data: [{ price: { id: 'price_growth_month' } }] },
      };

      const res = await postWebhook(subscriptionEvent(`evt_active_1-${runId}`));

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'PROCESSED', duplicate: false });

      const subscription = await prisma.client.subscription.findFirstOrThrow({
        where: { organizationId: owner.orgId },
        include: { plan: true },
      });
      expect(subscription.status).toBe('ACTIVE');
      expect(subscription.plan.key).toBe('growth');
      expect(subscription.mode).toBe('TEST');

      // The plan's entitlements now apply.
      const entitlements = (await get(owner, `${base()}/entitlements`)).json() as {
        planKey: string;
      };
      expect(entitlements.planKey).toBe('growth');
    }, 60_000);

    it('is idempotent: the same event id twice grants one month of credits', async () => {
      const before = await prisma.client.creditGrant.count({
        where: { organizationId: owner.orgId, source: 'MONTHLY_ALLOWANCE' },
      });
      expect(before).toBe(1);

      const replay = await postWebhook(subscriptionEvent(`evt_active_1-${runId}`));

      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toMatchObject({ duplicate: true, status: 'PROCESSED' });
      const after = await prisma.client.creditGrant.count({
        where: { organizationId: owner.orgId, source: 'MONTHLY_ALLOWANCE' },
      });
      expect(after).toBe(1);
      // And only one webhook row exists for that event id.
      expect(
        await prisma.client.billingWebhookEvent.count({
          where: { providerEventId: `evt_active_1-${runId}` },
        }),
      ).toBe(1);
    }, 60_000);

    it('records a payment failure, and clears it when payment succeeds', async () => {
      const failed = await postWebhook({
        id: `evt_failed_1-${runId}`,
        type: 'invoice.payment_failed',
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: {
          object: {
            id: 'in_1',
            subscription: `sub_test_${runId}`,
            last_finalization_error: { message: 'Your card was declined.' },
          },
        },
      });
      expect(failed.statusCode).toBe(200);

      let state = (await get(owner, `${base()}/subscription`)).json() as {
        paymentFailed: boolean;
        subscription: { lastPaymentFailureMessage: string | null };
      };
      expect(state.paymentFailed).toBe(true);
      expect(state.subscription.lastPaymentFailureMessage).toContain('declined');

      const paid = await postWebhook({
        id: `evt_paid_1-${runId}`,
        type: 'invoice.payment_succeeded',
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'in_1', subscription: `sub_test_${runId}` } },
      });
      expect(paid.statusCode).toBe(200);

      state = (await get(owner, `${base()}/subscription`)).json() as typeof state;
      expect(state.paymentFailed).toBe(false);
    }, 60_000);

    it('drops the organization to the fallback plan when the subscription is cancelled', async () => {
      standIn.subscription = { ...standIn.subscription, status: 'canceled' };

      await postWebhook(subscriptionEvent(`evt_cancelled_1-${runId}`));

      const state = (await get(owner, `${base()}/subscription`)).json() as {
        effectivePlanKey: string;
        downgradedToFallback: boolean;
      };
      expect(state.effectivePlanKey).toBe('free');
      expect(state.downgradedToFallback).toBe(true);
    }, 60_000);

    it('stores a live event but refuses to apply it in a test deployment', async () => {
      const res = await postWebhook({
        id: `evt_live_1-${runId}`,
        type: 'customer.subscription.updated',
        livemode: true,
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'sub_live_1', metadata: { organizationId: owner.orgId } } },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: 'IGNORED' });
      const stored = await prisma.client.billingWebhookEvent.findFirstOrThrow({
        where: { providerEventId: `evt_live_1-${runId}` },
      });
      expect(stored.status).toBe('IGNORED');
      expect(stored.error).toContain('does not match');
      // No LIVE subscription leaked into a TEST deployment.
      expect(
        await prisma.client.subscription.count({
          where: { organizationId: owner.orgId, mode: 'LIVE' },
        }),
      ).toBe(0);
    }, 60_000);

    it('records an event it has no handler for, rather than dropping it', async () => {
      const res = await postWebhook({
        id: `evt_unhandled_1-${runId}`,
        type: 'customer.discount.created',
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: { object: { id: 'di_1' } },
      });

      expect(res.json()).toMatchObject({ status: 'IGNORED' });
      expect(
        (
          await prisma.client.billingWebhookEvent.findFirstOrThrow({
            where: { providerEventId: `evt_unhandled_1-${runId}` },
          })
        ).status,
      ).toBe('IGNORED');
    }, 60_000);
  });

  describe('credits', () => {
    it('grants a monthly allowance once the subscription activates', async () => {
      const res = await get(owner, `${base()}/credits`);

      const body = res.json() as {
        balance: { available: number; expiringAtPeriodEnd: number };
        grants: Array<{ source: string }>;
      };
      expect(body.grants.some((g) => g.source === 'MONTHLY_ALLOWANCE')).toBe(true);
      expect(body.balance.available).toBeGreaterThan(0);
    }, 60_000);

    it('spends the soonest-expiring credits first, not the purchased ones', async () => {
      const organizationId = owner.orgId;
      await prisma.client.creditGrant.create({
        data: {
          organizationId,
          source: 'PURCHASED',
          amount: 1000,
          remaining: 1000,
          expiresAt: null,
        },
      });
      const service = app.get((await import('../src/billing/billing.service')).BillingService);

      await service.consumeCredits(organizationId, 50, { idempotencyKey: `spend-${runId}-1` });

      const allowance = await prisma.client.creditGrant.findFirstOrThrow({
        where: { organizationId, source: 'MONTHLY_ALLOWANCE' },
      });
      const purchased = await prisma.client.creditGrant.findFirstOrThrow({
        where: { organizationId, source: 'PURCHASED' },
      });
      // The expiring allowance was drained first; the paid credits are intact.
      expect(allowance.remaining).toBeLessThan(allowance.amount);
      expect(purchased.remaining).toBe(1000);
    }, 60_000);

    it('does not charge twice for a retried operation', async () => {
      const service = app.get((await import('../src/billing/billing.service')).BillingService);
      const key = `retry-${runId}`;
      const before = (await get(owner, `${base()}/credits`)).json() as {
        balance: { available: number };
      };

      await service.consumeCredits(owner.orgId, 25, { idempotencyKey: key });
      const once = (await get(owner, `${base()}/credits`)).json() as typeof before;
      await service.consumeCredits(owner.orgId, 25, { idempotencyKey: key });
      const twice = (await get(owner, `${base()}/credits`)).json() as typeof before;

      expect(once.balance.available).toBe(before.balance.available - 25);
      expect(twice.balance.available).toBe(once.balance.available);
    }, 60_000);

    it('reports a shortfall rather than going negative', async () => {
      const service = app.get((await import('../src/billing/billing.service')).BillingService);
      const balance = (await get(owner, `${base()}/credits`)).json() as {
        balance: { available: number };
      };

      const result = await service.consumeCredits(owner.orgId, balance.balance.available + 500, {
        idempotencyKey: `over-${runId}`,
      });

      expect(result.shortfall).toBe(500);
      const after = (await get(owner, `${base()}/credits`)).json() as typeof balance;
      expect(after.balance.available).toBe(0);
    }, 60_000);

    it('returns credits on a reversal', async () => {
      const service = app.get((await import('../src/billing/billing.service')).BillingService);
      await prisma.client.creditGrant.create({
        data: {
          organizationId: owner.orgId,
          source: 'PURCHASED',
          amount: 200,
          remaining: 200,
        },
      });
      const key = `reversible-${runId}`;
      await service.consumeCredits(owner.orgId, 60, { idempotencyKey: key });
      const spent = (await get(owner, `${base()}/credits`)).json() as {
        balance: { available: number };
      };

      const result = await service.reverseCredits(owner.orgId, key, 'Render failed after charge.');
      const restored = (await get(owner, `${base()}/credits`)).json() as typeof spent;

      expect(result.restored + result.reissued).toBe(60);
      expect(restored.balance.available).toBe(spent.balance.available + 60);
    }, 60_000);

    it('lets an operator grant credits by hand, with a reason, audit-logged', async () => {
      const res = await send(owner, 'POST', `${base()}/credits/grant`, {
        amount: 500,
        reason: 'Goodwill after an outage.',
      });

      expect(res.statusCode).toBe(201);
      const audits = await prisma.client.auditLog.findMany({
        where: { organizationId: owner.orgId, action: 'billing.credits.granted' },
      });
      expect(audits).toHaveLength(1);
      expect(JSON.stringify(audits[0]!.changes)).toContain('Goodwill');
    }, 60_000);
  });

  describe('tenant isolation', () => {
    it('refuses another tenant’s billing entirely', async () => {
      const foreignPlans = await get(other, `${base(owner)}/plans`);
      const foreignCredits = await get(other, `${base(owner)}/credits`);
      const foreignCheckout = await send(other, 'POST', `${base(owner)}/checkout`, {
        planKey: 'growth',
      });

      for (const res of [foreignPlans, foreignCredits, foreignCheckout]) {
        expect([403, 404]).toContain(res.statusCode);
      }
    }, 60_000);

    it('keeps credit balances separate', async () => {
      const mine = (await get(owner, `${base()}/credits`)).json() as {
        balance: { available: number };
      };
      const theirs = (await get(other, `${base(other)}/credits`)).json() as typeof mine;

      expect(theirs.balance.available).toBe(0);
      expect(mine.balance.available).not.toBe(theirs.balance.available);
    }, 60_000);
  });

  describe('no secret logging', () => {
    it('never returns the secret key or webhook secret in any response', async () => {
      const responses = await Promise.all([
        get(owner, `${base()}/capabilities`),
        get(owner, `${base()}/plans`),
        get(owner, `${base()}/subscription`),
      ]);

      for (const res of responses) {
        const text = JSON.stringify(res.json());
        expect(text).not.toContain('sk_test_integration');
        expect(text).not.toContain(WEBHOOK_SECRET);
      }
    });
  });
});
