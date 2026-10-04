# ADR-0041: FFmpeg as the video engine, and a renderer that admits when it cannot

**Status:** Accepted · **Date:** 2026-10-04 · **Relates to:** ADR-0006, ADR-0018, ADR-0026,
ADR-0029, ADR-0033, ADR-0040

## Context

Phase 7A gave Spectra pixels. Several publishing adapters want **video** — YouTube uploads
(ADR-0037), Reels, Shorts, TikTok — and until now a video had to be made somewhere else.

The obvious 2026 answer is a generative-video API. It is the wrong one here for the same reason
image generation was wrong in ADR-0040: a generated clip is not the operator's brand, it cannot be
traced to anything, and nobody can vouch for it. It is also expensive per second, which makes it a
poor default for the thing most operators actually need — a few of their own photos, their own
words, at the size a platform wants. So: **deterministic local rendering first**, and if a
generative provider is ever wired, it arrives behind the same port as a deliberate, priced choice.

Video rendering also differs from image rendering in a way that shapes everything below: it takes
**seconds to minutes**, so it cannot happen inside an HTTP request; it **can hang**; and it depends
on a binary whose build options vary by host.

## Decision

### 1. FFmpeg, as a subprocess, never vendored

`OPEN_SOURCE_AND_LICENSE_POLICY.md` §3 already settled the engine choice: _"ffmpeg: LGPL/GPL build
flags matter; use LGPL builds or system packages, invoked as a subprocess (no linking concerns)."_
Remotion remains flagged for commercial licence review, so it is not adopted; `CompositionRenderer`
stays a port.

So Spectra **ships no ffmpeg binary**. The worker resolves one from `FFMPEG_PATH`, then `PATH`, and
the build belongs to the deployment. One honest wrinkle, recorded rather than hidden: the tests use
`@ffmpeg-installer/ffmpeg`, whose npm metadata says LGPL-2.1 while the macOS binary it carries
reports `--enable-gpl --enable-nonfree`. That package is a **devDependency, never shipped**, and the
licence table now says so.

### 2. Every capability is detected, never assumed

Because the build varies, `FfmpegVideoRenderer.capabilities()` runs `-version`, `-encoders` and
`-filters` and reports what it found: the H.264 encoder it will use (`libx264`, else
`h264_videotoolbox`, else `libopenh264`), and whether text overlays, burned-in captions, crossfades
and an audio bed are possible. Each `false` carries a named reason. A storyboard needing something
the build lacks is refused **before a job is queued**, with that reason — not halfway through an
encode.

Fonts are the sharpest case. `drawtext` needs a font _file_: a build without fontconfig cannot
resolve a family name. With no `VIDEO_FONT_FILE` and none of the common base-image fonts present,
text overlays are reported unavailable rather than silently dropped.

### 3. The storyboard is data; the filtergraph is generated

A `Storyboard` is scenes with durations, a colour or image background, optional heading/body text
and a caption line. `buildVideoRenderPlan` turns it into a pixel-level plan: absolute scene timing,
font sizes scaled to the frame, caption cues, the asset ids to fetch. It is pure and deterministic,
so the plan is testable, exports are idempotent, and the argument list can be asserted exactly.

Two security properties fall out of that structure, and the tests pin both:

- **No user text ever enters the filtergraph.** Scene text is written to files and referenced with
  `textfile=`; captions go to an SRT file referenced by `subtitles=filename=`. The filtergraph
  contains only numbers, validated hex colours, and paths Spectra generated.
- **No string is ever handed to a shell.** Arguments are an array; paths are escaped for filter
  syntax by one function.

### 4. Rendering is a worker job, because it is slow and can hang

The API plans, checks capability, validates inputs under the tenant scope, takes the budget
pre-flight and writes a `VideoRender` row as QUEUED, then enqueues. The worker runs it with the
queue's own abort signal, which reaches ffmpeg itself: a timeout or a cancellation **kills the
encoder** rather than abandoning it. Progress comes from `-progress pipe:1` and is persisted at
whole-percent steps.

One discovery changed the design: ffmpeg handed a corrupt image with `-loop 1` **waits forever**.
Left alone, a bad asset would burn the whole timeout and then report TIMEOUT — true, but useless. So
every input is probed before the encode starts, and a bad one fails in a second as
`INPUT_UNSUPPORTED`, naming the asset.

### 5. A render is a state machine with no ambiguous states

`QUEUED → RUNNING →` exactly one of `SUCCEEDED`, `FAILED`, `CANCELLED`, `TIMED_OUT`. The row _is_
the job state, and one rule makes it readable: **only SUCCEEDED has `mediaAssetId`**, and every
other terminal state has a `VideoFailureReason` — eleven of them, each with operator-facing text.
"It failed" with no reason is not representable, and a failed retry clears any asset so "no video"
can never read as "a video". A render that already reached a terminal state is skipped on retry
rather than re-encoded or re-billed.

### 6. Outputs are ordinary media assets

The MP4, the caption sidecar and the poster frame are stored under the tenant's `renders/` prefix,
validated against the storage policy, and recorded as `MediaAsset` rows — so the calendar, the
publishing adapters and the media library can use them with no new plumbing, exactly as design
exports can. Renders are idempotent by `renderHash` (plan + output settings + the identity of every
input asset), so re-rendering unchanged inputs returns the existing file. A poster frame that cannot
be extracted is a warning, not a failure: it must not lose a real video.

## Consequences

- Slideshows, vertical shorts, square and landscape social video, captioned video and crossfaded
  sequences are produced by this codebase, and the integration suite proves it by **decoding the
  stored bytes** — `ftyp` box, h264, dimensions, duration within a frame of the plan.
- **No generative video**, and the UI says so where a user would ask.
- A deployment without ffmpeg is a first-class, visible state: the page says which setting fixes it,
  and no render is ever queued that cannot run.
- Rendering is CPU-bound and capped at two concurrent jobs per worker; a long carousel at 1080p is
  minutes of CPU. Scaling means more workers, or a render-specific queue.
- Audiogram support is **foundation only**: an audio bed mixes under a video, but waveform
  visualisation (`showwaves`) is not implemented, and `AudiogramGenerator` stays a port.
- Captions are **authored, never transcribed** — Spectra has no STT provider, so caption text comes
  from the storyboard.
- Intro/outro are scenes, not a separate concept, which keeps one timing model.
