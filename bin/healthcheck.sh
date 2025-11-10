#!/usr/bin/env bash
set -euo pipefail

if [ ! -f "/app/data/.last-success" ]; then
  echo "missing success marker"
  exit 1
fi

threshold="${HEALTHCHECK_THRESHOLD_SECONDS:-86400}"
last_run=$(cat /app/data/.last-success 2>/dev/null || echo 0)
now=$(date +%s)

if (( now - last_run > threshold )); then
  echo "last successful backup older than threshold"
  exit 1
fi

echo "ok"
