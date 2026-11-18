# Analysis and Lightweight Adaptation of WebRTC Video Conferencing Under Variable Cellular Network Conditions

**CS6048: Advanced Computer Networks · Course Project · Group 2 | IIT Madras**  
**Authors:** CS25S019 · CS26E009 · CS22B080  


---

## Abstract & Project Overview

Interactive video conferencing is highly sensitive to access-network capacity drops, queueing delay, jitter, and packet loss. This project develops a reproducible two-endpoint WebRTC testbed and evaluates a lightweight sender-side adaptation policy that operates alongside browser-native **Google Congestion Control (GCC)**. 

Rather than modifying browser internals or replacing GCC, our endpoint policy acts as a transparent supervisory controller at the application boundary:
1. **Multi-Signal Telemetry:** Continuously monitors endpoint-visible WebRTC telemetry (`RTCPeerConnection.getStats()`): selected candidate-pair RTT, receiver-reported RTCP fraction lost, outbound frame rate (FPS), and available outgoing bitrate estimate.
2. **Persistent Adverse Detection:** Detects persistent network/video stress via multi-signal adverse detection and temporal hysteresis (requiring 3 consecutive adverse samples) to ignore isolated transient spikes.
3. **Bounded Sender Rate Control:** Constrains sender encoding rate using standard browser APIs (`RTCRtpSender.setParameters()` with `encodings[0].maxBitrate`), backing off with a 0.92 reduction factor down to a 150 kbps safety floor.
4. **Staged Recovery & Restoration:** Restores sender configuration in stages (5 consecutive healthy samples enter gradual recovery via a 1.25 multiplier; 10 consecutive healthy samples restore native unconstrained operation).

### Key Experimental Highlights (Matched 720-Second Windows)

- **Window 1 (W1):** 43.2% reduction in video freeze events (37 → 21) and 51.3% reduction in cumulative freeze duration (18.37 s → 8.95 s).
- **Window 2 (W2):** 45.2% reduction in video freeze events (42 → 23) and 58.0% reduction in cumulative freeze duration (16.88 s → 7.10 s).
- **Window 3 (W3):** Characterized the operational boundaries of sender-side rate limiting in delay-heavy queue accumulation regimes, demonstrating that sender rate reduction alone cannot drain in-flight buffers or reverse receiver playout gaps once delay dominates.
- **Ablation & Sensitivity:** W2 FPS ablation proved the necessity of application-quality feedback, and RTT sensitivity validated the 250 ms trigger as the optimal operating point.

---

## Scope and Claims

- **Supervisory Heuristic:** The adaptation controller is a transparent experimental heuristic, not an optimal or production congestion-control algorithm.
- **Preserves Native GCC:** The controller requests changes to the video sender's `RTCRtpSender.setParameters().encodings[0].maxBitrate`. It does **not** replace or disable the browser's native WebRTC congestion control.
- **Encoding Ceiling vs Measured Bitrate:** The configured `maxBitrate` is a sender parameter limit, **not a guarantee that every measured bitrate sample will stay below that value**.
- **Metrics Integrity:**
  - `RTT` is the browser's selected ICE candidate-pair round-trip-time estimate; it is not one-way latency.
  - `rtcpFractionLost_pct` is the fraction reported by the remote receiver in `remote-inbound-rtp` statistics. It is not a locally calculated interval loss percentage.
  - `intervalPacketLoss_pct` and `intervalPacketsLost` intentionally remain blank because standard `RTCRemoteInboundRtpStreamStats` does not guarantee a paired receiver packet-count field suitable for a valid interval-loss calculation. Do not substitute a cumulative `packetsLost` value or a fraction-loss report and label it interval loss.
  - `remotePacketsLost` is the remote receiver's reported cumulative packet-loss counter. It may be unavailable or have browser-specific interpretation; do not compare its raw value between runs as a percentage.
  - `maxBitrateParameterAfterSet_kbps` records the value requested and accepted by `setParameters`, not the actual media bitrate. Use `bitrate_kbps` for the measured sending rate.
  - Missing browser statistics remain missing (`null`/blank) rather than being falsely imputed as zero.
- **Testbed Isolation:** The signaling server is a minimal lab server with no user authentication or production hardening. Do not expose it publicly without additional security controls.

---

## System Architecture

