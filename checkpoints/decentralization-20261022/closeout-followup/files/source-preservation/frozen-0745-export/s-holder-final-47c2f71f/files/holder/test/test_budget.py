"""Shared NVMe cache budget (budget.py): ledger rules, allocation/verification on real small files, real-process
concurrency, ACTUAL-allocation accounting (markers, rounding, per-reservation aggregate), and CONTROLS that run the PREVIOUS
storage script (fd0134d) and the PREVIOUS budget.py (2681e8a, the source root reviewed), both read with git show, to show
they admit what this source refuses. Run inside `unshare -rn` (files appear root-owned there, as the ledger
requires). Privileged commands in the controls are the test/stubs state machine; fallocate/stat/du are real.
Nothing here proves kernel quota or device enforcement."""
import copy, ctypes, hashlib, importlib.util, json, os, shutil, subprocess, sys, tempfile, threading, time, unittest
from unittest import mock
from pathlib import Path
HERE = Path(__file__).resolve().parent
PKG = HERE.parent
spec = importlib.util.spec_from_file_location('budget', PKG / 'budget.py')
B = importlib.util.module_from_spec(spec); spec.loader.exec_module(B)
MiB = 1 << 20
MID = B.machine_id()
OTHER = 'cd' * 16


def ledger(reservations, shares=None):
    shares = shares or {MID: B.TARGET}
    return {'format': B.FORMAT, 'capBytes': B.CAP, 'targetBytes': B.TARGET,
            'hosts': [{'machineId': m, 'label': m[:4], 'shareBytes': v} for m, v in shares.items()], 'reservations': reservations}


def res(rid, files, slack=MiB, host=MID, kind='preallocated-files', block=4096):
    return {'id': rid, 'host': host, 'owner': rid, 'kind': kind, 'blockBytes': block, 'slackBytes': slack,
            'maxBytes': sum(b for _, b in files) + slack, 'files': [{'path': str(p), 'bytes': b} for p, b in files]}


def tight(rid, files, **kw):
    """A reservation whose slack is EXACTLY the required headroom."""
    r = res(rid, files, slack=0, **kw)
    r['slackBytes'] = B.required_headroom(r)
    r['maxBytes'] += r['slackBytes']
    return r


LIBC = ctypes.CDLL(None, use_errno=True)
LIBC.fallocate.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_long, ctypes.c_long]


def allocate_past_eof(path, nbytes):
    """Real extra allocation that keeps the file's size (FALLOC_FL_KEEP_SIZE): what an over-allocating filesystem or a
    consumer preallocating past EOF does. Size stays exact, st_blocks grows."""
    fd = os.open(path, os.O_WRONLY)
    try:
        size = os.fstat(fd).st_size
        if LIBC.fallocate(fd, 1, size, nbytes) != 0:
            raise OSError(ctypes.get_errno(), 'fallocate KEEP_SIZE')
    finally:
        os.close(fd)


def old_budget(tmp):
    """The PREVIOUS budget.py exactly as committed in 2681e8a (sha a82192bc..., the source root froze)."""
    repo = os.environ.get('HOLDER_GIT_REPO', str(PKG.parent))
    src = subprocess.run(['git', '-C', repo, 'show', '2681e8a:holder/budget.py'], capture_output=True, check=True).stdout
    assert hashlib.sha256(src).hexdigest() == 'a82192bc30715f94cb86934507430ab2956a6962e0b51b3bf85071030ce21bcd'
    (tmp / 'old_budget.py').write_bytes(src)
    sp = importlib.util.spec_from_file_location('old_budget', tmp / 'old_budget.py')
    m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
    return m


class Base(unittest.TestCase):
    def setUp(self):
        self.t = Path(tempfile.mkdtemp(prefix='hb-'))
        self.lp = str(self.t / 'budget.json')

    def tearDown(self):
        shutil.rmtree(self.t)

    def write(self, doc):
        Path(self.lp).write_text(json.dumps(doc)); os.chmod(self.lp, 0o644)


