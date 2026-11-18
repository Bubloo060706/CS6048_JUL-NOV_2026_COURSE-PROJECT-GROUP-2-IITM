# Randomized WebRTC baseline experiment starter

This is a **pilot automation layer** for the existing HTTPS-ready WebRTC project. It does not change the WebRTC application or enable the application-level adaptation controller. The browser must use `mode=baseline`; native browser WebRTC/GCC remains enabled.

## Important scope and safety

- The script below creates a reproducible randomized schedule and can apply its `tc netem` profiles on a Linux endpoint.
- It does **not** remotely launch Chrome on two computers. The app's existing `auto=1` URL mode starts the call/logging after the peers connect and requests CSV downloads after the timer. Camera/microphone permissions must already be granted.
- `tc netem` affects **egress only**. Apply it only on a verified interface that carries WebRTC media packets, not merely the signaling server interface.
- Live application is fail-closed and restricted to a disposable veth whose root qdisc is default `noqueue`. The script refuses physical/Wi-Fi interfaces and existing qdisc trees because arbitrary qdisc hierarchies cannot be reconstructed safely from textual output.
- Start with the 10-minute pilot. Do not begin seven-hour runs until the end-to-end pipeline, actual media path, logging, profile transitions, and cleanup have been verified.
- The profiles are illustrative pilot profiles, not a validated cellular-network model. Randomization is reproducible via a seed.

## Files

- `scripts/run_randomized_baseline.py`: dry-run by default; optional `tc` schedule execution.
- `experiments/baseline-profiles.json`: pilot profiles and random persistence range.
- `results/`: generated schedule, manifest, and event log are saved here when run.

## 1. Set up the two endpoints

Use two separate computers on the lab network. Run the existing HTTPS-ready project on the signaling host as documented in its README. Open the app on both computers using the trusted HTTPS URL, use the same room, allow camera/microphone, and confirm the call connects with video flowing in both directions.

Choose one endpoint to shape **its outgoing media path**. On that Linux endpoint, inspect:

```bash
ip route
ip -br link
ip route get <OTHER_ENDPOINT_IP>
tc qdisc show dev <VERIFIED_INTERFACE>
```

Do not guess the interface. Confirm the ICE candidate pair in the app's CSV/browser stats if available and verify that the route and interface carry media packets. If both directions need impairment, shape both directions deliberately in a separately designed topology; this starter only shapes one egress interface.

## 2. Generate and inspect a randomized 10-minute schedule (no network changes)

From the project root on the Linux shaping endpoint:

```bash
python3 scripts/run_randomized_baseline.py --seed 4102026 --run-id baseline-pilot-01
```

This is a dry run. Inspect the printed schedule and the generated CSV/JSON in `results/baseline/`. The schedule begins with 30 seconds of control, randomizes profile order and each profile's persistence (nominally 20–70 seconds), and ends with 30 seconds of control. Profiles are coherent combinations, not independently randomized parameter values at every step.

Use a unique `--run-id` for each browser run. Use a different seed for each independent randomized run. Keep all manifests and raw endpoint CSVs.

## 3. Prepare both browser URLs

Use the same `room` and `runId` on both endpoints, but different `role` values. Example for the 10-minute pilot (replace the host and ID):

```text
https://YOUR-LAB-HOST/?auto=1&room=baseline-room-01&runId=baseline-pilot-01&role=caller&mode=baseline&duration=600&intervalMs=1000&targetKbps=900
https://YOUR-LAB-HOST/?auto=1&room=baseline-room-01&runId=baseline-pilot-01&role=answerer&mode=baseline&duration=600&intervalMs=1000&targetKbps=900
```

Open the answerer URL first, then the caller URL. Approve any browser device permissions. Confirm the call is connected and both endpoints show logging has started. Baseline mode removes the application's sender `maxBitrate` cap; it does not disable native GCC.

