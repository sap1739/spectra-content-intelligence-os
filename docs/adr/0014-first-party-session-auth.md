# ADR-0014: First-party session authentication in the API

**Status:** Accepted · **Date:** 2026-07-07 · **Refines:** ADR-0007

## Context

ADR-0007 set the direction: cookie-session authentication with server-side sessions and
API-side verification, naming Auth.js as the expected web integration. Implementing Phase 2
surfaced a known constraint: Auth.js's Credentials provider does not support database
sessions (it forces the JWT strategy), while email+password is exactly the first mechanism
Phase 2 needs. Splitting session ownership between the web app (Auth.js) and the API would
have added a second session store and a cross-service verification protocol for no gain.

## Decision

The **API owns authentication end-to-end**:

- `POST /v1/auth/register|login|logout`, `GET /v1/auth/me`.
- Passwords hashed with **Node scrypt** (`@spectra/security`), parameters embedded per hash
  (`scrypt$N=…,r=…,p=…$salt$hash`) with `needsRehash` for future upgrades — no native deps.
- Sessions are **opaque 256-bit ids in Redis** (7-day TTL); the cookie (`spectra_session`,
  httpOnly, SameSite=Lax, Secure in prod) carries the id only. The principal is rebuilt from
  the database per request, so membership/permission revocation is immediate.
- Guard chain: **origin check (CSRF) → principal → tenant context → permissions**. Mutations
  with an Origin outside the allow-list are rejected; tenant scope resolves `:workspaceId` /
  `:organizationId` against the caller's memberships with identical 404s for missing vs.
  foreign resources.
- The web app is a plain cookie-credentialed API client (`credentials: 'include'`).

## Rationale

One session store, one enforcement point, no framework coupling: `AuthProviderPort`
(@spectra/auth) still abstracts the mechanism, so OAuth/SSO providers (or Auth.js for that
surface specifically) can be added behind the same principal model in Phase 5 without
touching guards or domain code.

## Consequences

- Login rate-limiting rides the global per-IP limiter now; per-identifier throttling and
  optional double-submit CSRF tokens are hardening items tracked in SECURITY.md.
- Session fixation is avoided by issuing a fresh id at every login; logout revokes instantly.
- Covered by integration tests: registration bootstrap, enumeration-safe login, isolation
  404 equality, READ_ONLY write denial, foreign-origin mutation rejection, logout revocation.