class Rules(Base):
    def test_ledger_rules(self):
        a = res('a', [(self.t / 'a.img', 4 * MiB)])
        ok = ledger([a])
        B.validate(ok)
        bad = [
            (lambda d: d.update(capBytes=B.CAP + 1), 'not configurable'),
            (lambda d: d['hosts'].append({'machineId': OTHER, 'label': 'o', 'shareBytes': B.CAP}), 'host shares sum'),
            (lambda d: d['hosts'].append(dict(d['hosts'][0])), 'unique'),
            (lambda d: d['hosts'][0].update(shareBytes=MiB), 'exceed its share'),
            (lambda d: d['reservations'][0].update(kind='directory'), 'not hard-bounded'),
            (lambda d: d['reservations'][0].update(maxBytes=1), 'maxBytes must equal'),
            (lambda d: d['reservations'][0].update(host=OTHER), 'unaccounted'),
            (lambda d: d['reservations'].append(dict(d['reservations'][0])), 'unique'),
            (lambda d: d['reservations'].append(res('b', [(self.t / 'a.img' / 'x', MiB)])), 'overlap'),
            (lambda d: d['reservations'][0]['files'][0].update(path='rel/a.img'), 'absolute'),
            (lambda d: d.update(extra=1), 'exactly'),
            (lambda d: d.update(format='enclave-rpc-nvme-cache-budget/v1'), 'v1 charged declared bytes'),
            (lambda d: d['reservations'][0].update(blockBytes=3000), 'filesystem block size'),
            (lambda d: d['reservations'][0]['files'][0].update(bytes=4 * MiB + 1) or d['reservations'][0].update(maxBytes=5 * MiB + 1),
             'multiple of blockBytes'),
            (lambda d: d['reservations'][0].update(slackBytes=4096, maxBytes=4 * MiB + 4096), 'required headroom'),
            (lambda d: d['hosts'][0].update(shareBytes=5 * MiB), 'plus bookkeeping'),   # = maxBytes, no bookkeeping left
        ]
        for mutate, needle in bad:
            d = copy.deepcopy(ok); mutate(d)
            with self.subTest(needle=needle), self.assertRaises(B.BudgetError) as e:
                B.validate(d)
            self.assertIn(needle, str(e.exception))

    def test_headroom_is_exact_and_bookkeeping_is_charged(self):
        r = tight('a', [(self.t / 'a.img', 4 * MiB), (self.t / 'b.img', 8192)])
        B.validate(ledger([r], {MID: r['maxBytes'] + B.BOOKKEEPING_BYTES}))      # exactly fits: required slack + bookkeeping
        r2 = dict(r, slackBytes=r['slackBytes'] - 1, maxBytes=r['maxBytes'] - 1)
        with self.assertRaises(B.BudgetError) as e:
            B.validate(ledger([r2]))
        self.assertIn('required headroom', str(e.exception))
        with self.assertRaises(B.BudgetError):
            B.validate(ledger([r], {MID: r['maxBytes'] + B.BOOKKEEPING_BYTES - 1}))
        big = Path(self.lp)
        big.write_text(json.dumps(ledger([r])) + ' ' * B.LEDGER_MAX_BYTES); os.chmod(big, 0o644)
        with self.assertRaises(B.BudgetError) as e:
            B.load(self.lp, require_root_owned=False)
        self.assertIn('larger than', str(e.exception))

    def test_example_share_split_across_hosts_never_exceeds_cap(self):
        d = ledger([], {MID: 150_000_000_000, OTHER: 100_000_000_000})
        B.validate(d)                                   # exactly the cap across two hosts
        d['hosts'][1]['shareBytes'] += 1
        with self.assertRaises(B.BudgetError):
            B.validate(d)


