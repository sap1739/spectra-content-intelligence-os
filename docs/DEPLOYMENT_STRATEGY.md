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

- **Meta (Phase 6E):** the worker needs `SOCIAL_TOKEN_ENCRYPTION_KEY` and
  `SOCIAL_OAUTH_FACEBOOK_CLIENT_SECRET` (every Graph call carries `appsecret_proof`). Instagram
  fetches images from 15-minute signed links, so object storage must be served from a public
  address; with a local or private `STORAGE_ENDPOINT` the worker logs that Instagram is unavailable
  and those posts resolve `UNSUPPORTED`. Pin `META_GRAPH_API_VERSION`, complete Meta App Review
  before customers connect, and run `docs/META_LIVE_VERIFICATION.md` before announcing it.

- **YouTube (Phase 6F):** the worker performs the upload, so it needs `SOCIAL_TOKEN_ENCRYPTION_KEY`
  and the same `SOCIAL_OAUTH_YOUTUBE_CLIENT_ID/SECRET` as the API (it refreshes tokens on the
  standard grant). Set `YOUTUBE_API_PROJECT_AUDITED=true` only once Google has audited the project;
  until then uploads come back private and the UI says why. An upload is held in memory while it is
  sent, so size the worker for the file (Spectra caps a media object at 500 MB). Browser uploads
  need CORS on the bucket for `PUT` from the web origin. Run
  `docs/YOUTUBE_LIVE_VERIFICATION.md` before announcing it.

## 8. External analytics (Phase 6H, ADR-0039)

- **Worker:** runs every sync, so it needs `SOCIAL_TOKEN_ENCRYPTION_KEY` and the same OAuth client
  credentials as the API (to refresh tokens). It registers `analytics.sync.execute` and a
  five-minute `analytics.sync.dispatch`, and logs at boot whether scheduled sync is on.
