#!/usr/bin/env bash
set -Eeuo pipefail

# Run from the extracted baseline_project_bundle directory.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

CTRL="public/adaptation-controller.js"
SCHEDULE="experiments/controller_windows/schedules/W2_B1_schedule_12min.csv"
PROFILES="experiments/baseline-profiles.json"
NETRUN="scripts/run_ifb_schedule.py"
OUTROOT="experiments/automated_w2_ablations_$(date +%Y%m%d_%H%M%S)"
BACKUP="$(mktemp)"
SERVER_PID=""
CURRENT_NET_PID=""
RESTORED=0

UBUNTU_IP="${UBUNTU_IP:-10.21.239.165}"
WINDOWS_IP="${WINDOWS_IP:-10.42.81.181}"
IFACE="${IFACE:-eno1}"
PORT="${PORT:-8080}"

die() { echo "ERROR: $*" >&2; exit 1; }

[[ -f "$CTRL" && -f "$SCHEDULE" && -f "$PROFILES" && -f "$NETRUN" ]] || \
  die "Run this script from the project root; required source files are missing."
command -v node >/dev/null || die "Node.js is not installed/on PATH."
command -v python3 >/dev/null || die "python3 is not installed/on PATH."
[[ -d node_modules/ws ]] || die "node_modules/ws missing. Install project dependencies first."
[[ ! -e /sys/class/net/ifb-in && ! -e /sys/class/net/ifb-out ]] || \
  die "ifb-in/ifb-out already exist. Check/clean the previous network test before proceeding."
if ss -ltn 2>/dev/null | grep -qE "[:.]${PORT}[[:space:]]"; then
  ORIGINAL_PORT="$PORT"
  while ss -ltn 2>/dev/null | grep -qE "[:.]${PORT}[[:space:]]"; do
    PORT=$((PORT + 1))
  done
  echo "[INFO] Port ${ORIGINAL_PORT} is occupied; using free port ${PORT}. Existing server will not be stopped."
fi

cp -p "$CTRL" "$BACKUP"
mkdir -p "$OUTROOT"

restore_controller() {
  if [[ "$RESTORED" -eq 0 && -f "$BACKUP" ]]; then
    cp -p "$BACKUP" "$CTRL"
    RESTORED=1
    echo "[RESTORE] Original adaptation-controller.js restored."
  fi
}
cleanup() {
  set +e
  if [[ -n "$CURRENT_NET_PID" ]] && kill -0 "$CURRENT_NET_PID" 2>/dev/null; then
    sudo kill -TERM "$CURRENT_NET_PID" 2>/dev/null
    wait "$CURRENT_NET_PID" 2>/dev/null
  fi
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  restore_controller
  rm -f "$BACKUP"
}
trap cleanup EXIT
trap 'echo "[INTERRUPT] stopping; restoring original controller."; exit 130' INT
trap 'echo "[TERM] stopping; restoring original controller."; exit 143' TERM

# Capture a stable copy/hash of the exact schedule used for every trial.
sha256sum "$SCHEDULE" | tee "$OUTROOT/W2_schedule.sha256"
python3 - "$SCHEDULE" <<'PY'
import csv,sys
p=sys.argv[1]
rows=list(csv.DictReader(open(p,newline='')))
total=sum(int(r["duration_s"]) for r in rows)
assert rows and int(rows[0]["start_s"]) == 0, "W2 schedule must start at 0"
assert total == 720, f"Expected 720 seconds, found {total}"
elapsed=0
for r in rows:
    assert int(r["start_s"]) == elapsed, "Schedule has a gap/overlap"
    elapsed += int(r["duration_s"])
print(f"[OK] Exact W2 schedule validated: {len(rows)} segments, {total}s")
PY

# Determine the Ubuntu address used to reach the Windows peer.
LOCAL_IP="$(python3 - "$WINDOWS_IP" <<'PY'
import socket,sys
s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM)
try:
    s.connect((sys.argv[1],9)); print(s.getsockname()[0])
except OSError:
    print("")
finally: s.close()
PY
)"
[[ -n "$LOCAL_IP" ]] || LOCAL_IP="$UBUNTU_IP"

if [[ -f certs/lan-cert.pem && -f certs/lan-key.pem ]]; then
  PROTO="https"
else
  PROTO="http"
fi

# Start the original project server from the original project directory.
PORT="$PORT" node server.js >"$OUTROOT/server.log" 2>&1 &
SERVER_PID=$!
sleep 2
kill -0 "$SERVER_PID" 2>/dev/null || die "Node server failed. See $OUTROOT/server.log."

