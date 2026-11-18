#!/usr/bin/env python3
"""Create and optionally execute a reproducible randomized tc-netem baseline schedule.

Safe by default: without --apply this only creates/prints the schedule. Live application
is restricted to a disposable veth with a default noqueue root qdisc because arbitrary
existing qdisc trees cannot be restored safely. Never use on physical/Wi-Fi/SSH interfaces.
"""
from __future__ import annotations
import argparse, csv, json, os, random, shlex, subprocess, sys, time
from datetime import datetime, timezone
from pathlib import Path


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def build_schedule(cfg, seed, duration):
    rng = random.Random(seed)
    warm = int(cfg["warmup_seconds"])
    recovery = int(cfg["recovery_seconds"])
    min_d = int(cfg["min_condition_seconds"])
    max_d = int(cfg["max_condition_seconds"])
    if duration <= warm + recovery:
        raise ValueError("duration must exceed warmup + recovery")
    remaining = duration - warm - recovery
    profiles = [p for p in cfg["profiles"] if p != "control"]
    rows = []
    t = 0
    rows.append({"phase":"warmup", "profile":"control", "start_s":t, "duration_s":warm})
    t += warm
    previous = None
    while remaining > 0:
        candidates = [p for p in profiles if p != previous] or profiles
        p = rng.choice(candidates)

        if remaining <= max_d:
            d = remaining
        else:
            d = rng.randint(min_d, max_d)
            if 0 < remaining - d < min_d:
                d = remaining - min_d

        if not min_d <= d <= max_d:
            raise ValueError(f"Invalid randomized segment duration: {d}s")

        rows.append({"phase":"randomized", "profile":p, "start_s":t, "duration_s":d})
        t += d
        remaining -= d
        previous = p
    rows.append({"phase":"recovery", "profile":"control", "start_s":t, "duration_s":recovery})
    t += recovery
    if t != duration:
        raise AssertionError(f"schedule duration mismatch: {t} != {duration}")
    return rows


def qdisc_args(iface, profile):
    args = ["tc", "qdisc", "replace", "dev", iface, "root", "handle", "1:", "netem"]
    delay = float(profile.get("delay_ms", 0))
    jitter = float(profile.get("jitter_ms", 0))
    corr = float(profile.get("delay_correlation_percent", 0))
    loss = float(profile.get("loss_percent", 0))
    if delay > 0 or jitter > 0:
        args += ["delay", f"{delay:g}ms"]
        if jitter > 0:
            args += [f"{jitter:g}ms", f"{corr:g}%"]
    if loss > 0:
        args += ["loss", f"{loss:g}%"]
    rate = profile.get("rate")
    if rate:
        args += ["rate", str(rate)]
    if len(args) == 9:  # netem with no impairment options: explicit zero delay for control
        args += ["delay", "0ms"]
    return args


