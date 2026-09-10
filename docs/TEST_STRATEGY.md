# Test Strategy

## 1. Pyramid

| Layer       | Tooling                                   | Location                                      | Runs                                                          |
| ----------- | ----------------------------------------- | --------------------------------------------- | ------------------------------------------------------------- |
| Unit        | Vitest                                    | `packages/*/src/*.test.ts`, `apps/worker/src` | `pnpm test` (every CI push)                                   |
| Integration | Vitest + @nestjs/testing + fastify inject | `apps/api/test/*.spec.ts`                     | `pnpm test:integration` (CI job with Postgres/Redis services) |
| End-to-end  | Playwright                                | `apps/web/e2e`                                | `pnpm test:e2e` against the production build                  |

## 2. Determinism rules

- **No randomness, no clock reads** in test data: `@spectra/testing` factories use sequence-
  derived UUIDs and a fixed timestamp (`FIXED_TEST_TIME`); engines under test accept `now()`
  injection (see trend scoring tests).
- Factory outputs are parsed through their Zod contracts — factories cannot drift from the
  domain.
- Failing tests are fixed or the code is fixed; suppression (`.skip`, retry-until-green,
  swallowed rejections) is prohibited.

## 3. What Phase 1 covers

- **Contracts**: lifecycle transition machine (valid path, review loop, illegal jumps);
  vertical/finding/capability schema semantics (free-text industry, provenance retention,
  null-means-unknown capabilities).
- **Security**: role bundle completeness; permission checks incl. extra grants; tenant
  ownership guard incl. the no-existence-leak property; AES-GCM round-trip, IV uniqueness,
  key rotation, tamper detection.
- **Data layer**: tenant-guard argument checker (scoped/unscoped/AND-nested/bulk mutations).
- **Storage**: tenant-rooted key building/parsing, traversal rejection, hostile filename
  sanitization, MIME/size policy validation.
- **Workflow**: in-memory queue semantics — idempotent enqueue, retry-then-dead-letter,
  recovery, cancellation.
- **Research-core**: provider registry (dedupe, typed errors, fixture flagging), 23-stage
  ordering and forward-only advancement.
- **Trend-core**: deterministic scoring, penalties + risk flags, evidence floor, config
  swap without code change, invalid input rejection.
- **Knowledge-core**: cosine math, cross-tenant retrieval isolation, deletion propagation,
  deterministic chunking, injection scanner + wrapper properties.
- **Worker**: heartbeat payload construction (UTC, uptime, clock-skew safety).
- **API integration**: liveness without dependencies; readiness component reporting
  consistent with actual infra state; correlation id echo/generation; versioned meta route;
  problem+json 404s; OpenAPI served.
- **E2E**: shell renders with honest empty states; research/trends navigation; 404 page;
  keyboard reachability.

## 4. CI

`.github/workflows/ci.yml`: `quality` (format, lint, build, typecheck, unit),
`integration` (pgvector + redis services, migrate, seed, API tests), `e2e` (build web,
Playwright chromium). All jobs must pass; no `continue-on-error`.

## 5. Phase 2 additions

Pipeline stage tests against fixture providers; RLS/tenant fuzz tests (property-based
cross-tenant probes); contract tests for each provider adapter; injection red-team corpus;
visual regression on the shell; load smoke on research runs.

## 6. Frontend testing (Phase 6A)

Before 6A the web app had **zero unit tests** — 8k+ lines of UI covered only by a handful of
unauthenticated Playwright smoke tests.

**Web unit tests** (Vitest + React Testing Library, `apps/web/src/**/*.test.tsx`) cover logic that
is expensive to reach through a browser: permission gating (including that it ignores role names
and fails closed with no membership), cost formatting (null renders as a dash, never `$0.00`), and
the Brands page's own behaviour — permission gating, form validation, and empty/error/loading
states.

**Playwright** (`apps/web/e2e`) runs the production build against a **stubbed `/v1` API**
(`e2e/fixtures.ts`). That boundary is deliberate: the API's behaviour is already covered by the
integration suite against a real database, so duplicating it here would make the frontend suite
slow and flaky without testing anything new. What these tests cover is what only a browser shows —
routing, rendering, permission gating, form validation, and honest empty/error states across
login, dashboard, brands, settings, templates, research, usage/budgets, publication status and
operations.

The consequence to keep in mind: a Playwright pass proves the UI renders correctly _given_ an API
response shape. If the real API's shape drifts, only the integration and unit suites will catch it.

## 7. Observability testing (Phase 6B)

Telemetry is tested for what it must NOT do as much as for what it does.

- **Redaction is a regression suite** (`packages/logging/src/redaction.test.ts`), not a spot check:
  every path added to `MANDATORY_REDACT_PATHS` has a case, including header casings and model
  input/output. A leak is silent in production, so the test is the only place it surfaces.
- **The span allow-list is asserted directly**: an attribute that is not on the list must be
  dropped, objects and arrays must be dropped whole, and long strings truncated.
- **Tracing-disabled is a tested state.** With no endpoint, `initTracing` must return
  `enabled: false` with a reason and must not load the SDK — the default deployment shape.
- **An unreadable gauge must be OMITTED**, never rendered as `0`. This one assertion encodes the
  platform's whole honesty rule in the metrics layer.
- **Ops integration tests** (`apps/api/test/ops.spec.ts`) run against real Redis and BullMQ: a job
  is genuinely failed by a worker rather than forced into the failed set, because the state
  machine's own rules (locks, attempt counts, dead-lettering) are part of what is under test.
  Foreign-tenant listing and retry are asserted to be indistinguishable from "not found".

One caveat the ops suite has to live with: a developer's own worker may be listening on the same
Redis queue. The seeding helper therefore hands back any job that is not its own, and polls for the
failed state rather than trusting its own worker to win the race. Assertions that depended on which
worker processed the job were deliberately loosened — see the comments in that file.
