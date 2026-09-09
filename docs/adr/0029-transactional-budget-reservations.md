# ADR-0029: Transactional budget reservations

**Status:** Accepted · **Date:** 2026-09-09 · **Relates to:** ADR-0028, ADR-0027, ADR-0026

## Context

ADR-0028 introduced budget reservations so in-flight work would count against a ceiling before
its real cost landed in the ledger. It closed most of the gap but not the last one, and the ADR
said so: _"two pre-flights that read before either writes can still both pass."_

The reason was structural. `reserve()` performed two separate statements:

1. read the budget, the period's spend, and the active reservations, then decide;
2. write the hold.

Two operations arriving together both execute step 1 against the same state, both conclude there
is room, and both proceed to step 2. Each individually respected the ceiling; together they
exceeded it. **A hold is worthless if acquiring it is not atomic with the decision to allow it.**

This was not theoretical. Removing the fix below and re-running the new concurrency test lets
**7 of 10** concurrent operations through where exactly one should pass.

## Decision

The entire decide-and-hold sequence runs inside one database transaction, serialized by a
PostgreSQL **transaction-scoped advisory lock keyed on `organizationId`**.

```
$transaction:
  pg_advisory_xact_lock(hashtextextended(organizationId, 0))
  → idempotency lookup
  → preflight (ceilings, per-kind limits, active reservations)
  → BLOCK ⇒ throw (rolls back — no partial hold)
  → create reservation
```

### Why an advisory lock rather than row locks

`SELECT … FOR UPDATE` needs a row to lock, and a budget row **legitimately may not exist**: a
workspace with no cost ceiling still has per-kind operation limits to enforce. Locking "the
budget row" would silently do nothing precisely where unpriceable work is bounded. An advisory
lock needs no row.

### Why the key is the organization, not the workspace

The organization ceiling aggregates across that organization's workspaces. A workspace-scoped
lock would leave two different workspaces free to race the same organization allowance — the
integration test covers exactly this. Organization-scoped serialization is the smallest scope
that makes both checks safe.

### Deadlock handling

There is nothing to handle: **exactly one lock is acquired per transaction**, so no lock-ordering
cycle can form. This is a deliberate property of the design rather than a mitigation. Being
transaction-scoped, the lock is released on commit _and_ on rollback, so an erroring or crashing
reserve cannot strand it.

### Why not SERIALIZABLE

The advisory lock already serializes the critical section, so READ COMMITTED is sufficient.
SERIALIZABLE would add `40001` serialization failures and a retry loop for no additional safety.

### Idempotency

The idempotency lookup happens **before** the decision, inside the lock. A retry must re-use its
own hold rather than re-evaluating against a budget its own reservation is inflating — otherwise
a retried job could be blocked by itself. Concurrent retries of the same key serialize on the
lock, so the second sees the first's committed row: a retry storm creates exactly one hold. A key
that resolves to another tenant's reservation is refused rather than handed back.

### Stale reservations

Holds carry `expiresAt` and pre-flight ignores expired ones, so a crashed worker cannot
permanently consume an allowance. A recurring `budget.reservation.sweep` job marks them
`RELEASED` — hygiene, keeping the table bounded and interpretable, not correctness.

### Reconciliation

Settlement is tenant-scoped (`organizationId` + `workspaceId` + key), never by key alone:

| Outcome                          | Action                    | Why                                                                                  |
| -------------------------------- | ------------------------- | ------------------------------------------------------------------------------------ |
| Success                          | `reconcile`               | Real usage is in the ledger; the hold must stop counting or spend is double-counted. |
| Failure before the provider call | `release`                 | Nothing was spent.                                                                   |
| Failure after the provider call  | `reconcile`               | Something was spent and the ledger has it.                                           |
| Retry                            | re-uses the existing hold | No double-reserve.                                                                   |
| Cancellation / refusal           | `release`                 | Never ran.                                                                           |
| Crash                            | expiry, then sweep        | No settlement code runs at all.                                                      |

### Applied paths

Research runs, content generation, knowledge-search embedding, re-embed enqueue, re-embed
per-batch, and publishing attempts all reserve transactionally.

**The API layer was also fixed.** It had been calling `assertPreflight` and then `reserve` as two
separate steps — reproducing the very race this ADR removes, one layer up. Both research runs and
content drafts now mint the row id up front, reserve atomically against it, and only then create
the row (releasing the hold if creation fails). The API concurrency test caught this.

### Tenant guard

`UsageEvent`, `WorkspaceBudget`, `OrganizationBudget`, `BudgetOperationLimit` and
`BudgetReservation` joined `TENANT_SCOPED_MODELS`, so an un-scoped multi-row budget query now
throws rather than relying on convention. The one deliberate exception is the cross-tenant expiry
sweep, which uses `$executeRaw` and touches only expiry bookkeeping.

## Consequences

- Concurrent operations can no longer overspend the same remaining allowance. Proven against real
  PostgreSQL: 10 concurrent reserves against room for one yield exactly one winner, and the test
  fails without the lock.
- **Budget decisions within one organization are serialized.** Each transaction is short (a
  handful of indexed queries), but a very high reservation rate in a single organization will
  queue on this lock. Correctness was preferred over throughput; sharding the lock by
  `(organization, kind)` is possible later, at the cost of making the org ceiling unsafe again
  unless it is handled separately.
- Reservations still hold **estimates**, so the ceiling remains approximate for the reasons in
  ADR-0028 (unpriced operations, conservative fallback pricing). Atomicity fixes _who gets the
  allowance_, not _how accurately it is measured_.
- Advisory locks are PostgreSQL-specific. The budget engine is no longer database-portable —
  acceptable given ADR-0004, and called out here rather than discovered later.
- A reservation may be reconciled while the underlying job is retried by BullMQ; the retry re-uses
  the same idempotency key but its hold is already settled, so the retry proceeds on the ledger
  state alone. Acceptable: by then the real usage is recorded.