- **Scheduled sync is off by default.** `ANALYTICS_SCHEDULED_SYNC_ENABLED=true` turns it on;
  `ANALYTICS_SYNC_INTERVAL_MINUTES` (default 360, minimum 15) sets the cadence per workspace. Every
  sync spends platform quota (YouTube's daily units, LinkedIn's daily limits, Meta's rate limits), so
  size the interval to the number of workspaces and posts. The dispatcher always picks up due
  retries, whether or not scheduling is on.
- **Other settings:** `ANALYTICS_STALE_AFTER_HOURS` (24), `ANALYTICS_SYNC_MAX_ATTEMPTS` (3),
  `YOUTUBE_ANALYTICS_API_BASE_URL` (https in production; override only for tests).
- **Scopes:** analytics scopes are not in the default scope lists. Add them per platform with
  `SOCIAL_OAUTH_<PLATFORM>_SCOPES` after the platform approves them, then have users reconnect
  (`docs/ANALYTICS_PROVIDER_SETUP.md`).
- **Cost control:** set an `ANALYTICS_SYNC` operation limit where syncs must be capped; a refused run
  calls no platform.
- **Migration:** `20260914043605_phase6h_external_analytics` adds three tables and two `CHECK`
  constraints; it is additive and safe to deploy before the worker.
- Run `docs/ANALYTICS_LIVE_VERIFICATION.md` before presenting platform numbers to customers.

## 9. Video rendering dependencies (Phase 7B, ADR-0041)

Video rendering is the first feature with a **binary dependency outside the Node runtime**, and
Spectra deliberately does not vendor it: no ffmpeg ships in any image, so the build — and its
licence — is the deployment's choice (OPEN_SOURCE_AND_LICENSE_POLICY.md §3).

### What the worker image needs

```dockerfile
# Debian/Ubuntu base
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# Alpine base
RUN apk add --no-cache ffmpeg font-dejavu
```

Then point the worker at them (or rely on `PATH`):

| Variable                    | Default           | Why                                                                       |
| --------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `FFMPEG_PATH`               | first on `PATH`   | The encoder. Absent → rendering is reported unavailable, not attempted.   |
| `FFPROBE_PATH`              | first on `PATH`   | Reads back what was actually encoded, so stored metadata describes bytes. |
| `VIDEO_FONT_FILE`           | a known base font | `drawtext` needs a font **file**; without one, text overlays are off.     |
| `VIDEO_RENDER_TIMEOUT_MS`   | `900000` (15 min) | Wall-clock ceiling; the encoder is killed, not abandoned.                 |
| `VIDEO_RENDER_MAX_ATTEMPTS` | `3`               | Retries for transient failures.                                           |

### The build matters, and is checked at runtime

`GET /v1/workspaces/:id/video/capabilities` reports the engine version, the H.264 encoder it chose
(`libx264` → `h264_videotoolbox` → `libopenh264`) and whether text overlays, burned-in captions,
crossfades and an audio bed are available — each `false` with a named reason. **Check this endpoint
after deploying a new worker image**: a build missing `libass` silently losing burned-in captions is
exactly the failure this prevents, because such a storyboard is refused up front instead.

The worker also logs its capability line once at startup, so a misconfigured image is visible in the
first lines of its log rather than in a user's failed render.

### Capacity

Encoding is CPU-bound and capped at **two concurrent renders per worker**. A 1080p minute costs
roughly a CPU-minute on a modern core, so plan workers by expected render-seconds, not by request
rate, and give the worker real CPU limits rather than burstable ones. Renders write scratch files to
the system temp directory and clean up in a `finally`, but the container still needs temp space for
the largest expected output plus its inputs.

### What is not needed

No GPU, no Chromium, no font server, and no network access from the encoder — inputs are read from
object storage by the job and handed to ffmpeg as local files, so the engine itself never fetches a
URL.

## 10. Billing configuration (Phase 8A, ADR-0044)

Billing is the first dependency that handles money, and the first whose _absence_ is a supported
state rather than a degradation.

### Environment

| Variable                           | Unset behaviour                                                                                                                                                       |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`                | Billing off. Plans and entitlements **still apply** — every org is on the free plan.                                                                                  |
| `STRIPE_WEBHOOK_SECRET`            | Webhooks are **refused**, so status never updates. Checkout still works, which is the dangerous half-configured state — `GET capabilities` warns about it explicitly. |
| `STRIPE_API_BASE_URL`              | Stripe's API.                                                                                                                                                         |
| `STRIPE_WEBHOOK_TOLERANCE_SECONDS` | 300.                                                                                                                                                                  |
| `BILLING_RETURN_ORIGIN`            | `http://localhost:3000`. **Set this in production** — it is the origin checkout returns to.                                                                           |

### Webhook endpoint

Point Stripe at `POST https://<api-host>/v1/billing/webhook/stripe`. It is deliberately outside
session auth: its signature is its authentication.

Two deployment details matter:

1. **Nothing may rewrite the body.** A proxy that re-serializes JSON breaks every signature. The
   API keeps the raw bytes for this path only; anything in front of it must pass them through
   unmodified.
2. **The endpoint must answer within Stripe's timeout.** It records the event, applies it, and
   returns `200` — including for events it ignores, since any other status triggers a retry.

### Prices are per-deployment

Plans are seeded from the built-in catalog in every environment (the free plan is the entitlement
fallback, so it must always exist). **Prices are not**: they carry provider ids. Create them in
Stripe, then insert one `ProductPrice` row per plan per mode. A plan with no price in the active
mode is shown as not purchasable rather than offering a checkout that would fail.

### Going live

Switching `sk_test_` → `sk_live_` changes the mode, and the mode partitions everything: customers,
prices and subscriptions are unique per mode, and a live event arriving at a test deployment is
stored and ignored. So a live cutover needs **live prices inserted** as well as the key swapped —
otherwise live subscriptions resolve to no plan and the webhook fails loudly (by design).

Run `docs/BILLING_LIVE_VERIFICATION.md` before trusting any of this against a real account.