class Allocation(Base):
    def setUp(self):
        super().setUp()
        self.files = [(self.t / 'd.img', 4 * MiB), (self.t / 'm.img', 2 * MiB)]
        self.write(ledger([res('h', self.files)]))

    def alloc(self, rid='h'):
        return B.allocate(self.lp, rid, MID)

    def test_allocate_exact_non_sparse_then_idempotent(self):
        made = self.alloc()
        for p, n in self.files:
            st = os.stat(p)
            self.assertEqual(st.st_size, n)
            self.assertGreaterEqual(st.st_blocks * 512, n)
            self.assertIn(str(p), made)
            self.assertIn(str(p) + B.MARKER, made)
        ino = os.stat(self.files[0][0]).st_ino
        self.assertEqual(self.alloc(), [], 'a second allocate creates nothing and grants nothing')
        self.assertEqual(os.stat(self.files[0][0]).st_ino, ino)
        v = B.verify(self.lp, 'h', MID)
        self.assertEqual(v['chargedBytes'], 7 * MiB + B.BOOKKEEPING_BYTES)
        self.assertLessEqual(v['reservationActualBytes'], v['reservationBytes'])

    def test_foreign_file_refused_untouched(self):
        self.files[0][0].write_bytes(b'foreign')
        with self.assertRaises(B.BudgetError) as e:
            self.alloc()
        self.assertIn('ownership marker', str(e.exception))
        self.assertEqual(self.files[0][0].read_bytes(), b'foreign')
        self.assertFalse(self.files[1][0].exists())

    def test_interrupted_create_is_completed_not_regranted(self):
        p = self.files[0][0]
        Path(str(p) + B.MARKER).write_text(json.dumps({'reservation': 'h'}))
        with open(p, 'wb') as f:
            f.write(b'\0' * MiB)                    # an interrupted earlier create: owned, 1 of 4 MiB
        ino = os.stat(p).st_ino
        made = self.alloc()
        self.assertNotIn(str(p), made, 'the owned partial file is completed in place, not recreated')
        self.assertEqual((os.stat(p).st_ino, os.stat(p).st_size), (ino, 4 * MiB))
        B.verify(self.lp, 'h', MID)

    def test_failure_unwinds_only_what_this_call_created(self):
        p0 = self.files[0][0]
        Path(str(p0) + B.MARKER).write_text(json.dumps({'reservation': 'h'}))
        subprocess.run(['fallocate', '-l', str(4 * MiB), str(p0)], check=True)    # already owned and complete
        doc = ledger([res('h', [self.files[0], (self.t / 'nodir' / 'm.img', 2 * MiB)])])
        self.write(doc)
        with self.assertRaises(OSError):
            self.alloc()
        self.assertTrue(p0.exists() and Path(str(p0) + B.MARKER).exists(), 'pre-existing owned artifacts kept')

    def test_verify_bounds(self):
        self.alloc()
        other = res('sia', [(self.t / 's.img', 3 * MiB)])
        self.write(ledger([res('h', self.files), other]))
        self.assertEqual(B.verify(self.lp, 'h', MID)['chargedBytes'], 7 * MiB + 4 * MiB + B.BOOKKEEPING_BYTES, 'absent: charged at max')
        Path(str(self.t / 's.img') + B.MARKER).write_text(json.dumps({'reservation': 'sia'}))
        with open(self.t / 's.img', 'wb') as f:
            f.truncate(3 * MiB)                       # sparse: not a bounded preallocation
        with self.assertRaises(B.BudgetError) as e:
            B.verify(self.lp, 'h', MID)
        self.assertIn('sparse', str(e.exception))
        os.remove(self.t / 's.img')
        subprocess.run(['fallocate', '-l', str(5 * MiB), str(self.t / 's.img')], check=True)   # grown
        with self.assertRaises(B.BudgetError):
            B.verify(self.lp, 'h', MID)
        os.remove(self.files[0][0])
        os.remove(self.t / 's.img')
        with self.assertRaises(B.BudgetError) as e:
            B.verify(self.lp, 'h', MID)
        self.assertIn('missing', str(e.exception))


