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
- **Research-core**: provider registry (dedupe, typed errors, fixture flagging), 22-stage
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
