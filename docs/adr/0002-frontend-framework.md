# ADR-0002: Next.js App Router frontend

**Status:** Accepted · **Date:** 2026-07-05

## Context

The web app needs a premium SaaS shell now and data-heavy dashboards later. Options: Next.js
App Router, Remix/React Router, Vite SPA, SvelteKit.

## Decision

Next.js 15 (App Router) + React 19 + Tailwind CSS v4 + hand-written shadcn-style primitives
in `@spectra/ui`, TanStack Query for client data, next-themes for dark mode.

## Rationale

- App Router's layouts/streaming/error+loading conventions map exactly to the shell,
  skeleton and boundary requirements; server components keep the shell fast.
- Tailwind v4 CSS-first tokens give a small, themeable design system without runtime CSS-in-JS.
- Hand-written primitives (cva + tailwind-merge) avoid pulling Radix before overlays are
  actually needed, keeping the accessibility story explicit and auditable.
- SPA would sacrifice streaming/SEO-capable marketing surfaces later; Remix/SvelteKit are
  fine tools but the team-knowledge and ecosystem (Playwright, Vercel-compatible hosting)
  favour Next.

## Consequences

- React Hook Form + Zod resolvers arrive with the first real forms (Phase 2).
- The web app consumes compiled `@spectra/ui` output; Tailwind scans the package source via
  `@source` for class extraction.
