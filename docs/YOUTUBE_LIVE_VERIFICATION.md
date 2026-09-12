# YouTube live verification checklist

The adapter is tested end to end against a local server that follows Google's documented resumable
upload protocol (`apps/api/test/youtube.spec.ts`). It has **not** been run against YouTube itself.
Run this list against a real Google Cloud project and a test channel before relying on it, and
record the result.

Use a throwaway channel. Delete test uploads afterwards — each one costs a `videos.insert` call
against the project's 100-per-day allowance.

**Environment**

- [ ] The project has the **YouTube Data API v3** enabled and an OAuth client whose redirect URI
      matches Spectra's exactly.
- [ ] API and worker share `SOCIAL_TOKEN_ENCRYPTION_KEY` and the YouTube client id/secret.
- [ ] `YOUTUBE_API_BASE_URL` is unset (real Google).
- [ ] `YOUTUBE_API_PROJECT_AUDITED` matches reality for this project.
- [ ] Object storage allows browser `PUT` uploads from the web origin.

**Connect and discover**

- [ ] Connect while the consent screen is in "Testing": Google shows the unverified-app warning and
      only a listed test user can continue.
- [ ] The connection records a refresh token (`access_type=offline` + `prompt=consent` worked).
- [ ] The channel appears with its real title, custom URL and `longUploadsStatus`.
- [ ] A Google account with no channel fails with "no YouTube channel", not a crash.
- [ ] Connecting with a brand channel selected at Google's account chooser discovers that channel.

**Upload**

- [ ] Upload a ~50 MB MP4 through **Media → Upload a file**; the asset records the real size.
- [ ] Publish it privately: the entry reaches PUBLISHED and "View post" opens the watch page.
- [ ] Title, description, tags, category and made-for-kids all arrive as set (check YouTube Studio).
- [ ] `notifySubscribers=false` does not notify subscribers.
- [ ] A custom JPEG thumbnail is applied. **If Google refuses it, record the error** — a channel
      usually must be verified to set custom thumbnails, which Google's thumbnails.set reference
      does not state.
- [ ] A 3 MB thumbnail and a WebP thumbnail are refused at scheduling time.
- [ ] A 101-character title and a description over 5,000 bytes are refused at scheduling time.

**The two honesty cases**

- [ ] With an **unaudited** project, ask for `public`: the video comes back private, the entry is
      PUBLISHED, and its note quotes Google's restriction. Confirm in YouTube Studio.
- [ ] Exhaust the daily quota (or use a project with none left): the entry fails `QUOTA` with
      Google's reason, and the message mentions the midnight Pacific reset.

**Resume and retry**

- [ ] Interrupt the worker mid-upload (stop it), then publish the entry again: the upload RESUMES —
      `social_media_uploads.uploadedBytes` advances and no second `videos.insert` session starts.
- [ ] Publishing an entry whose upload already finished does not create a second video.
- [ ] Leave a session unused for a day: a resumed upload that Google has expired (404) starts a
      fresh session rather than failing permanently.

**Failure**

- [ ] Revoke access at <https://myaccount.google.com/permissions>, then publish: the entry fails
      `AUTH`, the connection becomes "reconnect required", and the next publish stops before
      calling Google.
- [ ] Reconnect restores publishing without creating a second connection.
- [ ] With the app in "Testing", leave the connection 8 days and publish: the refresh token has
      expired, and the entry says to reconnect.

**Hygiene**

- [ ] No access token, refresh token, client secret or resumable session URL appears in API or
      worker logs.
- [ ] Disconnect deletes the stored credential and revokes it with Google.

**Record**

| Date | Project audited? | Quota available | Result | Notes |
| ---- | ---------------- | --------------- | ------ | ----- |
|      |                  |                 |        |       |