class Accounting(Base):
    """ACTUAL allocated bytes (files + markers + directory-entry charge) against maxBytes: before any write, while
    allocating, and at verify. Real tmpfs files (block 4096) unless noted."""
    def names(self):
        return sorted(x.name for x in self.t.iterdir() if x.name not in ('budget.json', 'budget.json.lock'))

    def test_root_probe_one_byte_zero_slack_refused_before_any_marker_or_file(self):
        f = self.t / 'tiny.img'
        hosts = {MID: 1, OTHER: B.CAP - 1}                # root's probe: local share 1, the other host's CAP-1 declared only
        (self.t / 'x').mkdir()
        old = old_budget(self.t / 'x')
        # OLD (2681e8a): the probe's exact ledger is valid, allocation writes two real 4096-byte files, verify accepts
        doc = {'format': old.FORMAT, 'capBytes': old.CAP, 'targetBytes': old.TARGET,
               'hosts': [{'machineId': m, 'label': m[:4], 'shareBytes': v} for m, v in hosts.items()],
               'reservations': [{'id': 'test', 'host': MID, 'owner': 'fixture', 'kind': 'preallocated-files', 'maxBytes': 1,
                                 'slackBytes': 0, 'files': [{'path': str(f), 'bytes': 1}]}]}
        self.write(doc)
        made = old.allocate(self.lp, 'test', MID, require_root_owned=False)
        v = old.verify(self.lp, 'test', MID, require_root_owned=False)
        actual = sum(os.stat(x).st_blocks * 512 for x in made)
        self.assertEqual((v['chargedBytes'], actual), (1, 8192), 'OLD: charged 1, two real blocks allocated, verify accepted')
        for x in made:
            os.remove(x)
        # NEW: the same reservation (v2 form) is refused before any marker or file exists, for each reason on its own
        cases = [(res('test', [(f, 1)], slack=0), 'multiple of blockBytes'),
                 (res('test', [(f, 4096)], slack=0), 'required headroom'),
                 (tight('test', [(f, 4096)]), 'plus bookkeeping')]          # aligned and headroomed, still over share 1
        for r, needle in cases:
            with self.subTest(needle=needle):
                self.write(ledger([r], hosts))
                with self.assertRaises(B.BudgetError) as e:
                    B.allocate(self.lp, 'test', MID, require_root_owned=False)
                self.assertIn(needle, str(e.exception))
                self.assertEqual(self.names(), ['x'], 'nothing written')
        r = cases[2][0]
        self.write(ledger([r], {MID: r['maxBytes'] + B.BOOKKEEPING_BYTES, OTHER: B.CAP - r['maxBytes'] - B.BOOKKEEPING_BYTES}))
        made = B.allocate(self.lp, 'test', MID, require_root_owned=False)
        v = B.verify(self.lp, 'test', MID, require_root_owned=False)
        self.assertEqual(sorted(made), [str(f), str(f) + B.MARKER])
        self.assertLessEqual(v['reservationActualBytes'], r['maxBytes'])
        self.assertLessEqual(v['actualBytes'], v['shareBytes'])

    def test_correctly_budgeted_small_files_pass_exactly_counted(self):
        files = [(self.t / 'd.img', 4 * MiB), (self.t / 'm.img', 3 * 4096)]
        r = tight('h', files)
        self.write(ledger([r]))
        B.allocate(self.lp, 'h', MID)
        v = B.verify(self.lp, 'h', MID)
        markers = 2 * 4096                                   # tmpfs: one page per marker, no extent blocks
        self.assertEqual(v['reservationActualBytes'], 4 * MiB + 3 * 4096 + markers + B.entry_bytes(r))
        self.assertLessEqual(v['reservationActualBytes'], r['maxBytes'])

    def test_files_and_markers_together_cannot_exceed_the_reservation(self):
        files = [(self.t / 'd.img', 4 * MiB), (self.t / 'm.img', 2 * MiB)]
        r = tight('h', files)
        self.write(ledger([r]))
        B.allocate(self.lp, 'h', MID)
        spare = r['maxBytes'] - B.verify(self.lp, 'h', MID)['reservationActualBytes']
        self.assertGreater(spare, 0)
        allocate_past_eof(files[0][0], spare)               # one file uses ALL remaining slack: exactly at maxBytes
        self.assertEqual(B.verify(self.lp, 'h', MID)['reservationActualBytes'], r['maxBytes'])
        allocate_past_eof(files[1][0], 4096)                # the second file cannot use the same slack again
        with self.assertRaises(B.BudgetError) as e:
            B.verify(self.lp, 'h', MID)
        self.assertIn('exceeds its maxBytes', str(e.exception))
        with self.assertRaises(B.BudgetError):
            B.allocate(self.lp, 'h', MID)                   # re-allocate (adoption) sees the same overrun
        # OLD (2681e8a): each file is judged alone against +64 MiB, so the same over-allocation is accepted
        old = old_budget(self.t)
        od = ledger([dict({k: v for k, v in r.items() if k != 'blockBytes'})])
        od['format'] = old.FORMAT
        self.write(od)
        ov = old.verify(self.lp, 'h', MID)
        self.assertEqual(ov['chargedBytes'], r['maxBytes'], 'OLD: accepted, charged maxBytes while actual exceeded it')

    def test_allocation_stops_inside_the_maximum_when_the_filesystem_overallocates(self):
        """A filesystem whose metadata exceeds the estimate (simulated: every step allocates 2 extra blocks past EOF):
        allocation must stop BEFORE the reservation's actual bytes exceed maxBytes, and unwind."""
        files = [(self.t / 'd.img', 4 * MiB), (self.t / 'm.img', MiB)]
        real = os.posix_fallocate
        seen = []
        with mock.patch.object(B, 'ALLOC_STEP', MiB):
            r = tight('h', files)
            self.write(ledger([r]))

            def over(fd, off, n):
                real(fd, off, n)
                LIBC.fallocate(fd, 1, off + n, 2 * 4096)
                seen.append(B.actual_bytes(r))
            with mock.patch.object(B.os, 'posix_fallocate', over), self.assertRaises(B.BudgetError) as e:
                B.allocate(self.lp, 'h', MID)
        self.assertIn('nothing more is allocated', str(e.exception))
        self.assertLess(len(seen), 5, 'stopped before the last step')
        self.assertLessEqual(max(seen), r['maxBytes'], 'actual allocation never exceeded maxBytes')
        self.assertEqual(self.names(), [], 'unwound: no file or marker left')

    def test_last_step_overrun_is_caught_after_allocation_and_unwound(self):
        files = [(self.t / 'd.img', 2 * MiB)]
        real = os.posix_fallocate
        r = tight('h', files)
        self.write(ledger([r]))

        def over(fd, off, n):
            real(fd, off, n)
            LIBC.fallocate(fd, 1, off + n, r['slackBytes'])  # far beyond any step headroom
        with mock.patch.object(B.os, 'posix_fallocate', over), self.assertRaises(B.BudgetError) as e:
            B.allocate(self.lp, 'h', MID)
        self.assertIn('after allocation', str(e.exception))
        self.assertEqual(self.names(), [])

    def test_present_overallocation_refuses_before_writing_the_rest(self):
        files = [(self.t / 'd.img', 4 * MiB), (self.t / 'm.img', MiB)]
        r = tight('h', files)
        self.write(ledger([r]))
        p = files[0][0]
        Path(str(p) + B.MARKER).write_text(json.dumps({'reservation': 'h'}))
        subprocess.run(['fallocate', '-l', str(4 * MiB), str(p)], check=True)    # owned, complete ...
        allocate_past_eof(p, r['slackBytes'])                                    # ... and over-allocated by all slack
        with self.assertRaises(B.BudgetError) as e:
            B.allocate(self.lp, 'h', MID)
        self.assertIn('before any write', str(e.exception))
        self.assertEqual(self.names(), ['d.img', 'd.img' + B.MARKER], 'm.img and its marker were never written')

    def test_filesystem_must_be_supported_with_the_declared_block_size(self):
        self.assertEqual(B.fs_of(str(self.t)), ('tmpfs', 4096))
        r = res('h', [(self.t / 'd.img', 4 * 8192)], block=8192)                 # aligned to 8192, the fs is 4096
        self.write(ledger([r]))
        with self.assertRaises(B.BudgetError) as e:
            B.allocate(self.lp, 'h', MID)
        self.assertIn('block size 4096', str(e.exception))
        self.assertEqual(self.names(), [])
        self.write(ledger([res('h', [(self.t / 'd.img', 4 * 8192)])]))
        with mock.patch.object(B, 'SUPPORTED_FS', ('ext4',)), self.assertRaises(B.BudgetError) as e:
            B.allocate(self.lp, 'h', MID)
        self.assertIn('unsupported', str(e.exception))
        self.assertEqual(self.names(), [])
        scratch = os.environ.get('HOLDER_NVME_SCRATCH')
        if scratch:
            self.assertEqual(B.fs_of(scratch), ('ext4', 4096), 'the real NVMe scratch is ext4 with 4096-byte blocks')


