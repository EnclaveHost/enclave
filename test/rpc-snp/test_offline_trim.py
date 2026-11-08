"""rpc/snp/offline_trim.py: free-range parsing, alignment, the run's stop/start rules, and a real trim of a
scratch qcow2 overlay (skipped without qemu-storage-daemon, e2fsprogs and FUSE).

python3 -m unittest test/rpc-snp/test_offline_trim.py
"""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import offline_trim as T  # noqa: E402

DUMP = '''Filesystem volume name:   enc-l1-origin
Filesystem features:      has_journal ext_attr resize_inode dir_index filetype extent 64bit flex_bg sparse_super
Filesystem state:         clean
Block size:               4096
Free blocks:              40

Group 0: (Blocks 0-32767)
  Free blocks: 100-131, 32760-32767
Group 1: (Blocks 32768-65535)
  Free blocks: 32768-32770, 40000
Group 2: (Blocks 65536-98303)
  Free blocks:
'''


class Parse(unittest.TestCase):
    def test_ranges_merge_across_groups(self):
        bs, r = T.free_ranges(DUMP)
        self.assertEqual(bs, 4096)
        self.assertEqual(r, [[100, 131], [32760, 32770], [40000, 40000]])

    def test_refuses_unclean_or_unrecovered(self):
        with self.assertRaises(T.Refused):
            T.free_ranges(DUMP.replace('state:         clean', 'state:         not clean'))
        with self.assertRaises(T.Refused):
            T.free_ranges(DUMP.replace('has_journal', 'has_journal needs_recovery'))

    def test_spans_shrink_inward_to_clusters(self):
        # blocks 100-131 = bytes 409600-540671: whole 64 KiB clusters 458752-524288 only
        self.assertEqual(T.byte_ranges(4096, [[100, 131]]), [(458752, 65536)])
        self.assertEqual(T.byte_ranges(4096, [[40000, 40000]]), [])
        self.assertEqual(T.byte_ranges(4096, [[16, 47]]), [(65536, 131072)])


