"""rpc/snp/disk_guard.py: superblock arithmetic, growth rate and the warn/trim/stop decision.

python3 -m unittest test/rpc-snp/test_disk_guard.py
"""
from pathlib import Path
import shutil
import struct
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'rpc/snp'))
import disk_guard as G  # noqa: E402

GIB = G.GIB


def superblock(blocks, free, log_bs=2, wide=True):
    sb = bytearray(1024)
    struct.pack_into('<I', sb, 4, blocks & 0xffffffff)
    struct.pack_into('<I', sb, 12, free & 0xffffffff)
    struct.pack_into('<I', sb, 24, log_bs)
    struct.pack_into('<H', sb, 0x38, 0xEF53)
    struct.pack_into('<I', sb, 0x60, 0x80 if wide else 0)
    struct.pack_into('<I', sb, 0x150, blocks >> 32 if wide else 0xdeadbeef)
    struct.pack_into('<I', sb, 0x158, free >> 32 if wide else 0xdeadbeef)
    return bytes(sb)


class Superblock(unittest.TestCase):
    def test_production_l1_numbers(self):
        # enc-l1-origin, 2026-11-08: 111937351 of 976562500 4 KiB blocks in use
        self.assertEqual(G.used_from_superblock(superblock(976562500, 976562500 - 111937351)), 111937351 * 4096)

    def test_high_words_need_64bit(self):
        self.assertEqual(G.used_from_superblock(superblock(1000, 400, wide=False)), 600 * 4096)
        self.assertEqual(G.used_from_superblock(superblock(5 << 32, 1 << 32)), (4 << 32) * 4096)

    def test_not_ext4(self):
        with self.assertRaises(ValueError):
            G.used_from_superblock(bytes(1024))

    @unittest.skipUnless(shutil.which('qemu-io') and shutil.which('mkfs.ext4'), 'needs qemu-io and mkfs.ext4')
    def test_reads_a_real_qcow2(self):
        with tempfile.TemporaryDirectory() as d:
            raw, img = Path(d, 'fs.raw'), Path(d, 'fs.qcow2')
            subprocess.run(['truncate', '-s', '256M', raw], check=True)
            subprocess.run(['mkfs.ext4', '-q', '-F', raw], check=True)
            subprocess.run(['qemu-img', 'convert', '-O', 'qcow2', raw, img], check=True)
            head = dict(l.split(':', 1) for l in subprocess.run(['dumpe2fs', '-h', raw], capture_output=True, text=True)
                        .stdout.splitlines() if ':' in l)
            total, free, bs = (int(head[k]) for k in ('Block count', 'Free blocks', 'Block size'))
            self.assertEqual(G.superblock_used(str(img)), (total - free) * bs)
            r = G.disk_report([str(img)])[0]
            self.assertIn('reclaimableGiB', r)


class Decide(unittest.TestCase):
    a = G.parse(['guest.service', '/vm', '100', '--launch-config', 'c.json', '--trim-unit', 'trim.service',
                 '--trim-state', 's.json'])

    def test_defaults(self):
        self.assertEqual((self.a.floor, self.a.trim_at, self.a.warn_at, self.a.min_reclaim),
                         (100 * GIB, 150 * GIB, 250 * GIB, 50 * GIB))

    def test_plenty_of_space(self):
        self.assertIsNone(G.decide(485 * GIB, self.a, 300 * GIB, {}, 0))

    def test_trim_when_low_and_reclaimable(self):
        self.assertEqual(G.decide(140 * GIB, self.a, 246 * GIB, {}, 10**9), 'trim')
        self.assertEqual(G.decide(90 * GIB, self.a, 246 * GIB, {}, 10**9), 'trim')

    def test_little_reclaimable_means_real_growth(self):
        self.assertIsNone(G.decide(140 * GIB, self.a, 10 * GIB, {}, 10**9))
        self.assertEqual(G.decide(90 * GIB, self.a, 10 * GIB, {}, 10**9), 'stop')

    def test_cooldown_failed_and_running_trims_fall_back_to_floor(self):
        now = 10**9
        for state in ({'result': 'ok', 'started': now - 3600}, {'result': 'failed', 'started': 0},
                      {'result': 'running', 'started': 0}):
            self.assertIsNone(G.decide(140 * GIB, self.a, 246 * GIB, state, now))
            self.assertEqual(G.decide(90 * GIB, self.a, 246 * GIB, state, now), 'stop')
        self.assertEqual(G.decide(140 * GIB, self.a, 246 * GIB, {'result': 'ok', 'started': now - 25 * 3600}, now), 'trim')

    def test_without_trim_unit_only_the_floor(self):
        a = G.parse(['guest.service', '/vm', '100'])
        self.assertIsNone(G.decide(140 * GIB, a, 246 * GIB, {}, 10**9))
        self.assertEqual(G.decide(90 * GIB, a, 246 * GIB, {}, 10**9), 'stop')

    def test_trim_unit_needs_its_inputs(self):
        with self.assertRaises(SystemExit):
            G.parse(['guest.service', '/vm', '100', '--trim-unit', 'trim.service'])


class Growth(unittest.TestCase):
    def test_rate(self):
        self.assertIsNone(G.growth_per_day([(0, 500 * GIB)]))
        self.assertIsNone(G.growth_per_day([(0, 500 * GIB), (1800, 499 * GIB)]))
        self.assertAlmostEqual(G.growth_per_day([(0, 500 * GIB), (43200, 496.5 * GIB)]) / GIB, 7.0)


if __name__ == '__main__':
    unittest.main()
