# TikTok, X, Threads and Pinterest setup

How to connect the four platforms added in Phase 6G (ADR-0038), and what each one will and will not
do. Spectra uses each platform's official API only — no scraping, no browser automation.

Email is deliberately **not** one of them; see [Email](#email-not-integrated) at the end.

Common to all four: set `SOCIAL_TOKEN_ENCRYPTION_KEY` and `SOCIAL_OAUTH_REDIRECT_BASE_URL`, then the
platform's client id and secret, in **both** the API and the worker (the worker publishes and
refreshes tokens). Each platform's redirect URI is shown on its card on **Social Accounts** and is
always `<SOCIAL_OAUTH_REDIRECT_BASE_URL>/v1/social/oauth/<platform>/callback`.

---

## TikTok

**What you get:** one video per post, published directly to the creator account that authorized
Spectra (Content Posting API, Direct Post), with the caption, privacy level and interaction
settings TikTok says that creator allows. Photo posts, inbox drafts, edits and deletions are not
implemented.

**The limit that decides everything:** TikTok restricts unaudited API clients —
_"All content posted by unaudited clients will be restricted to private viewing mode."_ Until your
client passes TikTok's audit, a public post is refused and Spectra says why. Declare the audit
result with `TIKTOK_API_CLIENT_AUDITED=true` once it passes; leaving it false only changes the
warnings, never what is sent.

1. At <https://developers.tiktok.com> create an app, add the **Content Posting API** product, and
   turn on **Direct Post**.
2. Get `video.publish` approved for the app (`user.info.basic` comes with it). Spectra does not
   request `video.upload`, which only drops a draft in the creator's inbox.
3. Add the redirect URI, then copy the **Client key** and **Client secret**.

```bash
SOCIAL_OAUTH_TIKTOK_CLIENT_ID=<client key>
SOCIAL_OAUTH_TIKTOK_CLIENT_SECRET=<client secret>
# Optional: TikTok requires 5–64 MB chunks; a file under 5 MB is sent whole.
# TIKTOK_UPLOAD_CHUNK_BYTES=10485760
# TIKTOK_API_CLIENT_AUDITED=false
```

**Publishing:** upload the video on **Media**, then on **Calendar** choose TIKTOK, the creator, the
video and the TikTok details (caption, privacy, comment/duet/stitch). Before every post Spectra asks
TikTok what that creator allows and refuses a privacy level that is not on the list. Videos may run
up to 10 minutes through the API and Spectra uploads files up to 500 MB (TikTok itself accepts
4 GB). An interrupted publish is never sent twice: TikTok's `publish_id` is recorded and the next
attempt asks TikTok what happened to it.

**Tokens:** an access token lasts 24 hours and its refresh token 365 days; the worker refreshes
before publishing.

---

## X

**What you get:** text posts and up to four images to the connected account, with images sent
through the v2 chunked upload endpoints. Video, polls, quote posts, threads, replies and deletions
are not implemented.

**What it costs:** X API v2 is pay-per-usage — credits are deducted per request, and a post costs
more when it contains a link. Check your access in the X developer portal before scheduling
volume; a refusal for an app without a covering plan is reported as exactly that.

1. At <https://developer.x.com> create a project and app with **OAuth 2.0** (confidential client,
   PKCE is required and Spectra uses it).
2. Add the redirect URI and copy the **Client ID** and **Client Secret**.

```bash
SOCIAL_OAUTH_X_CLIENT_ID=<client id>
SOCIAL_OAUTH_X_CLIENT_SECRET=<client secret>
```

Spectra requests `tweet.read tweet.write users.read media.write offline.access`: `media.write` is
needed to upload an image and `offline.access` to refresh the two-hour access token.

**Limits Spectra reports rather than guesses:** X documents 100 posts per user per 15 minutes and
10,000 per app per 24 hours. X's API reference states **no** character limit, so Spectra caps a post
at 280 characters and says so — a verified account may be allowed more.

---

## Threads

**What you get:** text posts and single-image posts to the connected Threads profile, published
through a media container. Video, carousels, replies, quotes and deletions are not implemented.

**Who can use it:** until Meta grants advanced access for `threads_content_publish`, _"you can only
post to Threads for your account and your app's tester accounts."_

1. In the Meta app dashboard add the **Threads API** use case and request `threads_basic` and
   `threads_content_publish`.
2. Add the redirect URI and copy the app id and secret.

```bash
SOCIAL_OAUTH_THREADS_CLIENT_ID=<app id>
SOCIAL_OAUTH_THREADS_CLIENT_SECRET=<app secret>
```

**Images need public storage.** Threads fetches the image itself, so Spectra gives it a 15-minute
signed link to the object. If `STORAGE_ENDPOINT` is a local or private address, image posts are
reported as unavailable with that reason and text posts still work.

**Limits:** 500 characters; JPEG or PNG up to 8 MB, 320–1,440 pixels wide, aspect ratio up to 10:1;
250 API-published posts per profile per 24 hours. Meta recommends about 30 seconds between creating
a container and publishing it, so Spectra waits.

**Tokens:** Threads has no standard refresh grant here — reconnect before the authorization
expires.

---

## Pinterest

**What you get:** one image pin on a board of the connected account, created from a short-lived
link to the image, with a title, description, alt text and destination link. Video pins, carousels,
board creation and edits after publishing are not implemented.

**Access:** a new Pinterest app has **Trial access** — it can act only for accounts you have
granted it, and Pinterest must review the app for Standard access before wider use.

1. At <https://developers.pinterest.com> create an app, add the redirect URI, and copy the app id
   and secret.
2. Spectra requests `user_accounts:read boards:read pins:read pins:write`.

```bash
SOCIAL_OAUTH_PINTEREST_CLIENT_ID=<app id>
SOCIAL_OAUTH_PINTEREST_CLIENT_SECRET=<app secret>
```

**Boards are the targets.** Connecting lists your boards, and each board is a publishing target;
the account itself is listed as somewhere you cannot pin. Pinterest also needs to fetch the image,
so the same public-storage rule as Threads applies.

**What Spectra does not claim:** Pinterest documents no image formats, maximum file size or text
limits for a pin. Spectra sends what you chose and reports Pinterest's own refusal — its 403 is
documented as _"The Pin's image is too small, too large or is broken"_.

---

## Email (not integrated)

Email stays **unconnectable and unwired**, and the UI says so. This is a decision, not an
oversight: sending campaign email responsibly needs things Spectra does not model yet —

- a subscriber list with **provable consent** per address, and its own storage and tenancy rules;
- **unsubscribe** handling: a `List-Unsubscribe` header and a one-click endpoint, honoured before
  every send;
- suppression of bounces and complaints, plus the feedback loop that feeds it;
- sending-domain authentication (SPF, DKIM, DMARC) per workspace.

An ESP adapter without those would let an operator send mail they are not allowed to send, which is
worse than no feature. A post to EMAIL therefore resolves to the honest terminal `UNSUPPORTED`, and
`docs/SOCIAL_PLATFORM_CAPABILITY_MATRIX.md` records it as a deliberate placeholder rather than
work-in-progress.

---

## What is verified, and what is not

Every endpoint, limit and quoted restriction above comes from the platform's own documentation, and
each adapter is tested against a local stand-in that enforces those rules. **None of the four has
been run against the real platform** — there are no app credentials in this environment. Before
relying on any of them, run `docs/REMAINING_PLATFORMS_LIVE_VERIFICATION.md`.
