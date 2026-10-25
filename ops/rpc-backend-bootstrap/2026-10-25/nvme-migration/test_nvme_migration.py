#!/usr/bin/python3 -I
"""Tests for provision_vm.py v2 + migrate_nvme.py. Disposable qcow2 images (<= 64 MiB total) in a sandbox HOME; mocked
mount identities and free space; no VM, no systemd, no production file is written. Run through claude-test-queue.py."""
import contextlib
import hashlib
import importlib.util
import io as iomod
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.abspath(os.environ.get('PROVISION_VM_LAUNCHER') or os.path.join(HERE, '..', 'provision_vm.py'))
SNAP = os.path.join(HERE, 'fixtures', 'v1-installed')                # public golden fixture of the installed v1
MIB = 1 << 20
SANDBOX = tempfile.mkdtemp(prefix='nvme-mig-test-', dir=os.environ.get('TEST_TMP', HERE))
os.environ['HOME'] = os.path.join(SANDBOX, 'home')       # the launcher derives STATE_DIR/UNIT_PATH from HOME at import


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


pv = load(LAUNCHER, 'pv_under_test')
mig = load(os.path.join(HERE, 'migrate_nvme.py'), 'mig_under_test')


def qimg(*a):
    return subprocess.run(['/usr/bin/qemu-img', *a], check=True, capture_output=True, text=True).stdout


def qio(path, *cmds, fmt='qcow2'):
    a = ['/usr/bin/qemu-io', '-f', fmt]
    for c in cmds:
        a += ['-c', c]
    return subprocess.run(a + [path], check=True, capture_output=True, text=True).stdout


def sha(path):
    return hashlib.sha256(open(path, 'rb').read()).hexdigest()


# ---- v1 compatibility against the real installed manifest snapshot (public fields only are ever printed) -------------
class V1Compat(unittest.TestCase):
    def test_v1_argv_and_unit_render_byte_identical(self):
        text = open(os.path.join(SNAP, 'manifest.v1.json')).read()
        m = json.loads(text)
        self.assertEqual(pv.sha256_text(pv.canonical(pv.qemu_argv(m))), m['files']['qemuArgv'])
        self.assertEqual(pv.render_unit(m, pv.sha256_text(text)), open(os.path.join(SNAP, 'vm.service.v1')).read())
        self.assertFalse(pv.is_v2(m))
        self.assertNotIn('guardQmp', json.dumps(pv.qemu_argv(m)))


# ---- guard policy ----------------------------------------------------------------------------------------------------
CAP = {'floorBytes': 300, 'pauseMarginBytes': 64, 'shutdownMarginBytes': 100, 'startHeadroomBytes': 20,
       'shutdownLeadSeconds': 2400, 'pollSeconds': 1}
T = pv.thresholds(CAP)


class Decide(unittest.TestCase):
    def test_thresholds(self):
        self.assertEqual(T, {'floor': 300, 'pause': 364, 'shutdown': 464, 'start': 484})

    def test_levels(self):
        d = pv.guard_decide
        self.assertEqual(d(None, 0, None, T, 2400), 'pause')            # measurement failure fails closed
        self.assertEqual(d(364, 0, None, T, 2400), 'pause')
        self.assertEqual(d(365, 0, None, T, 2400), 'shutdown')
        self.assertEqual(d(464, 0, None, T, 2400), 'shutdown')
        self.assertEqual(d(465, 0, None, T, 2400), 'ok')
        self.assertEqual(d(10**6, 10**6 / 2399, None, T, 2400), 'shutdown')   # growth would reach pause within lead
        self.assertEqual(d(10**6, 1, None, T, 2400), 'ok')
        self.assertEqual(d(330, 10**9, 'shutdown-budget', T, 2400), 'ok')     # operator shutdown: hard floor only
        self.assertEqual(d(300, 0, 'shutdown-budget', T, 2400), 'pause')


class FakeQmp:
    def __init__(self, log, status='running', fail_on=()):
        self.log, self.st, self.fail_on = log, status, fail_on

    def cmd(self, name, args=None):
        self.log.append(name)
        if name in self.fail_on:
            raise OSError('boom')
        if name == 'query-status':
            return {'status': self.st}
        if name == 'stop':
            self.st = 'paused'
        return {}


