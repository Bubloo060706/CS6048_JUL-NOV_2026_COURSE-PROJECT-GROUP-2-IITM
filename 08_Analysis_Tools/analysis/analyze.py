#!/usr/bin/env python3
"""Summarize and plot one or more WebRTC experiment CSV files."""

import argparse
import json
from pathlib import Path
import sys

import pandas as pd

METRICS = [
    "bitrate_kbps",
    "fps",
    "width",
    "height",
    "remotePacketsLost",
    "rtcpFractionLost_pct",
    "intervalPacketsLost",
    "intervalPacketLoss_pct",
    "setParametersApplied",
    "jitter_ms",
    "rtt_ms",
    "availableOutgoingBitrate_kbps",
    "configuredTarget_kbps",
    "controllerTarget_kbps",
    "maxBitrateParameterAfterSet_kbps",
    "adaptationActions",
    "framesEncoded", "framesSent", "framesReceived", "framesDecoded", "framesDropped",
    "freezeCount", "totalFreezesDuration_s", "jitterBufferDelay_s",
    "jitterBufferEmittedCount", "inboundBytesReceived", "inboundPacketsReceived",
    "inboundPacketsLost", "retransmittedPacketsSent",
]
PLOT_METRICS = ["bitrate_kbps", "availableOutgoingBitrate_kbps", "fps", "width", "height", "rtt_ms", "jitter_ms", "rtcpFractionLost_pct", "framesDecoded", "framesDropped", "freezeCount", "totalFreezesDuration_s"]


def load_csv(filename: str) -> pd.DataFrame:
    path = Path(filename)
    if not path.is_file():
        raise FileNotFoundError(f"CSV file not found: {path}")
    frame = pd.read_csv(path)
    if frame.empty:
        raise ValueError(f"CSV contains no data rows: {path}")
    if "mode" not in frame.columns:
        frame["mode"] = path.stem
    # Backward compatibility for earlier exports. The old interval-loss
    # column was incorrectly populated from the RTCP fraction, so invalidate
    # it rather than treating it as a true counter-derived interval metric.
    if "rtcpFractionLost_pct" not in frame.columns and "fractionLost_pct" in frame.columns:
        frame["rtcpFractionLost_pct"] = pd.to_numeric(frame["fractionLost_pct"], errors="coerce")
        if "intervalPacketLoss_pct" in frame.columns:
            frame["intervalPacketLoss_pct"] = pd.NA
    if "remotePacketsLost" not in frame.columns and "packetsLost" in frame.columns:
        frame["remotePacketsLost"] = pd.to_numeric(frame["packetsLost"], errors="coerce")
    if "maxBitrateParameterAfterSet_kbps" not in frame.columns and "appliedMaxBitrate_kbps" in frame.columns:
        frame["maxBitrateParameterAfterSet_kbps"] = pd.to_numeric(frame["appliedMaxBitrate_kbps"], errors="coerce")

    # Derived QoE indicators. These are objective browser telemetry indicators,
    # not subjective MOS or a claim of perceived user quality.
    if "totalFreezesDuration_s" in frame.columns and "timestamp" in frame.columns:
        times = pd.to_datetime(frame["timestamp"], errors="coerce", utc=True)
        duration = (times.max() - times.min()).total_seconds() if times.notna().sum() >= 2 else None
        freeze_total = pd.to_numeric(frame["totalFreezesDuration_s"], errors="coerce").dropna()
        freeze_delta = float(freeze_total.max() - freeze_total.min()) if not freeze_total.empty else None
        frame["freeze_duration_ratio_pct"] = (
            (freeze_delta / duration) * 100
            if duration and duration > 0 and freeze_delta is not None else pd.NA
        )
    if "framesDropped" in frame.columns and "framesDecoded" in frame.columns:
        dropped = pd.to_numeric(frame["framesDropped"], errors="coerce")
        decoded = pd.to_numeric(frame["framesDecoded"], errors="coerce")
        denom = dropped + decoded
        frame["frame_drop_ratio_pct"] = (dropped / denom * 100).where(denom > 0)
    frame["source_file"] = path.name
    if "timestamp" in frame.columns:
        frame["timestamp"] = pd.to_datetime(frame["timestamp"], errors="coerce", utc=True)
    for metric in METRICS + ["freeze_duration_ratio_pct", "frame_drop_ratio_pct"]:
        if metric in frame.columns:
            frame[metric] = pd.to_numeric(frame[metric], errors="coerce")
    return frame


def summarize_group(group: pd.DataFrame) -> dict:
    result = {"rows": int(len(group))}
    if "timestamp" in group.columns:
        valid_times = group["timestamp"].dropna()
        result["duration_seconds"] = (
            round((valid_times.max() - valid_times.min()).total_seconds(), 3)
            if len(valid_times) >= 2
            else None
        )
    if "connectionState" in group.columns:
        states = group["connectionState"].dropna()
        result["connected_pct"] = round(float((states == "connected").mean() * 100), 3) if len(states) else None

    for metric in METRICS:
        if metric not in group.columns:
            continue
        values = group[metric].dropna()
        result[f"{metric}_valid_samples"] = int(values.size)
        for stat in ("mean", "median", "min", "max", "std"):
            result[f"{metric}_{stat}"] = round(float(getattr(values, stat)()), 4) if values.size else None
    return result


