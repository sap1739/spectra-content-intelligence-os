# ADR-0006: BullMQ for Phase 1 behind queue-neutral ports

**Status:** Accepted · **Date:** 2026-07-05

## Context

Research pipelines, rendering and publishing need queues with retries, idempotency, DLQ,
cancellation, progress, schedules. Compared:

| Option                    | Strengths                                                               | Costs                                                                        |
| ------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| **BullMQ + Redis**        | Simple ops (Redis already present), mature, repeatable jobs, priorities | No native long-workflow orchestration; timeouts/DLQ hand-rolled              |
| **Temporal**              | True durable workflows, replay, signals                                 | Heavy infra (server+DB), SDK learning curve — premature for Phase 1          |
| **Trigger.dev / managed** | Low ops                                                                 | Vendor coupling for the core domain, less control over tenancy/data locality |

## Decision

BullMQ + Redis now, accessed **only** through `JobQueuePort` / `WorkerRuntimePort`
(`@spectra/workflow-core`). Domain code never imports bullmq.

## Rationale

Phase 1–2 needs are queue-shaped (stage jobs advancing a DB-persisted run), not
workflow-engine-shaped; the run state machine lives in Postgres (`ResearchRun.currentStage`),
which keeps us engine-portable. Temporal remains the designated upgrade if orchestration
complexity grows (multi-day human-in-the-loop flows), as a new adapter + stage-runner.

## Consequences

- Idempotency = BullMQ jobId mapping; DLQ = failed-event routing to `<queue>:dead-letter`;
  timeouts = AbortSignal race (handlers must observe `context.signal`).
- An in-memory adapter provides deterministic unit testing of job semantics.
