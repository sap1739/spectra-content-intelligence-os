# ADR-0004: PostgreSQL + Prisma ORM

**Status:** Accepted · **Date:** 2026-07-05

## Context

Multi-tenant relational data with JSONB flexibility, migrations, and future vector search.
ORM options: Prisma, Drizzle, Kysely, raw SQL.

## Decision

PostgreSQL 17 (pgvector-capable image) with Prisma ORM (`prisma-client-js`), migration-based
schema management, seeds via tsx.

## Rationale

- Prisma: mature migration engine, generated types that flow through the workspace, wide
  operational knowledge, `$extends` query extensions that power our tenant guard.
- Drizzle was evaluated (lighter, SQL-closer, faster cold starts) but Prisma's migration
  DX + extension hooks + schema readability won for a contract-first team; nothing in the
  data layer leaks Prisma types beyond `@spectra/database`, so a future swap stays contained.
- Postgres over anything else: JSONB for validated flexible fields, pgvector for Phase 2
  retrieval, boring reliability.

## Consequences

- The tenant-guard extension enforces organizationId filters on multi-row queries.
- JSONB columns are documented in-schema and validated by Zod at boundaries.
- Prisma engine binaries require `allowBuilds` approval under pnpm ≥ 10 (configured).
