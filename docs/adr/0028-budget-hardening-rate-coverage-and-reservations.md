# ADR-0028: Budget hardening — rate coverage, embedding guards, per-kind limits, org ceilings, reservations

**Status:** Accepted · **Date:** 2026-09-09 · **Relates to:** ADR-0026, ADR-0027, ADR-0023, ADR-0024

## Context

ADR-0027 delivered workspace budgets with pre-flight enforcement. An audit of that work found
the mechanism sound but the coverage incomplete, in one case seriously:

- **`voyage-4` — the repository's DEFAULT embedding model — had no rate-table entry.** On a
  default deployment with `VOYAGE_API_KEY` set, every embedding priced to `null` and contributed
  **nothing** to any ceiling. An entire paid category was invisible to enforcement while the
  budget reported itself unbreached. The existing tests passed because they asserted an
  explicitly-named model (`voyage-3.5`) rather than the default the repo ships with.
- Two embedding paths bypassed budgets entirely: knowledge search (per-query embedding) and the
  re-embed backfill — the single most expensive operation in the product.
- Limits existed only as a total cost ceiling, so operations that are free, unpriced or not
  vendor-billed could not be bounded at all.
- No organization-level ceiling above the workspace.
- No concurrency control: two simultaneous pre-flights could both pass against the same
  remaining allowance.
- Publishing had no budget seam, so a future paid publishing provider would bypass enforcement
  by construction.

## Decision

### 1. Unknown cost is never silently zero

`estimateCost` now returns either a number **with a `rateSource`**, or `null` **with an explicit
`unpricedReason`**. Both are persisted on every `UsageEvent`. The reasons are distinct facts and
must not collapse:

| Reason                 | Meaning                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `NO_RATE_FOR_MODEL`    | Real spend we cannot price. **This is the gap worth closing.**          |
| `FREE_LOCAL`           | First-party/local work that genuinely costs nothing.                    |
| `NOT_VENDOR_BILLED`    | Real external work, not billed per-unit (page fetches).                 |
| `NO_MEASURED_QUANTITY` | A rate exists, but the provider reported nothing to price.              |
| `COUNTER_ONLY`         | Counted for limits only; spend is metered on the underlying operations. |

Collapsing these into "cost: 0" is the same class of error as fabricating analytics: it reports
a precise-looking number that is not true.

### 2. Conservative family fallback for known paid providers

An unknown model from a provider we _definitely pay_ (`voyage`, `anthropic`, `brave`) is priced
at the most expensive rate known for that provider and flagged
`FAMILY_FALLBACK_CONSERVATIVE`. We do not have verified list pricing for every future model, and
inventing a precise figure would be its own dishonesty — so spend is **over-stated rather than
invisible**, and the over-statement is labelled everywhere it surfaces. A provider we have no
relationship with still returns `NO_RATE_FOR_MODEL`; the fallback is not a licence to guess.

### 3. Default-provider rate-coverage regression test

`rate-coverage.test.ts` reads the defaults from the repository's own config
(`apiEnvSchema.parse({})`, `DEFAULT_VOYAGE_MODEL`) rather than hard-coding model names, and
asserts every default paid provider resolves to a non-null estimate — plus that no `null`
estimate ever lacks a reason. Hard-coding the model name is precisely how the original defect
survived testing.

### 4. Embedding paths are guarded

Knowledge search runs pre-flight **before** calling the provider; `POST /knowledge/reembed`
refuses **before enqueueing**, so a blocked workspace never has paid work sitting in the queue;
and the re-embed executor re-checks **every batch**, not once at entry — a corpus backfill spends
continuously and a single entry check would let it run straight through a ceiling it crossed
mid-run. A budget stop ends the backfill honestly, reporting how far it got and how much remains.
The lexical fallback is `FREE_LOCAL` and is never blocked: search keeps working, visibly lexical.

### 5. Per-operation monthly limits

`BudgetOperationLimit` caps requests and (where measured) tokens per `UsageKind`, at workspace or
organization scope, independent of estimated spend. This is the **only** bound that works for
operations we cannot price — which is exactly why unpriced work is allowed but still counted.
Events whose token counts were never reported are counted as operations but **not** as zero
tokens; they surface as `unknownQuantityEvents`.

### 6. Organization ceiling above the workspace

`OrganizationBudget` is optional. Pre-flight evaluates workspace and organization ceilings
together and the **stricter decision wins**. Organization aggregates span that organization's
workspaces only.

### 7. Publishing passes through pre-flight

Publishing is not vendor-billed today, so it normally yields
`UNKNOWN_COST_ALLOW_WITH_NOTICE` — but it counts against a `PUBLISH_ATTEMPT` per-kind limit, and
the seam exists so a paid publishing provider added later cannot bypass enforcement. Unsupported
platforms still resolve to the honest `UNSUPPORTED`; nothing about that changed.

### 8. Reservations for concurrency

`BudgetReservation` holds estimated cost for in-flight work so the next pre-flight sees it as
committed. Reservations are **advisory, not accounting**: keyed by an idempotency key (a retry
re-uses its own hold rather than stacking a second), reconciled against real metered usage on
completion so spend is not double-counted, released when work never ran, and expiring so a
crashed worker cannot permanently consume an allowance. Implemented for the highest-risk paths:
research runs, content generation, re-embed.

### 9. Refusals stay 403 problem+json

`BudgetBlockedError` maps to `403` with `type: .../budget-exceeded` and the decision attached —
not `402`, because nothing here charges anyone and "Payment Required" would imply a bill that
does not exist. No foreign-tenant data appears in the body.

## Consequences

- Default embedding spend now counts toward ceilings; the category is no longer invisible.
- Costs priced by family fallback are **over-stated**. That is deliberate — the alternative was
  under-stating them to zero — but a fallback-priced ceiling is not a precise one.
- The rate table remains hand-maintained list pricing. `RATE_VERSION`, `rateSource` and the
  unpriced report make drift and gaps visible; they do not eliminate them.
- Reservations reduce but do not eliminate concurrent overspend: two pre-flights that read
  before either writes can still both pass. Closing that fully needs a transactional
  reserve-and-check (`SELECT … FOR UPDATE` or a serializable transaction), which is deferred.
- Per-kind limits are monthly and calendar-aligned (UTC); no rolling windows or burst limits.
- `REQUIRES_APPROVAL` is defined in the decision contract but nothing emits it yet — there is no
  approval workflow. It exists so adding one does not change the contract.
- Publish attempts are metered only once a publisher actually ran; `UNSUPPORTED` attempts do not
  count against the publish limit, since nothing external was attempted.
- Document extraction and media render kinds exist for limits but nothing emits them yet.
