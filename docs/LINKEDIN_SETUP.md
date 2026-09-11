# LinkedIn setup

How to connect LinkedIn so Spectra can publish as a member and as the pages they administer
(Phase 6D, ADR-0035). Spectra uses LinkedIn's official APIs only.

## What you get

| Post type                                   | Member profile                       | Page                                                  |
| ------------------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| Text                                        | Yes — needs `w_member_social`        | Yes — needs `w_organization_social`                   |
| One image (JPG/PNG/GIF)                     | Yes — processing cannot be confirmed | Yes — Spectra waits for LinkedIn to finish processing |
| Video, document, multi-image, article, poll | Not implemented                      | Not implemented                                       |

Posts are capped at 3,000 characters. Images must have fewer than 36,152,320 pixels; Spectra also
refuses files over 20 MB (its own limit, not LinkedIn's).

## 1. Create the LinkedIn app

1. Go to <https://www.linkedin.com/developers/apps> and create an app. LinkedIn asks you to link
   it to a LinkedIn Page and verify that page.
2. On the **Products** tab add:
   - **Sign In with LinkedIn using OpenID Connect** (self-serve) — scopes `openid`, `profile`.
     Needed to identify the member, so posts can be authored as them.
   - **Share on LinkedIn** (self-serve) — scope `w_member_social`. Needed to post as the member.
   - **Community Management API** (LinkedIn reviews the application) — scopes
     `r_organization_admin` (or `rw_organization_admin`) and `w_organization_social`. Needed to find
     and post as pages. Skip it if you only post as a member.
3. On the **Auth** tab, add the authorized redirect URL. Spectra shows the exact value on
   **Social Accounts → LinkedIn**; it is
   `<SOCIAL_OAUTH_REDIRECT_BASE_URL>/v1/social/oauth/linkedin/callback`.
4. Copy the **Client ID** and **Client Secret**.

## 2. Configure Spectra

Set these in the API **and** the worker (the worker opens tokens to publish and refreshes them):

```bash
SOCIAL_TOKEN_ENCRYPTION_KEY=<base64 32-byte key>
SOCIAL_OAUTH_REDIRECT_BASE_URL=https://api.example.com
SOCIAL_OAUTH_LINKEDIN_CLIENT_ID=<client id>
SOCIAL_OAUTH_LINKEDIN_CLIENT_SECRET=<client secret>
# Only if your app has Community Management (posting as pages):
SOCIAL_OAUTH_LINKEDIN_SCOPES=openid profile w_member_social r_organization_admin w_organization_social
```

The default scopes are `openid profile w_member_social`. **Only request scopes your app has been
granted** — LinkedIn refuses the whole sign-in if Spectra asks for one the app lacks.

Optional: `LINKEDIN_API_VERSION` (default `202608`). LinkedIn supports each monthly version for at
least a year and rejects calls without one; move it forward before the version in use is sunset.
`LINKEDIN_API_BASE_URL` exists so tests can point at a local server; leave it unset in production.

## 3. Connect

1. **Social Accounts → LinkedIn → Connect LinkedIn**. You are sent to LinkedIn to approve.
2. On return, Spectra discovers the member and — with Community Management — the pages they
   administer (roles `ADMINISTRATOR` or content administrator). Each appears under the connection
   with what it can publish.
3. If a product is missing, the connection lists it and whether LinkedIn reviews it. Add it to the
   app, then **Reconnect**.

## 4. Publish

On **Calendar**, choose LinkedIn, pick a discovered profile or page, optionally attach one image
from Media with alt text, and schedule. Scheduling refuses a post LinkedIn would reject (too long,
wrong image format, missing permission) with the reason. Published entries link to the post.

## Tokens and reconnecting

- LinkedIn access tokens last about 60 days. **Refresh tokens are issued only to approved
  partners**; without one, the connection must be reconnected before the token expires. Publishing
  on an expired token fails with "Reconnect LinkedIn" and marks the connection expired.
- With a refresh token, the worker refreshes shortly before expiry.
- If LinkedIn rejects the token (revoked in LinkedIn's settings), the connection is marked
  "reconnect required" and publishing stops until you reconnect.
- Disconnecting deletes the stored token. LinkedIn has no standard revocation endpoint, so also
  remove Spectra under LinkedIn **Settings → Data privacy → Permitted services**.

## Rate limits

Share on LinkedIn documents 150 requests per member per day and 100,000 per application per day.
A LinkedIn 429 is recorded as `RATE_LIMIT`; publish again later.

## Troubleshooting

| What you see                               | What it means                                                                                |
| ------------------------------------------ | -------------------------------------------------------------------------------------------- |
| LinkedIn sign-in fails immediately         | Spectra requested a scope the app lacks — fix `SOCIAL_OAUTH_LINKEDIN_SCOPES`.                |
| No pages discovered                        | No Community Management access, or no `ADMINISTRATOR`/content role on a page.                |
| "Missing LinkedIn products"                | Add the listed product to the app, then Reconnect.                                           |
| `PERMISSION` on publish                    | The grant lacks the scope, or the member lost their page role.                               |
| `AMBIGUOUS` on publish                     | LinkedIn did not answer after the request was sent — check LinkedIn before publishing again. |
| Image post not visible on a member profile | LinkedIn failed to process the image; member tokens cannot check. Re-upload it.              |
