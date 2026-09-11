# ADR-0034: OAuth token brokering — one provider-neutral broker, grants separate from accounts

**Status:** Accepted · **Date:** 2026-09-11 · **Relates to:** ADR-0019, ADR-0020, ADR-0022, ADR-0033

## Context

Seven of the ten platforms Spectra declares — LinkedIn, Facebook Pages, Instagram, Threads,
YouTube, TikTok, X and Pinterest — only accept an OAuth 2.0 authorization-code grant. WordPress
(ADR-0022) is the one live adapter, and it avoids OAuth entirely with an application password.
Every further adapter needs the same machinery first: start a flow, survive the round trip through
the platform's consent screen, exchange a code, store tokens, refresh them, and revoke them.

That machinery is the most security-sensitive code in the publishing path. It handles client
secrets, single-use codes, PKCE verifiers and long-lived refresh tokens, and its callback is a URL
that anyone can craft and send a signed-in user to. The Phase 1 `SocialPublisher` port put
`initiateOAuth`/`handleOAuthCallback`/`refreshToken` on each adapter, which would have meant eight
separate implementations of state validation — and eight chances to get it wrong. The old
`oauthInitiationRequestSchema` even accepted a caller-supplied `redirectUri`, which is the shape of
an open redirect.

The platforms also differ in ways that matter: X requires PKCE and HTTP Basic client auth; TikTok
calls the client id `client_key`; Google issues a refresh token only when asked for offline access;
the Meta family has no standard refresh grant at all; LinkedIn issues refresh tokens only to
approved partners; only Google, X and TikTok offer a standard revocation endpoint. And a single
Facebook grant yields several Pages, each a separate place to publish.

## Decision

### 1. One broker, driven by declared definitions

`@spectra/social-oauth` implements the flow once. Each platform is a declared
`OAuthPlatformDefinition`: endpoints, scope list and separator, PKCE mode
(`required`/`supported`/`none`), client-auth method, client-id parameter name, extra authorization
parameters, refresh style, the scopes each capability needs, and the platform approvals required.
Definitions are compiled from public documentation and labelled with the date they were recorded;
they are not verified against a live API. Every URL and the scope list can be overridden per
deployment (`SOCIAL_OAUTH_<PLATFORM>_*`), so an endpoint or API-version change is configuration,
not a code change.

OAuth is removed from the `SocialPublisher` port. An adapter receives an already-opened token; it
never runs a flow.

### 2. A connection is a grant; an account is a destination

`SocialConnection` holds one grant: status, granted and requested scopes, one sealed credential,
and expiry metadata. `SocialAccount` stays the publishing target, now optionally linked to the
connection it was discovered through. Between them sit three discovery ports in `social-core` —
identity, destinations (pages, channels, boards) and capabilities — registered per platform.

None is registered in this phase. A connection therefore records `discoveryStatus: NOT_AVAILABLE`
and creates no accounts: an account is only ever stored because a platform reported it. That is
distinct from `COMPLETE` with zero accounts.

### 3. State is single-use, short-lived and bound to the user who started it

- 32 random bytes, base64url. Only its SHA-256 is stored.
- Consumed by one `UPDATE … WHERE consumedAt IS NULL AND expiresAt > now() AND userId = caller`.
  Of any number of concurrent callbacks, exactly one wins; a second is a replay, rejected with no
  token exchange and audited as `social.oauth.replay_rejected`.
