# Billing Architecture

**Phase 8A · ADR-0044.** Plans, entitlements, credits and Stripe — and the line between an
estimate and an invoice.

## 1. Three numbers that must never be confused

|               | Estimated spend                  | Entitlement                  | Invoice              |
| ------------- | -------------------------------- | ---------------------------- | -------------------- |
| **Authority** | Spectra's rate table (ADR-0026)  | The plan                     | Stripe               |
| **Answers**   | "Roughly what is this costing?"  | "Does my plan include this?" | "What am I charged?" |
| **Stored in** | `UsageEvent.estimatedCostMicros` | `Plan.entitlements`          | Stripe only          |
| **Refusal**   | `403` budget-exceeded            | `402` entitlement-exceeded   | —                    |
| **Fixed by**  | Raising the budget               | Upgrading the plan           | Paying               |

They are never summed, substituted or relabelled. The billing API returns no field that could be
read as money owed, and an integration test asserts that structurally.

**Why 402 for entitlements and 403 for budgets.** A budget is the operator's own cost ceiling —
nobody is billed, so "Payment Required" would imply a bill that does not exist. An entitlement is a
commercial limit a customer resolves by paying. Different cause, different remedy, different status.

## 2. Entitlements

Ten keys, in four kinds — and the kind matters, because enforcing a flow limit against a standing
count is the classic entitlement bug:

| Kind       | Meaning                                      | Keys                                                                   |
| ---------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `COUNT`    | A standing quantity right now                | workspaces, users, verticals, social connections                       |
| `PERIOD`   | A flow per billing period                    | research runs, content generations, media renders, publishing attempts |
| `BYTES`    | Stored volume                                | storage                                                                |
| `INTERVAL` | A minimum gap — **lower is more permissive** | analytics sync frequency                                               |

`ANALYTICS_SYNC_MIN_INTERVAL_MINUTES` inverts: a better plan allows a _smaller_ gap. That is
declared on the definition (`higherIsMorePermissive: false`) rather than left to each call site.

### The fallback is the free plan, never "allow"

```
subscription ACTIVE / TRIALING / PAST_DUE  → the subscription's plan
subscription CANCELED / UNPAID / PAUSED /
  INCOMPLETE / INCOMPLETE_EXPIRED           → the free plan
no subscription                             → the free plan
Stripe not configured at all                → the free plan
```

`PAST_DUE` keeps its plan on purpose: dunning is the provider's job, and cutting a customer off the
instant a card retries is a support incident.

### Where it is enforced

`BillingService.assertEntitlement()` is called at the point the work happens, so the limit applies
in the worker and the API alike, not just on a dashboard. Wired today:

| Key                        | Enforced at                 |
| -------------------------- | --------------------------- |
| `RESEARCH_RUNS_PER_PERIOD` | `ResearchRunsService.start` |

The rest are reported on the billing page and ready to enforce — each is one `assertEntitlement`
call at its call site. That gap is deliberate and listed rather than implied.

## 3. Credits

- **Sources**: `MONTHLY_ALLOWANCE` (granted on activation and rollover, lapses at period end),
  `PURCHASED`, `MANUAL` (operator-granted, reason required), `REVERSAL`.
- **Expiry is per grant**, not per balance.
- **Spend order: soonest-expiring first.** A monthly allowance is consumed before purchased
  credits — spending paid credits while free ones lapse would be unfair.
- **The balance is derived** from grants, never cached. A stored balance that drifts from its
  ledger is a billing dispute waiting to happen.
- **Deduction is idempotent** by key and reports a **shortfall** rather than going negative.
- **Reversal** returns credits to the grant they came from; if that grant has lapsed, the amount is
  reissued as a fresh `REVERSAL` grant rather than reviving an expired one.

## 4. Stripe integration

| Flow              | How                                                                              |
| ----------------- | -------------------------------------------------------------------------------- |
| Checkout          | `POST /checkout` returns a URL. Card entry happens on Stripe. Idempotency-keyed. |
| Portal            | `POST /portal` returns a URL for plan changes, cancellation and payment methods. |
| Subscription sync | Webhook → read the subscription **back from Stripe**, then mirror it.            |
| Payment status    | `invoice.payment_failed` / `payment_succeeded` drive the dunning banner.         |

Spectra never computes subscription state and never trusts the browser for it. A successful
checkout does **not** mark anything active — only a webhook, or a direct read, does.

### Webhook security

Signature verification is written out in `packages/billing-stripe/src/signature.ts` rather than
imported, because it is the one place a shortcut is a vulnerability:

1. HMAC-SHA256 over `{timestamp}.{raw body}` — **raw bytes**, so the port takes a `Buffer`.
2. **Constant-time** comparison.
3. **Timestamp tolerance** (default 300s), checked in both directions.
4. **Every `v1` signature** tried, so secret rotation works.

Fastify needed `bodyParser: false` on the Nest app plus a content-type parser that keeps the raw
buffer **for `/v1/billing/webhook/stripe` only**. A rejected signature returns a terse `400` — a
descriptive rejection is a forgery oracle.

### Idempotency

`BillingWebhookEvent` is unique on `(mode, providerEventId)`. Every event is recorded before it is
applied; a replay returns the first outcome. Unhandled types are recorded `IGNORED`, not dropped.

### Test / live separation

The mode comes from the key prefix (`sk_test_` / `sk_live_`), never a separate setting that could
disagree. Customers, prices and subscriptions are unique per mode, and an event whose `livemode`
does not match the deployment is stored and ignored.

## 5. What Spectra never stores

No card number, no token that can move money, no bank detail. Only `cus_…`, `sub_…`, `price_…` and
statuses. Checkout return URLs are built from `BILLING_RETURN_ORIGIN`, never from the request.

Invoices are not mirrored: status changes are, because they drive the banner, but totals and PDFs
stay in Stripe — one fewer place for an amount to be wrong.

## 6. Configuration

| Variable                           | Effect when unset                                                        |
| ---------------------------------- | ------------------------------------------------------------------------ |
| `STRIPE_SECRET_KEY`                | Billing is off; every org is on the free plan, limits still enforced     |
| `STRIPE_WEBHOOK_SECRET`            | Webhooks are **refused**, so status never updates — checkout still works |
| `STRIPE_API_BASE_URL`              | Defaults to Stripe; overridden for the test stand-in                     |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | 300                                                                      |
| `BILLING_RETURN_ORIGIN`            | `http://localhost:3000`                                                  |

Prices are **not** seeded: they carry provider ids and are per-deployment. Create them in Stripe,
then insert a `ProductPrice` row per plan per mode. A plan with no price in the active mode is
listed as not purchasable rather than offering a checkout that would fail.

## 7. Not built

- Invoice mirroring, proration maths, tax — the provider's, via its portal.
- Usage-based (metered) billing. Credits are the metering mechanism today.
- A scheduled grant of the free plan's monthly allowance to organizations with no subscription.
- **Nothing has run against Stripe itself** — see `BILLING_LIVE_VERIFICATION.md`.
