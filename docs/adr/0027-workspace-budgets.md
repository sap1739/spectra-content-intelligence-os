# ADR-0027: Workspace budgets — pre-flight enforcement on an estimate

**Status:** Accepted · **Date:** 2026-09-09 · **Relates to:** ADR-0026, ADR-0024, ADR-0025

## Context

ADR-0026 built the usage ledger: every paid operation is measured and attributed. But counting is
not control. A workspace could still spend without limit, and the only ceiling was per-run (100
page fetches). Nothing stopped work _before_ it started, and nothing bounded a month.

The hard part is that the only spend figure available is an **estimate** — priced from a local
rate table, excluding operations with no known rate. Enforcing a hard limit on an approximate
number risks two dishonest outcomes: refusing work on a figure presented as exact, or reporting
"within budget" while real spend is higher than measured.

## Decision

Add an optional per-workspace monthly ceiling, evaluated before expensive work and again at
execution time, with the estimate's incompleteness carried in every decision.

1. **`WorkspaceBudget`, one optional row per workspace.** `monthlyLimitMicros` (NULL = no
   ceiling), `enforcement` (`OFF` / `WARN` / `ENFORCE`), `warnAtPercent`. Evaluated against summed
   `estimatedCostMicros` for the current **UTC calendar month**.

2. **`NOT_CONFIGURED` is a distinct status, never `OK`.** `OK` asserts that a real limit was
   checked and there is room under it. Saying that when no ceiling exists would be a false
   reassurance, so the absence of a budget reports itself as an absence.

3. **Every decision carries `unpricedEvents`.** Non-zero means real spend is _under_-counted
   relative to the limit. The number travels with the decision — API, UI and refusal message —
   rather than being dropped at the boundary where it stops being convenient.

4. **Only `ENFORCE` blocks.** `WARN` and `OFF` report the identical breach without refusing, so an
   operator can watch real spend against a candidate limit before committing to a hard cap. A cap
   that surprises someone into a failed run is worse than one they opted into.

5. **Enforcement is pre-flight AND at execution.** The API refuses _before_ creating the run/draft
   row and enqueueing — an over-budget workspace never queues work it may not do. The worker
   re-checks, because a job queued before the ceiling was hit can execute after it. On refusal the
   worker marks the row `FAILED` with the reason and **returns without throwing**: retrying cannot
   help until the limit is raised or the month rolls over, so a throw would only burn queue
   attempts on work that must not spend.

6. **Refusal is `403` with a distinct problem type, not `402`.** Nothing in this system charges
   anyone, so `Payment Required` would imply a bill that does not exist. This is a refusal by
   operator policy; `type: .../budget-exceeded` distinguishes it from a permissions failure, and
   the full decision is attached so a client can show exactly what was hit.

## Rationale

- **Honest about the instrument** — the budget is enforced on an estimate, and says so everywhere
  it appears. The alternative (presenting the figure as exact) would be the same class of error
  as fabricating analytics.
- **Two checks, not one** — a pre-flight-only guard has a real gap between enqueue and execute;
  an execution-only guard lets doomed work sit in the queue. Both are cheap.
- **Graduated enforcement** — `WARN` exists so the first thing an operator meets is information,
  not a wall.

## Consequences

- A workspace can be bounded per month, with refusals that state the limit, the spend and the
  period end.
- **The ceiling is approximate.** Operations with no rate contribute nothing, so real spend can
  exceed a limit that reports itself as unbreached. `unpricedEvents` makes this visible but does
  not fix it; closing the gap means broader rate coverage.
- Enforcement is on **estimated cost only** — there are no per-kind sub-limits (e.g. "max N search
  queries"), and no org-level ceiling above the workspace. Both are deferred.
- The period is a fixed UTC calendar month; custom billing periods and rollover policies are not
  modelled.
- Publishing is not budget-guarded: it is not currently a metered paid operation. When a paid
  publishing path lands, it must adopt the same pre-flight guard.
