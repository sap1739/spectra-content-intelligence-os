# Media Pipeline Strategy

**Phase 1 status: contracts only — no rendering is implemented.** `@spectra/media-core`
defines renderer ports; `@spectra/contracts` (media.ts) defines the job specs they exchange.

## 1. Ports → planned engines

| Port                          | Spec                                                                                    | Planned engine (Phase 3)                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| ImageRenderer                 | `ImageRenderSpec` (resize/crop/rotate/overlay/format ops)                               | sharp (libvips)                                                                   |
| — resize / convertAspectRatio | width/height, `AspectRatioTarget`                                                       | sharp                                                                             |
| SvgRenderer                   | `SvgRenderSpec`                                                                         | resvg or sharp SVG input                                                          |
| HtmlToImageRenderer           | `HtmlToImageSpec` (**templateId + data only** — never arbitrary URLs; SSRF containment) | headless Chromium in a sandboxed pool                                             |
| VideoProcessor                | `FfmpegJobSpec` (declarative ops → filtergraph)                                         | ffmpeg                                                                            |
| CompositionRenderer           | `RemotionRenderSpec`                                                                    | Remotion (license review before adoption — see OPEN_SOURCE_AND_LICENSE_POLICY.md) |
| SubtitleRenderer              | `SubtitleRenderSpec` (SRT/VTT/burn-in)                                                  | ffmpeg + STT output                                                               |
| AudioMixer                    | `AudioMixSpec` (tracks, gain, offsets)                                                  | ffmpeg filtergraph                                                                |
| ThumbnailGenerator            | `ThumbnailSpec` (frame @ ms)                                                            | ffmpeg/sharp                                                                      |
| AudiogramGenerator            | `AudiogramSpec` (waveform styles, cover, captions)                                      | ffmpeg showwaves + overlay                                                        |

## 2. Execution model

Rendering runs in the **worker** as queued jobs (workflow-core): idempotency keys derived
from spec hashes, progress reporting for long renders, per-kind concurrency limits (video
renders are expensive), timeouts with cooperative abort, DLQ for failures. Inputs and outputs
live exclusively in tenant-scoped object storage (`media`/`renders` domains) — renderers
never fetch arbitrary network resources.

## 3. Platform variants

`AspectRatioTarget` presets per platform (e.g. 1:1, 4:5, 9:16, 16:9) are data, versioned with
the platform capability records — variant generation reads the capability matrix rather than
hard-coding platform assumptions.

## 4. Asset lifecycle

Every output registers a `MediaAssetRef` (kind, mime, size, checksum, dimensions/duration)
linked to content items; derived assets reference their sources so re-renders propagate.
Retention and cleanup follow tenant retention policy (SECURITY.md §7).

## 5. Sequencing

Phase 3a: sharp image ops + thumbnails + aspect-ratio variants (pure-CPU, safest).
Phase 3b: ffmpeg audio/video + subtitles + audiograms.
Phase 3c: HTML-to-image sandboxed template rendering.
Phase 3d: Remotion compositions (pending license fit).