class Concurrency(Base):
    """Real processes through the CLI (the storage script's path)."""
    def cli(self, *a):
        return subprocess.Popen([sys.executable, '-I', str(PKG / 'budget.py'), *a], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def test_concurrent_allocations_of_one_reservation_grant_once(self):
        files = [(self.t / 'd.img', 8 * MiB), (self.t / 'm.img', 2 * MiB)]
        self.write(ledger([res('h', files)]))
        ps = [self.cli('allocate', self.lp, 'h') for _ in range(4)]
        outs = [p.communicate(timeout=60) for p in ps]
        self.assertEqual([p.returncode for p in ps], [0] * 4, [o[1] for o in outs])
        creators = [o[0] for o in outs if 'created' in o[0]]
        self.assertEqual(len(creators), 1, 'exactly one process created the files; the others adopted them')
        self.assertEqual(sorted(x.name for x in self.t.iterdir() if x.suffix == '.img'), ['d.img', 'm.img'])

    def test_allocation_waits_for_a_ledger_edit_and_sees_its_result(self):
        files = [(self.t / 'd.img', 4 * MiB)]
        self.write(ledger([res('h', files)]))
        with B.Lock(self.lp, exclusive=True):        # root editing the ledger
            p = self.cli('allocate', self.lp, 'h')
            time.sleep(0.8)
            self.assertIsNone(p.poll(), 'allocation blocks behind the ledger edit')
            self.assertFalse(files[0][0].exists())
            self.write(ledger([]))                    # the edit removes the reservation
        out, err = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 3)
        self.assertIn('not in the ledger', err)
        self.assertFalse(files[0][0].exists())


