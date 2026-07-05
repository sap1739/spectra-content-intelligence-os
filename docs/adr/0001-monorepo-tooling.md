# ADR-0001: Monorepo with pnpm workspaces + Turborepo

**Status:** Accepted · **Date:** 2026-07-05

## Context

The platform spans three apps and many shared domain packages that must share contracts and
version together. Options: polyrepo, npm/yarn workspaces, pnpm + Turborepo, Nx, Bazel.

## Decision

pnpm workspaces for dependency management + Turborepo for task orchestration.

## Rationale

- pnpm's content-addressed store and **strict node_modules** prevent phantom dependencies —
  packages can only import what they declare, which protects the layering rules.
- Turborepo gives dependency-graph-ordered builds and local/remote caching with near-zero
  config; our compile chain (tsc per package) benefits directly.
- Nx offers more (generators, plugins) at higher conceptual cost; Bazel is unjustified at
  this scale. Polyrepo would make contract-first development painful.

## Consequences

- All tooling assumes pnpm ≥ 10 (`allowBuilds` gates native postinstalls explicitly).
- Task graph is declared once in `turbo.json`; new packages adopt the standard script names
  (build/typecheck/test/clean) to participate.