class FakeIO:
    def __init__(self, frees, present=None, qmp=None, mode=None, check_fail_at=()):
        self.frees, self.i, self.t = list(frees), -1, 0.0
        self.present = present or (lambda i: True)
        self.qmps, self.mode_v, self.check_fail_at = qmp, mode, check_fail_at
        self.log_lines, self.notes, self.statuses, self.cmds = [], [], [], []

    def check(self, b):
        if self.i in self.check_fail_at:
            raise pv.Refuse('mount identity changed')

    def free(self, mount):
        return self.frees[min(self.i, len(self.frees) - 1)]

    def now(self):
        self.i += 1
        self.t += 1.0
        return self.t

    def qemu_present(self):
        return self.present(self.i)

    def qmp(self):
        if self.qmps is None:
            raise OSError('no socket')
        return self.qmps

    def mode(self):
        return self.mode_v

    def notify(self, msg):
        self.notes.append(msg)

    def status(self, obj):
        self.statuses.append(obj['state'])

    def log(self, msg):
        self.log_lines.append(msg)

    def sleep(self, s):
        pass


def v2_min():
    b = {'kind': 'nvme', 'growth': 'bounded', 'mount': '/vm', 'dir': '/vm/x', 'discard': 'ignore', 'fstype': 'ext4',
         'source': '/dev/x', 'fsUuid': 'u', 'leafDisks': [{'name': 'n', 'model': 'm', 'rotational': False}],
         'guestRotationRate': 1, 'capacity': CAP}
    return {'format': pv.FORMAT_V2, 'paths': {k: '/tmp/' + k for k in pv.V2_PATHS}, 'backings': {'nvme': b},
            'disks': {'l1': {'path': '/vm/x/l1.qcow2', 'backing': 'nvme'}}}


class GuardLoop(unittest.TestCase):
    def test_shutdown_then_pause_once_each(self):
        log = []
        io = FakeIO([1000, 900, 450, 440, 360, 360], qmp=FakeQmp(log))
        self.assertIsNone(pv.guard_loop(v2_min(), 'S', io, max_loops=6))
        self.assertEqual([c for c in log if c != 'query-status'], ['system_powerdown', 'stop'])
        self.assertEqual(io.statuses, ['armed', 'armed', 'shutdown-requested', 'shutdown-requested', 'paused', 'paused'])
        self.assertEqual(sum(n == 'WATCHDOG=1' for n in io.notes), 6)
        self.assertTrue(any('PAUSED VM' in line for line in io.log_lines))

    def test_check_failure_pauses(self):
        log = []
        io = FakeIO([10**6], qmp=FakeQmp(log), check_fail_at={1})
        pv.guard_loop(v2_min(), 'S', io, max_loops=2)
        self.assertIn('stop', log)
        self.assertEqual(io.statuses, ['armed', 'paused'])

    def test_unreachable_qmp_at_pause_exits_3(self):
        io = FakeIO([300], qmp=None)
        self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=3), 3)

    def test_unreachable_qmp_60s_exits_3(self):
        io = FakeIO([10**6], qmp=None)
        self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=100), 3)
        self.assertGreater(io.i, 50)

    def test_qmp_error_while_present_exits_3(self):
        io = FakeIO([10**6], qmp=FakeQmp([], fail_on=('query-status',)))
        self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=3), 3)

    def test_qemu_gone_after_seen_exits_0(self):
        io = FakeIO([10**6], present=lambda i: i < 2, qmp=FakeQmp([]))
        self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=5), 0)

    def test_waits_for_qemu_without_acting(self):
        io = FakeIO([10**6], present=lambda i: False, qmp=None)
        self.assertIsNone(pv.guard_loop(v2_min(), 'S', io, max_loops=5))
        self.assertEqual(io.statuses, ['armed'] * 5)

    def test_shutdown_budget_mode_pauses_only_at_floor(self):
        log = []
        io = FakeIO([340, 320, 300], qmp=FakeQmp(log), mode='shutdown-budget')
        pv.guard_loop(v2_min(), 'S', io, max_loops=3)
        self.assertEqual([c for c in log if c != 'query-status'], ['stop'])
        self.assertEqual(io.statuses, ['armed', 'armed', 'paused'])

    def test_rate_triggers_early_shutdown(self):
        log = []
        frees = [10**9 - k * 10**5 for k in range(20)]           # 100 kB/s: (1e9 - 364) / 1e5 = 1e4 s > 2400 s
        io = FakeIO(frees, qmp=FakeQmp(log))
        pv.guard_loop(v2_min(), 'S', io, max_loops=20)
        self.assertNotIn('system_powerdown', log)
        log = []
        frees = [10**6 - k * 10**4 for k in range(20)]           # 10 kB/s: (1e6 - 364) / 1e4 = 100 s < 2400 s
        io = FakeIO(frees, qmp=FakeQmp(log))
        pv.guard_loop(v2_min(), 'S', io, max_loops=20)
        self.assertIn('system_powerdown', log)


