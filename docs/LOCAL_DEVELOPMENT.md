# Local Development

## 1. Prerequisites

- Node.js ≥ 22 (`.nvmrc`), pnpm ≥ 10 (`corepack enable` or standalone)
- Docker Desktop (Compose v2)

## 2. First run

```bash
./infrastructure/scripts/bootstrap.sh
```

which performs:

```bash
cp .env.example .env
cp packages/database/.env.example packages/database/.env
pnpm install
pnpm docker:up          # postgres :5432 · redis :6379 · minio :9000/:9001
pnpm db:generate && pnpm db:deploy && pnpm db:seed
```

## 3. Daily loop

```bash
pnpm dev                # turbo: web :3000, api :4000, worker (watch mode)
pnpm test               # unit tests
pnpm test:integration   # API tests (works degraded without infra; full with it)
pnpm lint && pnpm typecheck && pnpm format
```

Single workspace: `pnpm --filter @spectra/trend-core test`, `pnpm --filter @spectra/api dev`.

## 4. Verifying the stack

| Check            | How                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| API liveness     | `curl localhost:4000/health` → `{"status":"ok",…}`                                                    |
| API readiness    | `curl localhost:4000/health/ready` → postgres/redis/worker-heartbeat components                       |
| Worker heartbeat | start worker; readiness `worker-heartbeat` flips to `up`, or `redis-cli get spectra:worker:heartbeat` |
| OpenAPI          | http://localhost:4000/docs                                                                            |
| Web shell        | http://localhost:3000                                                                                 |
| MinIO console    | http://localhost:9001 (credentials from `.env.example`)                                               |
| DB browser       | `pnpm db:studio`                                                                                      |

## 5. Environment variables

All validated by `@spectra/config`; the process exits with named-key errors (values never
echoed). See `.env.example` for the full annotated list: `DATABASE_URL`, `REDIS_URL`,
`STORAGE_*` (MinIO/S3), `API_PORT/HOST/CORS_ORIGIN`, `WORKER_HEARTBEAT_INTERVAL_MS`,
`WORKER_CONCURRENCY`, `NEXT_PUBLIC_API_BASE_URL`, `LOG_LEVEL`.

## 6. Common issues

| Symptom                            | Fix                                                                       |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `EnvValidationError` on boot       | Copy/repair `.env`; check the named keys                                  |
| Prisma `P1001` (can't reach DB)    | `pnpm docker:up`; wait for healthchecks (`--wait` is default)             |
| Readiness `worker-heartbeat: down` | Expected until the worker runs; start `pnpm --filter @spectra/worker dev` |
| Port already in use                | Stop stray `next start`/API processes or change `API_PORT`                |
| Stale Prisma types                 | `pnpm db:generate` after schema changes                                   |
| Reset everything                   | `pnpm docker:reset && pnpm docker:up && pnpm db:deploy && pnpm db:seed`   |

## 7. E2E locally

```bash
pnpm --filter @spectra/web build
pnpm --filter @spectra/web exec playwright install chromium   # once
pnpm --filter @spectra/web test:e2e
```