- Expires after `SOCIAL_OAUTH_STATE_TTL_SECONDS` (default 600).
- Bound to the initiating user. The callback needs the session (the `SameSite=Lax` cookie travels
  on the platform's top-level redirect), and a state presented by anyone else — even a member of
  the same organization — is rejected, audited as `user_mismatch`, and left usable by its owner.
  This closes login CSRF: an attacker cannot make a victim's browser attach the attacker's account.
- `social:connect` is re-checked at the callback: it may have been revoked while the user was away.

### 4. PKCE wherever the platform accepts it

S256 only, sent when the platform supports it, not only when it insists. The verifier is sealed at
rest on the attempt row. Building an authorization URL without a challenge for a platform that
requires PKCE throws.

### 5. Nothing about the redirect is caller-controlled

The redirect URI is computed from `SOCIAL_OAUTH_REDIRECT_BASE_URL` and a fixed per-platform path.
The callback returns the browser to `WEB_APP_URL` — which boot validation requires to be one of
`API_CORS_ORIGIN` — plus a path from the `OAUTH_RETURN_PATHS` allow-list. It always answers with a
302 carrying one outcome code from a fixed enum; the web app maps each to fixed copy. Provider
`error_description` is never reflected, because the callback URL is attacker-craftable.

### 6. Refuse before consent; seal everything; state unknowns as unknown

- A flow is refused at start (503, naming the missing variables) when the platform or credential
  storage is not configured. A user is never sent to approve a grant Spectra would have to discard.
- Access and refresh tokens are sealed together as one AES-256-GCM bundle. Expiry lives in plain
  columns because it is not secret and must be queryable.
- A platform that does not report granted scopes is stored as `grantedScopesReported: false` —
  never as "granted what we requested".

### 7. Refresh and disconnect report what actually happened

- Refresh uses the standard `refresh_token` grant only. A response without a new refresh token
  keeps the old one. `invalid_grant` marks the connection `REAUTH_REQUIRED`; a timeout leaves its
  status alone. The Meta family is reconnect-only and says so.
- Every refresh re-seals the bundle under the ACTIVE key, so rotation advances as tokens are used.
- Disconnect asks the platform to revoke (RFC 7009) where it can and reports `REVOKED`,
  `NOT_SUPPORTED`, `FAILED` or `SKIPPED` — then deletes the credential regardless, and retires the
  accounts the connection discovered.

### 8. Key rotation is a key ring, not a flag day

`SOCIAL_TOKEN_ENCRYPTION_KEY_ID` names the active key and `SOCIAL_TOKEN_ENCRYPTION_RETIRED_KEYS`
lists decrypt-only predecessors. New ciphertexts carry the active id; `credentialKeyId` columns
record which key sealed each row so rotation progress is a query; `needsReseal()` flags stragglers.
The API and the worker build the ring from one function, so they cannot disagree about key ids.

### 9. The token endpoint client leaks nothing

Requests refuse redirects (`redirect: 'error'` — following one would re-send the secret and code
elsewhere) and time out. Errors carry the platform, HTTP status and the provider's error code only
— never the request, the response body or `error_description`. Log redaction covers the OAuth wire
names (`access_token`, `refresh_token`, `client_secret`, `code_verifier`, callback query).

### 10. Capability is scopes AND an adapter

`GET …/connections/:id/capabilities` reports, per capability, whether the scopes were granted and
whether an adapter is wired, and `available` only when both hold. A granted `publish` scope with no
adapter is reported as exactly that. No OAuth platform is reported as publishing-capable.

## Alternatives considered

- **OAuth per adapter** (the Phase 1 port). Rejected: eight copies of the most security-critical
  code in the path, and no single place to audit.
- **State in Redis with a TTL.** Workable, but the attempt row gives an audit trail of denied,
  expired and replayed flows, and Postgres already provides the atomic single-use update. The
  tenant guard also covers it.
- **Tokens on `SocialAccount`.** Rejected: one grant yields many destinations (Facebook Pages,
  YouTube channels), and refreshing one grant must not mean updating N rows.

## Consequences

- Adding a platform adapter is now: implement the discovery ports and a publisher, register them.
  No OAuth code.
- Connecting is real and end-to-end tested against a local HTTP provider that verifies PKCE, client
  authentication, single-use codes and refresh-token rotation — but no OAuth platform can publish
  yet, and the UI says so on every card and connection.
- Declared endpoints can drift from what platforms serve; overrides exist for that, and a live
  adapter must re-verify its platform's definition.
- Not done here: Meta's long-lived token exchange and per-Page tokens; a background refresh sweep
  ahead of expiry; a bulk re-seal job for rotation (today rotation advances on write); revocation
  for LinkedIn and the Meta family, which have no standard endpoint — disconnect tells the user to
  remove access in the platform's own settings.
- The callback depends on the session cookie being sent on a cross-site top-level redirect, i.e. on
  `SameSite=Lax`. Tightening the cookie to `Strict` would break every OAuth callback; the
  integration test would catch it as `session_required`.