run_trial() {
  local name="$1" rtt="$2" fps_on="$3"
  local dir="$OUTROOT/$name"
  local room="w2-${name,,}"
  mkdir -p "$dir"

  # Start every variant from the pristine backup, then make only the intended change.
  cp -p "$BACKUP" "$CTRL"
  python3 - "$CTRL" "$rtt" "$fps_on" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); rtt=int(sys.argv[2]); fps_on=(sys.argv[3]=="1")
s=p.read_text()
old="        rttHighMs: 250,"
if s.count(old)!=1: raise SystemExit("Expected exactly one default RTT threshold; aborting.")
s=s.replace(old, f"        rttHighMs: {rtt},", 1)
old="                lowFps: fps !== null && fps < config.fpsLow,"
if s.count(old)!=1: raise SystemExit("Expected exactly one lowFps signal; aborting.")
new=old if fps_on else "                lowFps: false,"
s=s.replace(old,new,1)
p.write_text(s)
PY
  node --check "$CTRL"
  cp "$CTRL" "$dir/adaptation-controller-used.js"
  sha256sum "$CTRL" "$SCHEDULE" > "$dir/source-hashes.sha256"
  cat > "$dir/trial-config.json" <<EOF
{
  "trial": "$name",
  "rttHighMs": $rtt,
  "fpsTriggerEnabled": $([[ "$fps_on" == "1" ]] && echo true || echo false),
  "lossHighPct": 1.0,
  "persistenceSamples": 3,
  "reductionFactor": 0.92,
  "recoveryStepFactor": 1.25,
  "schedule": "$SCHEDULE",
  "scheduleDurationSeconds": 720
}
EOF

  echo
  echo "================================================================"
  echo "TRIAL: $name"
  echo "================================================================"
  echo "Ubuntu (adaptive caller):"
  echo "$PROTO://$LOCAL_IP:$PORT/?auto=1&role=caller&mode=adaptive&duration=780&intervalMs=1000&runId=$name&room=$room&endpointRole=linux&experimentId=W2_sensitivity_ablation&pairId=W2_B1&scheduleId=W2_B1_schedule_12min"
  echo
  echo "Windows (baseline answerer):"
  echo "$PROTO://$LOCAL_IP:$PORT/?auto=1&role=answerer&mode=baseline&duration=780&intervalMs=1000&runId=$name&room=$room&endpointRole=windows&experimentId=W2_sensitivity_ablation&pairId=W2_B1&scheduleId=W2_B1_schedule_12min"
  echo
  echo "Open both URLs manually. Allow camera/microphone permission if prompted."
  echo "On BOTH pages, verify all of the following:"
  echo "  1) Status says Peer connection: connected"
  echo "  2) Event log says AUTOMATED RUN STARTED: runId=$name"
  echo "  3) The runId shown on each page is exactly $name"
  echo
  echo "The app starts timed logging only after pc.connectionState === 'connected'."
  echo "The signaling server does not expose each browser's peer-connection state"
  echo "to this shell script, so this is an explicit two-endpoint visual confirmation."
  echo "Do NOT continue if either page says connecting, failed, disconnected, or has no run-start message."
  echo
  read -r -p "Type BOTH_CONNECTED_AND_LOGGING only after verifying BOTH pages: " CONFIRM
  [[ "$CONFIRM" == "BOTH_CONNECTED_AND_LOGGING" ]] || die "Endpoint connection not confirmed; network impairment NOT started."

  echo "[RUN] Starting 720-second W2 network schedule..."
  sudo python3 "$NETRUN" \
    --schedule "$SCHEDULE" \
    --config "$PROFILES" \
    --ubuntu-ip "$UBUNTU_IP" \
    --windows-ip "$WINDOWS_IP" \
    --interface "$IFACE" \
    --out-dir "$dir/network" &
  CURRENT_NET_PID=$!
  set +e
  wait "$CURRENT_NET_PID"
  rc=$?
  set -e
  CURRENT_NET_PID=""
  [[ "$rc" -eq 0 ]] || die "$name network schedule failed (exit $rc). Original controller will be restored."

  echo
  echo "[DONE] Network schedule completed for $name."
  echo "Wait until BOTH browser pages show AUTOMATED RUN FINISHED and save/download the run bundles."
  echo "Move the downloaded files into: $dir/"
  read -r -p "After both endpoint exports are saved, press Enter for the next trial: "
}

run_trial "FPS_OFF_W2" 250 0
run_trial "RTT_200_W2" 200 1
run_trial "RTT_400_W2" 400 1

echo
echo "[SUCCESS] All three W2 trials completed."
echo "Results folder: $OUTROOT"
echo "Original controller will now be restored."
