#!/usr/bin/env bash
set -euo pipefail

# ── IRIS OS Dev Runner ──────────────────────────────────────
# Run: ./run.sh
# Kill: Ctrl+C (stops all child processes)
# ───────────────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PIDS=()

cleanup() {
  echo ""
  echo "Stopping all processes..."
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  wait 2>/dev/null
  echo "Done."
}
trap cleanup EXIT INT TERM

# 1. Check .env exists
if [ ! -f .env ]; then
  echo "Copying .env.example to .env..."
  cp .env.example .env
  echo "Edit .env to set POSTGRES_URL, BETTER_AUTH_SECRET, and API keys."
fi

# 2. Install deps if needed
if [ ! -d node_modules ]; then
  echo "Installing dependencies..."
  pnpm install
fi

# 3. Run migrations
echo "Running database migrations..."
pnpm db:migrate

# 4. Start memory worker (if curator mode is set)
echo "Starting memory worker..."
pnpm worker:memory &
PIDS+=($!)

# 5. Start Iris worker (learning, automation, delegation, A2A)
# Only starts if any V2 flag is enabled in .env
if grep -qE 'IRIS_(LEARNING|AUTOMATION|DELEGATION|REMOTE_AGENTS)_V2=1' .env 2>/dev/null; then
  echo "Starting Iris worker..."
  pnpm worker:iris &
  PIDS+=($!)
else
  echo "Skipping Iris worker (no V2 flags enabled in .env)"
fi

# 6. Start Next.js dev server
echo "Starting dev server..."
pnpm dev &
PIDS+=($!)

echo ""
echo "IRIS OS is running."
echo "  Web:   http://localhost:3000"
echo "  Workers: memory$(grep -qE 'IRIS_(LEARNING|AUTOMATION|DELEGATION|REMOTE_AGENTS)_V2=1' .env 2>/dev/null && echo ', iris' || echo '')"
echo ""
echo "Press Ctrl+C to stop everything."
echo ""

wait
