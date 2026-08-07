#!/bin/bash
set -euo pipefail

# SECURITY: Never commit .env to git. Copy from .env.example and fill in values.
# This helper is paper/read-only by default. Pass --execute explicitly for live mode.
export PATH="$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

FLYWHEEL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$FLYWHEEL_DIR"

if [ ! -f "$FLYWHEEL_DIR/.env" ]; then
  echo "ERROR: .env not found. Copy .env.example first."
  exit 1
fi

set -a
source "$FLYWHEEL_DIR/.env"
set +a

STATE_DIR="${SUWAPPU_FLYWHEEL_STATE_DIR:-$HOME/.suwappu-flywheel}"
mkdir -p "$STATE_DIR"

EXEC_ARGS=()
MODE="paper"
if [ "${1:-}" = "--execute" ]; then
  EXEC_ARGS=(--execute)
  MODE="live"
elif [ "$#" -gt 0 ]; then
  echo "Usage: $0 [--execute]"
  exit 2
fi

echo "$(date): starting flywheel run ($MODE)" >> "$STATE_DIR/cron.log"

# Preserve Bun's exit status even though output is also written to the log.
set +e
bun run src/cli.ts run "${EXEC_ARGS[@]}" --amount 2 --json 2>&1 | tee -a "$STATE_DIR/flywheel.log"
run_status=${PIPESTATUS[0]}
set -e

echo "$(date): flywheel run completed (exit $run_status)" >> "$STATE_DIR/cron.log"
exit "$run_status"