class Run(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        d = Path(self.tmp.name)
        self.disks = [str(d/'l1.qcow2'), str(d/'base.qcow2')]
        for p in self.disks:
            Path(p).write_bytes(b'')
        self.config = d/'launch.json'
        self.config.write_text(json.dumps({'disks': [{'path': p, 'discard': True} for p in self.disks]
                                          + [{'path': str(d/'other.qcow2')}]}))
        self.state = str(d/'state/trim.json')
        self.calls, self.active = [], 'inactive'

    def tearDown(self):
        self.tmp.cleanup()

    def ctl(self, *args):
        self.calls.append(args)
        return subprocess.CompletedProcess(args, 0, stdout=self.active + '\n')

    def go(self, trim, **kw):
        return T.run('guest.service', str(self.config), self.state, trim=trim, ctl=self.ctl, log=lambda *a, **k: None, **kw)

    def test_ok_stops_trims_discard_disks_then_starts(self):
        seen = []
        s = self.go(lambda p, log: seen.append(p) or {'disk': p})
        self.assertEqual(seen, self.disks)
        self.assertEqual([c for c in self.calls if c[0] != 'is-active'], [('stop', 'guest.service'), ('start', 'guest.service')])
        self.assertEqual(s['result'], 'ok')
        self.assertEqual(json.load(open(self.state))['result'], 'ok')

    def test_refused_disk_is_skipped_and_guest_starts(self):
        def trim(p, log):
            if p.endswith('l1.qcow2'):
                raise T.Refused('filesystem not clean')
            return {'disk': p}
        s = self.go(trim)
        self.assertEqual(s['result'], 'partial')
        self.assertIn(('start', 'guest.service'), self.calls)

    def test_failure_holds_the_guest_and_blocks_reruns(self):
        def trim(p, log):
            raise T.Failed('e2fsck -fn rc=4 after')
        with self.assertRaises(SystemExit):
            self.go(trim)
        self.assertNotIn(('start', 'guest.service'), self.calls)
        self.assertEqual(json.load(open(self.state))['result'], 'failed')
        with self.assertRaises(SystemExit):
            self.go(lambda p, log: {'disk': p}, now=lambda: 10**12)
        self.go(lambda p, log: {'disk': p}, force=True)

    def test_cooldown(self):
        self.go(lambda p, log: {'disk': p}, now=lambda: 1000.0)
        with self.assertRaises(SystemExit):
            self.go(lambda p, log: {'disk': p}, now=lambda: 1000.0 + 23 * 3600)
        self.go(lambda p, log: {'disk': p}, now=lambda: 1000.0 + 25 * 3600)

    def test_unit_that_will_not_stop_is_left_running_untouched(self):
        self.active = 'active'
        with self.assertRaises(SystemExit):
            self.go(lambda p, log: self.fail('trimmed a disk in use'))
        self.assertEqual(json.load(open(self.state))['result'], 'refused')


TOOLS = all(shutil.which(t) for t in ('qemu-storage-daemon', 'qemu-img', 'mkfs.ext4', 'debugfs', 'e2fsck', 'dumpe2fs', 'fusermount3'))


@unittest.skipUnless(TOOLS, 'needs qemu-storage-daemon, qemu-img, e2fsprogs and fusermount3')
class RealTrim(unittest.TestCase):
    """An overlay with a backing file, files kept and deleted in both layers, as on the production L1 disk."""
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.d = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def sh(self, *a):
        subprocess.run(a, check=True, capture_output=True)

    def put(self, raw, name, mib):
        src = self.d/name
        src.write_bytes(os.urandom(mib << 20))
        self.sh('debugfs', '-w', '-R', 'write %s %s' % (src, name), raw)
        return hashlib.sha256(src.read_bytes()).hexdigest()

    def test_freed_space_returns_and_kept_data_survives(self):
        base, ov = str(self.d/'base.qcow2'), str(self.d/'ov.qcow2')
        self.sh('qemu-img', 'create', '-q', '-f', 'qcow2', base, '2G')
        work = tempfile.mkdtemp(dir=self.d)
        with T.Export(base, work) as raw:
            self.sh('mkfs.ext4', '-q', '-F', raw)
            self.put(raw, 'b0', 60)
        base_sha = hashlib.sha256(Path(base).read_bytes()).hexdigest()
        self.sh('qemu-img', 'create', '-q', '-f', 'qcow2', '-b', base, '-F', 'qcow2', ov)
        keep = {}
        with T.Export(ov, work) as raw:
            for i, mib in enumerate((30, 45, 25, 50)):
                keep['f%d' % i] = self.put(raw, 'f%d' % i, mib)
            for gone in ('f1', 'f3', 'b0'):
                self.sh('debugfs', '-w', '-R', 'rm ' + gone, raw)
                keep.pop(gone, None)
        before = T.allocated(ov)
        r = T.trim_disk(ov, log=lambda *a, **k: None)
        self.assertEqual(r['qcow2Check'], 'clean')
        self.assertLess(r['afterBytes'], before - (90 << 20))
        self.assertLess(r['afterBytes'], (60 << 20))
        with T.Export(ov, work) as raw:
            for name, digest in keep.items():
                out = self.d/('out-' + name)
                self.sh('debugfs', '-R', 'dump %s %s' % (name, out), raw)
                self.assertEqual(hashlib.sha256(out.read_bytes()).hexdigest(), digest, name)
            self.assertEqual(subprocess.run(['e2fsck', '-fn', raw], capture_output=True).returncode, 0)
        self.assertEqual(hashlib.sha256(Path(base).read_bytes()).hexdigest(), base_sha)

    def test_image_in_use_is_refused(self):
        img = str(self.d/'busy.qcow2')
        self.sh('qemu-img', 'create', '-q', '-f', 'qcow2', img, '1G')
        work = tempfile.mkdtemp(dir=self.d)
        with T.Export(img, work) as raw:
            self.sh('mkfs.ext4', '-q', '-F', raw)
            with self.assertRaises(T.Refused):
                T.trim_disk(img, log=lambda *a, **k: None)


if __name__ == '__main__':
    unittest.main()