```text
+-----------------------------------------------------------------------------------------+
|                                    Sender Endpoint                                      |
|                                                                                         |
|  +--------------------+       Raw Telemetry       +----------------------------------+  |
|  | WebRTC Media Stack | ------------------------> | RTCPeerConnection.getStats()     |  |
|  | (Native GCC active)|                           | - Selected ICE candidate RTT     |  |
|  |                    |                           | - RTCP receiver fraction lost    |  |
|  |                    |                           | - Outbound FPS & bitrate         |  |
|  |                    |                           | - Available outgoing bandwidth   |  |
|  |                    |                           +----------------------------------+  |
|  |                    |                                            |                    |
|  |                    |                                            v                    |
|  |                    |                           +----------------------------------+  |
|  |                    |                           | Endpoint Adaptation Controller   |  |
|  |                    |                           | (NORMAL -> ADAPTIVE -> RECOVERY) |  |
|  |                    |                           +----------------------------------+  |
|  |                    |                                            |                    |
|  |                    |       maxBitrate Cap                       v                    |
|  | RTCRtpSender       | <------------------------ RTCRtpSender.setParameters()          |
|  +--------------------+                           (Single actuator: encodings[0])       |
+-----------------------------------------------------------------------------------------+
                                         |
                                         | RTP/RTCP Media Traffic
                                         v
+-----------------------------------------------------------------------------------------+
|                  Linux Traffic Control (tc netem + IFB Bidirectional)                  |
|                Repeatable Rate / Delay / Jitter / Loss Network Schedules                |
+-----------------------------------------------------------------------------------------+
                                         |
                                         v
+-----------------------------------------------------------------------------------------+
|                                   Receiver Endpoint                                     |
|            Remote Inbound RTP Stats, Frame Render / Freeze Counters, Telemetry          |
+-----------------------------------------------------------------------------------------+
```

### The Adaptation Controller (`01_Source_Code/public/adaptation-controller.js`)

At each 1-second sampling cycle, the controller evaluates four adverse signals:
1. **High RTT:** Selected candidate-pair $\text{RTT} \ge 250\text{ ms}$ (above 196–206 ms baseline median; below 386–393 ms P95 tail).
2. **High Loss:** Receiver-reported RTCP fraction lost $\ge 1.0\%$ (detects meaningful receiver feedback).
3. **Low FPS:** Outbound $\text{FPS} < 20$ (below the nominal 30 FPS median, detecting video-delivery stall).
4. **Constrained Estimate:** $\text{Available Outgoing Bitrate} < 80\% \times \text{Measured Bitrate}$ (detects mismatch between sending rate and browser transport estimate).

#### State Machine & Transitions

- **`NORMAL` $\to$ `ADAPTIVE`**: Requires **3 consecutive adverse samples** (filters transient spikes while responding to persistent stress).
  - Target calculation: $\text{target} = \max(150\text{ kbps}, \min(\text{originalCap}, \text{capacity} \times 0.92))$, where $\text{capacity} = \text{availableEstimate} \parallel \text{measuredBitrate}$.
  - Target damping: Changes are only committed if $|\Delta\text{target}| \ge \max(50\text{ kbps}, 10\% \times \text{lastTarget})$ to avoid rapid oscillation.
- **`ADAPTIVE` $\to$ `RECOVERY`**: Entered after **5 consecutive healthy samples**.
  - Rate ramp-up: $\text{target} = \min(\text{originalCap}, \text{recoveredCapacity}, \text{lastTarget} \times 1.25)$.
- **`RECOVERY` $\to$ `NORMAL`**: Restores the sender's unconstrained configuration after **10 consecutive healthy samples** (`restoreOriginal: true`).
- **Telemetry Guard:** Missing telemetry is never interpreted as a healthy sample (`hasUsableSignal` check).

---

## Experimental Findings

### 1. Baseline Characterization (Three 60-Minute Runs)

Across three 60-minute baseline runs (B1–B3) with native GCC:

| Run | Median RTT | P95 RTT | P95 RTCP Loss | Median FPS | Run Freeze Duration |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **B1** | 196.0 ms | 386.0 ms | 4.34% | 30.0 | 70.37 s |
| **B2** | 206.0 ms | 389.0 ms | 4.69% | 30.0 | 64.73 s |
| **B3** | 205.0 ms | 393.0 ms | 5.08% | 30.0 | 59.37 s |

