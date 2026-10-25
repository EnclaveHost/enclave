#!/usr/bin/env python3
"""Tests of nvme_copy.py on DISPOSABLE fixtures only (<= 64 MiB, in this stage's tmp/): a sparse raw file and a qcow2 made by
qemu-img/qemu-io; QEMU processes are qemu-io / qemu-img / qemu-storage-daemon (no VM, no KVM). The unit is a stub systemctl
whose state a test sets. Run: python3 -m unittest -v test_nvme_copy (through the shared queue)."""
import hashlib, json, os, shutil, subprocess, sys, time, unittest
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import nvme_copy as N

TMP = os.path.join(HERE, 'tmp')
MiB = 1 << 20
def sha(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for b in iter(lambda: f.read(MiB), b''): h.update(b)
    return h.hexdigest()

class Case(unittest.TestCase):
    def setUp(self):
        self.d = os.path.join(TMP, self.id().rsplit('.', 1)[-1]); shutil.rmtree(self.d, ignore_errors=True); os.makedirs(self.d)
        self.tdir = os.path.join(self.d, 'target'); os.makedirs(self.tdir)
        self.state = os.path.join(self.d, 'unit.state'); self.set_unit('inactive', '0')
        self.systemctl = os.path.join(self.d, 'systemctl')
        with open(self.systemctl, 'w') as f: f.write(f'#!/bin/sh\ncat "{self.state}"\n')
        os.chmod(self.systemctl, 0o755)
        self.n = 0
        self.orig_read, self.orig_hash = N.read_exact, N.hash_file
    def tearDown(self):
        N.read_exact, N.hash_file = self.orig_read, self.orig_hash
    def set_unit(self, active, pid, load='loaded'):
        with open(self.state, 'w') as f: f.write(f'LoadState={load}\nActiveState={active}\nSubState=dead\nMainPID={pid}\n')
    def sparse_fixture(self, name='l1.raw', size=64 * MiB, data=((0, b'\xab'), (5 * 8 * MiB + 123, b'\x5a'))):
        p = os.path.join(self.d, name)
        with open(p, 'wb') as f:
            f.truncate(size)
            for off, byte in data: f.seek(off); f.write(byte * MiB)
        return p
    def qcow2_fixture(self, name='l1.qcow2'):
        p = os.path.join(self.d, name)
        subprocess.run(['qemu-img', 'create', '-q', '-f', 'qcow2', p, '64M'], check=True)
        subprocess.run(['qemu-io', '-f', 'qcow2', '-c', 'write -P 0xab 0 1M', '-c', 'write -P 0x5a 40M 2M', p], check=True, capture_output=True)
        return p
    def plan(self, src, name='l1.qcow2', **over):
        st = os.lstat(src)
        pl = {'format': N.FORMAT, 'unit': 'enclave-rpc-vm.service', 'systemctl': self.systemctl,
              'source': {'path': src, 'dev': st.st_dev, 'ino': st.st_ino, 'size': st.st_size},
              'target': {'dir': self.tdir, 'name': name}, 'reserveBytes': N.MIN_RESERVE,
              'progressPath': os.path.join(self.d, f'progress-{self.n}.json'), 'receiptPath': os.path.join(self.d, f'receipt-{self.n}.json'),
              'allowIncompleteProcScan': True}   # tests run in a user namespace (not real root): /proc of other users is unreadable
        for k, v in over.items():
            if k == 'source': pl['source'].update(v)
            else: pl[k] = v
        self.n += 1
        p = os.path.join(self.d, f'plan-{self.n}.json')
        with open(p, 'w') as f: json.dump(pl, f)
        return p, pl
    def run_plan(self, plan_path, pl):
        rc = N.run(plan_path)
        with open(pl['receiptPath']) as f: return rc, json.load(f)
    def assert_refused_clean(self, rc, rec, why, final='l1.qcow2'):
        self.assertEqual(rc, 2, rec); self.assertEqual(rec['status'], 'refused', rec); self.assertRegex(rec['error'], why)
        self.assertFalse(os.path.lexists(os.path.join(self.tdir, '.' + final + '.partial')), 'no partial was created')

    # ---- success ------------------------------------------------------------------------------------------------------
    def test_sparse_copy_preserves_holes_hashes_and_source(self):
        src = self.sparse_fixture(); want = sha(src); before = os.stat(src)
        p, pl = self.plan(src, name='l1.raw')
        rc, rec = self.run_plan(p, pl)
        self.assertEqual(rc, 0, rec); self.assertEqual(rec['status'], 'ok')
        final = os.path.join(self.tdir, 'l1.raw')
        self.assertEqual(sha(final), want); self.assertEqual(rec['sourceSha256'], want); self.assertEqual(rec['copySha256'], want)
        self.assertEqual(os.path.getsize(final), 64 * MiB)
        self.assertEqual(rec['zeroChunksSkipped'], 6, 'chunks 1-4, 6, 7 are all zero (8 MiB chunks)')
        self.assertLessEqual(os.stat(final).st_blocks * 512, 2 * 8 * MiB + MiB, 'only the two data chunks are allocated')
        self.assertFalse(os.path.lexists(os.path.join(self.tdir, '.l1.raw.partial')))
        self.assertEqual(oct(os.stat(final).st_mode & 0o777), '0o600')
        after = os.stat(src)
        for k in ('st_ino', 'st_size', 'st_mtime_ns', 'st_ctime_ns', 'st_nlink', 'st_mode'): self.assertEqual(getattr(after, k), getattr(before, k), k)
        self.assertEqual(sha(src), want)
        with open(pl['progressPath']) as f: prog = json.load(f)
        self.assertEqual(prog['phase'], 'done'); self.assertEqual(prog['bytesDone'], 64 * MiB)
        for k in ('copySec', 'verifySec', 'finalFsyncSec', 'dirFsyncSec', 'allocatedBytes', 'helperSha256', 'lock'): self.assertIn(k, rec)

    def test_target_reserve_is_rechecked_during_copy(self):
        from unittest.mock import patch
        from types import SimpleNamespace
        src = self.sparse_fixture()
        original = sha(src)
        p, pl = self.plan(src, name='reserve.raw')
        calls = [0]
        real = os.statvfs
        def space(fd):
            calls[0] += 1
            if calls[0] > 1:
                return SimpleNamespace(f_bavail=N.MIN_RESERVE - 1, f_frsize=1)
            return real(fd)
        with patch.object(N.os, 'statvfs', space):
            rc, rec = self.run_plan(p, pl)
        self.assert_failed_kept(rc, rec, 'below reserve during copy', name='reserve.raw')
        self.assertEqual(sha(src), original)
        self.assertFalse(os.path.exists(os.path.join(self.tdir, 'reserve.raw')))

    def test_qcow2_copy_is_identical_to_qemu(self):
        src = self.qcow2_fixture(); p, pl = self.plan(src)
        rc, rec = self.run_plan(p, pl)
        self.assertEqual(rc, 0, rec)
        final = os.path.join(self.tdir, 'l1.qcow2')
        cmp_ = subprocess.run(['qemu-img', 'compare', '-f', 'qcow2', '-F', 'qcow2', src, final], capture_output=True, text=True)
        self.assertEqual(cmp_.returncode, 0, cmp_.stdout + cmp_.stderr)
        chk = subprocess.run(['qemu-img', 'check', '-f', 'qcow2', final], capture_output=True, text=True)
        self.assertEqual(chk.returncode, 0, chk.stdout + chk.stderr)
        self.assertEqual(sha(final), sha(src))

    # ---- refusals before anything is created ------------------------------------------------------------------------
    def test_collisions_never_overwrite(self):
        src = self.qcow2_fixture()
        for existing in ('l1.qcow2', '.l1.qcow2.partial', '.l1.qcow2.partial.FAILED.json'):
            path = os.path.join(self.tdir, existing)
            with open(path, 'wb') as f: f.write(b'KEEP')
            p, pl = self.plan(src); rc, rec = self.run_plan(p, pl)
            self.assertEqual(rc, 2); self.assertRegex(rec['error'], 'exists: never overwritten')
            self.assertEqual(open(path, 'rb').read(), b'KEEP'); os.unlink(path)
            self.assertEqual(os.listdir(self.tdir), [])

    def test_wrong_source_refused(self):
        src = self.qcow2_fixture(); st = os.lstat(src)
        cases = [({'source': {'ino': st.st_ino + 1}}, 'not the planned file'), ({'source': {'size': st.st_size + 1}}, 'not the planned file'),
                 ({'source': {'dev': st.st_dev + 1}}, 'not the planned file'), ({'source': {'path': 'rel/l1.qcow2'}}, 'absolute'),
                 ({'reserveBytes': 10**9}, 'reserveBytes must be')]
        link = os.path.join(self.d, 'link.qcow2'); os.symlink(src, link)
        cases.append(({'source': {'path': link}}, 'no symlinked component'))
        ldir = os.path.join(self.d, 'ldir'); os.symlink(self.d, ldir)
        cases.append(({'source': {'path': os.path.join(ldir, 'l1.qcow2')}}, 'no symlinked component'))
        for over, why in cases:
            p, pl = self.plan(src, **over); rc, rec = self.run_plan(p, pl)
            self.assert_refused_clean(rc, rec, why)
        hard = os.path.join(self.d, 'hard.qcow2'); os.link(src, hard)
        p, pl = self.plan(src); rc, rec = self.run_plan(p, pl); self.assert_refused_clean(rc, rec, 'hard links')

    def test_incomplete_proc_scan_refused_without_the_explicit_flag(self):
        src = self.qcow2_fixture(); p, pl = self.plan(src, allowIncompleteProcScan=False); rc, rec = self.run_plan(p, pl)
        if rec.get('procScan') is None and 'unreadable' in rec.get('error', ''):
            self.assert_refused_clean(rc, rec, 'fd tables were unreadable')
        else:
            self.skipTest('every /proc fd table is readable here (no incomplete scan to refuse)')

    def test_unit_must_be_stopped(self):
        src = self.qcow2_fixture()
        for (active, pid, load), why in [(('active', '1234', 'loaded'), 'not stopped'), (('inactive', '99', 'loaded'), 'not stopped'),
                                         (('inactive', '0', 'not-found'), 'not stopped'), (('activating', '0', 'loaded'), 'not stopped')]:
            self.set_unit(active, pid, load); p, pl = self.plan(src); rc, rec = self.run_plan(p, pl); self.assert_refused_clean(rc, rec, why)
        self.set_unit('failed', '0'); p, pl = self.plan(src); rc, rec = self.run_plan(p, pl); self.assertEqual(rc, 0, rec)

    def test_space_floor_and_ram_target(self):
        src = self.qcow2_fixture()
        vs = os.statvfs(self.tdir); free = vs.f_bavail * vs.f_frsize
        p, pl = self.plan(src, reserveBytes=free + 1); rc, rec = self.run_plan(p, pl); self.assert_refused_clean(rc, rec, 'free .* < source')
        if os.path.isdir('/dev/shm'):
            shm = '/dev/shm/nvme-copy-test-' + str(os.getpid()); os.makedirs(shm, exist_ok=True)
            try:
                p, pl = self.plan(src, target={'dir': shm, 'name': 'l1.qcow2'}); rc, rec = self.run_plan(p, pl)
                self.assertEqual(rc, 2, rec); self.assertRegex(rec['error'], 'not a disk filesystem'); self.assertEqual(os.listdir(shm), [])
            finally: shutil.rmtree(shm, ignore_errors=True)

    # ---- failures after the partial exists: kept, marked invalid, never published --------------------------------------
    def assert_failed_kept(self, rc, rec, why, name='l1.raw'):
        self.assertEqual(rc, 2, rec); self.assertEqual(rec['status'], 'failed', rec); self.assertRegex(rec['error'], why)
        self.assertFalse(os.path.lexists(os.path.join(self.tdir, name)), 'nothing was published')
        self.assertTrue(os.path.isfile(os.path.join(self.tdir, '.' + name + '.partial')), 'the partial is kept')
        with open(os.path.join(self.tdir, '.' + name + '.partial.FAILED.json')) as f: marker = json.load(f)
        self.assertRegex(marker['error'], why)

    def test_source_mutation_during_copy_refused(self):
        src = self.sparse_fixture(); want = None
        def hook(fd, buf, off, n):
            if off == 8 * MiB:
                with open(src, 'r+b') as f: f.seek(30 * MiB); f.write(b'X')        # a writer that ignores advisory locks
            return self.orig_read(fd, buf, off, n)
        N.read_exact = hook
        p, pl = self.plan(src, name='l1.raw'); rc, rec = self.run_plan(p, pl)
        self.assert_failed_kept(rc, rec, 'source changed during the copy')

    def test_copy_corruption_detected_by_reread(self):
        src = self.sparse_fixture()
        def corrupt(dfd, name, size, progress):
            fd = os.open(name, os.O_WRONLY, dir_fd=dfd); os.pwrite(fd, b'\x00', 7); os.close(fd)
            return self.orig_hash(dfd, name, size, progress)
        N.hash_file = corrupt
        p, pl = self.plan(src, name='l1.raw'); rc, rec = self.run_plan(p, pl)
        self.assert_failed_kept(rc, rec, 're-read copy hash .* != the source hash')

    def test_unit_started_during_copy_refused(self):
        src = self.sparse_fixture()
        def hook(fd, buf, off, n):
            if off == 16 * MiB: self.set_unit('active', '4242')
            return self.orig_read(fd, buf, off, n)
        N.read_exact = hook
        p, pl = self.plan(src, name='l1.raw'); rc, rec = self.run_plan(p, pl)
        self.assert_failed_kept(rc, rec, 'not stopped')

    # ---- QEMU locking -------------------------------------------------------------------------------------------------
    def test_qemu_cannot_open_the_source_while_copying(self):
        src = self.qcow2_fixture(); want = sha(src); seen = {}
        # control first, on a separate copy: qemu-io can open and write an unlocked image
        ctl = os.path.join(self.d, 'control.qcow2'); shutil.copyfile(src, ctl)
        r = subprocess.run(['qemu-io', '-f', 'qcow2', '-c', 'write -P 1 0 4k', ctl], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        def hook(fd, buf, off, n):
            if off == 0 and not seen:
                for label, cmd in [('qemu-io write', ['qemu-io', '-f', 'qcow2', '-c', 'write -P 1 0 4k', src]),
                                   ('qemu-io read-only', ['qemu-io', '-r', '-f', 'qcow2', '-c', 'read 0 4k', src]),
                                   ('qemu-img info', ['qemu-img', 'info', '-f', 'qcow2', src])]:
                    rr = subprocess.run(cmd, capture_output=True, text=True); seen[label] = (rr.returncode, (rr.stdout + rr.stderr).strip()[:300])
            return self.orig_read(fd, buf, off, n)
        N.read_exact = hook
        p, pl = self.plan(src); rc, rec = self.run_plan(p, pl)
        self.assertEqual(rc, 0, rec)
        for label, (code, out) in seen.items():
            print(f'  [observed] {label} while the helper held the lock: rc={code}: {out[:160]}')
            self.assertNotEqual(code, 0, f'{label} must be refused: {out}'); self.assertRegex(out, 'lock', label)
        self.assertEqual(sha(src), want, 'the source is unchanged')
        r = subprocess.run(['qemu-io', '-r', '-f', 'qcow2', '-c', 'read 0 4k', src], capture_output=True, text=True)
        self.assertEqual(r.returncode, 0, 'after the helper exits the image opens again: ' + r.stderr)

    def test_helper_refuses_an_image_qemu_holds(self):
        src = self.qcow2_fixture()
        sock = os.path.join(self.d, 'qsd.sock')
        qsd = subprocess.Popen(['qemu-storage-daemon', '--blockdev', f'driver=file,node-name=f,filename={src}', '--blockdev', 'driver=qcow2,node-name=q,file=f'],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            time.sleep(1.0)
            if qsd.poll() is not None: self.fail('qemu-storage-daemon exited: ' + qsd.stderr.read().decode()[:400])
            print(f'  [observed] qemu-storage-daemon pid {qsd.pid} holds {src}')
            p, pl = self.plan(src); rc, rec = self.run_plan(p, pl)
            print(f'  [observed] helper vs a running qemu-storage-daemon: {rec["error"][:160]}')
            self.assert_refused_clean(rc, rec, 'holds a lock on the QEMU lock bytes|open in other processes')
        finally:
            qsd.kill(); qsd.wait()

if __name__ == '__main__':
    unittest.main()
