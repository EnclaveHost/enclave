"""Seam tests for the rendered holder-storage.sh: the REAL script (rendered by holder.storage_script) runs under bash with
the privileged commands replaced by test/stubs (losetup, dmsetup, mount, umount, findmnt, lsblk, blockdev, mkfs.ext4,
e2fsck, modprobe, chown: a recorded state machine with failure injection). fallocate, dd, stat, du, mkdir and chmod are
REAL, on small files. This tests the script's own ordering, ownership, refusal and unwind logic; it does NOT test the
kernel's dm-cache (that is drill-cache.sh, root only, not run here)."""
import copy, importlib.util, json, os, shutil, subprocess, tempfile, unittest
from pathlib import Path
HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('holder', HERE.parent / 'holder.py')
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
EXAMPLE = json.loads((HERE.parent / 'holder.example.json').read_text())
MiB = 1 << 20


class Storage(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp(prefix='hs-'))
        self.hdd, self.nvme, self.mnt = self.t / 'hdd', self.t / 'nvme', self.t / 'mnt'
        for d in (self.hdd, self.nvme):
            d.mkdir()
        raw = copy.deepcopy(EXAMPLE)
        raw['binary']['sha256'] = 'ab' * 32
        raw['l1'] = {'executionRpc': 'https://l1.example.org/', 'beacon': 'https://beacon.example.org/', 'trustRpc': False}
        c = H.validate(raw)
        # the validated shape, then SMALL sizes for the seam test (validation minimums are for real deployments)
        c['storage'].update(mountPoint=str(self.mnt), nvmeInventoryPath=str(self.t / 'inventory.tsv'),
                            originFreeMarginBytes=0, nvmeFreeMarginBytes=0)
        c['datadir'] = str(self.mnt / 'data')
        c['storage']['origin'] = {'imagePath': str(self.hdd / 'origin.img'), 'bytes': 8 * MiB}
        c['storage']['cache'].update(dataImagePath=str(self.nvme / 'cache-data.img'), dataBytes=4 * MiB,
                                     metadataImagePath=str(self.nvme / 'cache-meta.img'), metadataBytes=16 * MiB, slackBytes=MiB)
        self.c = c
        (self.t / 'inventory.tsv').write_text('# test inventory\n')
        self.state = self.t / 'state.json'

    def tearDown(self):
        shutil.rmtree(self.t)

    def script(self, cap=H.AGGREGATE_NVME_CAP, c=None):
        p = self.t / 'holder-storage.sh'
        p.write_text(H.storage_script(c or self.c, cap=cap))
        p.chmod(0o700)
        return p

    def run_sh(self, verb, fail='', cap=H.AGGREGATE_NVME_CAP, c=None, rot=None):
        env = {'PATH': f"{HERE / 'stubs'}:/usr/bin:/bin", 'STUB_STATE': str(self.state), 'STUB_FAIL': fail,
               'STUB_ROT': json.dumps(rot or {str(self.hdd): '1', str(self.nvme): '0', str(self.t): '0'}),
               'STUB_CMETA': str(self.nvme / 'cache-meta.img')}
        r = subprocess.run(['bash', str(self.script(cap, c)), verb], env=env, capture_output=True, text=True, timeout=60)
        return r

    def st(self):
        return json.loads(self.state.read_text()) if self.state.exists() else {'loops': {}, 'dm': {}, 'mounts': {}, 'calls': []}

    def seed(self, **kw):
        s = self.st(); s.setdefault('next', 0); s.update(kw); self.state.write_text(json.dumps(s))

    def calls(self, name):
        return [c for c in self.st()['calls'] if c[0] == name]

    def create(self):
        r = self.run_sh('create')
        self.assertEqual(r.returncode, 0, r.stderr)

    # -- create --
    def test_create_preallocates_exact_sizes_and_leaves_nothing_attached(self):
        self.create()
        for f, n in (('hdd/origin.img', 8 * MiB), ('nvme/cache-data.img', 4 * MiB), ('nvme/cache-meta.img', 16 * MiB)):
            st = os.stat(self.t / f)
            self.assertEqual(st.st_size, n)
            self.assertGreaterEqual(st.st_blocks * 512, n, f'{f} is preallocated, not sparse')
        self.assertEqual(open(self.nvme / 'cache-meta.img', 'rb').read(8 * MiB), bytes(8 * MiB))
        self.assertEqual(len(self.calls('mkfs.ext4')), 1)
        self.assertEqual(self.st()['loops'], {}, 'create detaches what it attached')

    def test_create_refuses_existing_targets_and_touches_nothing(self):
        (self.hdd / 'origin.img').write_bytes(b'precious')
        r = self.run_sh('create')
        self.assertEqual(r.returncode, 2)
        self.assertIn('exists', r.stderr)
        self.assertEqual((self.hdd / 'origin.img').read_bytes(), b'precious')
        self.assertFalse((self.nvme / 'cache-data.img').exists())
        self.assertEqual(self.calls('losetup'), [])

    def test_create_refuses_wrong_media_before_allocating(self):
        for rot, needle in (({str(self.hdd): '0', str(self.nvme): '0', str(self.t): '0'}, 'rotational'),
                            ({str(self.hdd): '1', str(self.nvme): '1', str(self.t): '0'}, 'NVMe')):
            r = self.run_sh('create', rot=rot)
            self.assertEqual(r.returncode, 2)
            self.assertIn(needle, r.stderr)
            self.assertEqual(sorted(p.name for p in self.hdd.iterdir()) + sorted(p.name for p in self.nvme.iterdir()), [])

    def test_create_refuses_over_aggregate_cap_using_measured_inventory(self):
        other = self.t / 'sia-cache'
        other.mkdir()
        subprocess.run(['fallocate', '-l', str(8 * MiB), str(other / 'blob')], check=True)
        (self.t / 'inventory.tsv').write_text(f'sia cache\t{other}\n')
        cap = 4 * MiB + 16 * MiB + MiB + 8 * MiB - 1          # holder plan + slack + MEASURED other = cap + 1
        r = self.run_sh('create', cap=cap)
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn('aggregate NVMe cap', r.stderr)
        self.assertFalse((self.hdd / 'origin.img').exists(), 'nothing allocated')
        r = self.run_sh('create', cap=cap + 1)                 # exactly at the cap: allowed
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_create_failure_unwinds_only_its_own_resources(self):
        foreign = self.t / 'foreign.img'
        foreign.write_bytes(b'x')
        self.seed(loops={'/dev/loop9': str(foreign)}, next=0)
        r = self.run_sh('create', fail='mkfs')
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.hdd / 'origin.img').exists(), 'the image it created is removed')
        self.assertEqual(self.st()['loops'], {'/dev/loop9': str(foreign)}, 'its own loop detached, the foreign one kept')
        self.assertEqual(foreign.read_bytes(), b'x')

    # -- assemble --
    def expected_table(self, s):
        o, d, m = (next(k for k, v in s['loops'].items() if v == str(p)) for p in (self.hdd / 'origin.img', self.nvme / 'cache-data.img', self.nvme / 'cache-meta.img'))
        mm = lambda dev: '7:' + dev[9:]
        return f"0 {8 * MiB // 512} cache {mm(m)} {mm(d)} {mm(o)} 512 1 writethrough smq 0"

    def test_assemble_maps_writethrough_and_mounts_then_adopts_only_identical(self):
        self.create()
        r = self.run_sh('assemble')
        self.assertEqual(r.returncode, 0, r.stderr)
        s = self.st()
        self.assertEqual(s['dm'], {'enclave-base-holder': self.expected_table(s)})
        self.assertEqual(s['mounts'], {str(self.mnt): '253:0'})
        self.assertTrue((self.mnt / 'data').is_dir() and (self.mnt / 'tmp').is_dir())
        loops = dict(s['loops'])
        r = self.run_sh('assemble')                            # idempotent: adopts the identical mapping and mount
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.st()['loops'], self.st()['dm']), (loops, s['dm']))
        self.assertEqual(len([c for c in self.calls('dmsetup') if c[1] == 'create']), 1)

    def test_assemble_refuses_foreign_mapping_and_unwinds_its_loops(self):
        self.create()
        self.seed(dm={'enclave-base-holder': '0 100 linear 8:1 0'})
        r = self.run_sh('assemble')
        self.assertEqual(r.returncode, 2)
        self.assertIn('not this holder', r.stderr)
        s = self.st()
        self.assertEqual(s['dm'], {'enclave-base-holder': '0 100 linear 8:1 0'}, 'foreign mapping untouched')
        self.assertEqual(s['loops'], {}, 'loops this run attached were detached')
        self.assertEqual(s['mounts'], {})

    def test_assemble_refuses_foreign_mount(self):
        self.create()
        self.seed(mounts={str(self.mnt): '8:17'})
        r = self.run_sh('assemble')
        self.assertEqual(r.returncode, 2)
        self.assertIn('another device', r.stderr)
        s = self.st()
        self.assertEqual(s['mounts'], {str(self.mnt): '8:17'})
        self.assertEqual((s['dm'], s['loops']), ({}, {}), 'its new mapping and loops were undone')

    def test_assemble_failure_keeps_preexisting_loops(self):
        self.create()
        self.seed(loops={'/dev/loop7': str(self.hdd / 'origin.img')}, next=8)   # origin already attached before this run
        r = self.run_sh('assemble', fail='dmsetup-create')
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.st()['loops'], {'/dev/loop7': str(self.hdd / 'origin.img')}, 'new cache loops detached; the pre-existing origin loop kept')

    def test_assemble_refuses_origin_mounted_without_cache(self):
        self.create()
        self.seed(loops={'/dev/loop7': str(self.hdd / 'origin.img')}, next=8, mounts={str(self.t / 'elsewhere'): '7:7'})
        r = self.run_sh('assemble')
        self.assertEqual(r.returncode, 2)
        self.assertIn('stale-cache hazard', r.stderr)
        self.assertEqual(self.st()['dm'], {})

    # -- disassemble --
    def assembled(self):
        self.create()
        r = self.run_sh('assemble')
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_disassemble_stops_at_failed_unmount(self):
        self.assembled()
        before = self.st()
        r = self.run_sh('disassemble', fail='umount')
        self.assertEqual(r.returncode, 2)
        s = self.st()
        self.assertEqual((s['dm'], s['loops'], s['mounts']), (before['dm'], before['loops'], before['mounts']))

    def test_disassemble_stops_at_failed_unmap(self):
        self.assembled()
        loops = self.st()['loops']
        r = self.run_sh('disassemble', fail='dmsetup-remove')
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.st()['loops'], loops, 'loops kept under a live mapping')

    def test_disassemble_refuses_foreign_mapping(self):
        self.assembled()
        self.run_sh('disassemble')
        self.create_loops_and_foreign = None
        self.seed(dm={'enclave-base-holder': '0 100 linear 8:1 0'}, loops={'/dev/loop3': str(self.hdd / 'origin.img'),
                  '/dev/loop4': str(self.nvme / 'cache-data.img'), '/dev/loop5': str(self.nvme / 'cache-meta.img')})
        r = self.run_sh('disassemble')
        self.assertEqual(r.returncode, 2)
        self.assertEqual(self.st()['dm'], {'enclave-base-holder': '0 100 linear 8:1 0'})

    def test_disassemble_clean(self):
        self.assembled()
        r = self.run_sh('disassemble')
        self.assertEqual(r.returncode, 0, r.stderr)
        s = self.st()
        self.assertEqual((s['dm'], s['loops'], s['mounts']), ({}, {}, {}))

    # -- cache loss --
    def test_cache_loss_invalidates_before_touching_origin(self):
        self.assembled()
        r = self.run_sh('cache-loss')
        self.assertEqual(r.returncode, 2)
        self.assertIn('is mounted', r.stderr)
        with open(self.nvme / 'cache-meta.img', 'r+b') as f:
            f.write(b'\xff' * MiB)                            # pretend live cache metadata
        self.seed(mounts={})
        r = self.run_sh('cache-loss')
        self.assertEqual(r.returncode, 0, r.stderr)
        s = self.st()
        self.assertEqual(s['dm'], {})
        self.assertTrue(s.get('metaZeroAtFsck'), 'metadata was zeroed BEFORE the origin was checked')
        self.assertIn('EMPTY cache', r.stderr)

    # -- cap verification --
    def test_verify_cap_measures_allocated_bytes(self):
        self.create()
        other = self.t / 'sia'
        other.mkdir()
        subprocess.run(['fallocate', '-l', str(2 * MiB), str(other / 'blob')], check=True)
        (self.t / 'inventory.tsv').write_text(f'sia cache\t{other}\n# comment\nmissing\t{self.t / "absent"}\n')
        r = self.run_sh('verify-cap-measured')
        self.assertEqual(r.returncode, 0, r.stderr)
        vals = dict(kv.split('=') for kv in r.stdout.split())
        self.assertEqual(int(vals['holderBytes']), 20 * MiB)
        self.assertGreaterEqual(int(vals['otherMeasuredBytes']), 2 * MiB)
        r = self.run_sh('verify-cap-measured', cap=int(vals['totalBytes']) - 1)
        self.assertEqual(r.returncode, 3)

    def test_no_cache_layout_mounts_origin_loop(self):
        c = copy.deepcopy(self.c)
        c['storage']['cache'] = {'mechanism': 'none'}
        self.assertEqual(self.run_sh('create', c=c).returncode, 0)
        r = self.run_sh('assemble', c=c)
        self.assertEqual(r.returncode, 0, r.stderr)
        s = self.st()
        self.assertEqual(s['dm'], {})
        self.assertEqual(list(s['mounts'].values()), ['7:' + next(iter(s['loops']))[9:]])
        self.assertFalse((self.nvme / 'cache-data.img').exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
