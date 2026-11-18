# WebRTC Video Conferencing under Variable Network Conditions

A browser-based one-to-one WebRTC testbed for controlled networking experiments. It provides WebSocket signaling, periodic `RTCPeerConnection.getStats()` collection, CSV export, an endpoint-side sender bitrate controller, Linux `tc netem` helpers, and Python summaries/plots.

## Scope and claims

- The adaptation controller is a transparent experimental heuristic, not an optimal or production congestion-control algorithm.
- The controller requests changes to the video sender's `RTCRtpSender.setParameters().encodings[0].maxBitrate`. It does not replace or disable the browser's native WebRTC congestion control.
- The configured `maxBitrate` is a sender parameter limit, **not a guarantee that every measured bitrate sample will stay below that value**.
- `RTT` is the browser's selected ICE candidate-pair round-trip-time estimate; it is not one-way latency.
- `rtcpFractionLost_pct` is the fraction reported by the remote receiver in `remote-inbound-rtp` statistics. It is not a locally calculated interval loss percentage.
- `intervalPacketLoss_pct` and `intervalPacketsLost` intentionally remain blank because standard `RTCRemoteInboundRtpStreamStats` does not guarantee a paired receiver packet-count field suitable for a valid interval-loss calculation. Do not substitute a cumulative `packetsLost` value or a fraction-loss report and label it interval loss.
- `remotePacketsLost` is the remote receiver's reported cumulative packet-loss counter. It may be unavailable or have browser-specific interpretation; do not compare its raw value between runs as a percentage.
- `maxBitrateParameterAfterSet_kbps` records the value requested and accepted by `setParameters`, not the actual media bitrate. Use `bitrate_kbps` for the measured sending rate.
- Browser statistics differ by browser and version. Blank measurements are expected and must not be replaced with zero.
- This prototype does not modify native WebRTC source code.
- The signaling server is a minimal lab server. It has no user authentication, room authorization, or production hardening. Do not expose it publicly without additional security controls.

## Requirements

- Node.js 18+ and npm
- Recent Chrome/Chromium or Firefox with WebRTC support
- Camera and microphone access
- Python 3.9+ for analysis
- Linux `iproute2` (`tc`) for network emulation

## Install and run

From the project root:

```bash
npm install
npm test
npm start
```

Open `http://localhost:8080` in two tabs on the same machine for an initial connection/logging smoke test. Enter the same room ID in both tabs, join the room in both, allow camera/microphone access, then start the call from one participant. The other participant answers automatically.

Select **Baseline WebRTC** or **Adaptive controller** before starting logging. Set the target bitrate and sample interval, then click **Start logging**. At the end, click **Stop logging** and **Download CSV**. Settings are locked during a logging session. Each new baseline session removes an application `maxBitrate` cap so that the browser's native congestion control is not accidentally left under a cap from an earlier adaptive run.

For two separate devices, serve the app over HTTPS/WSS with a trusted certificate. The demo uses a public STUN server only; some NAT/firewall configurations require TURN.

### Automated browser run mode

