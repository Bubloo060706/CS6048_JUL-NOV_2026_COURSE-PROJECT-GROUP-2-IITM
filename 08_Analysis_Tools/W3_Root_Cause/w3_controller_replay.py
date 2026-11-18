#!/usr/bin/env python3
"""
Replay the actual public/adaptation-controller.js against W3's recorded
720-second impairment window. This evaluates controller behaviour only;
it does not predict new freezes or prove live video improvement.
"""
import csv, io, json, sys, zipfile, subprocess
from datetime import datetime, timezone
from pathlib import Path

ZIP_PATH = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("W3_W1-tune-2(1).zip")
CONTROLLER = Path("public/adaptation-controller.js")
if not ZIP_PATH.exists():
    sys.exit(f"ERROR: W3 archive not found: {ZIP_PATH.resolve()}")
if not CONTROLLER.exists():
    sys.exit(f"ERROR: Run this from the project root; missing {CONTROLLER}")

def dt(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00"))

with zipfile.ZipFile(ZIP_PATH) as z:
    csv_name = next(n for n in z.namelist() if n.endswith("adaptive-metrics.csv"))
    event_name = next(n for n in z.namelist() if n.endswith("network-events.jsonl"))
    rows = list(csv.DictReader(io.TextIOWrapper(z.open(csv_name), encoding="utf-8")))
    events = [json.loads(x) for x in z.read(event_name).decode().splitlines() if x.strip()]

start_event = next(e for e in events if e.get("event") == "runner_started")
start = dt(start_event["utc"])
end = start.timestamp() + 720
window = [r for r in rows if start.timestamp() <= dt(r["timestamp"]).timestamp() < end]
if len(window) < 700:
    sys.exit(f"ERROR: Expected about 720 impairment samples; found {len(window)}. Check archive/time alignment.")

def num(row, key):
    try:
        v = float(row.get(key, ""))
        return v if v == v else None
    except (TypeError, ValueError):
        return None

# Original sender maxBitrate recorded by the live run; first non-empty value.
# W3 controller_initialized confirmed originalMaxBitrate_kbps was null.
original = None

# Each run uses the exact JS controller file. Disabled trigger = unreachable threshold.
variants = [
    ("DEFAULT", {}),
    ("RTT_200", {"rttHighMs": 200}),
    ("RTT_300", {"rttHighMs": 300}),
    ("LOSS_0.5", {"lossHighPct": 0.5}),
    ("LOSS_2.0", {"lossHighPct": 2.0}),
    ("ABLATE_RTT_OFF", {"rttHighMs": 1e12}),
    ("ABLATE_LOSS_OFF", {"lossHighPct": 1e12}),
]

payload = {
    "controller": str(CONTROLLER.resolve()),
    "original": original,
    "variants": variants,
    "rows": [{
        "rttMs": num(r, "rtt_ms"),
        "rtcpFractionLostPct": num(r, "rtcpFractionLost_pct"),
        "fps": num(r, "fps"),
        "measuredBitrateKbps": num(r, "bitrate_kbps"),
        "availableOutgoingBitrateKbps": num(r, "availableOutgoingBitrate_kbps"),
    } for r in window]
}

js = r"""
const fs = require('fs');
const p = JSON.parse(fs.readFileSync(0, 'utf8'));
const api = require(p.controller);
for (const [name, overrides] of p.variants) {
  const c = api.create(overrides);
  let adaptive=0, recovery=0, normal=0, actions=0, firstActive=null;
  let targetSum=0, targetN=0, minTarget=Infinity, maxTarget=-Infinity;
  let signalCounts={highRtt:0,highLoss:0,lowFps:0,constrainedEstimate:0};
  let priorState='NORMAL';
  for (let i=0; i<p.rows.length; i++) {
    const x=p.rows[i];
    const d=c.update({...x, originalMaxBitrateKbps:p.original});
    if (d.state==='ADAPTIVE') adaptive++;
    else if (d.state==='RECOVERY') recovery++;
    else normal++;
    if (firstActive===null && d.state==='ADAPTIVE') firstActive=i;
    for (const k of Object.keys(signalCounts)) if (d.signals[k]) signalCounts[k]++;
    if (d.changed && d.targetKbps!=null) actions++;
    if (d.targetKbps!=null) {
      targetSum+=d.targetKbps; targetN++;
      minTarget=Math.min(minTarget,d.targetKbps);
      maxTarget=Math.max(maxTarget,d.targetKbps);
    }
    priorState=d.state;
  }
  console.log(JSON.stringify({
    test:name, samples:p.rows.length, normal_s:normal, adaptive_s:adaptive,
    recovery_s:recovery, adaptive_pct:+(100*adaptive/p.rows.length).toFixed(1),
    first_adaptive_sample:firstActive, controller_changes:actions,
    mean_target_kbps:targetN?+(targetSum/targetN).toFixed(1):null,
    min_target_kbps:targetN?minTarget:null, max_target_kbps:targetN?maxTarget:null,
    signal_samples:signalCounts
  }));
}
"""
proc = subprocess.run(["node", "-e", js], input=json.dumps(payload), text=True,
                      capture_output=True)
if proc.returncode:
    sys.stderr.write(proc.stderr)
    sys.exit(proc.returncode)

print(f"W3 impairment samples replayed: {len(window)}")
print(f"Network schedule: {start.isoformat()} to {datetime.fromtimestamp(end, timezone.utc).isoformat()}")
print("Original sender maxBitrate used:", "unset (null)" if original is None else f"{original:.1f} kbps")
print("NOTE: These are simulated controller decisions on recorded inputs, not new QoE results.")
print("\nRESULTS")
print("test,normal_s,adaptive_s,recovery_s,adaptive_pct,first_adaptive_sample,controller_changes,mean_target_kbps,min_target_kbps,max_target_kbps")
for line in proc.stdout.splitlines():
    x=json.loads(line)
    print(",".join(str(x[k]) for k in [
        "test","normal_s","adaptive_s","recovery_s","adaptive_pct",
        "first_adaptive_sample","controller_changes","mean_target_kbps",
        "min_target_kbps","max_target_kbps"]))
print("\nSIGNAL COUNTS (number of samples each trigger was true)")
for line in proc.stdout.splitlines():
    x=json.loads(line)
    print(x["test"], x["signal_samples"])
