# ADR-0007: Authentication direction — session-based, Auth.js + API session verification

**Status:** Accepted (direction; implementation in Phase 2) · **Date:** 2026-07-05

## Context

Phase 1 ships no login, but the foundation must not paint us into a corner. Options:
Auth.js (NextAuth), Clerk/Auth0/WorkOS (managed), custom sessions, JWT-everywhere.

## Decision

Direction: **cookie-session authentication** — Auth.js on the web app (credentials + OAuth
providers, passkeys later), with sessions stored server-side and verified by the API through
a shared session store; service-to-service calls use short-lived signed tokens. The codebase
depends only on `AuthProviderPort`/`Principal` (`@spectra/auth`), so a managed provider swap
remains possible.

## Rationale

- Sessions (httpOnly, SameSite) + CSRF tokens beat long-lived JWTs for revocation and
  tenant-switch semantics; multi-tenant B2B needs instant membership revocation.
- Auth.js is MIT, self-hosted (data residency for regulated tenants), and integrates
  natively with Next; managed providers add cost/lock-in but stay adoptable behind the port
  if enterprise SSO timelines demand it.
- Enterprise SSO (SAML/OIDC via WorkOS or Auth.js providers) and SCIM are Phase 5 concerns
  and fit the same principal model.

## Consequences

- `Principal` (memberships → role + extra permissions + workspace restriction) is already
  the authorization input everywhere; guards land with Phase 2.
- Encrypted token vault (`TokenVaultPort` + security KeyRing) also stores social OAuth
  tokens later.
