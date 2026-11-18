#!/usr/bin/env python3
"""Generate a reproducible randomized paired baseline/adaptive trial plan."""
import argparse
import csv
import json
import random
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', default='experiments/trial-matrix.json')
    parser.add_argument('--out', default='results/trial-plan.csv')
    parser.add_argument('--seed', type=int, default=20261026)
    parser.add_argument('--repetitions', type=int, default=None)
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text(encoding='utf-8'))
    repetitions = args.repetitions if args.repetitions is not None else int(config.get('repetitions', 3))
    if repetitions < 1:
        parser.error('--repetitions must be at least 1')
    rng = random.Random(args.seed)
    profiles = list(config['profiles'].keys())
    modes = list(config.get('modes', ['baseline', 'adaptive']))
    if set(modes) != {'baseline', 'adaptive'}:
        parser.error('config modes must contain baseline and adaptive exactly')

    rows = []
    ordinal = 0
    for repetition in range(1, repetitions + 1):
        profile_order = profiles[:]
        rng.shuffle(profile_order)
        for profile in profile_order:
            pair_order = modes[:]
            rng.shuffle(pair_order)
            pair_id = f'{profile}-rep{repetition:02d}'
            for mode in pair_order:
                ordinal += 1
                run_id = f'{pair_id}-{mode}'
                rows.append({
                    'order': ordinal,
                    'pair_id': pair_id,
                    'run_id': run_id,
                    'repetition': repetition,
                    'profile': profile,
                    'mode': mode,
                    'duration_seconds': config.get('duration_seconds', 105),
                    'sample_interval_ms': config.get('sample_interval_ms', 1000),
                    'target_bitrate_kbps': config.get('target_bitrate_kbps', 900),
                    'randomization_seed': args.seed,
                    'validity': 'planned',
                    'exclusion_reason': ''
                })
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open('w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        writer.writeheader()
        writer.writerows(rows)
    print(f'Wrote {len(rows)} randomized runs ({repetitions} repetitions x {len(profiles)} profiles x 2 modes) to {out}')
    print(f'Randomization seed: {args.seed}')
    for row in rows:
        print(f"{row['order']:02d}. {row['run_id']}")


if __name__ == '__main__':
    main()