def run(args, check=True, capture=False):
    print("$", shlex.join(args), flush=True)
    return subprocess.run(args, check=check, text=True, capture_output=capture)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--config", default="experiments/baseline-profiles.json")
    ap.add_argument("--interface", help="verified egress interface carrying media packets")
    ap.add_argument("--duration-seconds", type=int, default=None)
    ap.add_argument("--seed", type=int, default=None)
    ap.add_argument("--run-id", default=None, help="optional ID to match the browser URL runId")
    ap.add_argument("--schedule-file", help="replay an existing immutable schedule CSV (same file for matched baseline/adaptation runs)")
    ap.add_argument("--mode", choices=["baseline", "adaptive"], default="baseline")
    ap.add_argument("--pair-id", default="", help="matched baseline/adaptation pair identifier")
    ap.add_argument("--confirm-dedicated-veth", action="store_true", help="confirm the interface is a disposable dedicated veth with a noqueue root qdisc")
    ap.add_argument("--out-dir", default="results/baseline")
    ap.add_argument("--apply", action="store_true", help="actually execute tc changes; default is dry-run")
    args = ap.parse_args()

    cfg_path = Path(args.config)
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    duration = args.duration_seconds or int(cfg["pilot_duration_seconds"])
    seed = args.seed if args.seed is not None else random.SystemRandom().randrange(1, 2**31)
    if args.schedule_file:
        with Path(args.schedule_file).open(newline="", encoding="utf-8") as sf:
            schedule = list(csv.DictReader(sf))
        required = {"phase", "profile", "start_s", "duration_s"}
        if not schedule or not required.issubset(schedule[0]):
            ap.error("schedule CSV must contain phase, profile, start_s, duration_s")
        schedule = [{"phase": r["phase"], "profile": r["profile"], "start_s": int(r["start_s"]), "duration_s": int(r["duration_s"])} for r in schedule]
        expected_start = 0
        for row in schedule:
            if row["profile"] not in cfg["profiles"] or row["start_s"] != expected_start or row["duration_s"] <= 0:
                ap.error("schedule has unknown profile, non-contiguous start times, or non-positive duration")
            expected_start += row["duration_s"]
        duration = expected_start
    else:
        schedule = build_schedule(cfg, seed, duration)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    run_id = args.run_id or f"baseline-{stamp}-seed{seed}"
    schedule_path = out_dir / f"{run_id}-schedule.csv"
    manifest_path = out_dir / f"{run_id}-manifest.json"
    events_path = out_dir / f"{run_id}-events.jsonl"
    with schedule_path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["phase", "profile", "start_s", "duration_s"])
        w.writeheader(); w.writerows(schedule)
    manifest = {
        "run_id": run_id, "pair_id": args.pair_id, "study": cfg.get("study"), "mode": args.mode,
        "created_utc": utc_now(), "seed": seed, "planned_duration_seconds": duration,
        "sample_interval_ms": cfg.get("sample_interval_ms"), "interface": args.interface,
        "apply_requested": args.apply, "schedule_file": str(schedule_path),
        "events_file": str(events_path), "config_file": str(cfg_path),
        "profiles": cfg["profiles"], "schedule": schedule,
        "replayed_schedule_file": str(Path(args.schedule_file).resolve()) if args.schedule_file else None,
        "warning": "tc netem is egress-only; confirm media path and direction independently."
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Run ID: {run_id}\nSeed: {seed}\nDuration: {duration}s\nSchedule: {schedule_path}\nManifest: {manifest_path}")
    for row in schedule:
        print(f"{row['start_s']:>4}s +{row['duration_s']:>3}s  {row['phase']:<10} {row['profile']}")

    if not args.apply:
        print("DRY RUN ONLY: no network settings were changed.")
        print("Live application is fail-closed: it requires a disposable veth whose root qdisc is default noqueue.")
        print("Do not apply to physical, Wi-Fi, SSH-dependent, mq, or fq_codel interfaces.")
        return 0
    if not args.interface:
        ap.error("--interface is required with --apply")
    if not args.confirm_dedicated_veth:
        ap.error("Live application is restricted to a disposable dedicated veth. Pass --confirm-dedicated-veth only after verifying that condition.")
    if os.geteuid() != 0:
        ap.error("run with sudo when applying tc changes")
    if not shutil_which("tc") or not shutil_which("ip"):
        ap.error("tc and ip commands must be installed")
    run(["ip", "link", "show", "dev", args.interface])
    pre = run(["tc", "qdisc", "show", "dev", args.interface], capture=True)
    qdisc_before = pre.stdout.strip()
    # Generic qdisc trees cannot be reconstructed from `tc qdisc show` output.
    # Fail closed unless the disposable interface is at its default noqueue root.
    if "noqueue" not in qdisc_before or "mq" in qdisc_before or "fq_codel" in qdisc_before:
        ap.error("Refusing to replace this interface's qdisc: root must be the default noqueue on a disposable veth. Existing qdisc trees are not safely restorable by this script.")
    link_detail = run(["ip", "-d", "link", "show", "dev", args.interface], capture=True)
    if "veth" not in link_detail.stdout.lower():
        ap.error("Refusing live impairment: interface is not identified as a veth. Use an isolated disposable veth test topology.")
    with events_path.open("a", encoding="utf-8") as events:
        events.write(json.dumps({"event":"run_start", "utc":utc_now(), "qdisc_before":pre.stdout}) + "\n")
        monotonic_start = time.monotonic()
        try:
            for row in schedule:
                target = monotonic_start + row["start_s"]
                wait = target - time.monotonic()
                if wait > 0:
                    time.sleep(wait)
                prof = cfg["profiles"][row["profile"]]
                cmd = qdisc_args(args.interface, prof)
                run(cmd)
                q = run(["tc", "qdisc", "show", "dev", args.interface], capture=True)
                event = {"event":"profile_applied", "utc":utc_now(), "elapsed_s":round(time.monotonic()-monotonic_start, 3), **row, "command":shlex.join(cmd), "qdisc":q.stdout}
                events.write(json.dumps(event) + "\n"); events.flush()
                print(f"Applied {row['profile']} for planned {row['duration_s']}s")
            # Keep the final recovery profile active for its full planned duration.
            end_target = monotonic_start + duration
            final_wait = end_target - time.monotonic()
            if final_wait > 0:
                time.sleep(final_wait)
            # Restore the known default noqueue state of the disposable veth.
            cleanup_cmd = ["tc", "qdisc", "del", "dev", args.interface, "root"]
            run(cleanup_cmd, check=False)
            q = run(["tc", "qdisc", "show", "dev", args.interface], capture=True)
            events.write(json.dumps({"event":"run_end", "utc":utc_now(), "elapsed_s":round(time.monotonic()-monotonic_start, 3), "qdisc_after_cleanup":q.stdout}) + "\n")
        except Exception as exc:
            # Best-effort cleanup is safe only because preflight proved this is a disposable veth with default noqueue.
            subprocess.run(["tc", "qdisc", "del", "dev", args.interface, "root"], check=False)
            events.write(json.dumps({"event":"run_error", "utc":utc_now(), "error":repr(exc), "cleanup_attempted":True}) + "\n")
            raise
    manifest["execution_completed_utc"] = utc_now()
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("Schedule completed; root qdisc cleanup attempted. Verify tc qdisc show manually.")
    return 0


def shutil_which(name):
    import shutil
    return shutil.which(name)

if __name__ == "__main__":
    sys.exit(main())
