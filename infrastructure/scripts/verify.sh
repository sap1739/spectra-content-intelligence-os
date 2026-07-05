#!/usr/bin/env bash
# Full local verification: format, lint, typecheck, unit tests, build.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "==> Format check" && pnpm format:check
echo "==> Lint" && pnpm lint
echo "==> Typecheck" && pnpm typecheck
echo "==> Unit tests" && pnpm test
echo "==> Build" && pnpm build
echo ""
echo "All verification steps passed."
