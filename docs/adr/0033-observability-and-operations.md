# ADR-0033: Observability — optional tracing, first-party metrics, operator-visible failures

**Status:** Accepted · **Date:** 2026-09-10 · **Relates to:** ADR-0004, ADR-0008, ADR-0026, ADR-0029

## Context

Everything after Phase 3 runs asynchronously. A research run, a draft generation, an embedding
pass and a publish attempt all happen on the worker, minutes after the request that queued them.
Until now the only evidence any of it happened was a log line and a row in the database.

That left three gaps.

**Failures were invisible.** A job that exhausted its retries went to the dead-letter queue
(ADR-0008) and stopped there. Nothing listed it, nothing retried it, and no one found out unless a
customer asked why their content never appeared.

**There were no numbers.** Request latency, error rate, queue depth, provider latency and budget
refusals existed only as individual log lines. "Is the system healthy?" could only be answered by
reading logs.

**Readiness was too narrow.** `/health/ready` checked Postgres, Redis and the worker heartbeat. A
reachable Redis with an unusable queue, or unreachable object storage, both read as ready.

The constraint that shapes the answer: this is a multi-tenant platform handling other people's
credentials, documents and prompts. Telemetry is the one subsystem whose entire job is to copy
internal state somewhere else — increasingly to a third party. It is therefore the subsystem most
able to leak.

## Decision

### 1. Tracing is optional, lazy, and off by default

`@spectra/telemetry` exposes `initTracing(config, logger)`. With no `OTEL_EXPORTER_OTLP_ENDPOINT`
it returns `{ enabled: false, reason }` and the OpenTelemetry SDK is never imported — no exporter
threads, no background flush attempts, no dependency cost in a deployment that does not use it. The
reason is logged at boot, so an operator who expected traces learns immediately that they are off
rather than hunting an empty dashboard.

`initTracing` never throws. A broken collector must not stop the API from serving traffic.

`withSpan(name, attributes, fn)` works against the API's built-in no-op tracer when tracing is
disabled, so call sites never branch on whether telemetry is configured.

### 2. Span attributes are an allow-list, not a deny-list

Logs are redacted by path (`@spectra/logging`). Spans are not logs: they leave the process for a
backend we do not control, and they are written by call sites that will keep being added. A
deny-list fails open — the first attribute someone forgets to add to it ships to the vendor.

So `ALLOWED_SPAN_ATTRIBUTES` enumerates what may be exported, and `safeSpanAttributes()` drops
everything else. Objects and arrays are dropped whole (they are where payloads hide), and strings
are truncated. Adding a new attribute is a deliberate edit to that list.

Tenant **identifiers** are on the list; tenant **content** can never get on it.

### 3. Metrics are first-party, in-process and cardinality-capped

`MetricsRegistry` implements counters, histograms and gauges directly and renders Prometheus text
exposition at `GET /v1/meta/metrics`. Scraping is a pull, so no metrics endpoint is required for
the platform to function, and Prometheus/OTLP-metrics can be layered later without changing call
sites.

Two safety rules are built into the registry:

- **A cardinality cap** (500 series per metric). Label values come from routes, job names,
  providers and outcomes; the cap ensures an unbounded value can never blow up memory.
- **A gauge whose getter throws is omitted, not reported as zero.** "Queue depth unknown" and
  "queue depth zero" are opposite operational situations. This is the same rule as everywhere
  else in the platform: unavailable never renders as fine.

Requests are labelled by **route pattern** (`/v1/workspaces/:workspaceId/ops/queue`), never by the
resolved URL, so no identifier reaches the metrics backend.

### 4. Failed jobs are listed and retried, tenant-scoped, from the product itself

`BullMqQueueInspector` reads queue counts, failed jobs and dead-letter entries; the API exposes
them under `ops:read`, and retry under `ops:retry`.

Three decisions here matter more than the endpoints:

- **Retry re-runs the original job, not a copy.** BullMQ's `retry()` moves the existing job back to
  waiting with its id, name and payload intact. The id is the idempotency key, and the executor's
  own budget pre-flight (ADR-0029) runs again on execution. Enqueuing a copy would defeat both.
- **Tenant scope fails closed.** A job whose envelope records no tenant is excluded from every
  tenant-scoped listing. Showing an unattributed job to a tenant that may not own it is worse than
  omitting it.
- **A foreign job and a non-existent job return the same 404.** Retry checks ownership before it
  acts, and the two cases are indistinguishable to the caller — the platform's standing rule
  against existence leaks.

The failure **reason** is surfaced (truncated); the payload never is.

### 5. Readiness distinguishes required from optional dependencies

Added `job-queue` and `object-storage` as **optional** indicators: the API can still serve reads
when background work is stalled or storage is unreachable, so these degrade readiness rather than
failing it and pulling the service out of the load balancer. A non-empty dead-letter queue
degrades readiness too — it is a real operational problem that should be visible on a dashboard,
not a reason to stop serving traffic.

Component details carry counts and states only. No endpoint, bucket, key or credential appears in
a readiness body, because readiness is typically unauthenticated.

### 6. Log redaction widened at the same time

Redaction now covers header casings (`Authorization`, `X-Api-Key`, `Cookie`, `Set-Cookie`),
credential shapes (`applicationPassword`, `encryptedToken`, `sessionToken`, `passwordHash`,
`privateKey`, `clientSecret`), **model input and output** (`prompt`, `completion`, `messages`,
`instructions`), extracted content (`extractedText`, `rawHtml`) and payment fields. Model I/O is
customer content and third-party document text; it has no business in a log line.

## Rationale

An observability layer is the wrong place to be clever. Everything above is a choice of the
conservative option:

- **Off by default** rather than a sensible default endpoint — nobody's telemetry leaves this
  deployment because a config file had a placeholder in it.
- **Allow-list** rather than deny-list — because the failure mode of the deny-list is silent
  exfiltration and the failure mode of the allow-list is a missing attribute on a dashboard.
- **In-process metrics** rather than a metrics SDK — the exposition format is stable and trivial;
  the dependency, the push pipeline and the second set of credentials are not worth it yet.
- **Retry the original job** rather than re-enqueue — the alternative silently disables the two
  guarantees (idempotency, budget pre-flight) that the async paths depend on.

The one place we accept extra work is the span allow-list: adding an attribute takes an edit in a
second file. That friction is the point.

## Consequences

- Deployments without a collector run exactly as before, and say so once at boot.
- Adding a span attribute requires adding it to `ALLOWED_SPAN_ATTRIBUTES`; an attribute that is not
  on the list is dropped silently at export time, which will look like a missing field on a
  dashboard. This is documented in `docs/SECURITY.md`.
- `GET /v1/meta/metrics` is public (Prometheus scrape). It is safe because it carries no tenant
  identifiers or content — but it does reveal route names and rough traffic shape, so a deployment
  that considers that sensitive must restrict it at the ingress.
- Operators can now retry customer jobs. That is an audited action (`ops.job.retried`) gated behind
  a distinct `ops:retry` permission, separate from `ops:read`.
- Queue counts are global to the deployment while the failed-job list is tenant-scoped. A tenant
  therefore sees an accurate list and a shared depth figure; the depth is deliberately not
  presented as theirs.
