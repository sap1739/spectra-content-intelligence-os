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
