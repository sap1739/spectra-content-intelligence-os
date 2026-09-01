# ADR-0026: Usage metering — measured spend, estimated cost, capped runs

**Status:** Accepted · **Date:** 2026-08-31 · **Relates to:** ADR-0017, ADR-0023, ADR-0024, ADR-0025

## Context

Phases 3A, 5A, 5B and 5C each wired a paid provider — Anthropic generation, Voyage embeddings,
Brave search, and page fetching at discovery time. Nothing counted any of it. An operator could
not answer "what did this workspace cost me?", and a single research run could fan out to an
unbounded number of fetches (queries × results-per-query) with no ceiling.

Two failure modes follow: silent overspend, and — worse for this product — a billing surface
that invents numbers to look complete.

## Decision

Meter what actually happened; estimate cost separately and label it as an estimate; cap the one
genuinely unbounded loop.

1. **`UsageEvent` is an append-only ledger.** Tenant-scoped rows carry kind
   (`AI_GENERATION`/`AI_EMBEDDING`/`WEB_SEARCH`/`NEWS_SEARCH`/`PAGE_FETCH`), provider, model,
   requests, token counts, bytes, the estimate, the rate version, and what the spend was for
   (`resourceType`/`resourceId`).

2. **Unreported means NULL, never zero.** Token columns stay null when a provider does not report
   them. Zero would read as "measured, and it was free" — a different and false claim. The
   summary endpoint counts unpriced events separately rather than folding them in at zero.

3. **Cost is an estimate, and says so.** `estimateCostMicros` prices usage from a local,
   versioned rate table (`RATE_VERSION`). An unknown provider/model yields `null`, not `0`. Every
   stored row records the rate version that priced it, so old rows stay interpretable after
   prices change. The API response and the UI both state plainly that these are estimates from a
   local table, not vendor invoices.

4. **The embedding port now returns usage with its vectors.** `EmbeddingProvider.embed()` returns
   `{ vectors, usage? }`. Voyage already parsed `usage.total_tokens` and threw it away; metering
   embeddings honestly required surfacing it. Usage travels _with_ the result rather than through
   a `lastUsage()` accessor, because one provider instance serves concurrent callers and a
   stateful accessor would attribute one caller's tokens to another.

5. **Metering never breaks the work it measures.** A failed ledger write is logged and swallowed.
   Losing a ledger row is bad; failing a research run the user already paid for because the meter
   hiccuped is worse.

6. **Per-run page-fetch budget (ADR-0025 follow-up).** Discovery caps fetches per run (default
   100). Past the cap, candidates are still ingested — as snippet-only — and the run reports that
   the budget was reached. Degrading quality visibly beats either dropping real results or
   fetching without limit.

7. **The billing page reports usage, and disclaims billing.** It replaces the placeholder with
   real ledger data and states that no payment provider is connected, so nothing is charged.

## Rationale

- **Measured vs. estimated is the whole point** — conflating them is how a usage page becomes a
  lie. Quantities come from providers; money is our arithmetic on top, versioned and labelled.
- **Null over zero** — the codebase's existing honesty rule (`externalAvailable: false`,
  `UNSUPPORTED`, "not live-verified") applied to numbers.
- **Cap the loop, not the feature** — a budget that degrades to snippets keeps research working
  under a ceiling; one that aborts the run would make the cap worse than the overspend.

## Consequences

- Operators can see real spend per workspace, broken down by operation, with recent activity.
- The rate table is maintained by hand and will drift from vendor pricing; `RATE_VERSION` makes
  that visible but does not fix it. Rates are list prices — discounts, tiers and free allowances
  are not modelled.
- Budgets are per-run only. There is no per-workspace monthly cap and no enforcement that blocks
  work before it starts — a run can still cost whatever 100 fetches plus its queries cost. That
  is the next increment.
- No payment provider, plans, or invoicing exist. Nothing here charges anyone.
- Ledger rows are written best-effort, so the ledger is a strong signal, not an audit-grade
  financial record.
