# YouTube setup

How to connect YouTube so Spectra can upload videos to a channel (Phase 6F, ADR-0037). Spectra uses
the official YouTube Data API v3 only.

## What you get

| Capability                                                   | Status                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Video upload (resumable, retry-safe)                         | Yes — title, description, tags, category, privacy, made-for-kids declaration |
| Custom thumbnail                                             | Yes — JPEG or PNG up to 2 MB, set after the upload                           |
| Text or image posts                                          | Not possible — YouTube community posts have no public API                    |
| Livestreams, playlists, editing or deleting after publishing | Not implemented                                                              |

YouTube's own limits, enforced before anything is uploaded: a title of at most 100 characters, a
description of at most 5,000 **bytes**, and at most 500 characters of tags combined. Titles and
descriptions may not contain `<` or `>`. Spectra uploads files up to 500 MB (its object-storage
limit; YouTube itself accepts up to 256 GB).

## 1. Create the Google Cloud project

1. At <https://console.cloud.google.com> create a project and enable the **YouTube Data API v3**.
2. Configure the **OAuth consent screen** (External unless everyone is in your Workspace domain).
   Add the scopes Spectra requests:

   | Scope                                              | Used for                        |
   | -------------------------------------------------- | ------------------------------- |
   | `https://www.googleapis.com/auth/youtube.upload`   | Uploading videos and thumbnails |
   | `https://www.googleapis.com/auth/youtube.readonly` | Listing the channels you own    |

   Both are **sensitive scopes**: while the app's publishing status is "Testing", only users you add
   as test users can connect — and Google issues refresh tokens that **expire after 7 days**
   ("A Google Cloud Platform project with an OAuth consent screen configured for an external user
   type and a publishing status of 'Testing' is issued a refresh token expiring in 7 days"). Publish
   the app and pass Google's OAuth verification before real use.

3. Create an **OAuth client ID** of type _Web application_ and add the redirect URI Spectra shows on
   **Social Accounts → YouTube**:
   `<SOCIAL_OAUTH_REDIRECT_BASE_URL>/v1/social/oauth/youtube/callback`.
4. Copy the **Client ID** and **Client secret**.

## 2. The two limits that decide what an upload actually does

- **API compliance audit.** Google restricts what an unaudited project may publish: _"All videos
  uploaded via the `videos.insert` endpoint from unverified API projects created after 28 July 2020
  will be restricted to private viewing mode."_ Until your project passes the YouTube API Services
  audit, a video you ask to publish publicly can come back **private**. Spectra never claims
  otherwise: it reports the privacy YouTube actually applied, and says why.
- **Quota.** A new project gets a default allocation of 10,000 units per day for most endpoints,
  plus **100 `videos.insert` calls per day**. Uploads are the scarce resource. A refusal is recorded
  as `QUOTA` with Google's own reason; quota resets at midnight Pacific Time.

Declare the audit result to Spectra with `YOUTUBE_API_PROJECT_AUDITED` (below). Leaving it `false`
only makes the warnings appear — it never changes what is uploaded.

## 3. Configure Spectra

Set these in the API **and** the worker (the worker performs the upload):

```bash
SOCIAL_TOKEN_ENCRYPTION_KEY=<base64 32-byte key>
SOCIAL_OAUTH_REDIRECT_BASE_URL=https://api.example.com
SOCIAL_OAUTH_YOUTUBE_CLIENT_ID=<client id>
SOCIAL_OAUTH_YOUTUBE_CLIENT_SECRET=<client secret>
# Once Google has audited the project:
# YOUTUBE_API_PROJECT_AUDITED=true
# Resumable chunk size; must be a multiple of 262144 (256 KiB):
# YOUTUBE_UPLOAD_CHUNK_BYTES=8388608
```

Spectra requests `access_type=offline` and `prompt=consent`, so Google issues a refresh token and
the worker renews the access token by itself. `YOUTUBE_API_BASE_URL` exists so tests can point at a
local server; leave it unset in production.

## 4. Get the video into Spectra

Spectra renders images but not video, so the video itself is uploaded: **Media → Upload a file**
(video or image, up to 500 MB). The browser gets a signed link and sends the file straight to your
object storage; Spectra then records the asset with the size and type storage reports. Your bucket
must allow browser `PUT` uploads from the web origin (CORS).

## 5. Connect and publish

1. **Social Accounts → YouTube → Connect**, and choose the Google account that owns the channel. To
   publish as a brand channel, pick that channel at Google's account chooser.
2. Spectra lists the channels the grant returned, with what each can publish and any warning
   (unaudited project, long-uploads status).
3. On **Calendar**, choose **YOUTUBE**, the channel, the video, and fill in the video details:
   title, description, tags, category id, privacy, whether it is made for kids, and whether to
   notify subscribers. Optionally attach a thumbnail. Scheduling refuses anything YouTube would
   reject.
4. The worker uploads the video in chunks. An interrupted upload **resumes** on the next attempt
   rather than starting again, and a finished upload is never sent twice.

## Tokens, quota and reconnecting

- Google issues a refresh token when the flow asks for offline access; the worker refreshes shortly
  before expiry. In "Testing" status those refresh tokens expire after 7 days, and Google also
  invalidates them after six months unused, on some password changes, or when the user revokes
  access — each of which shows as "reconnect required".
- **Disconnect** deletes the stored tokens and asks Google to revoke them
  (`https://oauth2.googleapis.com/revoke`).

## Troubleshooting

| What you see                                      | What it means                                                                                 |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Google shows an "unverified app" warning          | The consent screen is not verified yet; only test users can continue.                         |
| The video is private though you asked for public  | The project has not passed the API audit — see section 2. The entry says so.                  |
| `QUOTA` on publish                                | The project's daily allowance (or the 100 uploads/day) is used up. It resets at midnight PT.  |
| `PERMISSION`                                      | The grant lacks `youtube.upload`, or the account cannot act on that channel. Reconnect.       |
| `TRANSIENT` "publish again to resume"             | The upload stalled; the next attempt continues from the bytes YouTube confirmed.              |
| `AMBIGUOUS`                                       | YouTube did not answer after the upload was sent — check the channel before publishing again. |
| The thumbnail was refused but the video published | YouTube accepted the video and rejected the image; the entry says exactly that.               |
| Uploading in the browser fails                    | Object storage must allow `PUT` from the web origin (CORS).                                   |
