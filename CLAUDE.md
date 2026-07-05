# CLAUDE.md — working on SpectraContent Intelligence OS

## What this is

Multi-tenant, research-first content intelligence platform. **Phase 1 = foundation only**:
contracts, schema, app shells, security/testing standards. Later phases add auth, research
providers, generation, publishing.

## Ground rules (do not violate)

- **No fake integrations.** No research provider, AI API or social platform is wired. Never
  claim otherwise; UI must keep honest empty states. Never fabricate analytics or trends.
- **No hard-coded secrets.** All config via validated env (`@spectra/config`). Local dev
  credentials live only in `.env.example` / docker-compose.
- **Tenant isolation is non-negotiable.** Every query on tenant-scoped models filters by
  `organizationId` (the Prisma tenant-guard extension throws otherwise). Storage keys are
  tenant-rooted (`org/<id>/ws/<id>/…`). Vector search requires tenant scope. Missing and
  foreign resources return the same error (no existence leaks).
- **Permissions, not roles.** Check `hasPermission()` from `@spectra/security`; never branch
  on role names.
- **Lifecycles are enums** in `@spectra/contracts` (content lifecycle, trend states, pipeline
  stages) — never scattered strings.
- **UTC everywhere**; user/workspace timezones are explicit display-only fields.
- **Never log** passwords, tokens, keys, payment data or uploaded document content
  (pino redaction in `@spectra/logging` + `deepRedact` in `@spectra/security`).
- Untrusted external/uploaded content is wrapped via `wrapUntrustedContent()`
  (knowledge-core) and never concatenated into instructions.

## Layout

`apps/{web,api,worker}` + 17 `packages/*` (see README). Domain logic lives in packages;
apps are thin framework adapters. Provider integrations implement ports from
`research-core` / `ai-core` / `media-core` / `social-core` / `workflow-core` / `storage`.

## Build system

pnpm workspaces + Turborepo. Packages compile with `tsc` to `dist/` (CJS + d.ts);
`turbo build` orders by dependency graph. Web is Next.js 15 (Tailwind v4, tokens in
`apps/web/src/app/globals.css`); API is NestJS 11 on Fastify; worker is plain Node + BullMQ.

## Commands

```bash
pnpm install && pnpm docker:up && pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm dev | build | lint | typecheck | test | test:integration | test:e2e
```

Single package: `pnpm --filter @spectra/<name> <script>`.

## Testing

- Unit: Vitest per package (`*.test.ts` beside sources). Use `@spectra/testing` factories —
  deterministic, schema-validated, no faker/randomness.
- API integration: `apps/api/test/*.spec.ts` boots the real app via `createApp()` + fastify
  `inject` (SWC transform for decorators — see `vitest.config.ts`).
- E2E: Playwright in `apps/web/e2e` against the production build.
- Never suppress failures; fix or surface them.

## Conventions

- Zod schema + inferred type per contract in `@spectra/contracts` (`xSchema` / `X`).
- Errors: reuse typed errors (`@spectra/security`, package-level errors); API maps them to
  problem+json in `GlobalExceptionFilter`.
- Conventional Commits. ADRs in `docs/adr` — add one for any significant decision.
- Prisma schema changes require a migration (`pnpm db:migrate`) and a
  `docs/DATABASE_DESIGN.md` update.