class ValidateV2(unittest.TestCase):
    def test_ok(self):
        pv.validate_v2(v2_min())

    def test_rejects(self):
        for mutate in (lambda m: m['backings']['nvme'].update(guestRotationRate=7200),
                       lambda m: m['disks']['l1'].update(path='/elsewhere/l1.qcow2'),
                       lambda m: m['backings']['nvme']['capacity'].pop('floorBytes'),
                       lambda m: m['backings']['nvme'].update(discard='zap'),
                       lambda m: m['disks']['l1'].update(backing='nope'),
                       lambda m: m['paths'].pop('guardQmp')):
            m = json.loads(json.dumps(v2_min()))
            mutate(m)
            with self.assertRaises(pv.Refuse):
                pv.validate_v2(m)


# ---- migration end to end on disposable images -----------------------------------------------------------------------
class Env:
    """A v1 install in the sandbox HOME with three tiny qcow2 disks on a fake HDD mount."""

    def __init__(self, root):
        self.root = root
        self.hdd_mnt, self.nvme_mnt = os.path.join(root, 'hdd-mnt'), os.path.join(root, 'nvme-mnt')
        os.makedirs(self.hdd_mnt)
        os.makedirs(os.path.join(self.nvme_mnt, 'enclave-volumes'))
        pv.HDD_MOUNT, pv.HDD_DIR = self.hdd_mnt, os.path.join(self.hdd_mnt, pv.NAME)
        os.makedirs(pv.HDD_DIR, 0o700)
        os.makedirs(pv.STATE_DIR, 0o700)
        os.makedirs(pv.UNIT_PATH.parent)
        self.free = {self.nvme_mnt: 10**15, self.hdd_mnt: 10**15}
        pv.fs_free = lambda mount: self.free[mount]
        ident = {self.nvme_mnt: ('ext4', '/dev/fake-nvme', 'fake-nvme-uuid', False, 'FAKE T710'),
                 self.hdd_mnt: ('ntfs3', '/dev/fake-hdd', 'FAKEHDDSERIAL', True, 'FAKE TR-004')}

        def describe(mount):
            fs, src, u, rot, model = ident[mount]
            return {'mount': mount, 'fstype': fs, 'source': src, 'fsUuid': u, 'rw': True,
                    'leafDisks': [{'name': 'fake0', 'model': model, 'rotational': rot}]}
        pv.describe_backing = describe
        mig.load_launcher = lambda path: pv
        self.units = {pv.UNIT: ('inactive', 0), pv.GUARD_UNIT: ('inactive', 0)}
        mig.unit_state = lambda u: self.units[u]
        m = pv.skeleton()
        m['disks']['os']['bytes'], m['disks']['l1']['bytes'], m['disks']['base']['bytes'] = 16 * MIB, 24 * MIB, 8 * MIB
        for k, d in m['disks'].items():
            qimg('create', '-q', '-f', 'qcow2', '-o', 'compat=1.1,preallocation=off,lazy_refcounts=off', d['path'],
                 str(d['bytes']))
            qio(d['path'], f'write -P 0x{ord(k[0]):02x} 0 1M', f"write -P 0x5a {d['bytes'] - MIB} 512k")
            d['ino'] = os.stat(d['path']).st_ino
        m['sshPublicKey'], m['sshKeyFingerprint'] = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTONLY test', 'SHA256:test'
        shutil.copyfile(LAUNCHER, m['paths']['launcher'])
        os.chmod(m['paths']['launcher'], 0o500)
        m['files'] = {'launcher': sha(LAUNCHER), 'qemuArgv': pv.sha256_text(pv.canonical(pv.qemu_argv(m))),
                      **{'seed/' + n: pv.sha256_text(t) for n, t in pv.seed_files(m).items()}}
        self.m1 = m
        self.mtext = pv.canonical(m)
        with open(m['paths']['manifest'], 'w') as f:
            f.write(self.mtext)
        with open(str(pv.UNIT_PATH), 'w') as f:
            f.write(pv.render_unit(m, pv.sha256_text(self.mtext)))
        self.tdir = os.path.join(self.nvme_mnt, 'enclave-volumes', 'rpc-production')
        self.plan = os.path.join(root, 'plan.json')
        self.journal = os.path.join(root, 'journal.jsonl')

    def args(self, cmd, **kw):
        a = [cmd]
        for k, v in kw.items():
            if v is True:
                a.append('--' + k)
            elif v is not None:
                a += ['--' + k, str(v)]
        return a

    def do(self, cmd, **kw):
        err = iomod.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(iomod.StringIO()):
            rc = mig.main(self.args(cmd, **kw))
        return rc, err.getvalue()

    def plan_ok(self):
        return self.do('plan', manifest=self.m1['paths']['manifest'], launcher=self.m1['paths']['launcher'],
                       **{'target-mount': self.nvme_mnt, 'target-dir': self.tdir, 'roles': 'os,l1', 'out': self.plan})


