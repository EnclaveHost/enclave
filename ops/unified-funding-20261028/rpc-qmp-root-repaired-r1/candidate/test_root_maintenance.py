"""Offline fixtures only; no VM, SSH, disk image or live service operations."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
M = load('maint_fixture', HERE / 'maint_boot.py')
G = load('guest_fixture', HERE / 'guest_mask.py')

class Host(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.rd = self.tmp.name
        self.launcher = M.load_pinned(M.DEFAULT_CFG['launcher'], M.LAUNCHER_SHA)
        self.manifest = json.loads(Path(M.DEFAULT_CFG['manifest']).read_text())
        self.argv = M.derive(self.launcher, self.manifest, self.rd)

    def test_real_pinned_render_has_only_os_and_readonly_seed(self):
        self.assertTrue(M.validate(self.argv, self.rd, self.manifest, M.DEFAULT_CFG))
        blocks = [json.loads(v) for f, v in M.parse(self.argv) if f == '-blockdev']
        self.assertEqual({b['node-name'] for b in blocks}, {'os0', 'seed0'})
        self.assertEqual([b['read-only'] for b in blocks if b['node-name'] == 'seed0'], [True])
        self.assertNotIn('/mnt/usb', ' '.join(self.argv))
        self.assertNotIn(self.manifest['disks']['l1']['path'], ' '.join(self.argv))

    def test_rejects_chain_disk_public_forward_extra_device_and_ram_drift(self):
        variants = []
        a = self.argv.copy(); i = a.index('-blockdev') + 1
        b = json.loads(a[i]); b['file']['filename'] = self.manifest['disks']['base']['path']; a[i] = json.dumps(b); variants.append(a)
        a = [v.replace('127.0.0.1:22851', '0.0.0.0:22851') for v in self.argv]; variants.append(a)
        a = [v.replace('restrict=on', 'restrict=off') for v in self.argv]; variants.append(a)
        variants.append(self.argv + ['-device', 'virtio-blk-pci,drive=base0'])
        a = self.argv.copy(); a[a.index('-m') + 1] = '65536M'; variants.append(a)
        for a in variants:
            with self.subTest(argv=a), self.assertRaises(M.Refuse):
                M.validate(a, self.rd, self.manifest, M.DEFAULT_CFG)

    def test_launcher_pin_drift_refused(self):
        f = Path(self.rd) / 'wrong.py'; f.write_text('raise AssertionError("must not execute")')
        with self.assertRaises(M.Refuse): M.load_pinned(str(f), M.LAUNCHER_SHA)

    def test_active_production_refused(self):
        c = M.Ctx()
        with patch.object(M, 'unit_state', return_value={'ActiveState': 'active'}):
            with self.assertRaises(M.Refuse): M.quiet(c)

    def test_os_inode_drift_and_symlink_refused(self):
        f = Path(self.rd) / 'os'; f.write_bytes(b'x')
        c = M.Ctx(dict(M.DEFAULT_CFG, osDisk=str(f)))
        with self.assertRaises(M.Refuse): M.os_identity(c, {'ino': f.stat().st_ino + 1})
        link = Path(self.rd) / 'link'; link.symlink_to(f)
        c.cfg['osDisk'] = str(link)
        with self.assertRaises(M.Refuse): M.os_identity(c, {})

    def test_sparse_copy_hash_readback_and_timeout(self):
        a, b = Path(self.rd) / 'a', Path(self.rd) / 'b'
        with a.open('wb') as f: f.seek(5 << 20); f.write(b'ending')
        with a.open('rb') as src, b.open('w+b') as dst:
            h, copied = M.hash_copy(src.fileno(), a.stat().st_size, 10, lambda: 0, dst.fileno())
            dst.truncate(a.stat().st_size); dst.flush()
        with b.open('rb') as f:
            self.assertEqual(M.hash_copy(f.fileno(), b.stat().st_size, 10, lambda: 0)[0], h)
            with self.assertRaises(M.Refuse): M.hash_copy(f.fileno(), b.stat().st_size, 0, lambda: 1)
        self.assertEqual(a.read_bytes(), b.read_bytes())
        self.assertLess(copied, a.stat().st_size)

    def test_backup_failure_never_writes_prepared_or_launches(self):
        c = M.Ctx(stamp=lambda: '20261028T020000Z-abcdef')
        ev = Path(self.rd) / 'evidence'; ev.mkdir()
        fakeid = {'size': 10, 'ino': 3, 'dev': 4}
        with patch.object(M, 'load_pins', return_value=(self.launcher, self.manifest)), \
             patch.object(M, 'host_checks', return_value=fakeid), \
             patch.object(M, 'nvme', return_value={}), \
             patch.object(M, 'read_nofollow', return_value=(b'fixture', None)), \
             patch.object(M, 'backup', side_effect=M.Refuse('copy failed')):
            with self.assertRaises(M.Refuse): M.cmd_prepare(c, str(ev), self.rd)
        self.assertFalse((ev / 'PREPARED.json').exists())
        self.assertTrue((ev / 'BACKUP-FAILED.json').exists())
        with self.assertRaises(OSError): M.load_prepared(str(ev))

    def test_cleanup_cannot_stop_foreign_invocation(self):
        calls = []
        c = M.Ctx(run=lambda argv, **kw: calls.append(argv))
        plan = {'unit': 'enclave-rpc-maint-owned.service', 'argv': self.argv}
        state = {'ActiveState': 'active', 'InvocationID': 'foreign'}
        with patch.object(M, 'wait_unit_inactive', return_value=state):
            r = M.cleanup(c, None, plan, 'ours', 0)
        self.assertIn('refused', r['stop']); self.assertEqual(calls, [])

    def test_no_guest_shutdown_event_is_not_success(self):
        q = types.SimpleNamespace(events=[{'event': 'SHUTDOWN', 'data': {'guest': False}}])
        self.assertFalse(M.guest_shutdown_seen(q))
        q.events.append({'event': 'SHUTDOWN', 'data': {'guest': True}})
        self.assertTrue(M.guest_shutdown_seen(q))

    def test_powerdown_requires_event_exit_and_inactive_unit(self):
        c = M.Ctx()
        q = types.SimpleNamespace(cmd=lambda cmd: None, pump=lambda n: False, eof=True,
                                  events=[{'event': 'SHUTDOWN', 'data': {'guest': True}}])
        plan = {'unit': 'enclave-rpc-maint-fixture.service', 'argv': self.argv}
        with patch.object(M, 'wait_unit_inactive', return_value={'ActiveState': 'inactive', 'LoadState': 'loaded', 'Result': 'success'}), \
             patch.object(M, 'same_process', return_value=False):
            self.assertTrue(M.powerdown(c, q, plan, 123)['verified'])
            q.events.clear()
            self.assertFalse(M.powerdown(c, q, plan, 123)['verified'])
        q.events = [{'event': 'SHUTDOWN', 'data': {'guest': True}}]
        with patch.object(M, 'wait_unit_inactive', return_value={'ActiveState': 'active', 'Result': 'success'}), \
             patch.object(M, 'same_process', return_value=True):
            self.assertFalse(M.powerdown(c, q, plan, 123)['verified'])

class Guest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        (self.root / 'sys/block/sda').mkdir(parents=True)
        (self.root / 'dev/disk/by-uuid').mkdir(parents=True)
    def test_chain_uuid_or_second_disk_refuses_before_changes(self):
        G.chain_absent(str(self.root))
        f = self.root / 'dev/disk/by-uuid' / G.CHAIN_UUIDS[0]; f.symlink_to('/missing')
        with self.assertRaises(G.Die): G.chain_absent(str(self.root))
        f.unlink(); (self.root / 'sys/block/sdb').mkdir()
        with self.assertRaises(G.Die): G.chain_absent(str(self.root))
    def test_fragment_drift_refuses_without_moving_files(self):
        etc = self.root / 'etc/systemd/system'; etc.mkdir(parents=True)
        for u in G.UNITS: (etc / u).write_text('wrong source')
        before = {f.name: f.read_bytes() for f in etc.iterdir()}
        def run(argv, **kw):
            return types.SimpleNamespace(returncode=0, stdout='' if 'list-jobs' in argv else 'LoadState=loaded\nActiveState=inactive\n')
        self.assertEqual(G.main(['20261028T020000Z-abcdef'], root=str(self.root), run=run), 2)
        self.assertEqual(before, {f.name: f.read_bytes() for f in etc.iterdir()})
        self.assertFalse((self.root / 'var/lib/enclave-rpc-maint').exists())

    def test_full_mask_preserves_originals_and_removes_enablement(self):
        import hashlib
        etc = self.root / 'etc/systemd/system'; etc.mkdir(parents=True)
        wants = etc / 'multi-user.target.wants'; wants.mkdir()
        originals = {u: ('fixture ' + u).encode() for u in G.UNITS}
        pins = {u: hashlib.sha256(b).hexdigest() for u, b in originals.items()}
        for u, b in originals.items():
            (etc / u).write_bytes(b); (wants / u).symlink_to('../' + u)
        def run(argv, **kw):
            op = argv[1]; out = ''
            if op == 'show':
                masked = G.masked_link(str(etc / argv[-1]))
                out = 'ActiveState=inactive\nLoadState=' + ('masked' if masked else 'loaded') + '\nUnitFileState=' + ('masked' if masked else 'enabled') + '\n'
            elif op == 'disable':
                for u in pins: (wants / u).unlink()
            elif op == 'mask':
                for u in pins: (etc / u).symlink_to('/dev/null')
            elif op not in ('daemon-reload', 'list-jobs'):
                raise AssertionError(argv)
            return types.SimpleNamespace(returncode=0, stdout=out)
        with patch.object(G, 'UNITS', pins), patch.object(G.os, 'sync'):
            self.assertEqual(G.main(['20261028T020000Z-abcdef'], root=str(self.root), run=run), 0)
        kept = self.root / 'var/lib/enclave-rpc-maint/20261028T020000Z-abcdef'
        for u, b in originals.items():
            self.assertEqual((kept / u).read_bytes(), b)
            self.assertTrue(G.masked_link(str(etc / u)))
        self.assertFalse(list(wants.iterdir()))

if __name__ == '__main__': unittest.main()
