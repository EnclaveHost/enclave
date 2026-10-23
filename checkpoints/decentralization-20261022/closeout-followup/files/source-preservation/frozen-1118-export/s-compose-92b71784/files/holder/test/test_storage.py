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
        raw['binary']['sha256'] = H.BINARY['binary']['sha256']
        raw['l1'] = {'executionRpc': 'https://l1.example.org/', 'beacon': 'https://beacon.example.org/', 'trustRpc': False}
        c = H.validate(raw)
        # the validated shape, then SMALL sizes for the seam test (validation minimums are for real deployments)
        c['storage'].update(mountPoint=str(self.mnt), originFreeMarginBytes=0, nvmeFreeMarginBytes=0)
        c['storage']['nvmeBudget'] = dict(c['storage']['nvmeBudget'], ledgerPath=str(self.t / 'budget.json'))
        c['datadir'] = str(self.mnt / 'data')
        c['storage']['origin'] = {'imagePath': str(self.hdd / 'origin.img'), 'bytes': 8 * MiB}
        c['storage']['cache'].update(dataImagePath=str(self.nvme / 'cache-data.img'), dataBytes=4 * MiB,
                                     metadataImagePath=str(self.nvme / 'cache-meta.img'), metadataBytes=16 * MiB, slackBytes=MiB)
        self.c = c
        self.mid = H.BUDGET.machine_id()               # this host's real /etc/machine-id (read only)
        self.write_ledger()
        self.state = self.t / 'state.json'

    def tearDown(self):
        shutil.rmtree(self.t)

    def write_ledger(self, extra=(), share=H.BUDGET.TARGET, mutate=None):
        r = dict(H.budget_reservation(self.c), host=self.mid)
        doc = {'format': H.BUDGET.FORMAT, 'capBytes': H.BUDGET.CAP, 'targetBytes': H.BUDGET.TARGET,
               'hosts': [{'machineId': self.mid, 'label': 'test', 'shareBytes': share}], 'reservations': [r, *extra]}
        if mutate:
            mutate(doc)
        p = self.t / 'budget.json'
        p.write_text(json.dumps(doc))
        p.chmod(0o644)
        return doc

    def script(self, c=None):
        p = self.t / 'holder-storage.sh'
        p.write_text(H.storage_script(c or self.c, budget_tool=str(HERE.parent / 'budget.py')))
        p.chmod(0o700)
        return p

    def run_sh(self, verb, fail='', c=None, rot=None):
        env = {'PATH': f"{HERE / 'stubs'}:/usr/bin:/bin", 'STUB_STATE': str(self.state), 'STUB_FAIL': fail,
               'STUB_ROT': json.dumps(rot or {str(self.hdd): '1', str(self.nvme): '0', str(self.t): '0'}),
               'STUB_CMETA': str(self.nvme / 'cache-meta.img')}
        r = subprocess.run(['bash', str(self.script(c)), verb], env=env, capture_output=True, text=True, timeout=60)
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

    def test_create_requires_the_exact_ledger_reservation_before_allocating(self):
        cases = [
            (lambda d: d.update(reservations=[]), 'not in the ledger'),
            (lambda d: d['reservations'][0]['files'][0].update(bytes=8 * MiB) or d['reservations'][0].update(maxBytes=8 * MiB + 16 * MiB + MiB), 'differ from this configuration'),
            (lambda d: d['hosts'].append({'machineId': 'cd' * 16, 'label': 'other', 'shareBytes': H.BUDGET.CAP}), 'host shares sum'),
            (lambda d: d['reservations'][0].update(kind='directory'), 'not hard-bounded'),
            (lambda d: d['reservations'][0].update(host='cd' * 16) or d['hosts'].append({'machineId': 'cd' * 16, 'label': 'o', 'shareBytes': 1 << 30}), 'belongs to host'),
        ]
        for mutate, needle in cases:
            with self.subTest(needle=needle):
                self.write_ledger(mutate=mutate)
                r = self.run_sh('create')
                self.assertEqual(r.returncode, 2, r.stderr)
                self.assertIn(needle, r.stderr)
                self.assertEqual(sorted(p.name for p in self.hdd.iterdir()) + sorted(p.name for p in self.nvme.iterdir()), [],
                                 'nothing allocated')
        self.write_ledger()
        (self.nvme / 'cache-data.img').write_bytes(b'foreign')          # present WITHOUT this reservation's marker
        r = self.run_sh('create')
        self.assertEqual(r.returncode, 2)
        self.assertIn('ownership marker', r.stderr)
        self.assertEqual((self.nvme / 'cache-data.img').read_bytes(), b'foreign')
        self.assertFalse((self.hdd / 'origin.img').exists())

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
    def test_unwind_keeps_image_when_detach_fails(self):
        r = self.run_sh('create', fail='mkfs,losetup-detach')
        self.assertEqual(r.returncode, 1, r.stderr)
        self.assertTrue((self.hdd / 'origin.img').exists(), 'never unlink a still-attached image')
        self.assertIn(str(self.hdd / 'origin.img'), self.st()['loops'].values())
        self.assertIn('cleanup stopped', r.stderr)

    def test_unwind_stops_when_mapping_removal_fails(self):
        self.create()
        before = len(self.st()['calls'])
        r = self.run_sh('assemble', fail='mount,dmsetup-remove')
        self.assertEqual(r.returncode, 1, r.stderr)
        s = self.st()
        self.assertTrue(s['dm'], 'failed cleanup retains the mapping')
        self.assertEqual(len(s['loops']), 3, 'loops must remain under the live mapping')
        self.assertFalse(any(c[:2] == ['losetup', '-d'] for c in s['calls'][before:]))
        self.assertIn('cleanup stopped', r.stderr)

    def test_unwind_stops_when_unmount_fails(self):
        self.create()
        before = len(self.st()['calls'])
        r = self.run_sh('assemble', fail='chown,umount')
        self.assertEqual(r.returncode, 1, r.stderr)
        s = self.st()
        self.assertEqual(s['mounts'], {str(self.mnt): '253:0'})
        self.assertTrue(s['dm'])
        self.assertEqual(len(s['loops']), 3)
        self.assertFalse(any(c[:2] in [['dmsetup', 'remove'], ['losetup', '-d']] for c in s['calls'][before:]))
        self.assertIn('cleanup stopped', r.stderr)

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

    def test_disassemble_refuses_foreign_mount_without_mutation(self):
        self.assembled()
        self.seed(mounts={str(self.mnt): '8:17'})
        before = self.st()
        r = self.run_sh('disassemble')
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn('another device', r.stderr)
        after = self.st()
        self.assertEqual((after['dm'], after['loops'], after['mounts']),
                         (before['dm'], before['loops'], before['mounts']))
        self.assertFalse(any(c[0] == 'umount' for c in after['calls'][len(before['calls']):]))

    def test_disassemble_checks_mapping_before_unmount(self):
        self.assembled()
        self.seed(dm={'enclave-base-holder': '0 100 linear 8:1 0'})
        before = self.st()
        r = self.run_sh('disassemble')
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn('not this holder', r.stderr)
        after = self.st()
        self.assertEqual((after['dm'], after['loops'], after['mounts']),
                         (before['dm'], before['loops'], before['mounts']))
        self.assertFalse(any(c[0] == 'umount' for c in after['calls'][len(before['calls']):]))

    def test_disassemble_no_cache_refuses_foreign_mount(self):
        c = copy.deepcopy(self.c)
        c['storage']['cache'] = {'mechanism': 'none'}
        self.assertEqual(self.run_sh('create', c=c).returncode, 0)
        self.assertEqual(self.run_sh('assemble', c=c).returncode, 0)
        self.seed(mounts={str(self.mnt): '8:17'})
        before = self.st()
        r = self.run_sh('disassemble', c=c)
        self.assertEqual(r.returncode, 2, r.stderr)
        after = self.st()
        self.assertEqual((after['loops'], after['mounts']), (before['loops'], before['mounts']))
        self.assertFalse(any(c[0] == 'umount' for c in after['calls'][len(before['calls']):]))

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
    def test_verify_cap_charges_maxima_and_bounds_every_local_file(self):
        other = {'id': 'sia-cache', 'host': self.mid, 'owner': 'sia', 'kind': 'preallocated-files', 'blockBytes': 4096, 'maxBytes': 10 * MiB + MiB,
                 'slackBytes': MiB, 'files': [{'path': str(self.t / 'sia.img'), 'bytes': 10 * MiB}]}
        self.write_ledger(extra=[other])
        self.create()
        r = self.run_sh('verify-cap')
        self.assertEqual(r.returncode, 0, r.stderr)
        v = json.loads(r.stdout.splitlines()[0])
        self.assertEqual(v['chargedBytes'], 21 * MiB + 11 * MiB + H.BUDGET.BOOKKEEPING_BYTES, 'the absent sia reservation is charged at its MAXIMUM, not 0')
        self.assertLessEqual(v['reservationActualBytes'], 21 * MiB)
        # the other participant's file appears, grown beyond its declared size: out of bounds, refused
        (self.t / 'sia.img.enclave-budget-owner').write_text(json.dumps({'reservation': 'sia-cache'}))
        subprocess.run(['fallocate', '-l', str(12 * MiB), str(self.t / 'sia.img')], check=True)
        r = self.run_sh('verify-cap')
        self.assertEqual(r.returncode, 3)
        self.assertIn('declared', r.stderr)
        os.remove(self.t / 'sia.img'); os.remove(self.t / 'sia.img.enclave-budget-owner')
        os.remove(self.nvme / 'cache-data.img')                         # this reservation's own file is missing
        r = self.run_sh('verify-cap')
        self.assertEqual(r.returncode, 3)
        self.assertIn('missing', r.stderr)

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


    # -- composed fixes (rpc-storage-final-compose): signal unwind, adoption free-space credit, loop policies --
    def test_term_signal_takes_the_unwind_path(self):
        """Fix 0002: SIGTERM to the whole process group (what systemd sends) mid-create runs the same unwind as an
        error (exit 143); before the fix bash skipped the EXIT trap and left the origin image + loop (vm-2/vm-3)."""
        import signal, time
        env = {'PATH': f"{HERE / 'stubs'}:/usr/bin:/bin", 'STUB_STATE': str(self.state), 'STUB_FAIL': '',
               'STUB_ROT': json.dumps({str(self.hdd): '1', str(self.nvme): '0', str(self.t): '0'}),
               'STUB_CMETA': str(self.nvme / 'cache-meta.img'), 'STUB_SLEEP': 'mkfs.ext4', 'STUB_SLEEP_SEC': '20'}
        p = subprocess.Popen(['bash', str(self.script()), 'create'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             text=True, start_new_session=True)
        for _ in range(200):                                  # wait until the slow mkfs is running (origin + loop exist)
            if self.state.exists() and self.calls('mkfs.ext4'):
                break
            time.sleep(0.05)
        self.assertTrue((self.hdd / 'origin.img').exists() and self.st()['loops'], 'signal must land mid-create')
        os.killpg(p.pid, signal.SIGTERM)
        out, err = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 143, err)
        self.assertIn('failed (rc=143): undid only what this run created', err)
        self.assertFalse((self.hdd / 'origin.img').exists(), 'the image it created is removed')
        self.assertEqual(self.st()['loops'], {}, 'the loop it attached is detached')

    def margin_for(self, path, keep):
        """A free margin that leaves exactly `keep` bytes of headroom on path's filesystem (live statvfs)."""
        st = os.statvfs(path)
        return st.f_bavail * st.f_frsize - keep

    def test_free_space_credits_owned_existing_cache_files(self):
        """Fix 0001: a re-run of create that ADOPTS this reservation's complete owned cache files needs free space only
        for what is not yet allocated (vm-2/vm-3: the production template refused)."""
        self.create()
        os.remove(self.hdd / 'origin.img')                    # as after an interrupted create: cache files + markers remain
        self.c['storage']['nvmeFreeMarginBytes'] = self.margin_for(self.nvme, 8 * MiB)   # < the 20 MiB a full re-allocation needs
        r = self.run_sh('create')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.hdd / 'origin.img').exists())

    def test_free_space_does_not_credit_foreign_or_unowned_files(self):
        for name, marker in (('unmarked', None), ('symlink', 'link')):
            with self.subTest(name):
                for f in list(self.nvme.iterdir()):
                    f.unlink()
                meta = self.nvme / 'cache-meta.img'
                if marker == 'link':
                    real = self.t / 'elsewhere.img'
                    with open(real, 'wb') as h:
                        os.posix_fallocate(h.fileno(), 0, 16 * MiB)
                    meta.symlink_to(real)
                    Path(str(meta) + '.enclave-budget-owner').write_text(json.dumps({'reservation': self.c['storage']['nvmeBudget']['reservationId']}))
                else:
                    with open(meta, 'wb') as h:
                        os.posix_fallocate(h.fileno(), 0, 16 * MiB)
                self.c['storage']['nvmeFreeMarginBytes'] = self.margin_for(self.nvme, 8 * MiB)
                r = self.run_sh('create')
                self.assertEqual(r.returncode, 2, r.stderr)
                self.assertIn('not enough NVMe free space', r.stderr, 'no credit for a file that is not an owned regular file')
                self.assertFalse((self.hdd / 'origin.img').exists())

    def test_admit_still_refuses_a_credited_file_owned_by_another_reservation(self):
        meta = self.nvme / 'cache-meta.img'
        with open(meta, 'wb') as h:
            os.posix_fallocate(h.fileno(), 0, 16 * MiB)
        Path(str(meta) + '.enclave-budget-owner').write_text(json.dumps({'reservation': 'someone-else', 'path': str(meta), 'bytes': 16 * MiB}))
        self.c['storage']['nvmeFreeMarginBytes'] = self.margin_for(self.nvme, 8 * MiB)
        r = self.run_sh('create')
        self.assertEqual(r.returncode, 2, r.stderr)
        self.assertIn('ownership marker', r.stderr, 'credit is only a preflight number: admission refuses the foreign owner')
        self.assertFalse((self.hdd / 'origin.img').exists())
        self.assertEqual(meta.stat().st_size, 16 * MiB, 'the foreign file is untouched')

    def test_free_space_does_not_credit_a_cache_file_on_another_filesystem(self):
        scratch = Path(tempfile.mkdtemp(prefix='hf-', dir=os.environ['HOLDER_NVME_SCRATCH']))   # NOT the filesystem of self.t
        try:
            if os.stat(scratch).st_dev == os.stat(self.nvme).st_dev:
                self.skipTest('scratch is on the same filesystem as the test directory')
            self.c['storage']['cache']['metadataImagePath'] = str(scratch / 'cache-meta.img')
            self.write_ledger()
            rot = {str(self.hdd): '1', str(self.nvme): '0', str(self.t): '0', str(scratch): '0'}
            self.assertEqual(self.run_sh('create', rot=rot).returncode, 0)
            os.remove(self.hdd / 'origin.img')
            # crediting BOTH files would pass; crediting only the CDATA-filesystem file must not
            self.c['storage']['nvmeFreeMarginBytes'] = self.margin_for(self.nvme, 8 * MiB)
            r = self.run_sh('create', rot=rot)
            self.assertEqual(r.returncode, 2, r.stderr)
            self.assertIn('not enough NVMe free space', r.stderr)
        finally:
            shutil.rmtree(scratch)

    def test_cache_loss_detaches_only_the_loop_it_attached(self):
        self.create()
        r = self.run_sh('cache-loss')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.st()['loops'], {}, 'its own origin loop is detached after the check')
        self.seed(loops={'/dev/loop7': str(self.hdd / 'origin.img')}, next=8)    # a loop that existed before
        r = self.run_sh('cache-loss')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.st()['loops'], {'/dev/loop7': str(self.hdd / 'origin.img')}, 'a pre-existing loop stays')

    def test_disassemble_never_detaches_an_active_loop(self):
        self.create()
        cases = [('held by a foreign mapping', {'foreign-hold': '0 100 linear 7:3 0'}, {}),
                 ('mounted elsewhere', {}, {str(self.t / 'elsewhere'): '7:3'})]
        for name, dm, mounts in cases:
            with self.subTest(name):
                self.seed(loops={'/dev/loop3': str(self.hdd / 'origin.img')}, dm=dm, mounts=mounts, next=4)
                r = self.run_sh('disassemble')
                self.assertEqual(r.returncode, 2, r.stderr)
                self.assertIn('still mounted or held', r.stderr)
                s = self.st()
                self.assertEqual(s['loops'], {'/dev/loop3': str(self.hdd / 'origin.img')}, 'the active loop is kept')
                self.assertEqual((s['dm'], s['mounts']), (dm, mounts), 'its user is untouched')
                self.assertFalse(any(c[:2] == ['losetup', '-d'] and c[2] == '/dev/loop3' for c in s['calls']))
                self.seed(loops={}, dm={}, mounts={})


if __name__ == '__main__':
    unittest.main(verbosity=2)
