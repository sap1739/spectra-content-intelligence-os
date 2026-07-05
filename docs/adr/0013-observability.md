# ADR-0013: Observability — structured pino logs + correlation ids, OpenTelemetry-ready

**Status:** Accepted · **Date:** 2026-07-05

## Context

Debugging multi-hop flows (web → API → queue → worker → providers) requires correlation;
logs must never leak secrets; metrics/tracing should not be over-built before real traffic.

## Decision

- **Logging:** pino JSON everywhere via `@spectra/logging` — ISO UTC timestamps, service
  bindings, and a **mandatory redaction path set** (tokens, passwords, keys, payment data,
  document content) that callers cannot opt out of.
- **Correlation:** `x-correlation-id` accepted/generated per request (Fastify hook), echoed
  in responses, stamped into audit logs and propagated to jobs via `JobEnvelope`;
  AsyncLocalStorage context available for implicit access.
- **Health:** dependency-free liveness + aggregated readiness (`aggregateHealth`) with
  required vs. optional components (worker heartbeat is optional/degrading).
- **Metrics/tracing:** deferred to Phase 2 — OpenTelemetry SDK wiring at the app composition
  roots (Nest interceptor, BullMQ instrumentation), exporting OTLP. Nothing in domain
  packages will change: spans wrap ports.

## Rationale

pino is the fastest structured logger in the Node ecosystem and its redaction is
battle-tested; correlation ids deliver 80% of trace value at 5% of the setup cost now, and
OTel slots in at the adapter seams later without domain rewrites.

## Consequences

- Redaction behaviour is unit-tested; new sensitive fields must be added to
  `MANDATORY_REDACT_PATHS` with tests.
- Dashboards/alerts (readiness failures, DLQ depth, heartbeat staleness) are defined in
  DEPLOYMENT_STRATEGY.md and land with the first deployed environment.
