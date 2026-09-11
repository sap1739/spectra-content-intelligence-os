# ADR-0035: LinkedIn — the first live OAuth publisher, over LinkedIn's official APIs only

**Status:** Accepted · **Date:** 2026-09-11 · **Relates to:** ADR-0019, ADR-0020, ADR-0022, ADR-0029, ADR-0034

## Context

Phase 6C built a provider-neutral OAuth broker and deliberately published nothing with it. LinkedIn
is the first platform to use it for real: discover who connected and which pages they administer,
then post text and images as them.

LinkedIn has several generations of API, and the choices matter:

- The Posts API (`POST /rest/posts`) replaces `ugcPosts`; the Images API (`/rest/images`)
  replaces the Assets API. Both are "versioned": every call must send `Linkedin-Version: YYYYMM`
  and `X-Restli-Protocol-Version: 2.0.0`, and a version is supported for at least a year.
- Member identity comes from OpenID Connect (`GET /v2/userinfo`); the old `r_liteprofile` `/me`
  route is not available to new apps.
- Pages a member can post as come from Organization Access Control
  (`/rest/organizationAcls?q=roleAssignee`), which needs the reviewed Community Management API.
- `commentary` is "little" text: reserved characters must be escaped or the post is rejected or
  mis-rendered.
- A member-only token (`w_member_social`) is write-only for images: it cannot read whether an
  uploaded image finished processing. LinkedIn warns that a post created on an image that then
  fails processing is not shown.
- There is no idempotency key on post creation, and LinkedIn issues refresh tokens only to
  approved partners.

## Decision

### 1. Official, current endpoints only

`@spectra/social-linkedin` calls exactly: OIDC `userinfo`; `organizationAcls` and
`organizationsLookup` for discovery; `images?action=initializeUpload`, the returned upload URL
and `images/{urn}` for media; and `posts` to publish. No scraping, no browser automation, no
legacy `ugcPosts`. The version is `LINKEDIN_API_VERSION` (default `202608`, the newest LinkedIn
documented at build time), so moving it forward is configuration.

### 2. Text and ONE image — and say so everywhere

The adapter publishes text posts and single-image posts (JPG, PNG, GIF, under 36,152,320 pixels).
Video, documents, multi-image, articles and polls are real LinkedIn features it does not
implement. That is declared three ways: `supportedMedia` on the publisher (the executor refuses
anything else as `UNSUPPORTED` before any request), a per-account capability snapshot
(`NOT_IMPLEMENTED`, distinct from `MISSING_PERMISSION`), and the registry summary shown on every
LinkedIn card.

### 3. Capabilities are per account, from the grant

Discovery stores an `AccountCapabilitySnapshot` on each account: a member posts with
`w_member_social`, a page with `w_organization_social`. A missing scope is reported as the missing
LinkedIn _product_ (Sign In with OpenID Connect, Share on LinkedIn, Community Management API) with
whether LinkedIn reviews it — the thing an operator can actually go and request. Scheduling checks
the snapshot and the post up front (422 with the reason); the executor checks again at dispatch.

### 4. Discovery is partial, not all-or-nothing

Identity and pages are discovered independently. A member found but pages refused is `PARTIAL`,
not a failure that hides the member. Only APPROVED roles that can post organically
(`ADMINISTRATOR`, `CONTENT_ADMINISTRATOR`/`CONTENT_ADMIN`) become targets; a page whose name
LinkedIn will not return is labelled by its id, never guessed. After a complete discovery, pages
the member lost a role on are retired.

### 5. Media uploads are recorded, so a retry never uploads twice

`SocialMediaUpload` records, per account and asset, the LinkedIn image URN and how far the upload
got (`REGISTERED`, `UPLOADED`, `FAILED`, verified or not). A retried publish reuses an uploaded
image — LinkedIn documents Images API uploads as reusable. Where the token may read image status
(page authors), the post waits for `AVAILABLE` and a still-processing image fails `TRANSIENT` with
the upload kept; `PROCESSING_FAILED` fails honestly with no post. Member uploads are recorded as
unverified, and the capability snapshot says why.

### 6. The upload URL is checked before bytes and token go to it

The Images API returns an upload URL and requires the bearer token on the PUT. The client sends
nothing unless the URL is `https://*.linkedin.com` (or the configured API origin, which is how a
test reaches a local mock).

### 7. Honest outcomes, with a code the UI can act on

Every attempt ends `PUBLISHED`, `FAILED` or `UNSUPPORTED` with a reason and a `failureCode`
(`AUTH`, `REAUTH_REQUIRED`, `PERMISSION`, `VALIDATION`, `UNSUPPORTED_MEDIA`, `RATE_LIMIT`,
`TRANSIENT`, `AMBIGUOUS`, `NOT_CONNECTED`, `BUDGET`). A resolver can say "not now, and why"
(`PublisherUnavailable`) so an expired authorization is `FAILED`/`REAUTH_REQUIRED` rather than a
generic "no publisher". A timeout after the post request was sent is `AMBIGUOUS`: the post may
exist, so the reason says to check LinkedIn before publishing again. A 401 marks the connection
`REAUTH_REQUIRED` and later attempts stop before contacting LinkedIn.

### 8. Refresh in the worker, shortly before expiry

The resolver refreshes a LinkedIn token within five minutes of expiry when LinkedIn issued a
refresh token, re-sealing under the active key. Without one, an expired token marks the
connection `EXPIRED` and the attempt `REAUTH_REQUIRED`. If a concurrent publish already spent a
rotated refresh token, the newer stored token is used rather than declaring the grant dead.

### 9. One resolver, shared by the worker and the tests

`createPublisherResolver` and `createMediaLoader` live in `@spectra/publishing`. The worker and
the integration tests drive the same code path; the tests run it against a local HTTP server that
enforces LinkedIn's rules (bearer tokens, per-scope permissions, version headers, single-use
codes).

### 10. Idempotency and budgets are unchanged

The executor's existing guarantees hold: a finished entry is skipped on re-delivery, the publish
pre-flight (ADR-0028/0029) reserves before any request, and an attempt refused before sending
returns its hold rather than counting it.

## Consequences

- LinkedIn posts go out for real, as the member or as a page, with images — once the operator's
  LinkedIn app has the right products. The UI says which products are missing.
- **Not verified against LinkedIn itself in this environment** (no app credentials here). The mock
  follows LinkedIn's documentation; `docs/LINKEDIN_LIVE_VERIFICATION.md` is the checklist for the
  first real run. The largest open question it covers: LinkedIn documents member posting for
  self-serve "Share on LinkedIn" apps with the legacy `ugcPosts` API, while the Posts API documents
  `w_member_social` for member posts. If `/rest/posts` refuses a self-serve app's member post,
  that app needs Community Management access or a `ugcPosts` path, which is not built.
- Not built: video (Videos API with finalizeUpload), documents, multi-image, articles, polls,
  mentions, post editing and deletion, and engagement analytics.
- Hashtags are kept as LinkedIn hashtag elements (`#word`); every other reserved character is
  escaped, so mentions typed as `@name` are plain text.
