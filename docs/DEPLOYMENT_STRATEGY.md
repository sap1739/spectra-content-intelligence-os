# Deployment Strategy

Phase 1 is local-first; this documents the production architecture the foundation was shaped
for, so later phases deploy without redesign.

## 1. Topology

| Component      | Target                                          | Scaling                                                                     |
| -------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| apps/web       | Container (Node standalone) or Next-native host | Horizontal, stateless                                                       |
| apps/api       | Container behind LB                             | Horizontal, stateless (sessions in store)                                   |
| apps/worker    | Container(s)                                    | Horizontal by queue depth; research pipelines isolate into dedicated queues |
| PostgreSQL     | Managed (pgvector-capable: RDS/Cloud SQL/Neon)  | Vertical + read replicas later                                              |
| Redis          | Managed (ElastiCache/Upstash w/ persistence)    | Per BullMQ sizing                                                           |
| Object storage | S3 / R2 / any S3-compatible                     | Native                                                                      |

Environments: `dev` (compose) → `staging` → `production`; same images promoted, only env
differs — configuration is entirely environment-driven and validated at boot.

## 2. Release pipeline

1. CI (lint, typecheck, unit, build, integration, e2e) on every PR.
2. Main merge → build multi-stage Docker images (pnpm fetch → build → prune prod deps) →
   push with git-sha tags.
3. `prisma migrate deploy` as a release step **before** rollout (expand-and-contract rule:
   migrations must be backward-compatible with the previous app version).
4. Rolling deploy; API readiness (`/health/ready`) gates traffic; worker drains gracefully
   (SIGTERM handling already implemented).

**Readiness semantics matter for the LB config.** `/health/ready` separates required from optional
dependencies (ADR-0033): Postgres and Redis being down returns `503` and pulls the instance out of
rotation; the worker heartbeat, the job queue and object storage returning down mark the response
`degraded` with `200`, because the API still serves reads when background work is stalled. **Wire
the load balancer to the status code, and alert on `degraded` separately** — treating `degraded` as
unhealthy will take a serving deployment offline over a stalled queue.

## 3. Secrets & config

Secret manager (AWS SM / GCP SM / Doppler) injects env at runtime; the encryption key ring
(`security` KeyRing JSON) rotates by adding a new active key. No secrets in images or repos.

## 4. Observability in production

Implemented in Phase 6B (ADR-0033).

**Logs.** Structured pino → log pipeline, indexed by `correlationId`. The same correlation id
appears on the HTTP request, the queued job and the worker span, so one id follows a research run
end to end. Redaction is enforced in the logger itself, not at the pipeline.

**Traces.** OpenTelemetry over OTLP/HTTP, entirely optional:

| Variable                      | Effect                                                              |
| ----------------------------- | ------------------------------------------------------------------- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Unset => tracing off, SDK never loaded, reason logged once at boot  |
| `OTEL_EXPORTER_OTLP_HEADERS`  | Comma-separated `key=value` (collector auth). Secret — never logged |

Set the **same endpoint in the API and the worker** or a request will not join the background job
it queued. `initTracing` never throws: a broken collector degrades telemetry, never traffic. Span
attributes are allow-listed, so an attribute that is not on the list silently does not appear on
your dashboard — see `docs/SECURITY.md` §12 before adding one.

**Metrics.** Prometheus text exposition at `GET /v1/meta/metrics` on the API (unauthenticated,
pull-based).

| Metric                                | Type      | Labels                      | Emitted by                |
| ------------------------------------- | --------- | --------------------------- | ------------------------- |
| `spectra_api_request_duration_ms`     | histogram | `route`, `method`           | API                       |
| `spectra_api_request_errors_total`    | counter   | `route`, `method`, `status` | API                       |
| `spectra_api_rate_limited_total`      | counter   | `route`, `method`           | API                       |
| `spectra_queue_depth`                 | gauge     | `state`                     | API (read at scrape time) |
| `spectra_ops_job_retries_total`       | counter   | `job`                       | API                       |
| `spectra_worker_job_duration_ms`      | histogram | `job`, `outcome`            | Worker                    |
| `spectra_worker_job_failures_total`   | counter   | `job`                       | Worker                    |
| `spectra_queue_dead_lettered_total`   | counter   | `job`                       | Worker                    |
| `spectra_provider_latency_ms`         | histogram | `provider`, `op`, `outcome` | Worker (pipelines)        |
| `spectra_research_run_duration_ms`    | histogram | `outcome`                   | Worker                    |
| `spectra_publish_attempt_duration_ms` | histogram | `outcome`                   | Worker                    |
| `spectra_budget_blocked_total`        | counter   | `surface`, `reason`, `kind` | API + worker              |

