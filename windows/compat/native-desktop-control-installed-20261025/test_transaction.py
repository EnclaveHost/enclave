#!/usr/bin/env python3
"""Fault recovery and drift checks; uses temporary fixture directories only."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('transaction', HERE / 'transaction.py')
tx = importlib.util.module_from_spec(spec)
spec.loader.exec_module(tx)


class TransactionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='native-transaction-test-')
        self.base = Path(self.tmp.name)
        self.root = self.base / 'control'
        self.payload = self.base / 'payload'
        self.journal = self.base / 'journal'
        self.root.mkdir(); self.payload.mkdir()
        self.manifest = dict(modified=[], added=[], requiredUnchanged=[])
        for name, old, new in [('manager.mjs', b'old manager', b'new manager'),
                               ('node.mjs', b'old node', b'new node'),
                               ('native/desktop.mjs', None, b'new desktop')]:
            if old is not None:
                (self.root / name).write_bytes(old)
                self.manifest['modified'].append(dict(path=name, beforeSha256=tx.sha(old),
                    afterSha256=tx.sha(new), afterBytes=len(new)))
            else:
                self.manifest['added'].append(dict(path=name, sha256=tx.sha(new), bytes=len(new)))
            (self.payload / name).parent.mkdir(parents=True, exist_ok=True)
            (self.payload / name).write_bytes(new)
        (self.root / 'fixed.mjs').write_bytes(b'unchanged')
        self.manifest['requiredUnchanged'].append(dict(path='fixed.mjs', sha256=tx.sha(b'unchanged'), bytes=9))
        self.guard_calls = 0

    def tearDown(self):
        self.tmp.cleanup()

    def guard(self, root):
        self.assertEqual(root, self.root)
        self.guard_calls += 1

    def apply(self, **kwargs):
        return tx.apply(self.root, self.payload, json.dumps(self.manifest).encode(), self.journal,
                        guard=kwargs.pop('guard', self.guard), **kwargs)

    def assert_before(self):
        self.assertTrue(all(x['state'] == 'before' for x in tx.inspect(self.root, self.manifest)))

    def test_apply_readback_and_idempotent_rollback(self):
        result = self.apply()
        self.assertEqual(result['phase'], 'applied')
        self.assertFalse(result['productionServicesTouched'])
        self.assertGreaterEqual(self.guard_calls, 4)
        self.assertTrue(all(x['state'] == 'after' for x in tx.inspect(self.root, self.manifest)))
        self.assertEqual(tx.rollback(self.root, self.journal, guard=self.guard)['phase'], 'rolled-back')
        tx.rollback(self.root, self.journal, guard=self.guard)
        self.assert_before()

    def test_live_guard_refuses_fixture_cli_target(self):
        with self.assertRaises(RuntimeError):
            tx.windows_stopped(self.root)
        self.assert_before()

    def test_running_services_prevent_any_backup_or_write(self):
        def running(_): raise RuntimeError('running')
        with self.assertRaisesRegex(RuntimeError, 'running'):
            self.apply(guard=running)
        self.assert_before()
        self.assertFalse(self.journal.exists())

    def test_payload_drift_before_any_installed_write(self):
        (self.payload / 'native/desktop.mjs').write_bytes(b'tampered')
        with self.assertRaisesRegex(ValueError, 'payload pin'):
            self.apply()
        self.assert_before()
        self.assertFalse(self.journal.exists())

    def test_loss_of_quiescence_stops_changes_until_explicit_recovery(self):
        calls = 0
        def restarted(root):
            nonlocal calls
            calls += 1
            if calls >= 3: raise RuntimeError('service unexpectedly restarted')
        with self.assertRaisesRegex(RuntimeError, 'unexpectedly restarted'):
            self.apply(guard=restarted)
        self.assertEqual([x['state'] for x in tx.inspect(self.root, self.manifest)], ['after', 'before', 'before'])
        self.assertEqual(json.loads((self.journal / 'state.json').read_text())['phase'], 'applying')
        tx.rollback(self.root, self.journal, guard=self.guard)
        self.assert_before()

    def test_installed_and_required_drift_refused(self):
        (self.root / 'fixed.mjs').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'required source drift'):
            self.apply()
        self.assertFalse(self.journal.exists())
        (self.root / 'fixed.mjs').write_bytes(b'unchanged')
        (self.root / 'node.mjs').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'baseline differs'):
            self.apply()
        self.assertFalse(self.journal.exists())

    def test_added_path_collision_refused(self):
        (self.root / 'native').mkdir()
        (self.root / 'native/desktop.mjs').write_bytes(b'unrelated')
        with self.assertRaisesRegex(ValueError, 'baseline differs'):
            self.apply()
        self.assertEqual((self.root / 'native/desktop.mjs').read_bytes(), b'unrelated')
        self.assertFalse(self.journal.exists())

    def test_write_exception_restores_partial_install(self):
        count = 0
        def interrupted(p, b):
            nonlocal count
            tx.atomic_write(p, b)
            count += 1
            if count == 2: raise OSError('injected disk error after replace')
        with self.assertRaisesRegex(OSError, 'injected disk error'):
            self.apply(write=interrupted)
        self.assert_before()
        self.assertEqual(json.loads((self.journal / 'state.json').read_text())['phase'], 'rolled-back')

    def test_process_death_before_journal_update_recovers_by_hash(self):
        def died(p, b):
            tx.atomic_write(p, b)
            raise KeyboardInterrupt('simulated process death')
        with self.assertRaises(KeyboardInterrupt): self.apply(write=died)
        self.assertEqual(json.loads((self.journal / 'state.json').read_text())['completed'], [])
        tx.rollback(self.root, self.journal, guard=self.guard)
        self.assert_before()

    def test_rollback_does_not_overwrite_later_changes(self):
        self.apply()
        (self.root / 'node.mjs').write_bytes(b'new unrelated update')
        with self.assertRaisesRegex(ValueError, 'unrelated installed changes'):
            tx.rollback(self.root, self.journal, guard=self.guard)
        self.assertEqual((self.root / 'manager.mjs').read_bytes(), b'new manager')
        self.assertEqual((self.root / 'node.mjs').read_bytes(), b'new unrelated update')
        self.assertEqual((self.root / 'native/desktop.mjs').read_bytes(), b'new desktop')

    def test_corrupt_backup_refuses_all_restores(self):
        self.apply()
        (self.journal / 'before/node.mjs').write_bytes(b'bad backup')
        with self.assertRaisesRegex(ValueError, 'backup pin mismatch'):
            tx.rollback(self.root, self.journal, guard=self.guard)
        self.assertTrue(all(x['state'] == 'after' for x in tx.inspect(self.root, self.manifest)))

    def test_manifest_tamper_refused(self):
        self.apply()
        with (self.journal / 'manifest.json').open('ab') as f: f.write(b' ')
        with self.assertRaisesRegex(ValueError, 'manifest drift'):
            tx.rollback(self.root, self.journal, guard=self.guard)

    def test_journal_not_reused(self):
        self.journal.mkdir()
        (self.journal / 'keep').write_bytes(b'old evidence')
        with self.assertRaisesRegex(ValueError, 'journal already exists'):
            self.apply()
        self.assert_before()
        self.assertEqual((self.journal / 'keep').read_bytes(), b'old evidence')

    def test_nonportable_paths_and_case_aliases_rejected(self):
        for name in ['../outside', '/outside', 'native//file', r'native\file', 'native/file:stream', 'native/./file']:
            with self.subTest(path=name), self.assertRaises(ValueError): tx.path_in(self.root, name)
        self.manifest['added'].append(dict(path='NODE.mjs', sha256='0'*64, bytes=0))
        with self.assertRaisesRegex(ValueError, 'duplicate path'): self.apply()
        self.manifest['added'].pop()
        self.assert_before()

    def test_linked_ancestor_refused(self):
        outside = self.base / 'outside'; outside.mkdir()
        if os.name == 'nt':
            subprocess.run(['cmd.exe', '/c', 'mklink', '/J', str(self.root / 'native'), str(outside)],
                           check=True, capture_output=True)
        else:
            (self.root / 'native').symlink_to(outside, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'linked path'): self.apply()
        self.assertEqual(list(outside.iterdir()), [])

    @unittest.skipUnless(os.environ.get('NATIVE_COMPAT_INSTALLED_SNAPSHOT') and os.environ.get('NATIVE_COMPAT_PREPARED'),
                         'set snapshot and prepared payload paths for exact 31-file exercise')
    def test_exact_pinned_control_round_trip(self):
        shutil.rmtree(self.root); shutil.rmtree(self.payload)
        shutil.copytree(os.environ['NATIVE_COMPAT_INSTALLED_SNAPSHOT'], self.root)
        shutil.copytree(Path(os.environ['NATIVE_COMPAT_PREPARED']) / 'control', self.payload)
        self.manifest = json.loads((HERE / 'manifest.json').read_text())
        self.assertEqual(len(tx.entries(self.manifest)), 31)
        self.assertEqual(len(self.manifest['requiredUnchanged']), 78)
        self.apply()
        self.assertTrue(all(x['state'] == 'after' for x in tx.inspect(self.root, self.manifest)))
        tx.rollback(self.root, self.journal, guard=self.guard)
        self.assert_before()

if __name__ == '__main__':
    unittest.main(verbosity=2)
