# ADR-0042: Audio and podcasts — real mixing, no generated voices, and consent that bites

**Status:** Accepted · **Date:** 2026-10-04 · **Relates to:** ADR-0017, ADR-0018, ADR-0026,
ADR-0029, ADR-0040, ADR-0041

## Context

Phases 7A and 7B gave Spectra pixels and video. Audio is the obvious next step — a podcast, a
voiceover for a vertical short, a music bed under an audiogram.

It is also the phase where the temptation to fake something is strongest. Speech synthesis is a
commodity API, and "generate a voiceover" is one call away. But a synthesised voice raises a
question none of the previous phases did: **whose voice is it?** A cloned voice is a person's
likeness. Using one without their agreement is not a product bug, it is a harm — and once a
clip exists, it cannot be recalled.

There is also a practical constraint. No speech, audio or music provider is configured in this
deployment, and none can be tested safely without credentials. The prompt's own instruction covers
this: implement an adapter _only_ if configuration exists and it can be tested safely; otherwise
build the env-gated foundation and be clear about the unavailable state.

## Decision

### 1. The local pipeline is real; the generators are honestly absent

Everything that can be done locally and deterministically **is** done, by the same FFmpeg the video
pipeline uses: segment mixing, per-segment gain, generated silence, a music bed with fades, **EBU
R128 loudness normalization** (`loudnorm`, with the result measured back via `ebur128`), waveform
pictures (`showwavespic`) and **audiograms** (`showwaves` over a background with optional cover art
and burned-in captions) — which closes the "audiogram foundation" ADR-0041 left as a port.

Everything that would require a vendor is reported as `NOT_IMPLEMENTED` **with a sentence**:
text-to-speech, speech-to-text, audio generation and music generation. `resolveAudioCapabilities`
distinguishes three different "no"s, because they mean different things to an operator:

| Status            | Meaning                                                                               |
| ----------------- | ------------------------------------------------------------------------------------- |
| `NOT_IMPLEMENTED` | No adapter exists. Nothing to configure — today, all four.                            |
| `NOT_CONFIGURED`  | An adapter exists, this deployment has no credentials. The reason names the env vars. |
| `DISABLED`        | An operator switched synthesis off by policy.                                         |

A script with spoken segments is refused **before a job is queued**, with
`TTS_NOT_CONFIGURED` and the suggestion to upload audio instead. No silence is substituted, no
placeholder tone is generated, and nothing is passed off as a voice.

### 2. Consent is a gate, not a checkbox

`evaluateVoiceUsability` is the single place that decides whether a voice may be used, and it is
deliberately conservative — **absence of information is never read as permission**:

- A `STOCK` or `CUSTOM_SYNTHETIC` voice imitates nobody, so there is nobody to ask.
- A `CLONED` voice is unusable unless a consent record is `GRANTED`, **unexpired**, and its scopes
  cover the use at hand. Consent is always time-boxed: an open-ended grant is not offered.
- The clock decides, not a column. A grant past its `expiresAt` is `EXPIRED` whatever the stored
  status says, and a `revokedAt` timestamp is a revocation whatever the status says — storage goes
  stale, and a stale row must not become permission.
- Creating a cloned voice **requires naming the person**, at the schema level.

The gate is applied **three times**, and that repetition is the point: in the editor (so a user sees
the block before trying), when a render is queued (so nothing unrenderable is enqueued), and again
**in the worker against the database** — because consent can be revoked after a render is queued,
and that revocation must stop it.

Recording and revoking consent needs its own permission, `voice:consent`, separate from
`audio:write`. Someone who assembles episodes should not be able to assert that a person agreed to
have their voice cloned. Every grant and revocation is audit-logged with who did it, for what scopes
and until when.

### 3. Transcripts say where their words came from

A `Transcript` carries a `source`. With no speech-recognition provider, the only honest values are
`AUTHORED` and `SCRIPT_DERIVED` — the latter meaning the words came from the script and the timings
from the measured segments. **Nothing listened to the audio**, and the UI says so. An uploaded clip
produces no cues at all, because Spectra does not know what is in it and will not guess.

### 4. Host notes are production direction, and never leave the studio

A segment's `hostNotes` are for the person at the microphone. They are never spoken, never rendered,
never written into the file's metadata, and never published — show notes are a separate field that
is. An integration test reads the finished MP3's bytes to confirm the note is not in them.

### 5. The render job follows the video pattern exactly

`AudioRender` is the state machine: `QUEUED → RUNNING →` exactly one terminal state, where only
`SUCCEEDED` has an asset and every other carries one of thirteen `AudioFailureReason`s with
operator-facing text. Budget pre-flight (`MEDIA_RENDER`) before the job exists, idempotency by
`renderHash`, progress from `-progress`, a timeout and cancellation that kill the encoder, retries
that skip an already-finished render, and outputs stored as ordinary tenant-rooted media assets.
The process handling is literally shared code (`runFfmpeg`), extracted from the video renderer.

A failed render also returns its episode to `READY_TO_RENDER`, so an episode never looks like it has
audio when it does not.

## Consequences

- Podcast episodes are genuinely mixed, normalized and measured by this codebase, and the
  integration suite proves it by decoding the stored bytes — MPEG frames, duration matching the
  script within a frame, a real PNG waveform, and a measured LUFS figure.
- **No voice can be cloned, or used, without consent on record** — and the gate survives a
  revocation mid-flight.
- **No synthesis is faked.** The four generator kinds report themselves unavailable with reasons,
  and the studio page lists all four rather than hiding them.
- Adding a provider later is a registry entry plus an adapter: `resolveAudioCapabilities` already
  models `NOT_CONFIGURED`, and `TextToSpeechRequest.voiceConsentRef` has carried the consent
  requirement since Phase 1.
- Loudness normalization is **single-pass**. Good for a spoken mix; a two-pass measure-then-apply
  would be more exact, and the measured LUFS is reported so the difference is visible rather than
  claimed away.
- Music licensing is **not** checked. Spectra says so in a warning rather than implying it has.
- Speech-to-text remains absent, so transcripts cannot cover uploaded audio. That is stated, not
  worked around.
