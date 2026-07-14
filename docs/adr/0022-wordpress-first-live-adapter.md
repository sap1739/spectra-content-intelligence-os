# ADR-0022: WordPress — the first live platform adapter (REST + application password)

**Status:** Accepted · **Date:** 2026-07-15 · **Relates to:** ADR-0019, ADR-0020, ADR-0009

## Context

Phases 4A/4B built the publishing machinery and an honest `UNSUPPORTED` terminal — real
scheduling, dispatch, idempotency, and status tracking, but no platform actually wired
(ADR-0020). The ground rules forbid claiming a post went out when none did. It is time for the
first **real** integration: content genuinely leaving the platform and appearing on an external
site.

WordPress is the most tractable first target. It exposes a first-class REST API
(`POST {site}/wp-json/wp/v2/posts`) and, since WordPress 5.6, **application passwords** — a
per-user credential usable directly over HTTP Basic auth, with **no OAuth dance**, no callback
URLs, and no token refresh. That lets us prove the whole path end-to-end (credential storage →
dispatch → real HTTP publish → recorded external id/url) without first building an OAuth broker.

## Decision

Add `@spectra/social-wordpress`, a real adapter, and resolve a **per-account** publisher at
publish time. Credentials never enter the domain packages in the clear; the worker holds the key.

1. **A narrow `PostPublisher` port (social-core).** The full `SocialPublisher` port (OAuth,
   analytics, webhooks) remains aspirational. Real adapters implement the minimal
   `PostPublisher` now: `publish({ idempotencyKey, title, body }) → { status, externalPostId?,
   externalUrl?, publishedAt?, failureReason? }`. This keeps the first adapter to the surface it
   actually needs.

2. **`WordPressPublisher` — genuine HTTP I/O.** Constructed with `{ siteUrl, username,
   applicationPassword }`; `publish` does a real `fetch` `POST` to `/wp-json/wp/v2/posts` with
   `Authorization: Basic base64(username:app-password)` and `{ title, content, status:
   'publish' }`. `2xx` with a post id ⇒ `PUBLISHED` (records id + link + `date_gmt` as UTC);
   any non-2xx or network/parse error ⇒ `FAILED` with the real status + trimmed body. The site
   URL is validated as http(s); the credential and auth header are never logged.

3. **Per-account resolution in the executor.** `executePublication` gains a
   `resolvePublisher(account) → PostPublisher | undefined` dependency. It loads the target
   `SocialAccount` (including the sealed token), asks the resolver to build a publisher, and —
   when one is returned — publishes the content item's current best `body`. **No resolver, no
   credential, or no adapter ⇒ the existing honest `UNSUPPORTED`.** The dispatch/idempotency
   machinery is unchanged.

4. **The worker owns decryption.** It builds a `KeyRing` from `SOCIAL_TOKEN_ENCRYPTION_KEY`
   (env-gated) and wires `resolvePublisher`: for a `WORDPRESS` account with a stored credential
   it decrypts the sealed `username:application-password`, parses it, and constructs a
   `WordPressPublisher`. The decrypted secret never leaves that closure. Without the key,
   publishing resolves to `UNSUPPORTED` — never a fake success.

5. **Credential storage reuses the existing shape.** The site URL is the account's
   `externalAccountId`; the credential is `username:application-password`, sealed into
   `encryptedToken` (AES-256-GCM, ADR-0019). No schema change. The API validates the WordPress
   credential format on register (400 on malformed) and marks `WORDPRESS` wired so
   `GET /social/platforms` reports it honestly; the web register form collects the credential
   (gated on `credentialStorageConfigured`) and the banner states WordPress is live while other
   platforms remain registration-only.

## Rationale

- **Real, not simulated** — the adapter performs actual network I/O to a real WordPress site;
  failures surface the platform's own response. Verified end-to-end against a WordPress-shaped
  server (correct endpoint, Basic auth, 201 → PUBLISHED, wrong password → FAILED).
- **Application passwords first** — a live integration today without an OAuth broker; the heavier
  OAuth platforms slot behind the same `resolvePublisher` seam later.
- **Credential boundary** — sealed at rest, decrypted only inside the worker's resolver, never
  logged, never returned by the API (ADR-0019).
- **Honesty preserved** — every gap (no key, no credential, non-WordPress platform, bad response)
  degrades to a truthful `UNSUPPORTED`/`FAILED`, never a fabricated `PUBLISHED`.

## Consequences

- WordPress publishes for real when a site + application password + `SOCIAL_TOKEN_ENCRYPTION_KEY`
  are configured; every other platform stays honestly `UNSUPPORTED` until its adapter lands.
- A malformed stored credential resolves to `UNSUPPORTED` (the resolver returns `undefined`); the
  API's register-time format check makes that path effectively unreachable for API-created rows.
- SSRF surface is limited: the target is the operator's own site URL (http(s)-validated). A
  stricter private-IP guard and per-attempt history/DLQ dashboard remain deferred (ADR-0020).
- Next: OAuth token brokering for the remaining platforms and a live `AnalyticsProvider` feeding
  real engagement — both plug in behind the existing ports with no pipeline change.
