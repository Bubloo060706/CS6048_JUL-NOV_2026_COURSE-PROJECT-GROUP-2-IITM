#!/usr/bin/env python3
"""Generate immutable randomized network schedules and matched baseline/adaptive run plans.

Each pair references one saved schedule CSV. Reuse that exact file for both modes.
This script only plans experiments; it never changes network settings or launches browsers.
"""
from __future__ import annotations
import argparse, csv, json, random
from pathlib import Path
from run_randomized_baseline import build_schedule


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default='experiments/baseline-profiles.json')
    parser.add_argument('--out-dir', default='experiments/generated')
    parser.add_argument('--repetitions', type=int, default=3)
    parser.add_argument('--seed', type=int, default=20261030)
    parser.add_argument('--duration-seconds', type=int, default=None)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error('--repetitions must be >= 1')
    cfg = json.loads(Path(args.config).read_text(encoding='utf-8'))
    duration = args.duration_seconds or int(cfg['pilot_duration_seconds'])
    out = Path(args.out_dir); schedules_dir = out / 'schedules'
    schedules_dir.mkdir(parents=True, exist_ok=True)
    rng = random.Random(args.seed)
    rows = []
    for rep in range(1, args.repetitions + 1):
        schedule_seed = rng.randrange(1, 2**31)
        schedule = build_schedule(cfg, schedule_seed, duration)
        pair_id = f'r{rep:02d}-seed{schedule_seed}'
        schedule_id = f'S-{pair_id}'
        schedule_csv = schedules_dir / f'{schedule_id}.csv'
        schedule_json = schedules_dir / f'{schedule_id}.json'
        with schedule_csv.open('w', newline='', encoding='utf-8') as handle:
            writer = csv.DictWriter(handle, fieldnames=['phase','profile','start_s','duration_s'])
            writer.writeheader(); writer.writerows(schedule)
        schedule_json.write_text(json.dumps({
            'schema_version': 1, 'schedule_id': schedule_id, 'seed': schedule_seed,
            'duration_seconds': duration, 'sample_interval_ms': cfg.get('sample_interval_ms'),
            'profiles': cfg['profiles'], 'schedule': schedule,
            'replay_rule': 'Use this exact schedule file for both baseline and adaptive runs.'
        }, indent=2) + '\n', encoding='utf-8')
        modes = ['baseline', 'adaptive']; rng.shuffle(modes)
        for order, mode in enumerate(modes, start=1):
            rows.append({
                'pair_id': pair_id, 'schedule_id': schedule_id,
                'schedule_csv': str(schedule_csv), 'schedule_json': str(schedule_json),
                'run_id': f'{pair_id}-{mode}', 'mode': mode, 'order_within_pair': order,
                'duration_seconds': duration, 'sample_interval_ms': cfg.get('sample_interval_ms', 1000),
                'randomization_seed': args.seed, 'schedule_seed': schedule_seed,
                'status': 'planned', 'validity': 'not_run', 'notes': ''
            })
    plan = out / 'paired-run-plan.csv'
    with plan.open('w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]))
        writer.writeheader(); writer.writerows(rows)
    manifest = {'schema_version': 1, 'master_seed': args.seed, 'repetitions': args.repetitions,
                'duration_seconds': duration, 'paired_runs': len(rows), 'plan_csv': str(plan),
                'schedule_replay_required': True}
    (out / 'plan-manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    print(f'Generated {args.repetitions} immutable schedules and {len(rows)} matched runs.')
    print(f'Plan: {plan}')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
