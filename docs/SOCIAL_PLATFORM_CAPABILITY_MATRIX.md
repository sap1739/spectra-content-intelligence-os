# Social Platform Capability Matrix

**Status (Phase 6G):** Every platform except email now publishes for real: WordPress
(ADR-0022), LinkedIn (ADR-0035), Facebook Pages and Instagram professional accounts (ADR-0036),
YouTube (ADR-0037), and TikTok, X, Threads and Pinterest (ADR-0038).
professional accounts (ADR-0036) and YouTube channels (ADR-0037, video uploads) publish for real. LinkedIn publishes text and one image, as a
member or as a page they administer; Facebook publishes text and one photo to Pages; Instagram
publishes one JPEG image to professional accounts linked to a Page, through a Meta (Facebook)
connection; YouTube uploads a video to a channel; TikTok posts one video to the creator that
authorized it; X posts text and up to four images; Threads posts text or one image; Pinterest
creates one image pin on a board. A direct Instagram Login connection still stores an
authorization only. **Email is deliberately not integrated** — see §8.

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

| Platform        | Connect                    | Publish                                                           | PKCE      | Client auth               | Refresh                                        | Standard revocation | Default scopes                                                                                       |
| --------------- | -------------------------- | ----------------------------------------------------------------- | --------- | ------------------------- | ---------------------------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| LinkedIn        | if configured              | **live** (text + 1 image)                                         | none      | body                      | partners only                                  | no                  | `openid profile w_member_social`                                                                     |
| Meta (Facebook) | if configured              | **live** — Pages: text + 1 photo; Instagram: 1 JPEG               | none      | body (GET, as documented) | long-lived exchange; Page tokens do not expire | no                  | `pages_show_list,pages_read_engagement,pages_manage_posts,instagram_basic,instagram_content_publish` |
| Instagram Login | if configured              | authorization only — publish through a Meta (Facebook) connection | none      | body                      | none (reconnect)                               | no                  | `instagram_business_basic,instagram_business_content_publish`                                        |
| Threads         | if configured              | **live** (text + 1 image)                                         | none      | body                      | none (reconnect)                               | no                  | `threads_basic,threads_content_publish`                                                              |
| YouTube         | if configured              | **live** (video upload)                                           | supported | body                      | standard (offline)                             | yes                 | `youtube.upload youtube.readonly`                                                                    |
| TikTok          | if configured              | **live** (1 video, Direct Post)                                   | none      | body (`client_key`)       | standard                                       | yes                 | `user.info.basic,video.upload,video.publish`                                                         |
| X               | if configured              | **live** (text + up to 4 images)                                  | required  | HTTP Basic                | standard (`offline.access`)                    | yes                 | `tweet.read tweet.write users.read offline.access`                                                   |
| Pinterest       | if configured              | **live** (1 image pin)                                            | none      | HTTP Basic                | standard                                       | no                  | `user_accounts:read,boards:read,pins:read,pins:write`                                                |
| WordPress       | n/a — application password | **live**                                                          | —         | —                         | —                                              | —                   | —                                                                                                    |
| Email           | not connectable            | not wired                                                         | —         | —                         | —                                              | —                   | —                                                                                                    |

"Refresh: none (reconnect)" means the platform has no standard `refresh_token` grant. The Meta
(Facebook) connection uses Meta's own long-lived-token exchange instead (6E): the user token lasts
about 60 days and the Page tokens obtained with it do not expire, so publishing continues after the
user token lapses. Instagram Login and Threads connections still say "reconnect before the token
expires".

### Platform approval gates

Every OAuth platform gates real use behind its own review. The Social Accounts page shows these per
platform; in summary:

- **LinkedIn** — member posting is self-serve; organization pages need Community Management API
  access; refresh tokens only for approved partners.
- **Meta (Facebook, Instagram, Threads)** — App Review (Advanced Access) for every publishing
  permission; Business Verification for advanced access; Instagram publishing needs a professional
  (Business or Creator) account linked to a Facebook Page.
- **YouTube** — Google OAuth verification for sensitive scopes; while the consent screen is in
  "Testing" only listed test users can connect and refresh tokens expire after 7 days. Videos
  uploaded by an unaudited API project are restricted to private viewing until a YouTube API
  Services audit, and the daily quota includes only 100 uploads.
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

## 6. Meta adapters — Facebook Pages and Instagram (Phase 6E, ADR-0036)

Official Graph API only, at `META_GRAPH_API_VERSION` (default `v26.0`), every call signed with
`appsecret_proof`:

| Step                     | Endpoint                                                                     | Permission                                     |
| ------------------------ | ---------------------------------------------------------------------------- | ---------------------------------------------- |
| Exchange the code        | `GET /oauth/access_token` (code, then `grant_type=fb_exchange_token`)        | —                                              |
| What was granted         | `GET /me/permissions`                                                        | —                                              |
| Who connected            | `GET /me?fields=id,name` — a personal profile, never publishable             | —                                              |
| Pages, tokens, linked IG | `GET /me/accounts?fields=…,access_token,tasks,instagram_business_account{…}` | `pages_show_list` (+ `instagram_basic` for IG) |
| Facebook text post       | `POST /{page-id}/feed` (`message`) with the Page token                       | `pages_manage_posts`                           |
| Facebook photo post      | `POST /{page-id}/photos` multipart (`source`, `caption`)                     | `pages_manage_posts`                           |
| Instagram allowance      | `GET /{ig-id}/content_publishing_limit`                                      | `instagram_content_publish`                    |
| Instagram container      | `POST /{ig-id}/media` (`image_url` signed link, `caption`, `alt_text`)       | `instagram_content_publish`                    |
| Container status         | `GET /{container-id}?fields=status_code`                                     | —                                              |
| Instagram publish        | `POST /{ig-id}/media_publish` (`creation_id`)                                | `instagram_content_publish`                    |
| Permalinks               | `GET /{post-id}?fields=permalink_url`, `GET /{media-id}?fields=permalink`    | —                                              |