class OldBehaviorControls(Base):
    """The PREVIOUS storage script (fd0134d) under the same stub seam: it admits by point-in-time measurement."""
    OLD = 'fd0134d'

    def old_module(self):
        pkg = self.t / 'oldpkg'
        pkg.mkdir()
        for f in ('holder.py', 'holder-storage.sh.in', 'FLAGS.json', 'BINARY.json', 'holder.example.json'):
            repo = os.environ.get('HOLDER_GIT_REPO', str(PKG.parent))   # the real repository (mutant copies are not git trees)
            (pkg / f).write_bytes(subprocess.run(['git', '-C', repo, 'show', f'{self.OLD}:holder/{f}'], capture_output=True, check=True).stdout)
        sp = importlib.util.spec_from_file_location('oldholder', pkg / 'holder.py')
        m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
        return m, json.loads((pkg / 'holder.example.json').read_text())

    def old_script(self, name, inv_lines, cap):
        m, ex = self.old_module() if not hasattr(self, '_old') else self._old
        self._old = (m, ex)
        raw = copy.deepcopy(ex)
        raw['l1'] = {'executionRpc': 'https://l1.example.org/', 'beacon': 'https://beacon.example.org/', 'trustRpc': False}
        c = m.validate(raw)
        d = self.t / name
        (d / 'hdd').mkdir(parents=True); (d / 'nvme').mkdir()
        c['storage'].update(mountPoint=str(d / 'mnt'), nvmeInventoryPath=str(d / 'inv.tsv'), originFreeMarginBytes=0, nvmeFreeMarginBytes=0)
        c['datadir'] = str(d / 'mnt' / 'data')
        c['storage']['origin'] = {'imagePath': str(d / 'hdd' / 'origin.img'), 'bytes': 8 * MiB}
        c['storage']['cache'].update(dataImagePath=str(d / 'nvme' / 'cache-data.img'), dataBytes=16 * MiB,
                                     metadataImagePath=str(d / 'nvme' / 'cache-meta.img'), metadataBytes=4 * MiB, slackBytes=MiB)
        (d / 'inv.tsv').write_text(''.join(f'{l}\t{p}\n' for l, p in inv_lines))
        sh = d / 'holder-storage.sh'
        sh.write_text(m.storage_script(c, cap=cap)); sh.chmod(0o700)
        return d, sh

    def run_old(self, d, sh, extra_path=None):
        env = {'PATH': ':'.join(filter(None, [extra_path, str(HERE / 'stubs'), '/usr/bin:/bin'])), 'STUB_STATE': str(d / 'state.json'),
               'STUB_ROT': json.dumps({str(self.t): '0', str(d / 'hdd'): '1'})}
        return subprocess.Popen(['bash', str(sh), 'create'], env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

    def nvme_bytes(self, *ds):
        return sum(f.stat().st_blocks * 512 for d in ds for f in (d / 'nvme').glob('*.img'))

    def test_old_missing_path_counts_zero_and_growth_is_unbounded(self):
        cap = 30 * MiB                                   # holder plans 21 MiB; the Sia directory later grows to 16 MiB
        sia = self.t / 'sia-cache'
        d, sh = self.old_script('a', [('sia cache', sia)], cap)
        p = self.run_old(d, sh); out, err = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 0, 'OLD: admitted while the Sia path was absent (counted 0)')
        sia.mkdir(); subprocess.run(['fallocate', '-l', str(16 * MiB), str(sia / 'blob')], check=True)
        total = self.nvme_bytes(d) + 16 * MiB
        self.assertGreater(total, cap, 'OLD: nothing bounded the later growth: the aggregate is over the cap')
        # NEW: the same two participants must be reservations of MAXIMA; a directory is not admissible, and the sum is checked
        doc = ledger([res('holder', [(d / 'nvme' / 'x', 20 * MiB)]), res('sia', [(sia, 16 * MiB)], kind='directory')], {MID: cap})
        with self.assertRaises(B.BudgetError):
            B.validate(doc)
        doc['reservations'][1]['kind'] = 'preallocated-files'
        with self.assertRaises(B.BudgetError) as e:
            B.validate(doc)
        self.assertIn('exceed its share', str(e.exception))

    def test_old_concurrent_creates_both_pass_and_exceed_the_cap(self):
        cap = 30 * MiB
        slow = self.t / 'slowbin'
        slow.mkdir()
        (slow / 'fallocate').write_text('#!/bin/sh\nsleep 1.5\nexec /usr/bin/fallocate "$@"\n'); (slow / 'fallocate').chmod(0o755)
        a, sha = self.old_script('a', [('b cache', self.t / 'b' / 'nvme')], cap)
        b, shb = self.old_script('b', [('a cache', self.t / 'a' / 'nvme')], cap)
        pa, pb = self.run_old(a, sha, str(slow)), self.run_old(b, shb, str(slow))
        ra, rb = pa.wait(60), pb.wait(60)
        self.assertEqual((ra, rb), (0, 0), 'OLD: both creates passed their measurement before either allocated')
        self.assertGreater(self.nvme_bytes(a, b), cap, 'OLD: the aggregate exceeded the cap')
        # NEW: the same pair is decided by the ledger, independent of timing: over the share both are refused ...
        files = lambda n: [(self.t / f'n{n}' / 'd.img', 16 * MiB), (self.t / f'n{n}' / 'm.img', 4 * MiB)]
        for n in (1, 2):
            (self.t / f'n{n}').mkdir()
        self.write(ledger([res('h1', files(1)), res('h2', files(2))], {MID: 50 * MiB}))
        ps = [subprocess.Popen([sys.executable, '-I', str(PKG / 'budget.py'), 'allocate', self.lp, r], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
              for r in ('h1', 'h2')]
        self.assertEqual([p.wait(60) for p in ps], [0, 0])
        self.assertLessEqual(sum(f.stat().st_blocks * 512 for n in (1, 2) for f in (self.t / f'n{n}').glob('*.img')), 50 * MiB)
        self.write(ledger([res('h1', files(1)), res('h2', files(2))], {MID: 30 * MiB}))
        with self.assertRaises(B.BudgetError):
            B.load(self.lp, require_root_owned=False)


if __name__ == '__main__':
    unittest.main(verbosity=2)
