#!/usr/bin/python3 -I
"""Offline tests for cached_download_preflight.py: synthetic manifest/datadir, plus the real manifest (numbers only)."""
import contextlib
import io
import json
import os
import shutil
import tempfile
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cached_download_preflight as pf  # noqa: E402

REAL = os.environ.get('REAL_SNAPSHOT_MANIFEST')


def comp(n, size):
    return {'blocks_per_file': 500000, 'total_blocks': n * 500000 - 1, 'chunk_sizes': [size] * n,
            'chunk_decompressed_sizes': [2 * size] * n,
            'chunk_files': [f'static_files/x-{i}.tar.zst' for i in range(n)],
            'chunk_output_files': [[{'path': f'static_files/out_{id(size)}_{i}', 'size': 3, 'blake3': 'ab' * 32}] for i in range(n)]}


class Preflight(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(dir=os.environ.get('TEST_TMP'))
        m = {'block': 2_400_000, 'components': {k: comp(5, 10 * pf.GB) for k in
                                                  ('transactions', 'receipts', 'account_changesets', 'storage_changesets', 'headers')}}
        for k, c in m['components'].items():                           # distinct output paths per component
            c['chunk_output_files'] = [[{'path': f'static_files/{k}_{i}', 'size': 3, 'blake3': 'ab' * 32}] for i in range(5)]
        m['components']['rocksdb_indices'] = {'file': 'r.tar.zst', 'size': 1, 'decompressed_size': 100 * pf.GB}
        self.m = m
        self.mp = os.path.join(self.d, 'manifest.json')
        json.dump(m, open(self.mp, 'w'))
        os.makedirs(os.path.join(self.d, 'data', 'static_files'))

    def tearDown(self):
        shutil.rmtree(self.d, ignore_errors=True)

    def run_pf(self, *extra):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = pf.main(['--manifest', self.mp, '--datadir', os.path.join(self.d, 'data'),
                          '--history-from', '1000000', '--state-history-from', '2000000', *extra])
        return rc, json.loads(out.getvalue())

    def touch(self, comp_name, i, size=3):
        with open(os.path.join(self.d, 'data', 'static_files', f'{comp_name}_{i}'), 'wb') as f:
            f.write(b'x' * size)

    def test_selection_and_refusal(self):
        rc, r = self.run_pf('--free-bytes', str(10 * pf.GB))
        self.assertEqual(rc, 3)
        self.assertFalse(r['admitted'])
        self.assertEqual(r['selected']['receipts']['firstChunk'], 2)          # 1,000,000 // 500,000
        self.assertEqual(r['selected']['account_changesets']['firstChunk'], 4)  # 2,000,000 // 500,000
        self.assertEqual(r['missing']['archives'], 3 + 3 + 1 + 1)

    def test_present_outputs_are_reused_and_admitted(self):
        for k in ('transactions', 'receipts'):
            for i in (2, 3, 4):
                self.touch(k, i)
        for k in ('account_changesets', 'storage_changesets'):
            self.touch(k, 4)
        rc, r = self.run_pf('--free-bytes', str(10_000 * pf.GB))
        self.assertEqual((rc, r['missing']['archives']), (0, 0))
        self.touch('receipts', 2, size=4)                                     # wrong size is NOT reused
        rc, r = self.run_pf('--free-bytes', str(10_000 * pf.GB))
        self.assertEqual(r['missing']['byComponent']['receipts'], 1)

    def test_need_counts_compressed_extracted_index_growth(self):
        rc, r = self.run_pf('--free-bytes', str(10_000 * pf.GB))
        self.assertEqual(r['missing']['compressedBytes'], 8 * 10 * pf.GB)
        self.assertEqual(r['missing']['extractedBytes'], 8 * 20 * pf.GB)
        self.assertGreaterEqual(r['indexReserveBytes'], pf.MIN_INDEX_RESERVE)
        self.assertEqual(r['needBytes'], 80 * pf.GB + 160 * pf.GB + r['indexReserveBytes'] + r['growthReserveBytes'])
        rc2, r2 = self.run_pf('--free-bytes', str(r['needBytes'] - 1))
        self.assertEqual(rc2, 3)
        rc3, _ = self.run_pf('--free-bytes', str(r['needBytes']))
        self.assertEqual(rc3, 0)

    def test_command_never_deletes(self):
        _, r = self.run_pf('--free-bytes', str(10_000 * pf.GB))
        cmd = r['command']
        for bad in ('--force', '--prune-unlisted', '--with-senders', '--with-rocksdb', '--archive', '--minimal', '--full'):
            self.assertNotIn(bad, cmd)
        self.assertEqual(cmd[cmd.index('--with-txs-since') + 1], '1000000')
        self.assertEqual(cmd[cmd.index('--with-state-history-since') + 1], '2000000')
        self.assertEqual(cmd[cmd.index('--manifest-path') + 1], self.mp)

    def test_bad_inputs_refused(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = pf.main(['--manifest', self.mp, '--datadir', self.d, '--history-from', '9999999', '--state-history-from', '1'])
        self.assertEqual(rc, 3)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(pf.main(['--manifest', '/nonexistent', '--datadir', self.d, '--history-from', '1', '--state-history-from', '1']), 3)

    @unittest.skipUnless(REAL, 'REAL_SNAPSHOT_MANIFEST not set')
    def test_real_manifest_option_b_numbers(self):
        m = json.load(open(REAL))
        p = pf.plan(m, 48_000_000, 52_500_000)
        self.assertEqual(p['selected']['receipts']['firstChunk'], 96)
        self.assertEqual(p['selected']['storage_changesets']['firstChunk'], 105)
        hist = [x for x in p['missingArchives'] if x['component'] in ('transactions', 'receipts') and x['chunk'] < 105]
        self.assertEqual(len(hist), 18)
        self.assertEqual(round(sum(x['compressed'] for x in hist) / pf.GB, 1), 221.6)
        self.assertEqual(round(sum(x['extracted'] for x in hist) / pf.GB, 1), 410.0)


if __name__ == '__main__':
    unittest.main(verbosity=2)
