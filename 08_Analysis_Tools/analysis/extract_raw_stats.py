#!/usr/bin/env python3
"""Flatten raw getStats snapshots from a complete run JSON bundle or JSONL export.

Produces one row per getStats snapshot. Report-specific fields are prefixed with
report type and keyed by report ID so fields from different reports do not collide.
This is a loss-minimizing analysis view; the original raw file remains authoritative.
"""
from __future__ import annotations
import argparse, csv, json, sys
from pathlib import Path


def iter_snapshots(path: Path):
    if path.suffix.lower() == '.json':
        bundle = json.loads(path.read_text(encoding='utf-8'))
        for snapshot in bundle.get('rawGetStatsSnapshots', []):
            yield snapshot
    else:
        with path.open(encoding='utf-8') as handle:
            for line_number, line in enumerate(handle, 1):
                if not line.strip():
                    continue
                try:
                    yield json.loads(line)
                except json.JSONDecodeError as exc:
                    raise ValueError(f'{path}:{line_number}: invalid JSONL: {exc}') from exc


def flatten(snapshot: dict) -> dict:
    row = {
        'timestamp': snapshot.get('timestamp'),
        'monotonicMs': snapshot.get('monotonicMs'),
        'runId': snapshot.get('runId'),
        'endpointRole': snapshot.get('endpointRole'),
        'mode': snapshot.get('mode'),
        'reportCount': len(snapshot.get('reports', [])),
    }
    for report in snapshot.get('reports', []):
        report_type = str(report.get('type', 'unknown')).replace('-', '_')
        report_id = str(report.get('id', 'no_id'))
        prefix = f'{report_type}.{report_id}.'
        for key, value in report.items():
            if isinstance(value, (dict, list)):
                value = json.dumps(value, separators=(',', ':'), sort_keys=True)
            row[prefix + key] = value
    return row


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', help='complete run JSON bundle or raw getStats JSONL')
    parser.add_argument('--out', default='raw-stats-flattened.csv')
    args = parser.parse_args()
    source = Path(args.input)
    if not source.is_file():
        print(f'Input not found: {source}', file=sys.stderr); return 2
    try:
        rows = [flatten(snapshot) for snapshot in iter_snapshots(source)]
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f'Could not read raw stats: {exc}', file=sys.stderr); return 2
    if not rows:
        print('No raw getStats snapshots found.', file=sys.stderr); return 2
    columns = list(dict.fromkeys(key for row in rows for key in row))
    output = Path(args.out); output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('w', newline='', encoding='utf-8') as handle:
        writer = csv.DictWriter(handle, fieldnames=columns, extrasaction='ignore')
        writer.writeheader(); writer.writerows(rows)
    print(f'Flattened {len(rows)} getStats snapshots into {output}')
    return 0

if __name__ == '__main__':
    raise SystemExit(main())
