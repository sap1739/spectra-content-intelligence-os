# ADR-0020: Publishing pipeline v1 — real dispatch machinery, honest UNSUPPORTED terminal

**Status:** Accepted · **Date:** 2026-07-14 · **Relates to:** ADR-0006, ADR-0019, ADR-0017

## Context

Phase 4B is the publishing pipeline: schedule content, dispatch it when due, attempt to publish,
track status, retry safely, surface failures. But no platform adapter is wired (ADR-0019), and
the ground rules forbid claiming a post went out when none did. We need the full machinery —
real queue, real idempotency, real status tracking — that resolves to a **truthful** terminal
state until an adapter exists.

## Decision

Build the pipeline on the existing calendar (`ContentScheduleEntry` is the scheduled placement)
and the empty `social-core` publisher registry, mirroring the async-executor pattern used for
research and content generation (ADR-0015, ADR-0017).

1. **`ContentScheduleEntry` becomes the publication record.** Added `socialAccountId` (optional
   target), `idempotencyKey` (unique), `attemptCount`, `lastAttemptAt`, `failureReason`,
   `externalPostId`/`externalUrl`/`publishedAt`. Status gains `QUEUED`, `PUBLISHING`, and
   `UNSUPPORTED` alongside `SCHEDULED`/`PUBLISHED`/`FAILED`/`CANCELLED`.

2. **`@spectra/publishing` — worker-callable executor.** `claimDuePublications` atomically flips
   due, targeted, `SCHEDULED` entries to `QUEUED` (guarded `updateMany` — safe under concurrent
   dispatchers). `executePublication` marks `PUBLISHING`, increments attempts, then looks up
   `registry.getPublisher(platform)`:
   - **No publisher wired ⇒ `UNSUPPORTED`** with a truthful `failureReason` ("No live publisher is
     wired for X. Nothing was published."). This is an honest terminal state, **not** a fabricated
     `PUBLISHED` and not a system failure.
   - **Publisher wired (future) ⇒** `createPost(idempotencyKey, …)` → `PUBLISHED`/`FAILED`,
     recording the external id/url; a published entry moves the item to `PUBLISHED`.
     Idempotent — an entry not `QUEUED`/`PUBLISHING` is skipped on re-delivery.

3. **Worker dispatch.** A recurring `publication.dispatch` job (every 60s) claims due entries and
   enqueues one `publication.publish` job each; the publish handler runs `executePublication`.
   BullMQ retry + DLQ apply to the publish job (the executor also records failures, so a stuck
   `QUEUED`/`PUBLISHING` row never happens).

4. **API.** Scheduling accepts an optional tenant-scoped `socialAccountId` and always mints an
   `idempotencyKey`. `POST calendar/:id/publish` (perm `social:publish`) queues an entry for
   immediate dispatch; it requires a target account (422 otherwise) and is allowed from
   `SCHEDULED`/`UNSUPPORTED`/`FAILED` (retry). The calendar UI polls while entries are in flight
   and surfaces `UNSUPPORTED`/`FAILED` with the reason.

## Rationale

- **Machinery now, adapters later** — the same dispatch/executor path produces `PUBLISHED` the
  moment a real adapter registers; nothing about the pipeline changes.
- **Honest terminal state** — `UNSUPPORTED` distinguishes "no adapter" from a genuine `FAILED`,
  so operators are never misled into thinking content was posted.
- **Idempotent + concurrency-safe** — the unique `idempotencyKey` and guarded claim make
  re-delivery and parallel dispatchers safe (queue-neutral, per ADR-0006).

## Consequences

- Nothing is published until a real platform adapter is registered — by design; every attempt is
  recorded truthfully as `UNSUPPORTED`.
- Retries are supported (`publish-now` re-queues `UNSUPPORTED`/`FAILED`); a formal DLQ dashboard
  and per-attempt history table are deferred.
- OAuth token refresh and the first live adapter (WordPress/LinkedIn/YouTube) are the next work;
  they slot into `executePublication` behind the registry with no pipeline change.
