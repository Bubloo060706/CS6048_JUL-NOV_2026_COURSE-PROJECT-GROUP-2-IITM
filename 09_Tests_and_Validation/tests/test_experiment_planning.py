import csv
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

class PairedScheduleTests(unittest.TestCase):
    def test_generator_creates_matched_pairs_with_same_schedule_reference(self):
        with tempfile.TemporaryDirectory() as temp:
            subprocess.run([
                sys.executable, str(ROOT / 'scripts/generate_paired_schedules.py'),
                '--seed', '777', '--repetitions', '2', '--duration-seconds', '180',
                '--out-dir', temp
            ], check=True, capture_output=True, text=True)
            plan_path = Path(temp) / 'paired-run-plan.csv'
            with plan_path.open(newline='', encoding='utf-8') as handle:
                rows = list(csv.DictReader(handle))
            self.assertEqual(len(rows), 4)
            for pair_id in {row['pair_id'] for row in rows}:
                pair = [row for row in rows if row['pair_id'] == pair_id]
                self.assertEqual({row['mode'] for row in pair}, {'baseline', 'adaptive'})
                self.assertEqual(len({row['schedule_csv'] for row in pair}), 1)
                schedule_path = Path(pair[0]['schedule_csv'])
                self.assertTrue(schedule_path.is_file())
                with schedule_path.open(newline='', encoding='utf-8') as handle:
                    schedule = list(csv.DictReader(handle))
                cursor = 0
                for segment in schedule:
                    self.assertEqual(int(segment['start_s']), cursor)
                    self.assertGreater(int(segment['duration_s']), 0)
                    cursor += int(segment['duration_s'])
                self.assertEqual(cursor, 180)



    def test_raw_stats_extractor_flattens_report_types_without_field_collision(self):
        with tempfile.TemporaryDirectory() as temp:
            bundle = Path(temp) / 'run.json'
            bundle.write_text(json.dumps({
                'rawGetStatsSnapshots': [{
                    'timestamp': '2026-10-30T10:00:00Z', 'runId': 'R1', 'endpointRole': 'caller',
                    'reports': [
                        {'id': 'out1', 'type': 'outbound-rtp', 'bytesSent': 100},
                        {'id': 'in1', 'type': 'inbound-rtp', 'bytesReceived': 200}
                    ]
                }]
            }))
            output = Path(temp) / 'flat.csv'
            subprocess.run([
                sys.executable, str(ROOT / 'analysis/extract_raw_stats.py'),
                str(bundle), '--out', str(output)
            ], check=True, capture_output=True, text=True)
            with output.open(newline='', encoding='utf-8') as handle:
                row = next(csv.DictReader(handle))
            self.assertEqual(row['outbound_rtp.out1.bytesSent'], '100')
            self.assertEqual(row['inbound_rtp.in1.bytesReceived'], '200')

    def test_runner_replays_schedule_without_applying_network_changes(self):
        with tempfile.TemporaryDirectory() as temp:
            subprocess.run([
                sys.executable, str(ROOT / 'scripts/generate_paired_schedules.py'),
                '--seed', '321', '--repetitions', '1', '--duration-seconds', '150',
                '--out-dir', temp
            ], check=True, capture_output=True, text=True)
            source = next((Path(temp) / 'schedules').glob('*.csv'))
            output = Path(temp) / 'replay-output'
            result = subprocess.run([
                sys.executable, str(ROOT / 'scripts/run_randomized_baseline.py'),
                '--schedule-file', str(source), '--run-id', 'replay-check',
                '--out-dir', str(output)
            ], check=True, capture_output=True, text=True)
            replayed = output / 'replay-check-schedule.csv'
            self.assertEqual(source.read_text(), replayed.read_text())
            self.assertIn('DRY RUN ONLY', result.stdout)
            self.assertIn('no network settings were changed', result.stdout)

    def test_same_seed_generates_identical_schedule_files(self):
        with tempfile.TemporaryDirectory() as a, tempfile.TemporaryDirectory() as b:
            for directory in (a, b):
                subprocess.run([
                    sys.executable, str(ROOT / 'scripts/generate_paired_schedules.py'),
                    '--seed', '999', '--repetitions', '1', '--duration-seconds', '150',
                    '--out-dir', directory
                ], check=True, capture_output=True, text=True)
            pa = next((Path(a) / 'schedules').glob('*.csv')).read_text()
            pb = next((Path(b) / 'schedules').glob('*.csv')).read_text()
            self.assertEqual(pa, pb)

if __name__ == '__main__':
    unittest.main()