def save_plots(data: pd.DataFrame, output_path: Path, events: pd.DataFrame | None = None) -> None:
    try:
        import matplotlib.pyplot as plt
    except ImportError:
        print("matplotlib is not installed; skipping plots.")
        return

    available = [m for m in PLOT_METRICS if m in data.columns and data[m].notna().any()]
    if not available:
        print("No plottable telemetry metrics found.")
        return
    # One vertically stacked, shared-time-axis figure per source file. This is
    # useful for inspecting synchronized metric changes within an individual run.
    for source, group in data.groupby("source_file", sort=False):
        group = group.copy()
        if "timestamp" in group.columns:
            group = group.sort_values("timestamp")
            x = (group["timestamp"] - group["timestamp"].dropna().min()).dt.total_seconds()
            x_label = "Elapsed time (s)"
        else:
            x = range(len(group))
            x_label = "Sample"
        fig, axes = plt.subplots(len(available), 1, figsize=(12, max(2.2 * len(available), 5)), sharex=True)
        if len(available) == 1:
            axes = [axes]
        for axis, metric in zip(axes, available):
            axis.plot(x, group[metric], linewidth=1.0)
            axis.set_ylabel(metric.replace("_", " "))
            axis.grid(True, alpha=0.25)
            if events is not None and not events.empty and "timestamp" in events.columns and "timestamp" in group.columns:
                valid_start = group["timestamp"].dropna().min()
                valid_end = group["timestamp"].dropna().max()
                for _, event in events.iterrows():
                    event_time = event.get("timestamp")
                    if pd.notna(event_time) and valid_start <= event_time <= valid_end:
                        event_x = (event_time - valid_start).total_seconds()
                        axis.axvline(event_x, linestyle="--", linewidth=0.7, alpha=0.55)
        axes[-1].set_xlabel(x_label)
        fig.suptitle(f"Synchronized WebRTC telemetry — {source}")
        fig.tight_layout()
        plot_path = output_path.with_name(f"{output_path.stem}_{Path(source).stem}_stacked.png")
        fig.savefig(plot_path, dpi=150)
        plt.close(fig)
        print(f"Saved synchronized plot: {plot_path}")

    # Preserve the earlier cross-file per-metric comparison plots as well.
    for metric in ["bitrate_kbps", "fps", "rtt_ms", "jitter_ms", "rtcpFractionLost_pct"]:
        if metric not in data.columns or data[metric].notna().sum() == 0:
            continue
        fig, axis = plt.subplots(figsize=(10, 4))
        for source, group in data.groupby("source_file", sort=False):
            group = group.sort_values("timestamp") if "timestamp" in group.columns else group
            x_values = group["timestamp"] if "timestamp" in group.columns else range(len(group))
            axis.plot(x_values, group[metric], label=source, linewidth=1.1)
        axis.set_title(metric.replace("_", " ").title())
        axis.set_xlabel("Timestamp (UTC)" if "timestamp" in data.columns else "Sample")
        axis.set_ylabel(metric)
        axis.legend()
        axis.grid(True, alpha=0.25)
        fig.tight_layout()
        plot_path = output_path.with_name(f"{output_path.stem}_{metric}_comparison.png")
        fig.savefig(plot_path, dpi=150)
        plt.close(fig)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("csv", nargs="+", help="One or more downloaded CSV logs")
    parser.add_argument("--out", default="summary.csv", help="Output summary CSV")
    parser.add_argument("--no-plots", action="store_true", help="Do not generate time-series plots")
    parser.add_argument("--events", nargs="*", default=[], help="Optional network/browser event JSONL files for vertical event markers")
    args = parser.parse_args()

    try:
        frames = [load_csv(name) for name in args.csv]
        data = pd.concat(frames, ignore_index=True)
    except (OSError, ValueError, pd.errors.ParserError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 2

    summary_rows = []
    for (source, mode), group in data.groupby(["source_file", "mode"], dropna=False, sort=False):
        row = {"source_file": source, "mode": mode}
        row.update(summarize_group(group))
        summary_rows.append(row)
    summary = pd.DataFrame(summary_rows)

    output_path = Path(args.out)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    summary.to_csv(output_path, index=False)
    print(summary.to_string(index=False))
    print(f"\nSaved summary to {output_path}")

    events = None
    if args.events:
        event_rows = []
        for event_file in args.events:
            event_path = Path(event_file)
            if not event_path.is_file():
                print(f"Warning: event file not found: {event_path}", file=sys.stderr)
                continue
            with event_path.open(encoding="utf-8") as handle:
                for line in handle:
                    try:
                        item = json.loads(line)
                        if "timestamp" not in item and "utc" in item:
                            item["timestamp"] = item["utc"]
                        event_rows.append(item)
                    except json.JSONDecodeError:
                        print(f"Warning: skipped malformed event line in {event_path}", file=sys.stderr)
        if event_rows:
            events = pd.DataFrame(event_rows)
            if "timestamp" in events.columns:
                events["timestamp"] = pd.to_datetime(events["timestamp"], errors="coerce", utc=True)
    if not args.no_plots:
        save_plots(data, output_path, events)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
