# ADR-0040: Visual templates and a design studio that really renders

**Status:** Accepted · **Date:** 2026-09-15 · **Relates to:** ADR-0018, ADR-0019, ADR-0020,
ADR-0026, ADR-0037, ADR-0039

## Context

Spectra could generate text, publish it and now measure it, but it could not make a picture. Every
publishing adapter takes an image (LinkedIn, Facebook, Instagram, Pinterest, Threads, X) or a
thumbnail (YouTube), and until now those had to be made elsewhere and uploaded.

The temptation with "visual creation" is an image-generation API. That would break the rule this
codebase is built on: a generated picture is not the operator's brand, it cannot be traced, and the
result is a plausible-looking asset nobody can vouch for. What a content operator actually needs is
narrower and fully achievable locally: **their** logo, **their** colours, **their** photos, laid out
by a template, at the size a platform wants.

The engine for that already existed. ADR-0018 wired sharp (libvips), and libvips ships Pango and
fontconfig: real text layout with word wrapping, real font metrics, and TTF/OTF font files.

## Decision

### 1. Templates are layout data, never code or markup

`templateLayoutSchema` (`@spectra/contracts/design.ts`) describes a template as: a list of **fields**
(TEXT or IMAGE, with labels, limits and optional brand-token defaults) and one or more **pages**,
each with a background and up to 40 layers — `rect`, `text`, `image` or `logo`. Every box is
normalized to fractions of the canvas, so one layout renders at every output size. Colours are either
a literal hex or a **brand role** (`primary`, `secondary`, `accent`, `background`, `text`).

No HTML, CSS or SVG comes from a user. The only SVG the renderer sees is the rectangles Spectra
generates itself, and text reaches Pango escaped. `validateTemplateLayout` adds what a schema cannot
check: unique ids, text layers pointing at TEXT fields, image slots at IMAGE fields, and no unused
field.

Six built-in templates ship as code (quote card, announcement, three-page tips carousel, YouTube
thumbnail, event flyer, product spotlight). A workspace can copy one into `DesignTemplate` and edit
it; editing bumps the template's version, and every design keeps a **snapshot** of the layout it was
made from, so a template edit never changes an approved design.

### 2. Output sizes are presets, and say where they come from

`DESIGN_FORMATS` carries eleven sizes: platform presets (Instagram 1:1 and 4:5, story 9:16, Facebook,
LinkedIn, X, Pinterest, YouTube thumbnail 1280×720) and print sizes (A4, A3, US Letter at 150 dpi,
labelled as not print-shop resolution). Each carries a note saying what it is. Only YouTube documents
a hard byte limit (2 MB for `thumbnails.set`), and that is the only `maxBytes` in the catalog — the
exporter steps JPEG quality down to meet it and says so, rather than producing a file YouTube refuses.

### 3. A render plan, then real pixels

`buildRenderPlan` resolves a design into the complete, pixel-level description of what to draw:
brand colours, tokens filled in, boxes in pixels, fonts chosen. It is pure and deterministic, which
is what makes exports idempotent and tests exact. It refuses missing required fields, over-long text
and unknown fields — all at once — and reports everything it had to do differently as **warnings**:
a brand with no logo, a missing `{{brand.tagline}}`, an empty image placeholder, a colour role the
brand never set (Spectra's neutral is used, and named).

`SharpDesignRenderer` turns one page of a plan into bytes: libvips composites, librsvg for Spectra's
own rectangles, Pango for text with word wrapping and uploaded brand fonts. Text that does not fit is
either shrunk (autofit) or cut at its box — and either way the export says which. PDF export is a
small dependency-free writer that embeds each rendered JPEG as a page at the format's dpi; it is
described everywhere as a raster PDF, not editable vector text.

### 4. Exports are ordinary media assets

Every export is stored under the tenant's `renders/` prefix, validated against the storage policy
(MIME and size), and recorded as a `MediaAsset` plus a `DesignRender` row. So an export is
immediately usable by the calendar, the publishing adapters and the media library — no new plumbing,
and the same tenant-key checks as any other file. A 15-minute signed URL serves downloads.

Exports are **idempotent**: `renderHash` covers the plan, the output settings and the versions of
every input asset, so exporting unchanged inputs returns the same files instead of piling up
duplicates. A concurrent export of the same inputs keeps one row and drops the loser's bytes.

### 5. Rendering is metered and can be capped

Local rendering costs no money but is real work, so an export takes a `MEDIA_RENDER` budget
pre-flight for its page count before anything is drawn, and records usage afterwards — counter-only,
never priced as a fake zero. An operator can cap design rendering with a per-operation limit.

### 6. Designs have a state, and approval means something

`DRAFT → IN_REVIEW → APPROVED → PUBLISHED` (plus `ARCHIVED`). Submitting requires at least one export
— reviewers approve rendered files, not intentions. Approving needs `content:approve`, the same
permission that approves content. Two integrations make the state load-bearing:

- The **calendar refuses** to schedule a media asset that is a design export whose design is not
  approved, naming the design and its state.
- **Publishing marks it published**: when a post carrying an export publishes, its design moves
  `APPROVED → PUBLISHED`, within that tenant only.

Editing the visuals of an approved design returns it to `DRAFT` with a note — an approval covers the
files that were reviewed. Attaching it to a content item or campaign does not.

### 7. The brand kit lives on the brand

`Brand` gains the kit: `logoAssetId`, `palette`, `typography`, `tagline`, `visualStyle` and
`offerings`. A logo must be a PNG/JPEG/WebP and a font a TTF/OTF **in the same workspace** — checked
when the kit is saved and again at render time. SVG is refused as a logo: it is markup, not pixels.
A font family without an uploaded file renders only if the API host has it installed, and every
export carrying that font says so.

## Consequences

- Flyers, posters, social images, carousels and YouTube thumbnails are produced by this codebase, at
  real platform sizes, from the operator's own brand assets — and the integration suite proves it by
  decoding the stored bytes (dimensions, format, PDF page count, the brand colour at a pixel).
- **No AI image generation**, and the studio says so where a user would ask. Nothing here invents
  imagery; it arranges what the workspace already has.
- Fonts are the weak point: without an uploaded file, what renders depends on the API host's
  installed fonts. That is stated in the API capability response, the UI and the export warnings
  rather than hidden.
- PDF export is raster. Good for sharing and office printing; not for a commercial printer wanting
  vector text at 300 dpi.
- Rendering happens in the API process, synchronously. A 2480×3508 A3 page is comfortable; much
  larger canvases or long carousels would want the worker, which is a queue job away if it becomes a
  problem.
- The editor is a form plus a real preview, not a drag-and-drop canvas. Layout positions come from
  templates; moving layers by hand is future work.
- Video, audio and HTML-to-image renderers remain honestly unavailable (ADR-0018).
