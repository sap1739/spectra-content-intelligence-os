# ADR-0018: Media pipeline v1 — real image rendering, honest video/audio unavailability

**Status:** Accepted · **Date:** 2026-07-09 · **Relates to:** ADR-0008, MEDIA_PIPELINE_STRATEGY

## Context

Phase 3 needs media. The media-core package defines ten rendering ports (image, SVG,
HTML-to-image, video, composition, subtitles, audio, thumbnails, audiograms) but no engine was
wired. Wiring all of them at once is neither necessary nor honest — video/audio need ffmpeg and
HTML-to-image needs a sandboxed headless browser, both of which carry real operational and
security weight. The ground rules require honest empty states: the UI must never imply a media
capability works when its engine is not present.

## Decision

1. **Wire one renderer for real — `@spectra/media-sharp`.** Implements the media-core
   `ImageRenderer` port with sharp: a `resize | crop | rotate | overlay | format` operation
   pipeline plus `resize()` / `convertAspectRatio()` convenience methods. It reads the input
   from tenant-scoped object storage and writes the derived asset under the tenant-rooted
   `renders/` domain (`org/<id>/ws/<id>/renders/<assetId>/…`), returning a `MediaAssetRef` with
   real dimensions and byte size. The renderer is pure (storage injected) and unit-tested against
   an in-memory storage double with real sharp encode/decode.

2. **Everything else stays honestly unavailable.** `GET …/media/status` reports
   `{ image: true, video: false, audio: false, htmlToImage: false }`. The Media UI renders those
   as disabled capability badges. No stub video/audio endpoints exist — an absent engine is
   absent, not faked.

3. **Persist assets with lineage.** `media_assets` rows record `kind`, `storageKey`, `mimeType`,
   `sizeBytes`, dimensions, the producing `engine`, and `sourceAssetId` (the uploaded source a
   derived asset came from). Bytes are streamed back through an authenticated
   `…/media/:id/content` route — the object store is never exposed directly.

4. **Storage on the API.** The API now reads/writes object storage for media, so
   `storageEnvSchema` is merged into the API env (validated at boot; keys never logged).

## Rationale

- **Depth over breadth** — one real, tested renderer end-to-end (upload → process → store →
  stream) is more valuable and more honest than ten stubs.
- **Tenant-rooted keys** keep media isolation aligned with the rest of the platform (ADR-0008).
- **Honest status** extends the Phase 3 pattern (AI unavailable → 503; moderation SKIPPED) to
  media: capabilities are advertised truthfully.

## Consequences

- Video, audio, HTML-to-image, subtitles and audiograms remain interface-only until their
  engines (ffmpeg, headless chromium, Remotion) are wired — each a future increment with its own
  sandboxing and licensing review (MEDIA_PIPELINE_STRATEGY).
- Image input is currently accepted as base64 JSON (bounded at 10 MB); large-file multipart /
  signed-URL uploads are a later hardening step. A malware-scan hook (`MalwareScanProvider`)
  exists in the storage port and is not yet enforced on this path.
