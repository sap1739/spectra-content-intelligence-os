#!/usr/bin/env bash
# One-time local setup: env files, dependencies, infrastructure, database.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> Copying environment templates (no overwrite)"
[ -f .env ] || cp .env.example .env
[ -f packages/database/.env ] || cp packages/database/.env.example packages/database/.env

echo "==> Installing dependencies"
pnpm install

echo "==> Starting Docker services (PostgreSQL, Redis, MinIO)"
pnpm docker:up

echo "==> Generating Prisma client"
pnpm db:generate

echo "==> Applying migrations"
pnpm db:deploy

echo "==> Seeding development data"
pnpm db:seed

echo ""
echo "Bootstrap complete. Next steps:"
echo "  pnpm dev            # start web (3000), api (4000) and worker"
echo "  open http://localhost:3000"