*Observation:* While median frame rate remained stable at 30 FPS, upper-tail delay and loss accumulated 59–70 seconds of video freezes. Single average-rate or average-FPS metrics hide severe intermittent delivery disruptions.

### 2. Matched 720-Second Baseline vs. Adaptive Evaluation

Each matched comparison replays the exact 720-second network impairment schedule:

| Window | Schedule Origin | Metric | Baseline (GCC Only) | Adaptive (GCC + Controller) | Relative Change |
|:---:|:---:|:---|:---:|:---:|:---:|
| **W1** | B3 (360–1080s) | Freeze Events<br>Freeze Duration<br>Mean Bitrate<br>Mean FPS | 37<br>18.367 s<br>871 kbps<br>29.56 | 21<br>8.946 s<br>740 kbps<br>29.94 | **-43.2%**<br>**-51.3%**<br>-15.0%<br>+1.3% |
| **W2** | B1 (1794–2514s) | Freeze Events<br>Freeze Duration<br>Mean Bitrate<br>Mean FPS | 42<br>16.880 s<br>641 kbps<br>29.58 | 23<br>7.098 s<br>621 kbps<br>29.17 | **-45.2%**<br>**-58.0%**<br>-3.1%<br>-1.4% |
| **W3** | B2 (2457–3177s) | Freeze Events<br>Freeze Duration<br>Mean Bitrate<br>Mean FPS | 31<br>15.891 s<br>762 kbps<br>29.58 | 32<br>17.479 s<br>734 kbps<br>29.62 | +3.2%<br>+10.0%<br>-3.7%<br>+0.1% |

*Insights:*
- In W1 and W2, the controller cut freeze events by **>43%** and freeze duration by **>51%** with minimal impact on mean bitrate.
- In W3 (delay-dominated regime where 46.7% of samples crossed the 250 ms RTT trigger), queue buildup dominated path behavior. Rate limiting alone cannot drain existing queues or reverse packet-arrival gaps once delay dominates.

### 3. W2 Ablation & Parameter Sensitivity

| Configuration | Mean Bitrate | Mean FPS | Freeze Events | Freeze Duration | Trade-off Interpretation |
|---|:---:|:---:|:---:|:---:|---|
| **Default (250 ms + FPS)** | **621.3 kbps** | **29.17** | **23** | **7.098 s** | **Best balance of continuity and throughput** |
| **FPS Trigger OFF** | 625.8 kbps | 29.51 | 31 (+34.8%) | 10.092 s (+42.2%) | Proves FPS feedback captures video stalls missed by RTT/loss |
| **RTT 200 ms (Aggressive)** | 420.6 kbps | 28.79 | 31 (+34.8%) | 8.645 s (+21.8%) | Premature triggering restricts rate unnecessarily without reducing freezes |
| **RTT 400 ms (Permissive)** | 540.0 kbps | 29.50 | 22 (-4.3%) | 8.076 s (+13.8%) | Late reaction misses the initial degradation window |

### 4. W3 Stronger-Reduction Test (0.92 vs. 0.82 Factor)

| Configuration | Mean Bitrate | Freeze Events | Freeze Duration | Outcome |
|---|:---:|:---:|:---:|---|
| **Baseline B2** | 761.7 kbps | 31 | 15.891 s | Native GCC response |
| **Adaptive (0.92 factor)** | 733.7 kbps | 32 | 17.479 s | Moderate sender backoff |
| **Adaptive (0.82 factor)** | 711.7 kbps | 45 | 19.136 s | Aggressive rate reduction exacerbates freeze burden |

*Conclusion:* Escalating rate reduction in delay-dominated scenarios fails to drain the bottleneck and increases freeze penalties.

---

## Repository Structure