The app supports URL-configured run startup and timed CSV export to reduce per-trial clicking. It does **not** grant camera permission automatically; approve the browser prompt on each endpoint. Open a URL of this form on both endpoints (use the same `room` and `runId`, but set each endpoint's `role` differently):

```text
https://YOUR-LAB-HOST/?auto=1&room=trial-001&runId=trial-001-baseline-r1&role=caller&mode=baseline&duration=90&intervalMs=1000&targetKbps=900
https://YOUR-LAB-HOST/?auto=1&room=trial-001&runId=trial-001-baseline-r1&role=answerer&mode=baseline&duration=90&intervalMs=1000&targetKbps=900
```

Supported query parameters: `auto=1`, `room`, `runId`, `role=caller|answerer`, `mode=baseline|adaptive`, `duration` (10–3600 seconds), `intervalMs` (500–10000 ms), and `targetKbps` (100–10000). The caller creates the offer; both endpoints begin logging after their peer connection reaches `connected`, then stop and request CSV downloads after the configured duration. The browser may block automatic downloads depending on its settings. Keep the downloaded endpoint CSVs separate and label the sender-side impairment and endpoint role in a run manifest. Use a unique `runId` per trial.

**Automation boundary:** this URL mode automates app startup, call initiation (caller role), logging, timed stop, and CSV download request. It does not remotely launch a browser on a second machine, apply Linux `tc`, verify the ICE route, or guarantee a successful download. Those steps depend on separate endpoint access and network topology and must be independently verified. Do not interpret the run as valid merely because the timer completed; inspect CSV sample count, connection state, candidate-pair stats, and `tc` output.

## Important: network impairment topology

Two tabs on the same computer are useful for checking signaling, media, CSV fields, and basic adaptation. **They are not sufficient evidence of behavior under a constrained network.** WebRTC media normally travels peer-to-peer; the signaling server does not carry the media stream.

Applying `tc netem` to an unrelated server interface will not impair media between local browser tabs. The impairment must be applied to an interface/path that actually carries the WebRTC media packets. Use two machines with media traffic traversing the impaired interface, or an isolated network namespace/veth/bridge topology. Verify the selected ICE candidate pair and routing before interpreting the experiment.

## Linux network emulation

Identify the correct interface first:

```bash
ip route
ip -br link
tc qdisc show dev eth0
```

Example profile (replace `eth0` with the verified sender-side egress interface):

```bash
sudo ./scripts/netem_apply.sh eth0 5mbit 80ms 20ms 1%
```

Arguments: `INTERFACE RATE DELAY JITTER LOSS`.

Clear the test qdisc after each run:

```bash
sudo ./scripts/netem_clear.sh eth0
```

**Safety restriction:** the helper now refuses physical/Wi-Fi interfaces and any interface whose root qdisc is not the default `noqueue` on a disposable veth. Arbitrary existing qdisc trees cannot be reliably reconstructed from `tc qdisc show`, so the scripts fail closed instead of risking the Ubuntu `eno1` (`mq`/`fq_codel`) configuration. `netem` affects egress only; bidirectional shaping needs a separately validated topology.

## Analysis

Install analysis dependencies:

```bash
python -m pip install -r analysis/requirements.txt
```

Analyze one or more CSV files:

```bash
python analysis/analyze.py baseline.csv adaptive.csv --out results/summary.csv
```

The script creates the output directory, writes one summary row per source file and mode, reports sample counts and valid-value counts, and saves time-series plots for available metrics. Use `--no-plots` to create only the summary CSV.

## Experiment planning artifacts

- `experiments/protocol.md` defines the research question, topology checks, metrics, invalid-run criteria, and interpretation safeguards.
- `experiments/trial-matrix.json` contains an editable pilot matrix and a 15 s stable / 60 s impaired / 30 s recovery schedule.
- Generate a reproducible randomized paired trial order with:

```bash
python scripts/generate_trial_plan.py --out results/trial-plan.csv --seed 20261026 --repetitions 3
```

The default matrix expands to 18 runs: 3 profiles × 3 repetitions × 2 modes. The seed and randomized order are written to the plan. This generator plans runs; it does not itself apply network impairment or operate the remote endpoint. Record actual run validity and exclusions in the plan rather than deleting failed trials.

## Minimum controlled experiment protocol

1. Confirm both peers connect and both video directions work.
2. Use the same browser versions, camera/device, scene, resolution settings, room topology, sample interval, and run duration.
3. Verify the impairment is applied to the actual media path; record `tc qdisc show` and ICE candidate-pair details.
4. Run an unimpeded smoke test. Then choose one impairment profile and hold it constant across the baseline and adaptive runs.
5. For each condition, run baseline and adaptive sessions of the same planned duration. Repeat each condition at least 3 times for research reporting; randomize order when practical to reduce order effects.
6. Preserve raw CSVs. Record OS, browser/version, endpoint roles, interface, network profile, start/end time, duration, and anomalies.
7. Compare measured bitrate, FPS, resolution, RTCP-reported loss fraction, RTT, jitter, controller target, `setParameters` success/status, and adaptation action count. Do not report a performance improvement unless repeated controlled runs support it.
8. The app does not automatically measure freeze duration, subjective video quality, or one-way latency. Do not claim those metrics without separate instrumentation.

## CSV field interpretation

| Field | Meaning |
|---|---|
| `bitrate_kbps` | Measured outbound bitrate from the delta of `bytesSent` over the stats timestamps |
| `fps`, `width`, `height` | Browser-reported outbound video encoder/stream stats |
| `remotePacketsLost` | Remote receiver's reported cumulative loss counter, when available |
| `rtcpFractionLost_pct` | Remote receiver's RTCP-reported fraction lost converted to percent |
| `intervalPacketLoss_pct` | Blank unless a valid paired receiver counter calculation is implemented |
| `rtt_ms` | Selected ICE candidate-pair RTT estimate |
| `jitter_ms` | Jitter reported for the local inbound video stream |
| `availableOutgoingBitrate_kbps` | Browser-reported outgoing bandwidth estimate, when available |
| `controllerTarget_kbps` | Target selected by the heuristic |
| `maxBitrateParameterBeforeSet_kbps` | Sender `maxBitrate` parameter before the attempted update |
| `maxBitrateParameterAfterSet_kbps` | Sender parameter value after successful `setParameters`, not actual measured bitrate |
| `setParametersApplied`, `adaptationStatus`, `adaptationError` | Whether the controller changed the parameter and how the attempt ended |

## Project structure

```text
public/
  app.js                         Browser signaling, stats collection, CSV logging
  adaptation-controller.js       Pure, testable bitrate decision heuristic
  index.html                     Testbed UI
  style.css                      UI styles
server.js                        HTTP static server and WebSocket signaling
scripts/netem_apply.sh           Apply Linux traffic impairment
scripts/netem_clear.sh           Clear test qdisc
analysis/analyze.py              Summary statistics and plots
tests/adaptation-controller.test.js
verify-project.ps1               Windows static/test verification
```

## Two-computer Windows setup (HTTPS)

Camera/microphone access on another computer requires a secure browser context. The server supports local HTTPS when both `certs/lan-cert.pem` and `certs/lan-key.pem` exist; the WebSocket signaling endpoint automatically uses WSS when the page is HTTPS.

On Computer A (the server), in PowerShell:

1. Install mkcert using `winget install FiloSottile.mkcert` (or install mkcert using its official instructions).
2. Close and reopen PowerShell, then run `mkcert -install`.
3. Find Computer A's Wi-Fi IPv4 address with `ipconfig`. Create the certificate, replacing `192.168.1.25` with that actual address:

```powershell
New-Item -ItemType Directory -Force .\certs | Out-Null
mkcert -cert-file .\certs\lan-cert.pem -key-file .\certs\lan-key.pem localhost 127.0.0.1 ::1 192.168.1.25
```

4. Run `npm start` again. The server should print `https://localhost:8080` and `TLS enabled`.
5. On Computer A, open `https://localhost:8080`. On Computer B, open `https://192.168.1.25:8080` (use the actual IP). Do not use HTTP.
6. Trust mkcert's local root CA on Computer B: on Computer A, run `mkcert -CAROOT` and locate `rootCA.pem` in that directory. Copy **only `rootCA.pem`** to Computer B through a trusted private method. On Computer B, open PowerShell as Administrator and run `certutil -addstore -f Root C:\path\to\rootCA.pem` after replacing the path with the copied file's path. Restart Chrome on Computer B. Computer A's root CA is installed by `mkcert -install`.
7. Verify the browser shows a secure connection, then allow camera/microphone access. If Chrome still warns about the certificate, stop and correct certificate trust; do not bypass certificate warnings.

Security: keep this test on a trusted private network. Do not share the generated private key (`lan-key.pem`) or mkcert's `rootCA-key.pem`; do not expose the server publicly. The local IP may change when reconnecting to Wi-Fi; if it changes, regenerate the certificate with the new IP.

## Randomized baseline automation (pilot)

See [`experiments/BASELINE_AUTOMATION.md`](experiments/BASELINE_AUTOMATION.md) before running any impairment. The new `scripts/run_randomized_baseline.py` creates a reproducible randomized baseline schedule in dry-run mode by default. Actual `tc` execution is fail-closed and restricted to a disposable veth with a default `noqueue` root qdisc; it requires `--apply` and `--confirm-dedicated-veth`. This is not yet the impairment path for the physical two-endpoint setup. Start with dry-run validation; do not run live experiments until the actual media topology and cleanup are independently validated.


## Updated experimental workflow (v2)

### Complete endpoint data export

During a run, the browser records normalized telemetry CSV rows, complete available `getStats()` JSONL snapshots, browser/API snapshots, and event logs. Use **Download complete run bundle** on each endpoint to export one JSON file containing all four data groups. Keep both endpoint bundles; sender and receiver reports are complementary. RTT is selected ICE candidate-pair RTT, not one-way latency. RTCP fraction lost and cumulative packet counters are not interval packet-loss percentages.

### Matched randomized schedules

Generate immutable schedules and paired baseline/adaptive run plans:

```bash
python3 scripts/generate_paired_schedules.py --seed 20261030 --repetitions 3 --duration-seconds 600
```

The output `experiments/generated/paired-run-plan.csv` maps each pair to one exact schedule CSV. Replay that same schedule for both modes. The runner accepts `--schedule-file PATH`; it validates contiguous timing and known profile names. Add `runId`, `pairId`, `scheduleId`, and `experimentId` to the browser URL for traceability. The schedule planner does not launch browsers or apply network impairment.

### Safety restriction for network impairment

Live `tc` application is intentionally restricted to a disposable veth with a default `noqueue` root qdisc. The scripts refuse physical/Wi-Fi interfaces and existing qdisc trees because arbitrary qdisc configurations cannot be restored reliably from textual snapshots. In particular, do not run them against the previously observed `eno1` (`mq`/`fq_codel`) interface. The actual two-endpoint media topology still needs a separately validated, topology-specific impairment path before live experiments.

### Offline analysis

```bash
python3 analysis/analyze.py path/to/endpoint-metrics.csv --out analysis/output/summary.csv
```

The analysis produces summary statistics, synchronized stacked per-run plots, and cross-file comparison plots. Freeze and frame-drop indicators are only calculated when their source counters are available. No subjective QoE score is inferred.


### Flatten complete raw getStats reports for offline inspection

```bash
python3 analysis/extract_raw_stats.py path/to/endpoint-complete-run.json --out analysis/output/raw-stats.csv
```

The extractor creates one row per stats snapshot and prefixes columns by report type and report ID to avoid collisions. The original JSON bundle remains the authoritative raw record.


### Run identifiers in browser URL

For an automated endpoint, include the identifiers from the paired run plan, for example:

```text
https://HOST/?auto=1&room=ROOM&role=caller&mode=baseline&duration=180&intervalMs=1000&targetKbps=900&runId=RUN_ID&pairId=PAIR_ID&scheduleId=SCHEDULE_ID&experimentId=baseline-characterization
```

Use `role=answerer` on the other endpoint and the same room/run/pair/schedule/experiment identifiers. Change only `role` and the mode/run ID as appropriate for the matched adaptive run. The browser exports one complete JSON bundle automatically at the end of an automated run; each endpoint must retain its own bundle.

### Tests

```bash
npm test
npm run test:python
node --check public/app.js
python -m py_compile analysis/*.py scripts/*.py
bash -n scripts/netem_apply.sh scripts/netem_clear.sh
```
