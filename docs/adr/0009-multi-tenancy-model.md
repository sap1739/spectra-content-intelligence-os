# ADR-0009: Shared-database, shared-schema multi-tenancy

**Status:** Accepted · **Date:** 2026-07-05

## Context

Tenancy options: shared schema with tenant columns, schema-per-tenant, database-per-tenant.

## Decision

Shared database + shared schema. Two-level scope: **Organization** (billing/admin) →
**Workspace** (primary data isolation). Every tenant-owned row carries `organizationId`
(+ `workspaceId` where applicable).

## Rationale

- Operationally simplest at this stage: one migration path, one connection pool, easy
  cross-tenant ops (metrics, admin) under strict controls.
- Schema/db-per-tenant multiplies migration and pooling complexity long before any tenant's
  scale or compliance posture demands it; the tenant columns + port-level scoping keep a
  later carve-out (dedicated DB for an enterprise tenant) possible.

## Enforcement stack (implemented)

1. Service layer: `assertTenantOwnership` — identical error for missing vs. foreign rows.
2. Data layer: Prisma tenant-guard extension rejects unscoped multi-row queries.
3. Storage: tenant-rooted keys + `assertKeyWithinTenant`.
4. Vector port: tenant scope mandatory per call.
5. Jobs: `JobEnvelope.tenant` re-asserted in handlers.
6. Audit: tenant-scoped append-only rows.

Postgres RLS is the designated Phase 2+ hardening layer once per-request principals exist.

## Consequences

- Cross-tenant queries are impossible to write accidentally without tripping a guard.
- Noisy-neighbour management (rate limits, queue fairness) is handled at the application
  tier per organization.
