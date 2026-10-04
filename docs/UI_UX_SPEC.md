# UI / UX Specification

## 1. Principles

1. **Honest by construction** — empty states everywhere data does not exist; no fabricated
   analytics, trends or activity, ever. Disabled controls explain _why_ and _when_ they
   activate ("Organization switching arrives with authentication — Phase 2").
2. **Premium restraint** — quiet zinc-neutral surfaces, a single indigo/violet primary,
   generous whitespace, small type scale, subtle borders over shadows.
3. **Keyboard first** — every interactive element reachable and operable via keyboard;
   visible focus rings (`focus-visible:ring`); skip-to-content link; `aria-current` on nav.
4. **Explainability surfaces** — trends always render with their score breakdown; content
   always renders with its citations (Phase 2+ screens).

## 2. Design tokens

Defined in `apps/web/src/app/globals.css` as CSS variables (light + `.dark`), mapped into
Tailwind v4 via `@theme inline`: background/foreground, card, muted, primary, secondary,
accent, destructive, border, input, ring, sidebar. Components consume semantic tokens only —
no raw palette values in markup. Dark mode via `next-themes` (class strategy, system default,
FOUC-safe).

## 3. Shell anatomy

```
┌────────────┬──────────────────────────────────────────────┐
│  Sidebar   │ Topbar: org / workspace · search · create ·   │
│  (lg+)     │         notifications · help · theme · user   │
│  6 groups  ├──────────────────────────────────────────────┤
│  17 items  │ MobileNav strip (< lg)                        │
│            ├──────────────────────────────────────────────┤
│  Phase     │ <main id="main"> page content                 │
│  footnote  │                                               │
└────────────┴──────────────────────────────────────────────┘
```

Navigation groups: Overview (Home, Intelligence) · Research (Research, Trends) · Creation
(Create, Campaigns, Content, Calendar, Media, Templates) · Configuration (Brands, Verticals,
Social Accounts) · Insights (Analytics) · Organization (Team, Billing, Settings). Each item
carries its delivery phase; placeholder pages badge it.

## 4. Dashboard

Nine areas (trending topics, active research, evidence packs, awaiting approval, scheduled,
failed publications, recent assets, connected platforms, usage) rendered as cards with
dashed-border empty blocks stating what will appear and which phase enables it.

## 5. States

| State     | Implementation                                                                        |
| --------- | ------------------------------------------------------------------------------------- |
| Loading   | `loading.tsx` skeleton grid (aria-busy, sr-only text)                                 |
| Empty     | `EmptyState` primitive: icon, title, description, hint badge, optional action         |
| Error     | `(app)/error.tsx` boundary with retry + logged digest; `global-error.tsx` last resort |
| Not found | Root `not-found.tsx`, 404 status, "Back to Home"                                      |

## 6. Component library (`@spectra/ui`)

Button (6 variants × 4 sizes), Badge, Card family, Input, Label, Skeleton, Separator,
Spinner, EmptyState — hand-written shadcn-style (cva + tailwind-merge), accessible defaults
(roles, aria, focus-visible), no Radix dependency yet (introduced when overlays/menus are
actually needed in Phase 2).

## 7. Responsiveness

Sidebar ≥1024px; horizontal pill nav below. Dashboard grid 1/2/3 columns at base/md/xl.
Topbar collapses labels to icons below sm. Content max-widths keep line lengths readable.

## 8. Accessibility checklist (enforced in e2e/reviews)

- Landmarks: `nav[aria-label]`, `main#main`, `header`.
- Focus order follows visual order; skip link is first tabbable.
- Interactive disabled elements carry `title` explanations; icons are `aria-hidden` with
  text or `aria-label` alternatives; color contrast ≥ WCAG AA in both themes.

## 9. Forms (Phase 2)

React Hook Form + Zod resolvers against `@spectra/contracts` schemas; inline field errors
bound via `aria-describedby`; optimistic updates through TanStack Query mutations.

## 10. Honest UI states (Phase 6A)

The three stale placeholder pages are gone. Each had claimed an already-shipped
capability was a future phase — Brands said "arrives with authentication in Phase 2" while a
five-route Brand CRUD API had existed since Phase 2. The `PlaceholderPage` component itself was
deleted, so the pattern cannot silently return.

Rules the UI now follows:

- **A page states what exists, not what is planned.** Templates has no user-editable template
  store, so it says exactly that and shows the one real thing — the versioned prompt template every
  draft is attributed to — instead of an empty list implying one is coming.
- **A control that cannot be saved is not shown.** Settings offers organization name, workspace
  name and timezone, and personal name and timezone, because those are the columns the backend
  persists. There is deliberately no organization-wide timezone: the table has no such column, and
  a control that silently does nothing is worse than its absence.
- **Missing data renders as an em dash**, never as `0`, `—unknown—` or an invented default.
- **Permission gating names the missing permission** (`brand:write`, `org:manage`) rather than
  hiding a control with no explanation. Gating uses server-resolved effective permissions, never
  role names.
- **Every state is reachable and distinct**: loading (skeleton), empty (what to do next), error
  (the real message from the API), and read-only (why).

### Accessibility baseline

Every form control has a `<label for>` or an `aria-label`; errors use `role="alert"` and are linked
via `aria-describedby`; expand/collapse controls carry `aria-expanded` and `aria-controls`; focus
is always visible (`focus-visible:ring-2`); destructive actions require an explicit confirm step.
Two Playwright tests assert keyboard reachability and that every visible control on Settings has an
accessible name.

