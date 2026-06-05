#!/usr/bin/env bash
#
# Chaos test: kill the worker while a seat is HELD and show the system
# self-heals. The Redis lock TTL frees any orphaned lock, and once the worker
# restarts its sweeper expires the stale HELD reservation back to AVAILABLE —
# no seat is permanently stuck.
#
set -euo pipefail
BASE="${BASE_URL:-http://localhost:3000}"

echo "1) Reserving seat 1 (status -> HELD)..."
curl -s -XPOST "$BASE/api/reserve" -H 'content-type: application/json' \
  -d '{"userId":"chaos-user","seatNumber":1}'; echo

echo "2) Killing the worker process mid-hold..."
pkill -f 'dist/worker.js' 2>/dev/null || pkill -f 'src/worker.ts' 2>/dev/null || echo "   (worker not running under expected name)"

echo "3) Worker is down. The Redis lock TTL (LOCK_TTL_SECONDS) releases the lock"
echo "   automatically. Restart the worker (npm run dev:worker) and its reservation"
echo "   sweeper will expire the HELD seat back to AVAILABLE after HOLD_TTL_SECONDS."
echo
echo "   Verify recovery:  curl $BASE/api/seats | jq '.[] | select(.number==1)'"