class Migration(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp(dir=SANDBOX)
        self.e = Env(self.root)

    def tearDown(self):
        shutil.rmtree(self.root, ignore_errors=True)
        shutil.rmtree(pv.STATE_DIR, ignore_errors=True)
        shutil.rmtree(pv.UNIT_PATH.parent, ignore_errors=True)

    def src_hashes(self):
        return {k: sha(d['path']) for k, d in self.e.m1['disks'].items()}

    def test_plan_refuses_without_start_capacity(self):
        e = self.e
        e.free[e.nvme_mnt] = pv.thresholds(mig.DEFAULT_CAPACITY)['start'] + 10 * MIB    # copy bound >= 2 GiB
        rc, err = e.plan_ok()
        self.assertEqual(rc, 2)
        self.assertIn('start threshold', err)
        self.assertFalse(os.path.exists(e.plan))

    def test_plan_accepts_only_empty_private_preexisting_dir(self):
        e = self.e
        os.mkdir(e.tdir, 0o700)
        self.assertEqual(e.plan_ok()[0], 0)
        self.assertTrue(json.load(open(e.plan))['targetDirPreExisting'])
        os.unlink(e.plan)
        open(os.path.join(e.tdir, 'stray'), 'w').close()
        rc, err = e.plan_ok()
        self.assertEqual(rc, 2)
        self.assertIn('not an empty 0700 directory', err)
        os.unlink(os.path.join(e.tdir, 'stray'))
        os.chmod(e.tdir, 0o755)
        self.assertEqual(e.plan_ok()[0], 2)

    def test_full_cycle_resume_and_finalize(self):
        e = self.e
        before = self.src_hashes()
        self.assertEqual(e.plan_ok()[0], 0)
        plan = json.load(open(e.plan))
        self.assertIn('rotation_rate=1', ' '.join(plan['preview']['qemuArgv']))
        e.units[pv.UNIT] = ('active', 4242)
        rc, err = e.do('copy', plan=e.plan, journal=e.journal)
        self.assertEqual((rc, 'MainPID 4242' in err), (2, True))
        self.assertFalse(os.path.exists(e.tdir))
        e.units[pv.UNIT] = ('inactive', 0)
        holder = subprocess.Popen(['/usr/bin/qemu-io', '-f', 'qcow2', e.m1['disks']['l1']['path']],
                                  stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(1.0)
        rc, err = e.do('copy', plan=e.plan, journal=e.journal)
        holder.communicate(b'quit\n', timeout=30)
        self.assertEqual(rc, 2, err)
        self.assertIn('lock', err.lower())
        # abort mid-copy: free space drops to the pause threshold while converting
        t = pv.thresholds(mig.DEFAULT_CAPACITY)
        real_free = pv.fs_free
        calls = {'n': 0}

        def dropping(mount):
            calls['n'] += 1
            return t['pause'] if calls['n'] >= 2 else 10**15
        pv.fs_free = dropping
        rc, err = e.do('copy', plan=e.plan, journal=e.journal)
        pv.fs_free = real_free
        self.assertEqual(rc, 2)
        self.assertIn('pause threshold', err)
        partial = plan['disks']['os']['partial']
        self.assertTrue(os.path.exists(partial))
        self.assertEqual(self.src_hashes(), before)
        rc, err = e.do('copy', plan=e.plan, journal=e.journal)
        self.assertEqual(rc, 2)
        self.assertIn('--resume', err)
        rc, err = e.do('copy', plan=e.plan, journal=e.journal, resume=True)
        self.assertEqual(rc, 0, err)
        for r in ('os', 'l1'):
            dst = plan['disks'][r]['dst']
            self.assertFalse(os.path.exists(plan['disks'][r]['partial']))
            qimg('compare', '-f', 'qcow2', '-F', 'qcow2', e.m1['disks'][r]['path'], dst)
            out = qio(dst, f'read -P 0x{ord(r[0]):02x} 0 1M')
            self.assertNotIn('fail', out.lower())
        self.assertEqual(self.src_hashes(), before)
        rc, err = e.do('copy', plan=e.plan, journal=e.journal)
        self.assertEqual(rc, 2)
        rc, err = e.do('copy', plan=e.plan, journal=e.journal, resume=True)
        self.assertEqual(rc, 0, err)
        # finalize: v2 staged, nothing installed
        out = os.path.join(self.root, 'staged')
        installed = {p: sha(p) for p in (e.m1['paths']['manifest'], e.m1['paths']['launcher'], str(pv.UNIT_PATH))}
        rc, err = e.do('finalize', plan=e.plan, journal=e.journal, out=out)
        self.assertEqual(rc, 0, err)
        self.assertEqual({p: sha(p) for p in installed}, installed)
        self.assertFalse(os.path.exists(os.path.join(str(pv.UNIT_PATH.parent), pv.GUARD_UNIT)))
        mtext = open(os.path.join(out, 'manifest.json')).read()
        m2 = json.loads(mtext)
        pv.validate_v2(m2)
        self.assertEqual(m2['format'], pv.FORMAT_V2)
        self.assertEqual(pv.sha256_text(pv.canonical(pv.qemu_argv(m2))), m2['files']['qemuArgv'])
        for r in ('os', 'l1', 'base'):
            for k in ('serial', 'uuid', 'bytes', 'label', 'mount'):
                self.assertEqual(m2['disks'][r].get(k), e.m1['disks'][r].get(k))
        self.assertEqual(m2['disks']['l1']['path'], plan['disks']['l1']['dst'])
        self.assertEqual(m2['disks']['l1']['ino'], os.stat(plan['disks']['l1']['dst']).st_ino)
        self.assertEqual(m2['disks']['base']['path'], e.m1['disks']['base']['path'])
        for k in ('mac', 'instanceId', 'sshPublicKey', 'sshKeyFingerprint'):
            self.assertEqual(m2[k], e.m1[k])
        self.assertEqual(pv.seed_files(m2), pv.seed_files(e.m1))
        argv = ' '.join(pv.qemu_argv(m2))
        self.assertIn('drive=l10,serial=' + e.m1['disks']['l1']['serial'] + ',rotation_rate=1,', argv)
        self.assertIn('drive=base0,serial=' + e.m1['disks']['base']['serial'] + ',rotation_rate=7200,', argv)
        self.assertIn('id=qmpg', argv)
        unit = open(os.path.join(out, pv.UNIT)).read()
        self.assertIn(f'BindsTo={pv.GUARD_UNIT}', unit)
        self.assertIn(pv.sha256_text(mtext), unit)
        guard = open(os.path.join(out, pv.GUARD_UNIT)).read()
        self.assertIn(f'guard {e.m1["paths"]["manifest"]} {pv.sha256_text(mtext)}', guard)
        self.assertEqual(subprocess.run(['sha256sum', '-c', '--quiet', 'SHA256SUMS'], cwd=out).returncode, 0)
        # install.sh / rollback.sh mechanics with a fake systemctl (verify is expected to fail: fake mounts)
        fake = os.path.join(self.root, 'bin')
        os.makedirs(fake)
        with open(os.path.join(fake, 'systemctl'), 'w') as f:
            f.write('#!/bin/sh\ncase "$*" in *ActiveState*) echo inactive;; *MainPID*) echo 0;; esac\nexit 0\n')
        os.chmod(os.path.join(fake, 'systemctl'), 0o755)
        env = dict(os.environ, PATH=fake + ':/usr/bin:/bin')
        r = subprocess.run(['bash', os.path.join(out, 'install.sh')], env=env, capture_output=True, text=True)
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn('verify FAILED after install', r.stdout)
        self.assertEqual(sha(e.m1['paths']['manifest']), sha(os.path.join(out, 'manifest.json')))
        self.assertEqual(sha(e.m1['paths']['launcher']), sha(os.path.join(out, 'provision_vm.py')))
        bk = [d for d in os.listdir(pv.STATE_DIR) if d.startswith('backup-')]
        self.assertEqual(len(bk), 1)
        r2 = subprocess.run(['bash', os.path.join(out, 'install.sh')], env=env, capture_output=True, text=True)
        self.assertNotEqual(r2.returncode, 0)                     # old shas no longer match: refuses a second install
        r = subprocess.run(['bash', os.path.join(out, 'rollback.sh')], env=env, capture_output=True, text=True)
        self.assertEqual({p: sha(p) for p in installed}, installed, r.stdout + r.stderr)
        self.assertFalse(os.path.exists(os.path.join(str(pv.UNIT_PATH.parent), pv.GUARD_UNIT)))
        self.assertEqual(self.src_hashes(), before)


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(SANDBOX, ignore_errors=True)
