## Frontend testing (Phase 6A)

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
login, dashboard, brands, settings, templates, research, usage/budgets and publication status.

The consequence to keep in mind: a Playwright pass proves the UI renders correctly _given_ an API
response shape. If the real API's shape drifts, only the integration and unit suites will catch it.