The browser's 600-second timer begins when its peer connection reaches `connected`; the netem script's clock begins when you start it. For a pilot, start the script immediately after both endpoints report the automated run has started and record the small timing offset. For publication-quality experiments, this synchronization should later be automated or explicitly aligned in the event log.

## 4. Inspect and then apply the schedule

Before applying, record and inspect the current qdisc configuration. Confirm the interface is safe to modify and the media path is correct. Then run with explicit acknowledgements:

```bash
sudo python3 scripts/run_randomized_baseline.py \
  --interface <VERIFIED_INTERFACE> \
  --seed 4102026 \
  --run-id baseline-pilot-01 \
  --duration-seconds 600 \
  --apply \
  --confirm-dedicated-veth
```

The runner writes:

- `*-schedule.csv`: planned profile sequence and relative timings;
- `*-manifest.json`: seed, profiles, run ID, planned schedule and run metadata;
- `*-events.jsonl`: wall-clock timestamps, actual elapsed time, commands and `tc qdisc show` output at transitions.

The runner attempts to remove only the netem qdisc it installed on the disposable veth. **Verify cleanup manually** with `tc qdisc show dev <VERIFIED_VETH>`. Do not use it on the actual Ubuntu `eno1` interface or any physical/Wi-Fi/SSH-dependent interface.

## 5. Preserve both endpoint CSVs

The app requests a CSV download on each endpoint after 600 seconds. Browser settings may block automatic downloads, so verify both files exist. Rename/copy them without modifying their contents, e.g.:

- `baseline-pilot-01-caller.csv`
- `baseline-pilot-01-answerer.csv`

Keep sender-side and receiver-side CSVs separate. Add notes for browser version, OS, camera, endpoint role, interface, route, start time, any permission/reconnection events, and whether the `tc` transitions were verified.

## 6. What this pilot can and cannot establish

This pilot tests the end-to-end machinery and provides exploratory traces. It does **not** establish statistically that GCC is slow/cautious. To support that hypothesis, repeat randomized runs with independent seeds and quantify response/recovery times against predeclared operational definitions. Standard browser stats do not necessarily expose an authoritative internal GCC state; do not invent a state label. Use observable fields such as `availableOutgoingBitrate_kbps`, `bitrate_kbps`, `rtt_ms`, loss reports, FPS and resolution, and explicitly label them as indicators.

The `delay_correlation_percent` field configures correlation of successive delay variations in `tc netem`; it is not packet-loss correlation. Configured one-way egress delay is not the same as measured RTT.


## Updated telemetry and paired schedule workflow (v2)

The browser now preserves the complete available `getStats()` report as timestamped JSONL snapshots, in addition to normalized CSV metrics. It also records sender parameters, peer-connection state/configuration, media-track settings/constraints/capabilities, and event logs. Each endpoint should export its own complete run JSON bundle. Missing/unsupported fields are omitted, not converted to zero.

Use `scripts/generate_paired_schedules.py` to generate immutable schedules and a paired run plan. Both the baseline and adaptive run for a pair must use the exact same `schedule_csv` file. Pass that file to `scripts/run_randomized_baseline.py --schedule-file ...` when validating the replay path. Include the `runId`, `pairId`, `scheduleId`, and `experimentId` query parameters in the browser URL so the endpoint bundle can be associated with the run plan.

The network impairment runner is now fail-closed. Live application is restricted to a disposable veth whose root qdisc is the default `noqueue`; it refuses physical, Wi-Fi, SSH-dependent, `mq`, or `fq_codel` interfaces. This is intentional: a generic qdisc tree cannot be reconstructed safely from `tc qdisc show`. Do not use it on the previously observed Ubuntu `eno1` interface. A separate topology-specific solution is required before shaping the actual media path.

The Python analysis now generates synchronized vertically stacked plots per run and derives limited objective indicators such as frame-drop ratio and freeze-duration ratio when the required fields exist. These are telemetry-derived indicators, not subjective QoE scores.
