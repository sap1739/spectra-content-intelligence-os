# ADR-0019: Publishing foundation — declared capabilities, honest empty registry, sealed credentials

**Status:** Accepted · **Date:** 2026-07-13 · **Relates to:** ADR-0008, ADR-0017, SOCIAL_PLATFORM_CAPABILITY_MATRIX

## Context

Phase 4 is publishing. The product will post to LinkedIn, X, WordPress, YouTube and more —
but the `CLAUDE.md` ground rules are absolute: **no fake integrations, honest empty states,
never claim an operation happened when it didn't.** No social platform is wired yet, and
wiring real OAuth + posting is a large per-platform effort. The foundation must deliver real
value now (capability-aware content, encrypted credential handling, a registration model)
without pretending a post ever goes out.

## Decision

Ship the publishing **foundation** behind the existing `social-core` `SocialPublisher` port,
mirroring the env-gated honesty pattern of the AI adapter (ADR-0017):

1. **Declared capability matrix (`social-core`).** A first-party, versioned `PlatformCapability`
   per platform (`capabilityVersion: declared-1.0.0`), compiled from public platform docs and
   **explicitly labelled "not live-verified"** in every record's `notes`. Unknown support flags
   are `null` (fail-closed via `assertCapability`). A live adapter later replaces these with
   fetched values under a new version.

2. **Deterministic variant validation (`validateVariant`).** Real logic that runs with zero
   platform integration: checks text length, hashtag count, media count and media kinds against
   a platform's declared limits. This is genuinely useful today (does this copy fit X's 280
   chars? Instagram's 30-hashtag cap?).

3. **Honest empty publisher registry.** `SocialPublisherRegistry` has **no adapters registered**
   in Phase 4A. `isWired(platform)` is `false` everywhere; the API and UI report each platform
   as "not wired" and no publish path exists. A later phase registers real, env-gated adapters.

4. **Registration model with sealed credentials.** `SocialAccount` rows are publishing
   **targets**, created in status `PENDING` (registered, not OAuth-verified). Any supplied
   credential is sealed with AES-256-GCM (`@spectra/security` `encryptSecret`) into
   `encryptedToken`, which is **never** selected into an API response; the raw token is never
   stored or returned. Credential storage is env-gated on `SOCIAL_TOKEN_ENCRYPTION_KEY` — with
   no key, a request that supplies a token is honestly refused (503) rather than persisting it
   in the clear.

## Rationale

- **Value without pretence** — capability validation and a real registration/credential model
  ship now; the honest "not wired / PENDING" states keep the UI truthful.
- **Env-gated, fail-closed** — no key ⇒ no credential storage; no adapter ⇒ no publish; unknown
  capability ⇒ operation blocked. Every gap fails safe and visible.
- **Provider-neutral** — the domain depends on the `SocialPublisher` port and the capability
  contract; per-platform adapters plug in without touching the domain (ADR pattern from research
  and AI).
- **Secrets never leave the boundary** — sealed at the service, excluded from every projection,
  purged on disconnect; consistent with the token-vault posture in the architecture docs.

## Consequences

- No content is published in Phase 4A — by design. The scheduling engine, idempotent publish
  jobs with a DLQ, and the first real platform adapter are the next increments (4B).
- The declared capability numbers are reference values and will drift from live platform limits
  until adapters fetch them; the `declared-1.0.0` version and `notes` make that explicit.
- OAuth flows (`initiateOAuth`/`handleOAuthCallback`) are defined on the port but not yet
  implemented; accounts stay `PENDING` until an adapter verifies them.
