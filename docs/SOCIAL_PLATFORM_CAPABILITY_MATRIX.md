# Social Platform Capability Matrix

**Status (Phase 6D):** WordPress (ADR-0022) and LinkedIn (ADR-0035) publish for real. LinkedIn
publishes text and one image, as a member or as a page they administer. The other seven OAuth
platforms can be **connected** — a real OAuth 2.0 flow stores a sealed authorization (ADR-0034) —
but **cannot publish**: a post to any of them resolves to `UNSUPPORTED`. Email is neither
connectable nor publishable.

Capability records are _declared_ from official documentation, not fetched from a live API.
Platform rules change frequently, so `null`/"verify" means unknown-until-verified and the code fails
closed (`assertCapability`). A live adapter re-verifies its platform before relying on any of it.

## 1. The model

`platformCapabilitySchema` (contracts/social.ts): platform, `capabilityVersion`,
`recordedAt`, media formats (mime/size/duration/aspect ratios), limits (characters,
hashtags, media count), support flags (nativeScheduling, editAfterPublish, deletion,
analytics, comments, webhooks, stories, drafts — tri-state `true/false/null`), OAuth
(scopes, refresh, token lifetime), notes. Channel variants record the
`platformCapabilityVersion` they were validated against.

## 2. Planning-level expectations (to verify at integration)

| Platform        | Publishing surface              | Media                        | Scheduling                  | Edit after publish        | Analytics               | Comments      | Notes                                  |
| --------------- | ------------------------------- | ---------------------------- | --------------------------- | ------------------------- | ----------------------- | ------------- | -------------------------------------- |
| LinkedIn        | Posts (member/org)              | image, video, document       | verify                      | limited/verify            | org APIs, partner-gated | partner-gated | Partner program tiers gate many scopes |
| Instagram       | Business/creator via Graph API  | image, video, reels, stories | verify                      | no (typical)              | insights API            | Graph API     | Requires linked FB business assets     |
| Facebook        | Pages via Graph API             | image, video, link           | native scheduling (typical) | limited                   | insights                | yes           | Page tokens; app review                |
| YouTube         | Videos, shorts                  | video                        | publishAt (typical)         | metadata yes              | Analytics API           | yes           | Data API quotas are tight              |
| TikTok          | Content posting API             | video (+image modes)         | verify                      | no (typical)              | partial                 | partial       | Audited app access                     |
| Threads         | Threads API                     | text, image, video           | verify                      | verify                    | partial                 | partial       | Newer API; verify everything           |
| X               | v2 API                          | text, image, video           | no native (typical)         | edit windows vary by tier | tier-gated              | tier-gated    | Paid tiers dominate                    |
| Pinterest       | Pins API                        | image, video                 | verify                      | limited                   | analytics API           | limited       |                                        |
| WordPress       | REST API (self-hosted/.com)     | full HTML + media            | future-dated posts          | yes                       | site-dependent          | yes           | Closest to full control                |
| Email platforms | ESP APIs (e.g. Mailchimp-class) | HTML                         | yes                         | pre-send only             | delivery/open metrics   | n/a           | Per-ESP adapters                       |

## 3. Rules the architecture enforces

1. Optional operations (`deletePost`, `fetchAnalytics`, `fetchComments`) are capability-gated;
   unknown capability ⇒ operation refused (fail closed), covered by unit tests.
2. Scheduling degrades gracefully: platforms without native scheduling use Spectra-side
   scheduled jobs feeding immediate publish calls.
3. Character/media limits validate variants **before** queueing publish jobs, pinned to a
   capability version.
4. Webhooks verify signatures before parsing and dedupe by idempotency key.
5. OAuth tokens live in the encrypted vault; scopes requested are the minimum for granted
   features.
6. A connection is not a publisher. Connecting stores a grant; publishing needs an adapter, and a
   capability is `available` only when the scopes were granted **and** an adapter is wired.

## 4. OAuth connection matrix (Phase 6C, ADR-0034)

Declared in `@spectra/social-oauth` (recorded 2026-09-10), overridable per deployment. "Connect"
means the OAuth flow works end to end when configured; it says nothing about publishing.