`spectra_budget_blocked_total` is deliberately **not** an error metric: a budget refusal is the
platform doing what it was configured to do. Alert on it as a product signal — usually a limit that
needs raising — not as an outage.

Provider, run and publish metrics are emitted from the pipeline packages, which execute on the
worker. **The worker does not expose a scrape endpoint yet**, so today those series are visible
only in a process that renders the registry; the API endpoint carries the API's own series. Adding
a worker metrics listener is the next observability increment.

A gauge whose source is unreachable is **omitted from the exposition rather than reported as 0**.
Alert on `absent(spectra_queue_depth)` as well as on its value: a missing series means the depth is
unknown, which is a different incident from a depth of zero.

**Alerting baseline.** Readiness `down`; `degraded` sustained > 5 min; dead-letter depth > 0;
worker heartbeat stale; `spectra_api_request_errors_total` rate; migration failures; and
`spectra_budget_blocked_total` rising (customers are being refused work — usually a limit that
needs raising, not an outage).

**Failure triage.** The Operations page (`/operations`, `ops:read`) lists this workspace's failed
and dead-lettered jobs with their reason and correlation id, and retries them under `ops:retry`.
Retry re-runs the original job, so idempotency keys and budget pre-flight still apply — it is safe
to hand to support. See `docs/SECURITY.md` §13.

## 5. Data protection

Postgres PITR backups + restore drills; object-store versioning + lifecycle rules aligned
with tenant retention policies; Redis treated as rebuildable (queues drained, schedulers
re-registered on boot).

## 6. Open items (revisit with Phase 4 scale data)

Multi-region posture, per-tenant rate-limit tiers, queue partitioning by tenant size, RLS
enablement, CDN strategy for media delivery.

## 7. Social OAuth (Phase 6C, ADR-0034)

- **Secrets:** `SOCIAL_OAUTH_<PLATFORM>_CLIENT_SECRET` and `SOCIAL_TOKEN_ENCRYPTION_KEY` come from the
  secret manager, never the image. Half a client pair, a non-32-byte key, or an http OAuth URL in
  production fails boot with the variable named.
- **Redirect URIs:** register `<SOCIAL_OAUTH_REDIRECT_BASE_URL>/v1/social/oauth/<platform>/callback`
  for each platform in its developer console. The base must be the API's public https origin (and
  path prefix, if the API is served under one).
- **Return origin:** `WEB_APP_URL` must be one of `API_CORS_ORIGIN`; the callback only ever
  redirects there.
- **Session cookie:** keep it `SameSite=Lax`. The callback arrives as a cross-site top-level
  redirect; `Strict` would drop the session and fail every connection with `session_required`.
- **Key rotation:** set the same key ring in the API and the worker; the runbook is
  `docs/SECURITY.md` §14.
- **Metrics:** `spectra_oauth_flows_total{platform,stage,outcome}` counts starts, callbacks,
  refreshes and disconnects by outcome — a rise in `state_invalid` or `replayed` is worth an alert.
- **LinkedIn (Phase 6D):** the worker publishes, so it needs `SOCIAL_TOKEN_ENCRYPTION_KEY` and —
  to refresh tokens before publishing — the same `SOCIAL_OAUTH_LINKEDIN_CLIENT_ID/SECRET` and
  redirect base URL as the API. Pin `LINKEDIN_API_VERSION` and move it forward before LinkedIn
  sunsets it. Run `docs/LINKEDIN_LIVE_VERIFICATION.md` against a real app before announcing it.