## 11. Operations (Phase 6B, ADR-0033)

`/operations` is the first page written for an operator rather than a content producer, and it
exists to make one distinction visible that a counts-only dashboard destroys.

- **Unreachable is not empty.** If the queue cannot answer, the page says "The job queue is
  unreachable" with the reason and renders the failure list as "Failure list unavailable". The
  reassuring "No failed or dead-lettered jobs" line appears only when the queue actually answered
  and the list was genuinely empty. Both states are covered by e2e tests.
- **Counts are suppressed, not zeroed,** when the queue is unreachable — no tile shows `0` for a
  number nobody knows.
- **Failed and dead-lettered are separate lists.** Dead-lettered jobs carry the note that they
  exhausted their retries, because the operator's decision differs.
- **Every row shows the correlation id** — the string a customer quotes in a support request, and
  the one that ties the UI back to a log line.
- **Retry states its consequence.** The page header says retry re-runs the original job so
  idempotency keys and budget checks still apply; a reader should not have to guess whether
  clicking it double-publishes.
- **Permissions are named, not hidden.** Without `ops:read` the page says which permission is
  missing instead of showing an empty dashboard; without `ops:retry` the buttons are absent and
  the missing permission is named under the list.
- **Provider health sits beside the failures** because "publishing failed" and "publishing was
  never configured" are the two explanations an operator checks first.

## 12. Design studio (Phase 7A, ADR-0040)

`/studio` is a gallery plus an editor, and its whole job is to keep the difference between _what
Spectra can make_ and _what a user might expect from a "creative" tool_ visible.

- **The gallery leads with templates, not a blank canvas.** Built-in templates and the workspace's
  own are shown together, each labelled with its category and the sizes it suits. A workspace with
  no designs yet sees the templates, not an empty list — there is always a first move.
- **"No AI image generation" is stated, not implied.** The studio says plainly that it arranges the
  brand's own logo, colours and photos; it does not invent imagery. This is the one place a user
  would reasonably assume otherwise, so it is answered before they ask.
- **The preview is the renderer.** `/studio/[designId]` shows a real PNG produced by the same
  engine as the export — not a CSS approximation that would drift from the file. Carousel pages are
  paged through; the page count comes from the render, not from the form.
- **Warnings are shown where the cause is.** A brand with no logo, an unset colour role, an empty
  image slot, text that had to be shrunk or cut, a font family with no uploaded file — each render
  returns named warnings and the editor lists them under the preview. A degraded render is never
  presented as a clean one.
- **The size picker explains itself.** Every output format names its pixel size, its dpi and where
  the number comes from; the YouTube thumbnail names its 2 MB limit. Print sizes say they are 150
  dpi, not print-shop resolution.
- **Brand selection is explicit.** A design belongs to one brand; the editor shows the resolved
  palette and logo so a user can see which kit is being applied before exporting.
- **State is legible.** DRAFT → IN_REVIEW → APPROVED → PUBLISHED is shown on every design, and the
  only actions offered are the ones the current state allows. Submitting without an export is
  refused by the API (reviewers approve files, not intentions) and the reason is shown in an alert
  rather than swallowed. Editing an approved or in-review design warns, before saving, that the
  change returns it to draft.
- **Exports are reusable, and say so.** Each export links to its media asset, so the calendar and
  the publishing adapters can use it; the calendar's refusal to schedule an unapproved design names
  the design and its state rather than failing anonymously.
- **Permissions are named.** Without `design:read` the page says which permission is missing;
  without `design:write` the create/export controls are absent and the reason is stated, and
  approval controls follow `content:approve` the same way.

### Accessibility

The editor's fields are ordinary labelled form controls (§9) — the preview is an `<img>` with alt
text describing the design and page, and warnings are text, not colour alone.

## 13. Video (Phase 7B, ADR-0041)

`/video` has two honesty problems the design studio did not: a user will assume "video" means
AI-generated video, and rendering depends on a binary the deployment may not have installed.

- **"Real rendering, no generated video" is stated first.** The page says plainly that Spectra
  composes video from the images, text and audio in this workspace and that no generative-video
  provider is wired. This is the first card, not a footnote.
- **A missing engine is a sentence, not a disabled button.** When no ffmpeg is configured the page
  says so, names the setting that fixes it (`FFMPEG_PATH`), and lists every capability the build is
  missing. The render control is replaced by that explanation rather than greyed out with no reason.
- **A script becomes scenes before anything is created.** Typing a script shows how many scenes and
  how many seconds it will become, so the transformation is visible up front rather than discovered
  after saving.
- **Progress is the encoder's, not a spinner.** A running render shows a real percentage reported by
  ffmpeg, in an `aria`-labelled progressbar, and the page polls only while a render is queued or
  running. A queued render says it is waiting for a worker — not that it is encoding.
- **A failed render says why, in words, and offers nothing to download.** The eleven failure reasons
  each render as an operator-facing sentence, with the bounded engine note beneath. Download buttons
  exist only for a render that actually produced a file.
- **Finished renders describe the file that exists** — dimensions, codec, duration and size read
  back from the encoded bytes — and offer the MP4, the caption sidecar and the poster frame
  separately. Playback attaches the caption track when there is one.
- **An unrenderable storyboard is refused in the editor.** The problems are listed and the render
  button is disabled, so a user is never invited to queue something that cannot work.
- **Reuse is explained.** Re-rendering identical inputs says the existing file was reused rather
  than silently appearing to do nothing.
- **Permissions are named.** Without `video:write` the create and render controls are absent and the
  missing permission is stated.