```text
.
├── 00_Project_Guide/                     # Guides, review notes, changelogs, verification scripts
│   ├── README.md                         # Detailed operational and experiment guide
│   ├── REVIEW_NOTES.md                   # Audit log and code review findings
│   ├── CONTROLLER_IMPLEMENTATION_NOTES.md# Implementation details of the adaptation policy
│   ├── TEST_REPORT_V2.md                 # Test suite execution logs and validation report
│   ├── CHANGELOG_V2.md                   # Version history and bug fixes
│   └── verify-project.ps1                # PowerShell verification runner
│
├── 01_Source_Code/                       # Core WebRTC application
│   ├── server.js                         # Node.js HTTPS server & WebSocket signaling
│   ├── package.json / package-lock.json  # Dependencies (ws, testing tools)
│   ├── certs/                            # Local development TLS certificates (mkcert)
│   └── public/                           # Browser client
│       ├── index.html                    # Application UI
│       ├── style.css                     # Responsive styles
│       ├── app.js                        # Signaling, stats polling, CSV/JSONL export, auto-runner
│       └── adaptation-controller.js      # Pure, deterministic, testable adaptation state machine
│
├── 02_Experimental_Design/               # Emulation and scheduling infrastructure
│   ├── scripts/
│   │   ├── netem_apply.sh / netem_clear.sh # Linux tc netem impairment scripts
│   │   ├── run_ifb_schedule.py           # Bidirectional IFB network schedule executor
│   │   ├── generate_paired_schedules.py  # Seeded deterministic paired schedule generator
│   │   └── run_three_baselines.sh        # Runner for B1, B2, B3 baselines
│   └── experiments/
│       ├── baseline-profiles.json        # Cellular impairment profiles
│       ├── trial-matrix.json             # Protocol parameters
│       └── baseline_final_3runs/         # Baseline manifests and schedule definitions
│
├── 03_Baseline_Experiments/              # 60-minute baseline records (B1, B2, B3)
│   └── Ubuntu/                           # Ubuntu endpoint metrics, qdisc logs, and raw exports
│
├── 04_Adaptive_Experiments/              # Matched adaptive evaluation datasets
│   ├── W1_Final_0.92/                    # Window 1 results (0.92 factor)
│   ├── W2_Final_0.92/                    # Window 2 results (0.92 factor)
│   ├── W3_Final_0.92/                    # Window 3 results (0.92 factor)
│   └── W3_Mitigation_0.82/               # Window 3 stronger-reduction experiment (0.82 factor)
│
├── 05_W2_Ablation_and_Sensitivity/       # One-factor validation experiments on W2
│   ├── FPS-Ablation-W2/                  # W2 with FPS trigger disabled
│   ├── RTT-sensitivity-W2/               # W2 with 200 ms and 400 ms RTT thresholds
│   └── Results/                          # Consolidated CSV/JSON runs
│
├── 07_Complementary_Windows_Peer_Exports/# Complementary Windows receiver/caller exports
│   ├── Baseline_B1_B2_B3/                # Paired Windows baseline exports
│   └── Adaptive_And_Ablation/            # Paired Windows adaptive exports
│
├── 08_Analysis_Tools/                    # Post-processing and visualization
│   ├── analysis/
│   │   ├── analyze.py                    # Multi-run aggregation, summary tables, time-series plotting
│   │   ├── extract_raw_stats.py          # Flattens complete run JSON bundles into tabular CSVs
│   │   └── requirements.txt              # matplotlib, numpy, pandas
│   └── W3_Root_Cause/                    # Trace replay and root cause analysis
│
├── 09_Tests_and_Validation/              # Automated unit tests and IFB validation
│   ├── tests/
│   │   ├── adaptation-controller.test.js # Node.js unit tests for the controller state machine
│   │   └── test_experiment_planning.py   # Python unit tests for trial planning
│   └── results/validation/               # Bidirectional delay validation evidence
│
├── FILE_MANIFEST.json                    # Full archive file manifest with SHA-256 checksums
└── .gitattributes                        # Git LFS tracking rules for raw export bundles (>100MB)
```

---

## Installation and Quickstart

### Requirements

- **Node.js**: v18+ and `npm`
- **Browsers**: Recent Chrome/Chromium or Firefox with WebRTC support
- **Hardware**: Camera and microphone access
- **Python**: 3.9+ for analysis (`matplotlib`, `numpy`, `pandas`)
- **Linux**: `iproute2` (`tc`) for network emulation

### 1. Local Smoke Test (Two Tabs on Same Machine)

```bash
cd 01_Source_Code
npm install
npm test
npm start
```

