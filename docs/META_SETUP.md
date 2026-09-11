# Meta setup — Facebook Pages and Instagram

How to connect Meta so Spectra can publish to Facebook Pages and to the Instagram professional
accounts linked to them (Phase 6E, ADR-0036). Spectra uses Meta's official Graph API only, at the
version in `META_GRAPH_API_VERSION` (default `v26.0`).

## What you get

| Post type                                          | Facebook Page                                                  | Instagram professional account                    | Personal Facebook profile, or Instagram account that is not professional |
| -------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------ |
| Text                                               | Yes — `pages_manage_posts` and a Page role with Create content | Not supported by Instagram (every post has media) | Not supported by Meta                                                    |
| One image                                          | Yes — JPEG, PNG, GIF, BMP or TIFF, under 10 MB                 | Yes — JPEG only, 8 MB, aspect ratio 4:5 to 1.91:1 | Not supported by Meta                                                    |
| Video, Reels, stories, carousels, multi-photo post | Not implemented                                                | Not implemented                                   | Not supported by Meta                                                    |

Facebook posts are capped at 63,206 characters. Instagram captions allow 2,200 characters, 30
hashtags and 20 @ tags; alt text up to 1,000 characters.

## 1. Create the Meta app

1. At <https://developers.facebook.com/apps> create an app of type **Business**.
2. Add **Facebook Login for Business** (Facebook Login on other app types). In its settings add
   the valid OAuth redirect URI Spectra shows on **Social Accounts → Meta**:
   `<SOCIAL_OAUTH_REDIRECT_BASE_URL>/v1/social/oauth/facebook/callback`.
3. The permissions Spectra asks for:

   | Permission                  | Used for                                                        |
   | --------------------------- | --------------------------------------------------------------- |
   | `pages_show_list`           | Listing the Pages you have a role on                            |
   | `pages_read_engagement`     | Page metadata; required alongside Page publishing and Instagram |
   | `pages_manage_posts`        | Publishing to those Pages                                       |
   | `instagram_basic`           | Finding the Instagram account linked to each Page               |
   | `instagram_content_publish` | Publishing to that Instagram account                            |

   Every one needs **Advanced Access through App Review** before anyone without a role on the app
   can grant it, and Meta may require **Business Verification**. Until then, people with a role on
   the app (administrators, developers, testers) can connect for testing. Pages reached through a
   Business portfolio may also need `business_management` (and, per Meta's Instagram docs,
   `ads_management` or `ads_read` when the Page role comes from Business Manager) — add them to
   `SOCIAL_OAUTH_FACEBOOK_SCOPES` if Meta asks.

4. Copy the **App ID** and **App Secret** (App settings → Basic).

## 2. Configure Spectra

Set these in the API **and** the worker (the worker publishes, and signs every Graph call):

```bash
SOCIAL_TOKEN_ENCRYPTION_KEY=<base64 32-byte key>
SOCIAL_OAUTH_REDIRECT_BASE_URL=https://api.example.com
SOCIAL_OAUTH_FACEBOOK_CLIENT_ID=<App ID>
SOCIAL_OAUTH_FACEBOOK_CLIENT_SECRET=<App Secret>
# Only if the app is not yet approved for Instagram:
# SOCIAL_OAUTH_FACEBOOK_SCOPES=pages_show_list pages_read_engagement pages_manage_posts
```

The App Secret also produces `appsecret_proof`, sent with every Graph call; turn on **Require App
Secret** in the app's advanced settings once connected.

Optional: `META_GRAPH_API_VERSION` (default `v26.0`, released 2026-07-29). Meta supports a version
for about two years; move it forward before the one in use is retired. `META_GRAPH_API_BASE_URL`
exists so tests can point at a local server; leave it unset in production.

