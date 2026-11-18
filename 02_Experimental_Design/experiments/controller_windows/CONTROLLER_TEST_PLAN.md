# Short-window adaptive-controller experiment plan

## Purpose

Use the three preselected 12-minute schedule windows for controller development and matched baseline/adaptive screening. These are short development/validation experiments, not substitutes for independent final confirmation trials.

## Controller behavior in this build

- Native WebRTC congestion control (GCC) remains enabled throughout.
- The application controller only requests an encoder `maxBitrate` cap through `RTCRtpSender.setParameters()`; it does not read or directly control GCC's internal bandwidth estimate.
- No fixed user-entered target bitrate is used.
- Degradation triggers: RTT >= 250 ms, RTCP-reported loss >= 1%, FPS < 20, or measured outgoing bitrate exceeding the available-outgoing-bitrate estimate by at least 20%.
- Three consecutive degradation samples are required before intervention.
- The requested cap is derived from the current available-bitrate estimate (or measured sending bitrate when the estimate is unavailable), reduced by 15%, with a 150 kbps floor. An existing sender maxBitrate is treated as an upper bound.
- Recovery requires five consecutive healthy samples before a gradual 20% increase; after ten consecutive healthy samples the original sender maxBitrate configuration is restored.
- Missing metrics are not treated as zero or as proof of recovery.
- The original sender maxBitrate setting is restored when adaptive logging stops or the call is hung up.

These are initial controller parameters for screening. They must be reported as implementation settings, not as proven optimal thresholds.

## Schedule windows

| Window | Source baseline schedule | Original elapsed interval | Cropped duration |
|---|---|---:|---:|
| W1 | B3 | 360–1080 s | 720 s |
| W2 | B1 | 1794–2514 s | 720 s |
| W3 | B2 | 2457–3177 s | 720 s |

Each cropped CSV is rebased to start at 0 and preserves the original segment sequence and clipped durations. After the 720-second runner finishes, it removes its IFB shaping; keep browser telemetry running for another 180 seconds to record normal-network recovery.

## Safe execution rules

1. Run only on the Ubuntu endpoint using the existing `run_ifb_schedule.py` IFB runner.
2. Keep the original physical interface root qdisc unchanged. The runner checks the expected `mq`/`fq_codel` layout and refuses to proceed otherwise.
3. Do not run `run_randomized_baseline.py` or the veth-only test runner for these Ubuntu–Windows experiments.
4. Before any live run, confirm the Windows peer is connected and the Ubuntu browser reports `connectionState=connected`.
5. Use the same schedule file for the matched baseline and adaptive trial. Change only the browser mode.
6. Use a fresh browser page/peer connection for each trial and a distinct run ID. Keep camera, resolution, room, sample interval, and endpoint roles unchanged across the matched pair.
7. Start browser telemetry and the schedule runner as close together as practical; record their UTC start times and network event log.
8. Run browser telemetry for 900 seconds. The network runner shapes for 720 seconds and cleans up; the final 180 seconds are recovery.
9. Use `try/finally` behavior in the runner; if interrupted, verify `ifb-in`, `ifb-out`, and `clsact` are removed and confirm the physical interface root qdisc remains intact.
10. Do not interpret a 12-minute tuning result as final evidence. Choose a controller configuration on W1, then evaluate unchanged on W2/W3.

## Dry-run command

From the project root:

```bash
python3 scripts/run_ifb_schedule.py \
  --schedule experiments/controller_windows/schedules/W1_B3_schedule_12min.csv \
  --config experiments/baseline-profiles.json \
  --out-dir experiments/controller_windows/dryrun_W1 \
  --dry-run
```

Repeat with `W2_B1_schedule_12min.csv` and `W3_B2_schedule_12min.csv` before live execution.

## Browser logging

Use the existing app auto-run parameters with `duration=900`, `intervalMs=1000`, and `mode=baseline` or `mode=adaptive`. The obsolete `targetKbps` parameter is no longer used. Keep the peer connection established before starting the schedule. Export normalized CSV, raw getStats, browser API snapshots, event log, and complete run bundle for every trial.

## Analysis

Compare matched runs using actual measured bitrate, RTT, RTCP loss feedback, FPS, resolution, freeze increments/duration, and recovery behavior. Report controller actions and intervention duty cycle separately. Network profile names and configured impairment values are experimental inputs, not performance outcomes. Do not claim improvement unless the matched measurements support it.
