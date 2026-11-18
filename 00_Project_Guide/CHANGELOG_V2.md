# WebRTC experiment bundle — v2 changes

## Implemented
- Preserve full available `RTCPeerConnection.getStats()` reports as timestamped JSON snapshots in each browser session.
- Capture browser/API snapshots: peer connection state/configuration, sender parameters, media track settings, constraints and capabilities, plus `navigator.connection` fields when available.
- Capture connection/ICE/signalling and adaptation application/rejection events.
- Export normalized metrics CSV, raw getStats JSONL, API snapshot JSONL, event JSONL, and a complete per-endpoint JSON bundle.
- Add receiver-side video counters to normalized telemetry where the browser exposes them: frames received/decoded/dropped, freezes, jitter-buffer counters and inbound packet counters.
- Add run/pair/schedule/experiment identifiers to browser URL configuration and normalized rows.
- Add immutable randomized schedule generation with matched baseline/adaptive run plans; both modes reference the same schedule file.
- Add schedule replay support to the network schedule runner.
- Make impairment scripts fail closed unless used on a disposable veth with a default noqueue root. Existing arbitrary qdisc trees are not modified because they cannot be reliably restored from `tc qdisc show` output.
- Extend offline analysis with additional telemetry metrics, standard deviation, derived frame-drop/freeze indicators when available, synchronized stacked per-run plots and cross-file comparison plots.
- Add `analysis/extract_raw_stats.py` to flatten complete raw getStats snapshots into report-type/report-ID-prefixed CSV columns for offline inspection.
- Add automated tests for paired schedule generation and deterministic schedule generation.

## Explicit limitations
- Browser APIs expose different stats depending on browser/version/codec/device; missing values remain missing.
- RTT is selected ICE candidate-pair RTT, not one-way latency.
- `remote-inbound-rtp.fractionLost` and cumulative packet counters are not interval packet-loss percentages.
- The browser does not expose all internal GCC states.
- A complete raw report is collected at the configured sampling interval; the sampling rate should be kept low enough to avoid excessive measurement overhead.
- The current qdisc runner only safely operates on a disposable veth. It is not yet the final impairment mechanism for the physical Windows/Ubuntu media path. A topology-specific, validated impairment path is still required.
- The browser app exports each endpoint's data separately. Both endpoint bundles must be retained and joined by run/pair/schedule IDs during offline analysis.
- No real two-machine network experiment was executed during this code update; tests validate code, planning, parsing and dry-run behaviour only.
