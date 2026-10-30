#!/usr/bin/env python3
"""Tests for prune_profile_repair.py. Fixtures are the exact reth.toml files the PINNED base v1.5.1 binary wrote
offline (jobs/offline-reth.sh): after a lookup-flag-only launch (defect) and after a complete-flag launch (canonical)."""
import contextlib
import hashlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import prune_profile_repair as r  # noqa: E402

DEFECT = Path(HERE, 'fixtures/base-defect-reth.toml').read_bytes()
CANONICAL = Path(HERE, 'fixtures/base-canonical-reth.toml').read_bytes()
REAL_BASE = os.environ.get('PRUNE_TEST_BASE_BIN', os.path.join(HERE, '..', 'payload', 'bin', 'base'))


class Repair(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.bin = os.path.join(self.tmp.name, 'fake-base')
        with open(self.bin, 'wb') as f:
            f.write(b'pinned stand-in')
        old = dict(r.PINNED)
        r.PINNED['base'] = hashlib.sha256(b'pinned stand-in').hexdigest()
        self.addCleanup(r.PINNED.update, old)

    def toml(self, data=DEFECT, mode=0o640):
        p = os.path.join(self.tmp.name, 'reth.toml')
        with open(p, 'wb') as f:
            f.write(data)
        os.chmod(p, mode)
        return p

    def run_tool(self, *args):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = r.main(list(args))
        return rc, out.getvalue(), err.getvalue()

    def test_plan_reproduces_client_canonical_bytes_exactly(self):
        self.assertEqual(r.plan(DEFECT), CANONICAL)

    def test_dry_run_writes_nothing(self):
        p = self.toml()
        rc, out, _ = self.run_tool('--reth-toml', p, '--client', 'base', '--binary', self.bin)
        self.assertEqual(rc, 0)
        self.assertIn('DRY RUN', out)
        self.assertEqual(Path(p).read_bytes(), DEFECT)
        self.assertEqual(sorted(os.listdir(self.tmp.name)), ['fake-base', 'reth.toml'])

    def test_apply_bound_to_observed_sha_preserves_backup_and_mode(self):
        p = self.toml()
        rc, out, err = self.run_tool('--reth-toml', p, '--client', 'base', '--binary', self.bin, '--apply',
                                     '--expect-sha256', hashlib.sha256(DEFECT).hexdigest())
        self.assertEqual(rc, 0, err)
        self.assertEqual(Path(p).read_bytes(), CANONICAL)
        self.assertEqual(Path(p + r.BACKUP_SUFFIX).read_bytes(), DEFECT)
        self.assertEqual(os.stat(p).st_mode & 0o777, 0o640)
        self.assertFalse(os.path.exists(p + '.prune-repair.tmp'))
        rc, _, err = self.run_tool('--reth-toml', p, '--client', 'base', '--binary', self.bin, '--apply',
                                   '--expect-sha256', hashlib.sha256(CANONICAL).hexdigest())
        self.assertEqual(rc, 2)
        self.assertIn('already complete', err)

    def test_apply_requires_expected_sha(self):
        p = self.toml()
        rc, _, err = self.run_tool('--reth-toml', p, '--client', 'base', '--binary', self.bin, '--apply')
        self.assertEqual(rc, 2)
        rc, _, err = self.run_tool('--reth-toml', p, '--client', 'base', '--binary', self.bin, '--apply',
                                   '--expect-sha256', '00' * 32)
        self.assertEqual(rc, 2)
        self.assertIn('--expect-sha256', err)
        self.assertEqual(Path(p).read_bytes(), DEFECT)

    def test_second_repair_refused_when_backup_exists(self):
        p = self.toml()
        open(p + r.BACKUP_SUFFIX, 'wb').close()
        rc, _, err = self.run_tool('--reth-toml', p, '--client', 'base', '--binary', self.bin, '--apply',
                                   '--expect-sha256', hashlib.sha256(DEFECT).hexdigest())
        self.assertEqual(rc, 2)
        self.assertIn('one-time', err)
        self.assertEqual(Path(p).read_bytes(), DEFECT)

    def test_unpinned_binary_refused(self):
        p = self.toml()
        with open(self.bin, 'ab') as f:
            f.write(b'x')
        rc, _, err = self.run_tool('--reth-toml', p, '--client', 'base', '--binary', self.bin)
        self.assertEqual(rc, 2)
        self.assertIn('not the pinned', err)

    def test_anything_but_the_exact_defect_is_refused(self):
        cases = {
            'other interval': DEFECT.replace(b'block_interval = 5', b'block_interval = 6'),
            'other minimum': DEFECT.replace(b'minimum_pruning_distance = 10064', b'minimum_pruning_distance = 64'),
            'other lookup': DEFECT.replace(b'[prune.segments.transaction_lookup]\ndistance = 140000',
                                           b'[prune.segments.transaction_lookup]\ndistance = 9000'),
            'extra segment': DEFECT.replace(b'[prune.segments.transaction_lookup]',
                                            b'[prune.segments.receipts]\ndistance = 64\n\n[prune.segments.transaction_lookup]'),
            'no static files': DEFECT.replace(b'[static_files.blocks_per_file]', b'[static_files_removed]'),
            'archive (no prune)': DEFECT[:DEFECT.index(b'[prune]')] + DEFECT[DEFECT.index(b'[peers]'):],
            'not toml': b'[prune\n',
        }
        for name, data in cases.items():
            with self.subTest(name):
                with self.assertRaises(r.Refuse):
                    r.plan(data)

    def test_symlink_refused(self):
        p = self.toml()
        link = os.path.join(self.tmp.name, 'link.toml')
        os.symlink(p, link)
        rc, _, err = self.run_tool('--reth-toml', link, '--client', 'base', '--binary', self.bin)
        self.assertEqual(rc, 2)

    def test_real_pinned_base_binary_accepted(self):
        r.PINNED['base'] = '9c44836d3dd41ae92df3c52fe0df7957dc10b77859d8d80cce6d5fb89d35e53f'
        r.check_binary('base', REAL_BASE)


if __name__ == '__main__':
    unittest.main(verbosity=2)