**Instagram needs storage the internet can reach.** Instagram fetches each image itself. Spectra
gives it a signed link to the stored object that lasts 15 minutes. If `STORAGE_ENDPOINT` is a local
or private address (`localhost`, a docker-compose service name, `10.x`, `192.168.x`,
`172.16–31.x`), the worker says so at boot and Instagram posts resolve to `UNSUPPORTED` with that
reason. Facebook photos are uploaded directly and do not need this.

## 3. Connect

1. **Social Accounts → Meta — Facebook Pages & Instagram → Connect**. Meta asks which Pages and
   Instagram accounts to share.
2. Spectra exchanges Meta's one-hour token for a long-lived one (about 60 days) **before anything
   else**. If Meta refuses, nothing is stored and you see "token exchange failed" — a grant that
   would silently die within the hour is not kept.
3. Meta's token response does not say what was granted, so Spectra reads `/me/permissions` and
   records that. It then discovers:
   - **you** — a personal profile, listed as "cannot publish here" (Facebook does not let apps post
     to profiles);
   - **each Page** you have a role on, with that Page's own access token, sealed on the account;
   - **the Instagram account linked to each Page** — eligible when Facebook reports it as the
     Page's professional account (`instagram_business_account`); listed as not eligible, with the
     reason, when it is only connected through Page settings (`connected_instagram_account`).
4. Missing permissions are listed per Meta product, marked as reviewed by Meta. Add them to the
   app, then **Reconnect**.

## 4. Publish

On **Calendar**, choose **FACEBOOK** and a Page to post text or text with one photo; choose
**INSTAGRAM** and a professional account to post one JPEG with a caption and optional alt text —
the image is required. Scheduling refuses what Meta would reject (wrong format, wrong shape, too
long, missing permission, ineligible account) with the reason. Published entries link to the post.

Instagram limits API-published posts per account over a rolling 24 hours (documented as 100).
Spectra reads the account's actual allowance from `content_publishing_limit` before each post and
refuses with `RATE_LIMIT` when it is used up.

## Tokens and reconnecting

- **Meta issues no refresh tokens.** The long-lived user token lasts about 60 days; the Page tokens
  obtained with it do not expire. Publishing to Pages and Instagram continues after the user token
  lapses — the connection shows "token expired", and you reconnect to find new Pages or pick up
  permission changes.
- Meta invalidates Page tokens when the user changes their password, removes the app, or loses the
  Page role. Its error 190 fails the entry `AUTH`, marks the connection "reconnect required", and
  later publishes stop before contacting Meta. **Reconnect** renews the connection in place and
  re-seals fresh Page tokens on the same accounts.
- **Disconnect** deletes the user token and every Page token. Spectra has no Meta revocation
  endpoint, so also remove the app under Facebook **Settings → Business integrations**.

## Troubleshooting

| What you see                                                        | What it means                                                                                        |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| "Token exchange failed" right after consent                         | Meta refused the code or the long-lived exchange — check the App ID, App Secret and redirect URI.    |
| No Pages discovered                                                 | `pages_show_list` not granted, or no Pages selected in Meta's dialog. Reconnect and select them.     |
| A Page shows "permission missing" — no Page token                   | Your Page role does not include Create content. Ask a Page admin, then reconnect.                    |
| Instagram account: "Cannot publish here"                            | Not a professional account linked to the Page. Switch it to Business or Creator, link it, reconnect. |
| Instagram `UNSUPPORTED`: "local or private address"                 | Object storage is not reachable from the internet — see section 2.                                   |
| `PERMISSION` on publish                                             | The grant lacks the permission (App Review), or the Page role changed.                               |
| `RATE_LIMIT`                                                        | Meta throttled the app, or the Instagram 24-hour allowance is used up. Publish later.                |
| `AMBIGUOUS` on Facebook                                             | Meta did not answer after the post was sent — check the Page before publishing again.                |
| `AMBIGUOUS` on Instagram: "already published by an earlier attempt" | The post went out but its id was lost. Spectra will not publish it again.                            |
