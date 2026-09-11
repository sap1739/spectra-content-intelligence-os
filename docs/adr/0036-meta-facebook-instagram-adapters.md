# ADR-0036: Meta — Facebook Pages and Instagram professional accounts over the Graph API

**Status:** Accepted · **Date:** 2026-09-11 · **Relates to:** ADR-0019, ADR-0020, ADR-0034, ADR-0035

## Context

Phase 6C built the OAuth broker; 6D made LinkedIn the first live publisher on it. Meta is next,
and it differs from LinkedIn in ways that shape the design (Meta's documentation, checked
2026-09-11):

- **Tokens.** No refresh tokens. The authorization code yields a user token that lasts about an
  hour; the documented `fb_exchange_token` grant trades it for one lasting about 60 days. Page
  access tokens obtained with a long-lived user token **do not expire**. The token endpoint is
  documented as GET, and its response reports no scopes; `/me/permissions` does.
- **Where you can publish.** Apps cannot post to personal profiles. A Page is written with that
  Page's own access token, which `/me/accounts` returns only to a user with a role on it; posting
  needs the CREATE_CONTENT or MANAGE task and `pages_manage_posts`.
- **Instagram with Facebook Login.** The publishable account is the Page's
  `instagram_business_account` — a professional (Business or Creator) account. An account
  connected only through Page settings appears as `connected_instagram_account`. Publishing is two
  steps: create a media container from a **public** `image_url` (JPEG only, 8 MB, aspect ratio 4:5
  to 1.91:1), then `media_publish` it. Containers expire after 24 hours; accounts have a rolling
  24-hour publishing limit.
- **Signing.** `appsecret_proof` (HMAC-SHA256 of the token keyed by the app secret) protects
  server-side calls.
- **Review.** Every permission involved needs Advanced Access through App Review.

## Decision

### 1. One Meta connection, two platforms

A Facebook OAuth connection discovers destinations on **FACEBOOK and INSTAGRAM**. Discovery ports
gained an optional per-destination `platform`, and the connection service accepts only platforms
declared for the connection (`FACEBOOK → [FACEBOOK, INSTAGRAM]`); anything else is dropped. A direct
Instagram Login connection stores an authorization only, and its card says to connect Meta
instead.

### 2. Long-lived before anything else — fail closed

The callback exchanges the code, then immediately performs the `fb_exchange_token` upgrade, before
the grant is stored or discovery runs, so the Page tokens it derives do not expire. If the upgrade
fails, nothing is stored (`long_lived_*` failure code, `token_exchange_failed` to the browser): a
grant that would die within the hour is not kept. Token requests follow Meta's documented GET form;
the secret travels only in that request, to Meta, over TLS, and URLs are never logged.

### 3. The grant is what Meta reports

When the token response carries no scopes, discovery asks the platform (`discoverCapabilities` →
`/me/permissions`) and the connection records the **granted** permissions as reported. Declined
ones become missing products — each Meta product (Page access, Page publishing, Instagram
publishing) is marked as reviewed by Meta.

### 4. A sealed token per destination

A destination may carry its own token (`accessToken`, a secret). The connection service seals it
into the account's `encryptedToken` with `credentialKeyId` immediately; `null` clears a token Meta
stopped issuing (a lost role). Retiring an account or disconnecting deletes it. An Instagram
account carries its linked Page's token, because publishing through Facebook Login uses it.

### 5. Eligibility is stated, not implied

- A new post-type status, `NOT_SUPPORTED`, means **the platform** does not allow it — distinct from
  `NOT_IMPLEMENTED` (Meta allows it; Spectra has not built it) and `MISSING_PERMISSION`.
- The personal profile and any Instagram account not reported as `instagram_business_account` are
  stored with every post type `NOT_SUPPORTED` and the reason, shown once as "Cannot publish here".
  They are not dropped: the operator should see why an account they expected is not publishable.
- Account kind carries eligibility: an eligible Instagram account is `BUSINESS_ACCOUNT`, anything
  else `PROFILE`. The resolver refuses the wrong kind as `UNSUPPORTED` with a new failure code,
  `UNSUPPORTED_ACCOUNT`, before any request.

### 6. Facebook Pages

Text is `POST /{page-id}/feed` (`message`); one photo is a multipart `POST /{page-id}/photos`
(`source` + `caption`), so no public URL is needed. The permalink is looked up afterwards and kept
only if it is `https://*.facebook.com`. A timeout after sending is `AMBIGUOUS`.

### 7. Instagram, retry-safe

- The executor gained an optional `mediaUrl` dependency, and `PublishMediaInput` an optional
  `url()`. The worker supplies 15-minute signed links to tenant-checked keys **only** when
  `STORAGE_ENDPOINT` is not a local or private address (`publicMediaLinkProblem`); otherwise
  Instagram resolves to `UNSUPPORTED` with that reason.
- The container id is recorded on the schedule entry (`externalContainerId`, keyed by the entry's
  idempotency key) before polling. A retry checks it first: `FINISHED` is published rather than
  recreated, `ERROR`/`EXPIRED` is cleared and recreated, and **`PUBLISHED` is never published
  again** — it fails `AMBIGUOUS` saying the post went out. So an unanswered `media_publish` is
  `TRANSIENT` ("retrying is safe") when the container is recorded, `AMBIGUOUS` when it is not. An
  unanswered container creation published nothing and is `TRANSIENT`.
- `content_publishing_limit` is read before creating a container; a used-up allowance is
  `RATE_LIMIT` with the numbers Meta returned (never an assumed quota).

### 8. Signing, errors and secrets

Every call sends the token as `access_token` (as documented) plus `appsecret_proof` when the app
secret is configured; redirects are refused; calls time out. Errors map by Meta's code and
subcode (190/102/token subcodes → `AUTH`; 10, 200–299, 368, subcode 492 → `PERMISSION`; 4, 17, 32,
341, 613 → `RATE_LIMIT`; 1, 2 → `TRANSIENT`; 100, 506 → `VALIDATION`), with the token scrubbed from
any message.

### 9. Expiry means what it says

The user token lapsing does **not** stop publishing — Page tokens do not expire — so the resolver
does not check it; the connection shows "token expired" with a note explaining that. A Page token
Meta invalidates (190) marks the connection `REAUTH_REQUIRED`, and later attempts stop before
contacting Meta. Reconnect renews the connection in place and re-seals fresh Page tokens on the same
accounts.

### 10. Versioned, like LinkedIn

`META_GRAPH_API_VERSION` (default `v26.0`, the newest at build time) is the path segment on every
Graph call; `META_GRAPH_API_BASE_URL` exists for tests and must be https in production.

## Consequences

- Facebook Page text and photo posts and Instagram single-image posts go out for real once the
  operator's Meta app has passed App Review. Budgets, idempotency and the executor's honest states
  are unchanged.
- **Not verified against Meta itself here** (no app credentials). `docs/META_LIVE_VERIFICATION.md`
  lists the open questions: whether the GET code exchange accepts the standard `grant_type`
  parameter Spectra sends, whether `content_publishing_limit` answers a Page token (the reference
  describes a user token), `alt_text` on containers, and Business-portfolio permission needs
  (`business_management`, `ads_*`).
- Instagram requires internet-reachable storage; a signed link to the image exists for 15 minutes.
- Not built: video, Reels, stories, carousels, multi-photo posts, Meta-side scheduling, comments,
  insights, the Instagram Login publishing path, and Threads. Facebook photo alt text is not sent.
