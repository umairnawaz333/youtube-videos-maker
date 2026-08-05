#!/usr/bin/env bash
# Prepares the local environment for the database: creates .env from .env.example when
# missing (an existing .env is never touched), generates the Prisma client, and pushes
# the schema. Idempotent: safe to re-run — `prisma db push` is a no-op once the schema
# already matches.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ -f .env ]; then
  echo "--> .env already present, leaving it untouched"
else
  echo "--> creating .env from .env.example"
  cp .env.example .env
fi

# Export every variable from .env into this script's process so the pnpm/prisma commands
# below see DATABASE_URL without the caller having to inline it.
set -a
# shellcheck disable=SC1091
source .env
set +a

echo "--> generating the Prisma client"
pnpm --filter @yt/db db:generate

echo "--> pushing the database schema"
pnpm --filter @yt/db db:push

echo "done."
