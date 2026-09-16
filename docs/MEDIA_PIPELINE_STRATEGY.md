# Media Pipeline Strategy

**Status.** `@spectra/media-core` defines renderer ports; `@spectra/contracts` (media.ts,
design.ts) defines the job specs they exchange. Two engines are implemented and in use:

- `SharpImageRenderer` — image ops, resize, aspect-ratio variants, thumbnails (ADR-0018).
- `SharpDesignRenderer` — the design studio's page renderer (ADR-0040, §6 below).

Every other port in §1 remains a **port only**: video, audio, subtitles, audiograms,
HTML-to-image and compositions are honestly unavailable and report themselves as such.

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

## 6. Design rendering (Phase 7A, ADR-0040)

The design studio is a second, narrower pipeline that shares the same engine and the same
storage rules. It exists because a flyer, a carousel page or a YouTube thumbnail is not an
image _op_ on an existing file — it is a layout composed from a brand's own assets.

| Stage    | Where                                            | What it does                                                                          |
| -------- | ------------------------------------------------ | ------------------------------------------------------------------------------------- |
| Template | `@spectra/design-studio` (`builtins.ts`)         | Layout **data**: normalized boxes, brand colour roles, TEXT/IMAGE fields, layers      |
| Plan     | `design-studio/template.ts` (`buildRenderPlan`)  | Pure + deterministic: resolves brand, tokens, fonts, pixel boxes; collects warnings   |
| Pixels   | `@spectra/media-sharp` (`SharpDesignRenderer`)   | libvips composite, librsvg for Spectra's own rects, Pango for text with word wrapping |
| PDF      | `design-studio/pdf.ts` (`buildImagePdf`)         | Dependency-free PDF 1.4 writer embedding each page JPEG via `/DCTDecode` (raster)     |
| Store    | `@spectra/storage` + `MediaAsset`/`DesignRender` | Tenant-rooted `renders/` key, MIME + size validation, 15-minute signed URL            |

Rules this pipeline keeps:

- **No image generation.** Nothing is invented; the renderer arranges assets the workspace
  already uploaded. There is no AI image provider, and the UI says so where a user would ask.
- **No user markup.** Templates are data. The only SVG libvips sees is the rectangles Spectra
  generates itself, and text reaches Pango escaped.
- **Deterministic and idempotent.** `renderHash` covers the plan, the output settings and the
  version of every input asset, so re-exporting unchanged inputs returns the same files.
- **Honest degradation.** A missing logo, an unset colour role, an empty image slot, text that
  had to be shrunk or cut, or a font family with no uploaded file — each becomes a named
  warning on the export rather than a silent substitution.
- **Metered.** An export takes a `MEDIA_RENDER` budget pre-flight for its page count before
  anything is drawn, and records counter-only usage afterwards (never a fake zero price).

Rendering currently runs **synchronously in the API process**. An A3 page (2480×3508) is
comfortable; larger canvases or long carousels are the reason to move this to the worker,
which is one queue job away if page counts grow.

Fonts are the known weak point: with no uploaded TTF/OTF, what renders depends on the API
host's installed fonts. That is reported in the capability response, the UI and the export
warnings instead of being hidden.
