#!/usr/bin/env python3
"""Offline tests for download_diag2.py (sparse files in a private temp dir; no network)."""
import json, os, subprocess, sys, tempfile, threading, time, unittest
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
import download_diag2 as D
MIB = 1 << 20

class Pieces(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='dg2-')
        self.p = os.path.join(self.d, 'state.tar.zst.part')
        with open(self.p, 'wb') as f:
            f.truncate(10 * MIB)                         # set_len(total): sparse, full apparent size
            f.seek(0); f.write(b'x' * MIB)               # piece 0 complete
            f.seek(2 * MIB); f.write(b'x' * (MIB // 2))  # piece 2 half
            os.fsync(f.fileno())

    def test_seek_data_map(self):
        size, m = D.data_bytes_per_piece(self.p, MIB)
        self.assertEqual(size, 10 * MIB)
        self.assertEqual(m.get(0), MIB)
        self.assertGreaterEqual(m.get(2, 0), MIB // 2)      # fs block granularity may round up
        self.assertNotIn(5, m)

    def test_report_math(self):
        a = {0: MIB, 2: MIB // 2, 3: MIB // 4}
        b = {0: MIB, 2: MIB, 3: MIB // 2, 4: MIB // 8}
        r = D.piece_report(10 * MIB, a, b, MIB, 2.0)
        self.assertEqual((r['complete'], r['growing'], r['finishedInWindow'], r['stalledPartial']), (2, 2, 1, 0))
        self.assertEqual(r['perPieceMinBps'], round(MIB / 8 / 2))
        self.assertAlmostEqual(r['timeoutMarginAtMedian'], 120 / (MIB / (MIB / 4 / 2)), places=2)

    def test_cli_sees_concurrent_growth(self):
        def writer():
            time.sleep(0.3)
            with open(self.p, 'r+b') as f:
                for k in (6, 8):                         # two concurrently written pieces
                    f.seek(k * MIB); f.write(b'y' * (MIB // 4))
                os.fsync(f.fileno())
        t = threading.Thread(target=writer); t.start()
        r = subprocess.run([sys.executable, os.path.join(HERE, 'download_diag2.py'), 'pieces', '--part', self.p,
                            '--piece-mib', '1', '--seconds', '1.5'], capture_output=True, text=True, timeout=30)
        t.join()
        self.assertEqual(r.returncode, 0, r.stderr)
        j = json.loads(r.stdout)
        self.assertEqual((j['growing'], j['complete'], j['apparent']), (2, 1, 10 * MIB))
        self.assertIn('timeoutMarginAtMedian', j)

    def test_seconds_bound(self):
        r = subprocess.run([sys.executable, os.path.join(HERE, 'download_diag2.py'), 'pieces', '--part', self.p,
                            '--seconds', '500'], capture_output=True, text=True)
        self.assertEqual(r.returncode, 2)

class PartsAndJournal(unittest.TestCase):
    def test_parts_classifies_paths(self):
        d = tempfile.mkdtemp(prefix='dg2p-')
        man = os.path.join(d, 'm.json')
        json.dump({'components': {'state': {'file': '1792886410/state.tar.zst', 'size': 4 * MIB},
                                  'headers': {'chunk_files': ['1792886410/headers-0-499999.tar.zst'], 'chunk_sizes': [3 * MIB]}}},
                  open(man, 'w'))  # noqa
        c = os.path.join(d, 'cache'); os.mkdir(c)
        with open(os.path.join(c, 'state.tar.zst.part'), 'wb') as f: f.truncate(4 * MIB)
        with open(os.path.join(c, 'headers-0-499999.tar.zst.part'), 'wb') as f: f.write(b'z' * MIB)
        r = subprocess.run([sys.executable, os.path.join(HERE, 'download_diag2.py'), 'parts', '--cache', c, '--manifest', man],
                           capture_output=True, text=True, timeout=30)
        j = json.loads(r.stdout)
        self.assertTrue(j['state.tar.zst.part']['path'].startswith('segmented'))
        self.assertEqual(j['headers-0-499999.tar.zst.part']['path'], 'sequential append')

    def test_journal_whitelist_never_prints_urls(self):
        text = ('2026-10-25T19:00:00+0000 host base[4061]: INFO reth::cli: Starting queued segmented download '
                'file=state.tar.zst total_size="708.9 GiB" piece_size="64.0 MiB" pieces=11343 workers=16 max_concurrent_requests=16\n'
                '2026-10-25T19:01:00+0000 host base[4061]: WARN reth::cli: Archive attempt failed, retrying from scratch '
                'file=state.tar.zst component=state attempt=1 url=https://mainnet-v2-snapshots.base.org/x?token=SECRET\n'
                '2026-10-25T19:02:00+0000 host base[4061]: some unrelated line with Authorization: Bearer abc\n')
        r = subprocess.run([sys.executable, os.path.join(HERE, 'download_diag2.py'), 'journal'], input=text,
                           capture_output=True, text=True, timeout=30)
        lines = [json.loads(l) for l in r.stdout.splitlines()]
        self.assertEqual([l['message'] for l in lines], ['Starting queued segmented download', 'Archive attempt failed, retrying from scratch'])
        self.assertEqual((lines[0]['workers'], lines[0]['max_concurrent_requests'], lines[0]['pieces']), ('16', '16', '11343'))
        self.assertNotIn('SECRET', r.stdout); self.assertNotIn('https://', r.stdout); self.assertNotIn('Bearer', r.stdout)

if __name__ == '__main__':
    unittest.main()