| Platform       | Connect                    | Publish                   | PKCE      | Client auth         | Refresh                     | Standard revocation | Default scopes                                                |
| -------------- | -------------------------- | ------------------------- | --------- | ------------------- | --------------------------- | ------------------- | ------------------------------------------------------------- |
| LinkedIn       | if configured              | **live** (text + 1 image) | none      | body                | partners only               | no                  | `openid profile w_member_social`                              |
| Facebook Pages | if configured              | **not wired**             | none      | body                | none (reconnect)            | no                  | `pages_show_list,pages_read_engagement,pages_manage_posts`    |
| Instagram      | if configured              | **not wired**             | none      | body                | none (reconnect)            | no                  | `instagram_business_basic,instagram_business_content_publish` |
| Threads        | if configured              | **not wired**             | none      | body                | none (reconnect)            | no                  | `threads_basic,threads_content_publish`                       |
| YouTube        | if configured              | **not wired**             | supported | body                | standard (offline)          | yes                 | `youtube.upload youtube.readonly`                             |
| TikTok         | if configured              | **not wired**             | none      | body (`client_key`) | standard                    | yes                 | `user.info.basic,video.upload,video.publish`                  |
| X              | if configured              | **not wired**             | required  | HTTP Basic          | standard (`offline.access`) | yes                 | `tweet.read tweet.write users.read offline.access`            |
| Pinterest      | if configured              | **not wired**             | none      | HTTP Basic          | standard                    | no                  | `user_accounts:read,boards:read,pins:read,pins:write`         |
| WordPress      | n/a — application password | **live**                  | —         | —                   | —                           | —                   | —                                                             |
| Email          | not connectable            | not wired                 | —         | —                   | —                           | —                   | —                                                             |

"Refresh: none (reconnect)" means the platform has no standard `refresh_token` grant — Meta uses
its own long-lived-token exchange, which arrives with each Meta adapter. Until then those
connections say "reconnect before the token expires".

### Platform approval gates

Every OAuth platform gates real use behind its own review. The Social Accounts page shows these per
platform; in summary:

- **LinkedIn** — member posting is self-serve; organization pages need Community Management API
  access; refresh tokens only for approved partners.
- **Meta (Facebook, Instagram, Threads)** — App Review for every publishing permission; Business
  Verification for advanced access; Instagram publishing needs a professional account.
- **YouTube** — Google OAuth verification for sensitive scopes; uploads from an unaudited project
  are private until a YouTube API Services audit.
- **TikTok** — the Content Posting API requires an app audit; until then posts are `SELF_ONLY`.
- **X** — a developer account; write volume depends on the paid API tier.
- **Pinterest** — Trial access by default; Standard access needs app review.

### Configuring a platform

Set `SOCIAL_OAUTH_<PLATFORM>_CLIENT_ID` and `_CLIENT_SECRET` (both or neither — half a pair fails
boot), `SOCIAL_OAUTH_REDIRECT_BASE_URL`, and `SOCIAL_TOKEN_ENCRYPTION_KEY`. Register
`<SOCIAL_OAUTH_REDIRECT_BASE_URL>/v1/social/oauth/<platform>/callback` in the platform's developer
console; the Social Accounts page shows the exact value. Optional overrides:
`_SCOPES`, `_AUTHORIZATION_URL`, `_TOKEN_URL`, `_REVOCATION_URL` (https-only in production).

## 5. LinkedIn adapter (Phase 6D, ADR-0035)

Official APIs only, versioned with `LINKEDIN_API_VERSION` (default `202608`, supported by LinkedIn
for at least a year from its release):

| Step                | Endpoint                                                   | Scope                                                      |
| ------------------- | ---------------------------------------------------------- | ---------------------------------------------------------- |
| Identify the member | `GET /v2/userinfo` (OpenID Connect)                        | `openid`, `profile`                                        |
| Find postable pages | `GET /rest/organizationAcls?q=roleAssignee&state=APPROVED` | `r_organization_admin` or `rw_organization_admin`          |
| Page names          | `GET /rest/organizationsLookup?ids=List(...)`              | —                                                          |
| Register an image   | `POST /rest/images?action=initializeUpload`                | `w_member_social` / `w_organization_social`                |
| Upload the bytes    | `PUT <uploadUrl>` (must be `*.linkedin.com`, bearer token) | same                                                       |
| Confirm processing  | `GET /rest/images/{urn}` — page authors only               | `w_organization_social`                                    |
| Publish             | `POST /rest/posts` → `x-restli-id`                         | `w_member_social` (member), `w_organization_social` (page) |

| Capability                                  | Member profile                 | Page                        |
| ------------------------------------------- | ------------------------------ | --------------------------- |
| Text (≤ 3,000 characters)                   | live                           | live                        |
| One image (JPG/PNG/GIF, < 36,152,320 px)    | live, processing unconfirmable | live, waits for `AVAILABLE` |
| Video, document, multi-image, article, poll | not implemented                | not implemented             |
| Edit / delete / analytics / comments        | not implemented                | not implemented             |

Pages become targets only for APPROVED roles that can post organically (`ADMINISTRATOR`,
`CONTENT_ADMINISTRATOR`/`CONTENT_ADMIN`). `commentary` is LinkedIn "little" text: `#word` is kept
as a hashtag and every other reserved character is escaped. Setup: `docs/LINKEDIN_SETUP.md`; the
first real run: `docs/LINKEDIN_LIVE_VERIFICATION.md`.
