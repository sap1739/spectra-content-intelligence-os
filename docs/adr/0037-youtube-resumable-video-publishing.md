# ADR-0037: YouTube — resumable video publishing over the Data API v3

**Status:** Accepted · **Date:** 2026-09-12 · **Relates to:** ADR-0018, ADR-0020, ADR-0034, ADR-0035, ADR-0036

## Context

Every live publisher so far posts text with at most one image. YouTube is different in ways that
reach back into the pipeline (Google's documentation, checked 2026-09-12):

- **The payload is a video file**, up to 256 GB, uploaded with a resumable protocol: `POST
/upload/youtube/v3/videos?uploadType=resumable` with `X-Upload-Content-Length`, then `PUT`s of
  256 KiB multiples against the session URI Google returns in `Location`, with `308` + `Range`
  reporting what it has and `404` meaning the session expired.
- **Spectra had no way to hold a video at all.** Media assets were only ever produced by the sharp
  renderer, which makes images; nothing could create a `VIDEO` asset, so a YouTube adapter alone
  would have had nothing to publish.
- **A video carries metadata a content item does not have**: title (100 characters), description
  (5,000 bytes), tags (500 characters combined), category, privacy, a made-for-kids declaration, and
  whether to notify subscribers. Titles and descriptions cannot contain `<` or `>`.
- **Two limits decide what an upload really does.** Videos uploaded by an unaudited API project are
  _"restricted to private viewing mode"_, and the project's daily quota includes only 100
  `videos.insert` calls.
- Uploads are expensive to retry: re-sending a whole file costs bandwidth and another upload call.

## Decision

### 1. A real upload path, before the adapter

`POST …/media/uploads` issues a 15-minute signed URL and `POST …/media/uploads/complete` registers
the asset **only after storage confirms the object**, recording the size and content type storage
reports rather than what the client claimed. The key is derived from the ticket id, so completing an
upload can never name another tenant's object, and a ticket nobody used leaves no row behind.
Completing twice returns the same asset.

### 2. Video details live on the schedule entry

`ContentScheduleEntry.publishMetadata` holds platform-specific fields (`publishMetadata.youtube`,
validated by `youtubeVideoMetadataSchema` in contracts), and `thumbnailAssetId` holds an optional
cover image. `PublishInput` gained `metadata` and `thumbnail`; each adapter validates its own slice
and ignores the rest. Without any metadata the adapter falls back to the content item's title and
body and keeps privacy `private` — the narrowest setting, never widened by default.

### 3. Resumable uploads, recorded so a retry resumes

`SocialMediaUpload` gained `encryptedUploadUrl`, `credentialKeyId` and `uploadedBytes`. The session
URL is a capability — anyone holding it can write to that upload — so it is sealed with the social
key ring, never logged, and dropped the moment the upload finishes. A retry probes the session
(`Content-Range: bytes */TOTAL`), resumes from the byte Google confirms, and a ledger that already
holds a video id publishes nothing at all. An expired session (404) starts a fresh one, because
nothing was published. Progress is visible on the calendar.

### 4. The session URI is checked before bytes or token go to it

Google returns the upload location in a header; Spectra sends the file and the bearer token only to
the API's own origin or a `*.googleapis.com` host.

### 5. Quota is its own answer

A new `QUOTA` failure code separates "the allowance for the period is used up" from `RATE_LIMIT`
("too fast, try shortly"). Spectra never predicts quota; it reports Google's own `reason` and says
when the quota resets.

### 6. A successful publish can carry a note

`PublishOutcome.note` → `ContentScheduleEntry.publishNote` states what the platform did that the
operator should know: YouTube setting a video private when `public` was asked (quoting the audit
restriction), still processing the video, or accepting the video while refusing the thumbnail. It
is only ever used on a SUCCESS — a failure is still a failure, with a reason.

### 7. Capabilities say what YouTube does not do

A channel's snapshot marks VIDEO available with `youtube.upload`, and TEXT, IMAGE and DOCUMENT
`NOT_SUPPORTED` — YouTube community posts have no public API, so they are not "not implemented".
Notes carry the unaudited-project restriction and the channel's `longUploadsStatus`.

### 8. Everything else is unchanged

Idempotency, budget pre-flight, tenant-checked media reads and the honest UNSUPPORTED/FAILED states
work exactly as before; `createPublisherResolver` gained a YouTube case, and its token-refresh
helper is now shared (Google issues refresh tokens on the standard grant, LinkedIn only to
partners).

## Consequences

- A video made elsewhere can be uploaded to Spectra and published to YouTube, with the details and
  thumbnail an operator set, resumably and without ever double-publishing.
- **Not verified against YouTube itself here** (no Google project credentials).
  `docs/YOUTUBE_LIVE_VERIFICATION.md` is the checklist; its open questions are whether a channel
  must be verified for custom thumbnails (thumbnails.set does not say), and the exact quota cost of
  an upload, which Google's table now expresses as a separate uploads bucket.
- Spectra caps uploads at 500 MB — its object-storage policy — far below YouTube's 256 GB, and the
  worker holds the file in memory while uploading it. Larger files need streaming, which is not
  built.
- Browser uploads need CORS on the bucket; without it the UI says so rather than failing silently.
- Not built: livestreams, playlists, captions, community posts, editing or deleting a published
  video, and analytics.
