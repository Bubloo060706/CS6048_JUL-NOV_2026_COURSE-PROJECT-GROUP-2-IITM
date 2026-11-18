#!/usr/bin/env bash
set -Eeuo pipefail

BASE="experiments/baseline_06nov_3runs"
OUT="$BASE/executed_baselines"
mkdir -p "$OUT"

SCHEDULES=(
  "S-r01-seed1393084745"
  "S-r02-seed189711548"
  "S-r03-seed504830888"
)

for i in 0 1 2; do
    n=$((i + 1))
    sid="${SCHEDULES[$i]}"

    echo "========== BASELINE B$n START =========="
    date -u +"UTC start: %Y-%m-%dT%H:%M:%SZ"

    python3 scripts/run_ifb_schedule.py \
      --schedule "$BASE/schedules/$sid.csv" \
      --config experiments/baseline-profiles.json \
      --out-dir "$OUT/B$n-network"

    echo "========== BASELINE B$n NETWORK SCHEDULE COMPLETE =========="
    date -u +"UTC network end: %Y-%m-%dT%H:%M:%SZ"

    echo "Keeping normal network for 300 seconds for browser telemetry."
    sleep 300

    echo "========== B$n TELEMETRY WINDOW COMPLETE =========="
done

echo "ALL THREE BASELINE NETWORK SCHEDULES AND RECOVERY WINDOWS COMPLETE."
