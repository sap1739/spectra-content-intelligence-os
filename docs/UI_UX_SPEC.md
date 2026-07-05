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