| Capability                                    | Facebook Page                         | Instagram professional account     | Personal profile / other Instagram |
| --------------------------------------------- | ------------------------------------- | ---------------------------------- | ---------------------------------- |
| Text                                          | live (≤ 63,206 characters)            | not supported by Instagram         | not supported by Meta              |
| One image                                     | live — JPEG/PNG/GIF/BMP/TIFF, < 10 MB | live — JPEG, ≤ 8 MB, 4:5 to 1.91:1 | not supported by Meta              |
| Video, Reels, stories, carousels, multi-photo | not implemented                       | not implemented                    | not supported by Meta              |
| Edit / delete / insights / comments           | not implemented                       | not implemented                    | —                                  |

A Page is writable only with a Page token, issued to a user whose role includes CREATE_CONTENT or
MANAGE. An Instagram account is eligible only as the Page's `instagram_business_account`; one
linked only through Page settings (`connected_instagram_account`) is recorded as `NOT_SUPPORTED`
with the reason. Instagram captions allow 2,200 characters, 30 hashtags and 20 @ tags; the image is
fetched by Instagram from a 15-minute signed link, so storage must be internet-reachable. Setup:
`docs/META_SETUP.md`; the first real run: `docs/META_LIVE_VERIFICATION.md`.

## 7. YouTube adapter (Phase 6F, ADR-0037)

The official YouTube Data API v3 only, with Google's documented resumable upload:

| Step                 | Endpoint                                                                   | Scope              |
| -------------------- | -------------------------------------------------------------------------- | ------------------ |
| Find channels        | `GET /youtube/v3/channels?part=snippet,status&mine=true` (quota 1)         | `youtube.readonly` |
| Start the upload     | `POST /upload/youtube/v3/videos?uploadType=resumable&part=snippet,status`  | `youtube.upload`   |
| Send the bytes       | `PUT <session URI>` in 256 KiB multiples, `Content-Range` per chunk        | `youtube.upload`   |
| Resume after a stall | `PUT <session URI>` with `Content-Range: bytes */TOTAL`, then from `Range` | `youtube.upload`   |
| Custom thumbnail     | `POST /upload/youtube/v3/thumbnails/set?videoId=…` (JPEG/PNG, 2 MB)        | `youtube.upload`   |

| Capability                                                       | Channel                                            |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| Video upload (title, description, tags, category, privacy, kids) | live                                               |
| Custom thumbnail                                                 | live — a refused thumbnail does not fail the video |
| Text or image posts                                              | not supported (community posts have no public API) |
| Livestreams, playlists, captions, edit/delete, analytics         | not implemented                                    |

Limits enforced before an upload starts: title 100 characters, description 5,000 **bytes**, tags
500 characters combined, no `<` or `>`; Spectra caps the file at 500 MB (its storage policy —
YouTube itself accepts 256 GB). Two facts are always reported rather than assumed: an unaudited API
project has its uploads "restricted to private viewing mode", and quota refusals come back as
`QUOTA` with Google's own reason. Setup: `docs/YOUTUBE_SETUP.md`; the first real run:
`docs/YOUTUBE_LIVE_VERIFICATION.md`.

## 8. The remaining platforms (Phase 6G, ADR-0038)

Official APIs only, and each adapter publishes exactly what its platform's API allows:

| Platform  | Endpoints used                                                                      | What it publishes                | The gate in front of it                                           |
| --------- | ----------------------------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------- |
| TikTok    | `creator_info/query`, `video/init` (FILE_UPLOAD), signed chunk PUTs, `status/fetch` | 1 video, Direct Post             | TikTok audit: unaudited clients post privately only               |
| X         | `POST /2/tweets`; media `initialize` → `append` → `finalize` → `STATUS`             | text + up to 4 images            | Pay-per-usage credits / covering API access                       |
| Threads   | `POST /{id}/threads` then `POST /{id}/threads_publish`; `GET /me`                   | text or 1 image                  | Meta advanced access (else own + tester accounts)                 |
| Pinterest | `GET /v5/user_account`, `GET /v5/boards` (bookmark paging), `POST /v5/pins`         | 1 image pin on a board           | Trial access until Pinterest reviews the app                      |
| Email     | none                                                                                | nothing — deliberate placeholder | consent, unsubscribe, suppression and domain authentication first |

What each adapter does NOT do is declared per account, not implied: TikTok photo posts and inbox
drafts, X video/polls/quotes/threads/replies, Threads video and carousels, and Pinterest video
pins, carousels and board creation are all `NOT_IMPLEMENTED`; a text-only pin and a text-only
TikTok post are `NOT_SUPPORTED`, because those platforms have no such thing.

Two places where the platform documents nothing, so Spectra claims nothing: X states no character
limit (Spectra caps a post at 280 and says the cap is its own), and Pinterest states no image
formats, size or text limits (its own 403 — "The Pin's image is too small, too large or is broken" —
is passed through). Both are in the live checklist to learn from a real run.

Threads and Pinterest fetch images themselves, so they need object storage reachable from the
internet, exactly as Instagram does; without it those posts report that reason and Threads still
posts text. Setup: `docs/REMAINING_PLATFORMS_SETUP.md`; the first real run:
`docs/REMAINING_PLATFORMS_LIVE_VERIFICATION.md`.
