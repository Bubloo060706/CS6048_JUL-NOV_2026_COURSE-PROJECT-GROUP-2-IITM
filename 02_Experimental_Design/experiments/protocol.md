# Controlled WebRTC adaptation experiment protocol

## Research question

Under matched, reproducible network conditions, does the endpoint-side `maxBitrate` heuristic change sender behavior relative to browser-native WebRTC congestion control, and what are the trade-offs in bitrate, frame rate, RTT, receiver-reported loss, and recovery?

## Experimental unit and comparison

- Experimental unit: one connected sender/receiver pair for one fixed mode and one network-condition schedule.
- Comparison: `baseline` (application `maxBitrate` removed) versus `adaptive` (heuristic enabled), matched by profile, duration, sender machine, receiver machine, browser build, camera, scene, resolution constraints, sample interval, and room/network topology.
- Minimum repetitions: 3 paired repetitions per profile. Randomize the mode order within each repetition using the generated trial plan. Treat repeated samples within one CSV as time-series observations, not independent experimental replicates.
- Primary metrics: mean/median measured outbound bitrate; mean/median FPS; receiver-reported RTCP loss fraction where available; selected candidate-pair RTT; inbound jitter; adaptation action count; time to recover after impairment ends.
- Secondary metrics: time below a predeclared bitrate/capacity threshold, resolution changes, `setParameters` rejection rate, connected-sample percentage, and valid-sample coverage.

## Topology and validity checks

1. Use two separate machines when testing a network interface impairment. A same-machine two-tab run is only a software smoke test.
2. The signaling WebSocket server is not the media relay. WebRTC media normally follows the negotiated ICE candidate pair, often peer-to-peer.
3. Record each endpoint's interface, route, browser/version, OS, local/remote endpoint role, ICE candidate-pair type/addresses when available, and the exact `tc qdisc show` output before/during/after each phase. Do not publish public IP addresses in reports.
4. Apply egress shaping to an interface that actually carries sender media packets. For bidirectional impairment, control both directions deliberately; do not assume a single egress qdisc affects both.
5. Ensure the camera scene and other network activity remain stable. Disable unrelated downloads, VPN route changes, and background conferencing where possible.
6. Preserve raw CSV files unchanged. Each endpoint writes its own outgoing-stream measurements; do not merge the two endpoints as if they measured the same stream.

## Trial schedule

Recommended initial protocol: 15 s stable warm-up, 60 s impaired condition, 30 s recovery/unimpaired phase (105 s total). Use the same schedule for baseline and adaptive. If testing persistent conditions, run a separate fixed-condition schedule with a 15 s warm-up followed by 90 s impairment and no recovery phase. Run the initial unimpeded baseline/adaptive smoke test before any impaired experiment.

Suggested profiles for pilot tuning (not claims about a real cellular network):

- `control`: no injected impairment.
- `moderate`: 2 Mbit/s egress rate, 80 ms added delay, 20 ms jitter, 1% loss.
- `severe`: 800 kbit/s egress rate, 150 ms added delay, 40 ms jitter, 3% loss.

The exact profile must be chosen based on the actual interface, path, and research question, then held constant across matched runs. `netem` delay is one-way added egress delay; measured RTT reflects both directions and the network path.

## Invalid-run criteria (predeclare and apply consistently)

Mark a run invalid or rerun it if any of the following occurs: peer connection never reaches `connected`; media is not flowing; fewer than 80% of planned samples are recorded; the impairment is not confirmed on the media path; the browser tab reloads/crashes; device/browser settings differ from the matched pair; a qdisc command fails; or the run has a material unrelated network event. Never silently discard a bad run—record the reason and retain the raw files.

## Interpretation safeguards

- `maxBitrate` is a requested sender encoding cap, not a hard promise that every short bytes-sent sample stays below it.
- The app's `bitrate_kbps` is an interval estimate from `bytesSent` deltas; first samples and counter resets should be blank, and sample windows can include packetization/overhead and timing effects.
- `availableOutgoingBitrate_kbps` is a browser estimate, not ground-truth link capacity.
- `rtcpFractionLost_pct` is a remote-inbound RTCP report, not a locally computed interval loss percentage. `remotePacketsLost` is cumulative and should not be compared as a percentage.
- RTT is round-trip time, not one-way latency. Inbound jitter is browser-reported jitter, not a direct measurement of user-perceived quality.
- This prototype does not directly measure freeze duration, glass-to-glass latency, MOS, or one-way delay. Do not claim those outcomes without additional instrumentation.
- Report per-run values and paired differences, uncertainty (e.g. confidence intervals across independent repetitions), valid sample counts, and all exclusions. Avoid significance claims with only three repetitions; treat three as pilot evidence.

## Required deliverables per run

- Raw CSV from each endpoint.
- Unique run ID and trial-plan row.
- Start/end timestamps, planned/actual duration, mode, endpoint role, browser/version, OS, camera/resolution, room ID (non-sensitive alias), target bitrate, sample interval.
- Interface and direction, qdisc before/during/after, exact impairment commands, candidate-pair/path evidence, and anomalies.
- A machine-readable run manifest and generated analysis summary.
