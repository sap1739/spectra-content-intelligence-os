# ADR-0044: Stripe Billing, and keeping an estimate from ever becoming an invoice

**Status:** Accepted · **Date:** 2026-10-08 · **Relates to:** ADR-0026, ADR-0029, ADR-0033

## Context

Spectra has tracked **estimated** provider spend since Phase 5D: a versioned rate table turns
usage into an approximate cost, and budgets refuse work that would exceed a ceiling. ADR-0026 was
emphatic that those numbers are estimates and "must never be presented as a vendor invoice".

Phase 8A puts real money next to them. The moment a billing page exists, the most likely failure
in the product is not a broken webhook — it is a customer reading an estimate as a bill, or an
engineer summing the two. Everything below is arranged around preventing that.

The second risk is subtler. Billing introduces the first code path where _being wrong costs money
in both directions_: a webhook that is not really verified lets anyone grant themselves a plan; a
webhook that is not really idempotent grants a customer twelve months of credits because Stripe
retried.

## Decision

### 1. Three numbers, three authorities, never merged

| Concept                        | Authority            | Question it answers             | Enforcement    |
| ------------------------------ | -------------------- | ------------------------------- | -------------- |
| **Estimated spend** (ADR-0026) | Spectra's rate table | "Roughly what is this costing?" | Budgets, `403` |
| **Entitlement**                | The plan             | "Does this plan include this?"  | `402`          |
| **Invoice**                    | Stripe               | "What is the customer charged?" | Stripe         |

They are stored separately, surfaced separately, and refuse work separately. The billing API never
returns an `amountDue`-shaped field, and an integration test asserts structurally that it does not.
`GET capabilities` carries one sentence stating the distinction, which the UI renders as its first
card.

The **402 vs 403** split is deliberate and is the clearest expression of this. A budget refusal is
`403`, with the existing comment explaining that "Payment Required" would imply a bill that does
not exist — an operator's own cost ceiling is not a commercial limit. An entitlement refusal _is_
commercial, and resolved by paying, so it is `402` and carries the decision so the UI can name the
limit and offer the right upgrade.

### 2. Unconfigured billing is the free plan, never unlimited

The default failure mode of a billing system is to no-op when it is not configured — which in
practice means "everything is allowed". That is exactly backwards for a plan limit.

So the entitlement engine has no "allow" fallback. With no subscription, a cancelled subscription,
or no Stripe configuration at all, the **free plan's** entitlements apply. The free plan is in the
built-in catalog, seeded in every environment including production, precisely so this fallback
always has something to fall back to. `capabilities()` says so in the unconfigured message: _"Plans
and entitlements still apply — every organization is on the free plan."_

`PAST_DUE` is the deliberate exception: it keeps its plan. Dunning is the provider's job, and
cutting a customer off the instant a card retries is a support incident, not a control. `UNPAID`
and `CANCELED` do fall back.

### 3. Signature verification is written out, not imported

Webhook signature checking is the one place in billing where a shortcut is a vulnerability, so it
is implemented directly in `packages/billing-stripe/src/signature.ts` where it can be read and
tested. Four properties, each with its own test:

1. **Raw bytes.** The signature covers the exact body Stripe sent. The port takes a `Buffer`, not a
   parsed object, so re-serializing is not an easy mistake to make — and a test proves a
   re-serialized body fails.
2. **Constant-time comparison.** A fast-fail string compare leaks the expected signature byte by
   byte.
3. **Timestamp tolerance**, checked in both directions. Without it a captured request replays
   forever; a far-future timestamp is as suspect as an old one.
4. **Every `v1` signature is tried.** Stripe sends two during a secret rotation, and accepting only
   the first silently breaks rotation.

Getting the raw bytes through Fastify required declining Nest's own JSON parser (`bodyParser:
false`) and registering one that keeps the buffer **for the webhook path alone**. Every other route
parses JSON exactly as before.

A rejected signature returns a deliberately terse `400`: a descriptive rejection is a forgery
oracle.

### 4. Idempotency is a unique constraint, not a cache

`BillingWebhookEvent` is unique on `(mode, providerEventId)`, and every event is recorded before it
is applied. A replay returns the first outcome without re-running it. Providers retry on any
non-2xx, so this is routine rather than exceptional — and the integration test asserts that the
same event id twice yields exactly one monthly credit grant.

Events with no handler are recorded as `IGNORED` rather than dropped, so an unhandled type is a
visible gap. Failures are recorded as `FAILED` with a bounded, scrubbed message — never the raw
payload, which can carry PII.

### 5. Test and live are different worlds

The mode is derived from the key's prefix (`sk_test_` / `sk_live_`) rather than configured
separately, because two settings that can disagree eventually will. A key of unknown shape yields
no mode and the provider refuses to run at all.

`BillingCustomer`, `ProductPrice` and `Subscription` are all unique _per mode_, and an event whose
`livemode` does not match the deployment is stored and **ignored** — a test subscription must never
entitle a real customer.

### 6. Credits spend soonest-expiring first

The ordering rule is commercial, not technical: a monthly allowance (which lapses at period end) is
consumed before purchased credits (which do not). Spending paid credits while free ones silently
expire is technically defensible and plainly unfair.

Expiry is **per grant**, not per balance, and the balance is **derived** from grants rather than
stored. A cached balance that drifts from its ledger is a billing dispute waiting to happen —
which is why `CreditBalance` is a computed contract type rather than a table.

Deduction reports a **shortfall** instead of going negative or part-charging, and is idempotent by
key so a retried job never charges twice. A reversal returns credits to the grant they came from;
where that grant has lapsed, the amount is reissued as a fresh `REVERSAL` grant rather than
reviving an expired one.

### 7. No payment instrument ever reaches Spectra

Card entry happens on Stripe's Checkout and Portal pages. The provider port's types carry only
opaque identifiers (`cus_…`, `sub_…`, `price_…`) and statuses; a test asserts that a parsed
subscription contains no `pm_…`. Checkout return URLs are built from a configured origin, never
from the request, so a caller cannot redirect a paying customer to an arbitrary host.

## Consequences

- Plans, entitlements and credits work with **no Stripe configuration at all** — every organization
  is on the free plan, limits are enforced, and the UI says why. Configuring Stripe adds purchase
  and sync; it does not switch enforcement on.
- Entitlements are enforced **where the work happens**, not only on a dashboard. Research runs are
  gated today; each remaining key is a one-line `assertEntitlement` at its call site, and the gaps
  are listed in `BILLING.md`.
- **Nothing here has run against Stripe itself.** The adapter is exercised against a local stand-in
  that enforces Stripe's documented request shapes; `docs/BILLING_LIVE_VERIFICATION.md` is the
  checklist for a real account, and it names the questions the documentation does not settle.
- Invoices are **not** mirrored. Status changes are (`invoice.payment_failed` /
  `payment_succeeded`), because they drive the dunning banner — but line items, totals and PDFs
  stay in Stripe, which avoids a second place for an amount to be wrong.
- Proration, plan downgrades mid-period and tax are the provider's, handled in its portal. Spectra
  shows a link, not a pricing calculator.
- `monthlyCredits` is granted on subscription activation and period rollover via webhook. An
  organization with no subscription gets no allowance today — the free plan's 100 credits need a
  scheduled grant, which is the first follow-up.