1. Open `http://localhost:8080` in two tabs on the same machine.
2. Enter the same room ID in both tabs, join the room in both, allow camera/microphone access, then start the call from one participant. The other participant answers automatically.
3. Select **Baseline WebRTC** or **Adaptive controller** before starting logging. Set the target bitrate and sample interval, then click **Start logging**.
4. At the end, click **Stop logging** and **Download CSV** (or **Download Complete Run Bundle**). Settings are locked during a logging session. Each new baseline session removes an application `maxBitrate` cap so that native congestion control is not left under a cap from an earlier run.

### 2. Two-Computer Setup over Local HTTPS

Camera/microphone access on another computer requires a secure browser context. The server supports local HTTPS when both `certs/lan-cert.pem` and `certs/lan-key.pem` exist; the WebSocket signaling endpoint automatically uses WSS when the page is HTTPS.

On Computer A (the server), in PowerShell:
```powershell
# 1. Install mkcert
winget install FiloSottile.mkcert

# 2. Install local CA
mkcert -install

# 3. Create LAN certificate for Computer A's Wi-Fi IP (e.g., 192.168.1.25)
New-Item -ItemType Directory -Force .\01_Source_Code\certs | Out-Null
mkcert -cert-file .\01_Source_Code\certs\lan-cert.pem -key-file .\01_Source_Code\certs\lan-key.pem localhost 127.0.0.1 ::1 192.168.1.25

# 4. Start the server
npm start
```

On Computer B:
1. Copy `rootCA.pem` (from `mkcert -CAROOT` on Computer A) to Computer B through a trusted method.
2. Open PowerShell as Administrator and run:
   ```powershell
   certutil -addstore -f Root C:\path\to\rootCA.pem
   ```
3. Restart Chrome and navigate to `https://192.168.1.25:8080`. Verify the connection is secure and approve camera permissions.

### 3. Automated Browser Run Mode

