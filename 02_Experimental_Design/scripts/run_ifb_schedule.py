#!/usr/bin/env python3
import argparse, csv, json, os, subprocess, sys, time, signal, hashlib
from pathlib import Path
from datetime import datetime, timezone

def run(cmd, check=True):
    return subprocess.run(cmd, text=True, capture_output=True, check=check)

def log(event, **kw):
    record = {"utc": datetime.now(timezone.utc).isoformat(),
              "elapsed_s": round(time.monotonic() - START, 3),
              "event": event, **kw}
    with LOG.open("a") as f:
        f.write(json.dumps(record) + "\n")
    print(json.dumps(record), flush=True)

def cleanup():
    global CLEANED
    if CLEANED:
        return
    CLEANED = True
    for cmd in [
        ["tc", "filter", "del", "dev", IFACE, "ingress"],
        ["tc", "filter", "del", "dev", IFACE, "egress"],
        ["tc", "qdisc", "del", "dev", IFACE, "clsact"],
        ["tc", "qdisc", "del", "dev", IFB_IN, "root"],
        ["tc", "qdisc", "del", "dev", IFB_OUT, "root"],
        ["ip", "link", "del", IFB_IN],
        ["ip", "link", "del", IFB_OUT],
    ]:
        run(cmd, check=False)
    log("cleanup_complete")

def stop_signal(signum, frame):
    raise KeyboardInterrupt

def apply_profile(name, profile):
    for dev in (IFB_IN, IFB_OUT):
        args = ["tc", "qdisc", "replace", "dev", dev,
                "root", "handle", "1:", "netem"]
        delay = float(profile.get("delay_ms", 0))
        jitter = float(profile.get("jitter_ms", 0))
        corr = float(profile.get("delay_correlation_percent", 0))
        loss = float(profile.get("loss_percent", 0))
        rate = profile.get("rate")
        if delay > 0 or jitter > 0:
            args += ["delay", f"{delay:g}ms"]
            if jitter > 0:
                args += [f"{jitter:g}ms", f"{corr:g}%"]
        if loss > 0:
            args += ["loss", f"{loss:g}%"]
        if rate:
            args += ["rate", str(rate)]
        if len(args) == 8:
            run(["tc", "qdisc", "del", "dev", dev, "root"], check=False)
        else:
            run(args)
    log("profile_applied", profile=name, settings=profile)

def main():
    global START, LOG, IFACE, IFB_IN, IFB_OUT, CLEANED
    ap = argparse.ArgumentParser()
    ap.add_argument("--schedule", required=True)
    ap.add_argument("--config", default="experiments/baseline-profiles.json")
    ap.add_argument("--ubuntu-ip", default="10.21.239.165")
    ap.add_argument("--windows-ip", default="10.42.82.153")
    ap.add_argument("--interface", default="eno1")
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    IFACE, IFB_IN, IFB_OUT = a.interface, "ifb-in", "ifb-out"
    CLEANED = False
    schedule_path = Path(a.schedule)
    config_path = Path(a.config)
    rows = list(csv.DictReader(schedule_path.open()))
    cfg = json.loads(config_path.read_text())
    profiles = cfg["profiles"]
    if not rows:
        raise SystemExit("Empty schedule")
    if os.geteuid() != 0 and not a.dry_run:
        raise SystemExit("Run with sudo")
    if a.ubuntu_ip == a.windows_ip:
        raise SystemExit("Endpoint IPs must differ")

    total = sum(int(r["duration_s"]) for r in rows)
    if int(rows[0]["start_s"]) != 0:
        raise SystemExit("Schedule must start at zero")
    for i, r in enumerate(rows):
        if int(r["start_s"]) != sum(int(x["duration_s"]) for x in rows[:i]):
            raise SystemExit("Schedule contains a gap or overlap")
        if r["profile"] not in profiles:
            raise SystemExit("Unknown profile: " + r["profile"])
    digest = hashlib.sha256(schedule_path.read_bytes()).hexdigest()
    out = Path(a.out_dir)
    out.mkdir(parents=True, exist_ok=True)
    LOG = out / "network-events.jsonl"
    START = time.monotonic()

    print(f"Schedule: {schedule_path}")
    print(f"Duration: {total}s; segments: {len(rows)}")
    print(f"Schedule SHA256: {digest}")
    print(f"Flow scope: UDP {a.ubuntu_ip} <-> {a.windows_ip}")
    if a.dry_run:
        for r in rows:
            print(r)
        return

    # Fail closed: never replace or alter the physical NIC root qdisc.
    root = run(["tc", "qdisc", "show", "dev", IFACE]).stdout
    if "qdisc mq" not in root or "qdisc fq_codel" not in root:
        raise SystemExit("Unexpected physical NIC qdisc; refusing to proceed")
    if "qdisc clsact" in root:
        raise SystemExit("Existing clsact found; refusing to overwrite it")
    for dev in (IFB_IN, IFB_OUT):
        if run(["ip", "link", "show", dev], check=False).returncode == 0:
            raise SystemExit(f"{dev} already exists; refusing to reuse it")

    signal.signal(signal.SIGINT, stop_signal)
    signal.signal(signal.SIGTERM, stop_signal)
    try:
        run(["modprobe", "ifb"])
        run(["ip", "link", "add", IFB_IN, "type", "ifb"])
        run(["ip", "link", "add", IFB_OUT, "type", "ifb"])
        run(["ip", "link", "set", IFB_IN, "up"])
        run(["ip", "link", "set", IFB_OUT, "up"])
        run(["tc", "qdisc", "add", "dev", IFACE, "clsact"])

        run(["tc", "filter", "add", "dev", IFACE, "ingress",
             "protocol", "ip", "pref", "49100", "flower",
             "ip_proto", "udp", "src_ip", a.windows_ip,
             "dst_ip", a.ubuntu_ip, "action", "mirred",
             "egress", "redirect", "dev", IFB_IN])
        run(["tc", "filter", "add", "dev", IFACE, "egress",
             "protocol", "ip", "pref", "49101", "flower",
             "ip_proto", "udp", "src_ip", a.ubuntu_ip,
             "dst_ip", a.windows_ip, "action", "mirred",
             "egress", "redirect", "dev", IFB_OUT])

        log("runner_started", schedule=str(schedule_path),
            schedule_sha256=digest, duration_s=total,
            ubuntu_ip=a.ubuntu_ip, windows_ip=a.windows_ip,
            interface=IFACE, ifb_in=IFB_IN, ifb_out=IFB_OUT)

        for r in rows:
            target = int(r["start_s"])
            while time.monotonic() - START < target:
                time.sleep(min(0.25, target - (time.monotonic() - START)))
            apply_profile(r["profile"], profiles[r["profile"]])
            log("schedule_segment", phase=r["phase"],
                profile=r["profile"], planned_start_s=target,
                planned_duration_s=int(r["duration_s"]))
        while time.monotonic() - START < total:
            time.sleep(0.25)
        log("schedule_finished", planned_duration_s=total)
    except KeyboardInterrupt:
        log("interrupted")
        raise
    finally:
        cleanup()
        final_root = run(["tc", "qdisc", "show", "dev", IFACE], check=False)
        (out / "physical-interface-qdisc-after.txt").write_text(
            final_root.stdout if final_root.returncode == 0 else final_root.stderr)

if __name__ == "__main__":
    START = time.monotonic()
    CLEANED = False
    main()
