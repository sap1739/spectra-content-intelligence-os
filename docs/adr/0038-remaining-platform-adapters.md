# ADR-0038: TikTok, X, Threads and Pinterest — adapters only where the official APIs allow, and email as a placeholder

**Status:** Accepted · **Date:** 2026-09-12 · **Relates to:** ADR-0019, ADR-0020, ADR-0034, ADR-0035, ADR-0036, ADR-0037

## Context

After WordPress, LinkedIn, Meta and YouTube, five platforms were left: TikTok, X, Threads,
Pinterest and email. Each gates real publishing differently, and each documents a different amount
of what it will accept (platform documentation, checked 2026-09-12):

- **TikTok** requires the Content Posting API's `video.publish`, an app audit, and a
  `creator_info/query` call **before** every direct post — the creator's own settings decide which
  privacy levels and interactions are allowed. Unaudited clients are restricted to private posts.
  A video is uploaded in 5–64 MB chunks against a signed URL, and a `publish_id` tracks the result.
- **X** documents `POST /2/tweets`, a four-step chunked media upload, and per-user/per-app rate
  limits — but **no character limit**, and its v2 pricing is pay-per-usage, so publishing costs
  money per request and an app without a covering plan is refused.
- **Threads** publishes through a media container and a separate publish call, needs the image on a
  public server, recommends ~30 seconds between the two, caps a profile at 250 API posts per 24
  hours, and — until advanced access — only allows posting to your own and tester accounts.
- **Pinterest** documents `board_id` + `media_source` for a pin and little else: no image formats,
  no maximum size, no text limits. New apps hold Trial access until Pinterest reviews them.
- **Email** has no platform API at all — it needs consent records, unsubscribe handling,
  suppression lists and domain authentication before a single send is defensible.

## Decision

### 1. Four adapters, and one honest placeholder

TikTok, X, Threads and Pinterest each get a real package (`@spectra/social-tiktok`,
`-x`, `-threads`, `-pinterest`) with configuration, discovery, per-account capabilities,
validation, a publisher for the operations their APIs actually support, and mocked tests. Email is
**not** integrated: `EMAIL` stays unconnectable and unwired, a post to it resolves to the honest
terminal `UNSUPPORTED`, and the setup guide records why (consent, unsubscribe, suppression, domain
authentication) rather than leaving it looking unfinished.

### 2. Nothing is claimed that a platform does not document

Where a platform states a limit, the adapter enforces it before sending (Threads' 500 characters
and image bounds; TikTok's 2,200-rune caption and chunk rules; X's four media ids and 5 MB
segments). Where it does not, no number is invented:

- Pinterest's capability record carries `maxCharacters: null` and an empty format list, and its
  documented 403 — _"The Pin's image is too small, too large or is broken"_ — is passed through in
  Pinterest's own words.
- X's 280-character cap is labelled as **Spectra's**, not X's, everywhere it appears.

Both facts are written into the live-verification checklist as things to learn from a real run.

### 3. The creator decides, not Spectra (TikTok)

Every TikTok publish queries `creator_info` first, as TikTok requires, and refuses a privacy level
that is not in the creator's own `privacy_level_options` — quoting TikTok's audit restriction when
that is why only `SELF_ONLY` is offered. An interaction the creator disabled is never re-enabled by
the post.

### 4. One publish, once

Each platform's "already in flight" marker is recorded so a retry can never double-post: TikTok's
`publish_id` (with its signed upload URL sealed by the key ring and dropped when the publish ends),
Threads' container id on the schedule entry, and X's media id so an image is attached again rather
than re-uploaded. A TikTok publish still processing, or an X image still processing, fails
`TRANSIENT` with the marker kept — and the message says a retry checks rather than re-sends.

### 5. Shared connection handling

`openConnection` in the resolver now does what four platforms need identically: find a live
connection on the right platform, refuse the wrong account kind, check the platform's required
scopes against the grant, open the sealed token, and refresh it where the platform issues refresh
tokens (TikTok 24 h/365 d, X ~2 h, Pinterest standard; Threads has none, so it asks for a
reconnect). Two small extensions made this possible: `DiscoveryContext.subjectId` (TikTok names the
creator only as the token response's `open_id`) and `PublishAccount.discoveryMetadata` (X and
Threads build a post's link from the handle discovery recorded).

### 6. Boards are destinations (Pinterest)

A pin belongs to a board, so discovery lists boards as `CHANNEL` destinations and the account
itself is recorded as somewhere you cannot pin. The board id is the account's `externalAccountId`,
which is what the resolver hands the publisher.

### 7. Images the platform fetches itself

Threads and Pinterest both pull the image from a URL, so they reuse the Instagram policy from
ADR-0036: a 15-minute signed link, offered only when `STORAGE_ENDPOINT` is not a local or private
address, and reported as unavailable with that reason when it is. For Threads, text posts keep
working in that case.

### 8. Every refusal keeps its own name

New error kinds map to existing failure codes without blurring them: TikTok's `AUDIT` and X's
`ACCESS` (plan/credits) both become `PERMISSION` with advice naming the real cause; Pinterest's
`IMAGE_REFUSED` becomes `VALIDATION` quoting Pinterest; X's duplicate-post refusal becomes
`VALIDATION`, not a rate limit.

## Consequences

- Six platforms now publish for real (WordPress, LinkedIn, Facebook, Instagram, YouTube, TikTok, X,
  Threads, Pinterest — nine targets in total), and the only platform left unwired is email, on
  purpose.
- **None of the four has been run against the real platform** (no credentials here).
  `docs/REMAINING_PLATFORMS_LIVE_VERIFICATION.md` lists what to confirm, including the two places
  where documentation is silent (X's text limit, Pinterest's image rules) and two cadences worth
  measuring (TikTok's publish completion, Threads' token lifetime).
- Not built: TikTok photo posts and inbox drafts; X video, polls, quotes, threads and replies;
  Threads video, carousels and replies; Pinterest video pins, carousels and board creation; edits
  and deletions anywhere; analytics for any of them.
- Each platform's approval gate is visible before anyone connects: TikTok's audit, X's paid access,
  Meta's advanced access for Threads, Pinterest's Standard-access review.