The app supports URL-configured run startup and timed CSV/JSON export to reduce per-trial clicking. Open a URL of this form on both endpoints (use the same `room` and `runId`, but set each endpoint's `role` differently):

```text
https://YOUR-LAB-HOST:8080/?auto=1&room=trial-001&runId=trial-001-baseline-r1&role=caller&mode=baseline&duration=90&intervalMs=1000&targetKbps=900
https://YOUR-LAB-HOST:8080/?auto=1&room=trial-001&runId=trial-001-baseline-r1&role=answerer&mode=baseline&duration=90&intervalMs=1000&targetKbps=900
```

Supported query parameters:
- `auto=1`: Enables automated execution.
- `role=caller|answerer`: Caller creates offer; answerer waits and responds.
- `mode=baseline|adaptive`: Mode selection.
- `duration`: Duration in seconds (10–7200).
- `intervalMs`: Polling frequency (500–10000 ms).
- `runId`, `pairId`, `scheduleId`, `experimentId`: Experiment tracking metadata.

Both endpoints begin logging after their peer connection reaches `connected`, then stop and request downloads after the configured duration.

### 4. Linux Network Emulation (`tc netem`)

> **Important Network Impairment Topology:** Two tabs on the same computer do not establish a meaningful impairment experiment if media flows over loopback. Applying `tc netem` to an unrelated interface will not impair peer-to-peer media. Emulation must be applied to an interface/path that actually carries the WebRTC media packets.

Identify the egress interface:
```bash
ip route
ip -br link
tc qdisc show dev eth0
```

Apply impairment profile (`INTERFACE RATE DELAY JITTER LOSS`):
```bash
sudo ./02_Experimental_Design/scripts/netem_apply.sh eth0 5mbit 80ms 20ms 1%
```

Clear the test qdisc after each run:
```bash
sudo ./02_Experimental_Design/scripts/netem_clear.sh eth0
```

Execute dynamic schedules via IFB:
```bash
python3 02_Experimental_Design/scripts/run_ifb_schedule.py --interface eth0 --schedule 02_Experimental_Design/experiments/WebRTC_12min_schedules_v2/W2_B1_schedule_12min.csv
```

### 5. Offline Analysis & Stats Extraction

Install analysis dependencies:
```bash
pip install -r 08_Analysis_Tools/analysis/requirements.txt
```

Analyze CSV exports:
```bash
python 08_Analysis_Tools/analysis/analyze.py baseline.csv adaptive.csv --out 08_Analysis_Tools/analysis/output/summary.csv
```

Flatten complete raw `getStats()` JSON bundles:
```bash
python 08_Analysis_Tools/analysis/extract_raw_stats.py endpoint-complete-run.json --out 08_Analysis_Tools/analysis/output/raw-stats.csv
```

---

## CSV Field Interpretation

| Field | Meaning |
|---|---|
| `timestamp` | ISO-8601 UTC timestamp of the sample |
| `monotonicMs` | Browser `performance.now()` clock reference |
| `bitrate_kbps` | Measured outbound bitrate from $\Delta \text{bytesSent} / \Delta t$ |
| `fps` | Browser-reported outbound video encoder/stream frame rate |
| `width`, `height` | Browser-reported outbound video resolution dimensions |
| `rtt_ms` | Selected ICE candidate-pair RTT estimate |
| `jitter_ms` | Jitter reported for the local inbound video stream |
| `rtcpFractionLost_pct` | Remote receiver's RTCP-reported fraction lost converted to percent |
| `intervalPacketLoss_pct` | Blank unless a valid paired receiver counter calculation is implemented |
| `remotePacketsLost` | Remote receiver's reported cumulative loss counter, when available |
| `availableOutgoingBitrate_kbps` | Browser-reported outgoing bandwidth estimate, when available |
| `controllerTarget_kbps` | Target encoding bitrate selected by the heuristic |
| `maxBitrateParameterBeforeSet_kbps` | Sender `maxBitrate` parameter before the attempted update |
| `maxBitrateParameterAfterSet_kbps` | Sender parameter value after successful `setParameters()`, not actual measured bitrate |
| `setParametersApplied` | Whether the controller changed the parameter |
| `adaptationStatus` | Controller state (`NORMAL`, `ADAPTIVE`, `RECOVERY`) |
| `adaptationError` | Exception details if `setParameters()` threw an error |

---

## Testing & Verification

Run the test suite:

```bash
# 1. Controller unit tests (Node.js)
npm test

# 2. Syntax validation
node --check 01_Source_Code/public/adaptation-controller.js
node --check 01_Source_Code/public/app.js
node --check 01_Source_Code/server.js

# 3. Python syntax check
python -m py_compile 08_Analysis_Tools/analysis/*.py 02_Experimental_Design/scripts/*.py

# 4. Shell script syntax
bash -n 02_Experimental_Design/scripts/netem_apply.sh 02_Experimental_Design/scripts/netem_clear.sh
```

---

## Team Contributions (CS6048 Group 2)

- **CS25S019**: Contributed to the WebRTC testbed and peer-connection workflow; supported telemetry integration, baseline validation, and systematic testing of the conferencing application.
- **CS26E009 — Rathan Balaji P R**: Contributed to controller design and implementation, including persistent trigger logic and bitrate recovery; supported W2 ablation, sensitivity analysis, and interpretation of adaptation results.
- **CS22B080**: Contributed to network emulation and experiment orchestration; supported matched baseline/adaptive runs, W3 scenario analysis, result visualization, and report preparation.

---

## References

1. B. Jansen, T. Goodwin, V. Gupta, F. Kuipers, and G. Zussman, *"Performance Evaluation of WebRTC-based Video Conferencing,"* ACM SIGMETRICS Performance Evaluation Review, vol. 45, no. 3, pp. 56–68, 2017. [doi:10.1145/3199524.3199534](https://doi.org/10.1145/3199524.3199534).
2. G. Bingöl, S. Porcu, A. Floris, and L. Atzori, *"WebRTC-QoE: A dataset of QoE assessment of subjective scores, network impairments, and facial & speech features,"* Computer Networks, vol. 244, art. 110356, 2024. [doi:10.1016/j.comnet.2024.110356](https://doi.org/10.1016/j.comnet.2024.110356).
3. F. Yi, H. Wan, K. Jamieson, and O. Michel, *"Automated, Cross-Layer Root Cause Analysis of 5G Video-Conferencing Quality Degradation,"* in *Proc. ACM Internet Measurement Conference (IMC)*, 2025. [doi:10.1145/3730567.3764434](https://doi.org/10.1145/3730567.3764434).
4. W3C, *"WebRTC: Real-Time Communication in Browsers,"* W3C Recommendation, `RTCRtpSender.setParameters()` and `RTCRtpEncodingParameters.maxBitrate`.
5. W3C, *"Identifiers for WebRTC’s Statistics API,"* WebRTC-Stats specification.
