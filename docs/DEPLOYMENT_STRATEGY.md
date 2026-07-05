# Deployment Strategy

Phase 1 is local-first; this documents the production architecture the foundation was shaped
for, so later phases deploy without redesign.

## 1. Topology

| Component      | Target                                          | Scaling                                                                     |
| -------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| apps/web       | Container (Node standalone) or Next-native host | Horizontal, stateless                                                       |
| apps/api       | Container behind LB                             | Horizontal, stateless (sessions in store)                                   |
| apps/worker    | Container(s)                                    | Horizontal by queue depth; research pipelines isolate into dedicated queues |
| PostgreSQL     | Managed (pgvector-capable: RDS/Cloud SQL/Neon)  | Vertical + read replicas later                                              |
| Redis          | Managed (ElastiCache/Upstash w/ persistence)    | Per BullMQ sizing                                                           |
| Object storage | S3 / R2 / any S3-compatible                     | Native                                                                      |

Environments: `dev` (compose) → `staging` → `production`; same images promoted, only env
differs — configuration is entirely environment-driven and validated at boot.

## 2. Release pipeline

1. CI (lint, typecheck, unit, build, integration, e2e) on every PR.
2. Main merge → build multi-stage Docker images (pnpm fetch → build → prune prod deps) →
   push with git-sha tags.
3. `prisma migrate deploy` as a release step **before** rollout (expand-and-contract rule:
   migrations must be backward-compatible with the previous app version).
4. Rolling deploy; API readiness (`/health/ready`) gates traffic; worker drains gracefully
   (SIGTERM handling already implemented).

## 3. Secrets & config

Secret manager (AWS SM / GCP SM / Doppler) injects env at runtime; the encryption key ring
(`security` KeyRing JSON) rotates by adding a new active key. No secrets in images or repos.

## 4. Observability in production

Structured pino logs → log pipeline (correlationId-indexed); OTel traces/metrics wiring per
ADR-0013; alerting on readiness failures, DLQ depth, heartbeat staleness, migration errors.

## 5. Data protection

Postgres PITR backups + restore drills; object-store versioning + lifecycle rules aligned
with tenant retention policies; Redis treated as rebuildable (queues drained, schedulers
re-registered on boot).

## 6. Open items (revisit with Phase 4 scale data)

Multi-region posture, per-tenant rate-limit tiers, queue partitioning by tenant size, RLS
enablement, CDN strategy for media delivery.
