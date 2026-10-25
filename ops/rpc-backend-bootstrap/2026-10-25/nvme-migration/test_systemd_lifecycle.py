#!/usr/bin/python3 -I
"""Real systemd lifecycle tests for the v2 guard/VM unit pair, in a DISPOSABLE nested `systemd --user` manager.

Isolation: the nested manager runs inside a transient Delegate=yes scope of the real user manager, with its own
XDG_RUNTIME_DIR (private bus socket), HOME and SYSTEMD_UNIT_PATH (only the sandbox unit dir). Every systemctl call
below talks to the nested manager only (no DBUS_SESSION_BUS_ADDRESS); the test asserts that production units are
unknown to it. Unit NAMES are test names ('sdltest-*'); the unit FILES are rendered by the real launcher functions.
The guard ExecStart is the real launcher `guard` command on an isolated v2 manifest (three tiny qcow2 disks on the
`/` filesystem). The VM unit keeps the rendered file; a drop-in replaces ONLY ExecStart/ExecStop with a lightweight
fake child: `qemu-system-x86_64 -machine none` exposing the same main + guard QMP monitors (no guest, no disks).

A separate class runs the real `provision_vm.py verify` on an isolated v2 install with production unit names and NO
guard running (install.sh's verify must not need the guard)."""
import importlib.util
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.abspath(os.environ.get('PROVISION_VM_LAUNCHER') or os.path.join(HERE, '..', 'provision_vm.py'))
MIB = 1 << 20
SANDBOX = tempfile.mkdtemp(prefix='sdl-', dir=os.environ.get('TEST_TMP', HERE))            # on the `/` filesystem (not tmpfs)


def load_pv(home):
    os.environ['HOME'] = home
    spec = importlib.util.spec_from_file_location(f'pv_{abs(hash(home))}', LAUNCHER)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def build_v2_state(pv, root, runtime_dir, cap):
    st, ud = pv.STATE_DIR, pv.UNIT_PATH.parent
    os.makedirs(st, 0o700)
    os.makedirs(ud, exist_ok=True)
    vmdir = os.path.join(root, 'vm')
    os.mkdir(vmdir, 0o700)
    m = pv.skeleton()
    p = m['paths']
    rd = os.path.join(runtime_dir, pv.NAME)
    p.update(runtimeDir=rd, qmp=rd + '/qmp.sock', console=rd + '/console.sock', guardQmp=rd + '/guard-qmp.sock',
             guardStatus=str(st / 'guard-status.json'), guardMode=str(st / 'guard-mode.json'),
             unitPath=str(ud / pv.UNIT), guardUnitPath=str(ud / pv.GUARD_UNIT))
    desc = pv.describe_backing('/')
    m['format'] = pv.FORMAT_V2
    m['backings'] = {'nvme': {'kind': 'nvme', 'growth': 'bounded', 'mount': '/', 'dir': vmdir, 'fstype': desc['fstype'],
                              'source': desc['source'], 'fsUuid': desc['fsUuid'], 'leafDisks': desc['leafDisks'],
                              'guestRotationRate': 1, 'discard': 'unmap', 'capacity': cap}}
    for k, size in (('os', 16 * MIB), ('l1', 24 * MIB), ('base', 8 * MIB)):
        d = m['disks'][k]
        d.update(bytes=size, path=f'{vmdir}/{k}.qcow2', backing='nvme')
        subprocess.run(['/usr/bin/qemu-img', 'create', '-q', '-f', 'qcow2', d['path'], str(size)], check=True)
        os.chmod(d['path'], 0o600)
        d['ino'] = os.stat(d['path']).st_ino
    subprocess.run(['/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'sdltest-throwaway', '-f', p['key']],
                   check=True)
    m['sshPublicKey'] = open(p['key'] + '.pub').read().strip()
    m['sshKeyFingerprint'] = subprocess.run(['/usr/bin/ssh-keygen', '-l', '-E', 'sha256', '-f', p['key'] + '.pub'],
                                            check=True, capture_output=True, text=True).stdout.split()[1]
    pv.build_seed(m, pv.Created())
    shutil.copyfile(LAUNCHER, p['launcher'])
    os.chmod(p['launcher'], 0o500)
    with open(p['sshConfig'], 'w') as f:
        f.write(pv.render_ssh_config(m))
    os.chmod(p['sshConfig'], 0o600)
    m['files'] = {'launcher': pv.sha256_file(p['launcher']), 'sshConfig': pv.sha256_text(pv.render_ssh_config(m)),
                  'seedIso': pv.sha256_file(p['seedIso']), 'qemuArgv': pv.sha256_text(pv.canonical(pv.qemu_argv(m))),
                  **{'seed/' + n: pv.sha256_text(t) for n, t in pv.seed_files(m).items()}}
    pv.validate_v2(m)
    mtext = pv.canonical(m)
    with open(p['manifest'], 'w') as f:
        f.write(mtext)
    os.chmod(p['manifest'], 0o600)
    msha = pv.sha256_text(mtext)
    with open(p['unitPath'], 'w') as f:
        f.write(pv.render_unit(m, msha))
    with open(p['guardUnitPath'], 'w') as f:
        f.write(pv.render_guard_unit(m, msha))
    return m, msha, vmdir


TINY = {'floorBytes': 1_000_000, 'pauseMarginBytes': 1_000_000, 'shutdownMarginBytes': 1_000_000,
        'startHeadroomBytes': 1_000_000, 'shutdownLeadSeconds': 2400, 'pollSeconds': 1}


class VerifyWithoutGuard(unittest.TestCase):
    def test_install_verify_does_not_need_the_guard(self):
        root = tempfile.mkdtemp(dir=SANDBOX)
        home = os.path.join(root, 'home')
        pv = load_pv(home)
        rt = tempfile.mkdtemp(prefix='sdv-', dir='/tmp')
        try:
            m, msha, _ = build_v2_state(pv, root, rt, TINY)
            self.assertFalse(os.path.exists(m['paths']['guardStatus']))
            env = {'PATH': '/usr/bin:/bin', 'HOME': home}
            r = subprocess.run(['/usr/bin/python3', '-I', m['paths']['launcher'], 'verify'], env=env,
                               capture_output=True, text=True)
            self.assertEqual(r.returncode, 0, r.stderr[-2000:])
            self.assertEqual(json.loads(r.stdout)['manifestSha256'], msha)
            self.assertFalse(os.path.exists(m['paths']['guardStatus']))     # verify never started/needed a guard
        finally:
            shutil.rmtree(rt, ignore_errors=True)


FAKE_STOP = r'''import json, socket, sys
try:
    s = socket.socket(socket.AF_UNIX); s.settimeout(10); s.connect(sys.argv[1]); f = s.makefile('rwb'); f.readline()
    for c in ('qmp_capabilities', 'quit'):
        f.write(json.dumps({'execute': c}).encode() + b'\n'); f.flush(); f.readline()
except OSError:
    pass
'''


class Nested:
    def __init__(self, home, xdg, unitdir, log):
        self.env = {'PATH': '/usr/bin:/bin', 'HOME': home, 'XDG_RUNTIME_DIR': xdg}
        self.scope = f'sdltest-{os.getpid()}-{int(time.time())}'
        inner = ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', f'HOME={home}', f'XDG_RUNTIME_DIR={xdg}',
                 f'SYSTEMD_UNIT_PATH={unitdir}', '/usr/lib/systemd/systemd', '--user', '--unit=sdltest-idle.target',
                 '--log-target=console', '--log-level=info']
        self.proc = subprocess.Popen(['/usr/bin/systemd-run', '--user', '--scope', '-q', '-p', 'Delegate=yes',
                                      f'--unit={self.scope}'] + inner, stdout=log, stderr=subprocess.STDOUT)
        deadline = time.time() + 30
        while not os.path.exists(os.path.join(xdg, 'systemd/private')):
            if time.time() > deadline or self.proc.poll() is not None:
                raise AssertionError('nested systemd --user did not come up')
            time.sleep(0.1)
        time.sleep(0.5)

    def sc(self, *args, check=False):
        return subprocess.run(['/usr/bin/systemctl', '--user', '--no-pager'] + list(args), env=self.env,
                              capture_output=True, text=True, check=check)

    def prop(self, unit, name):
        return self.sc('show', '-p', name, '--value', unit).stdout.strip()

    def close(self):
        self.sc('exit')                                          # nested manager stops its own units, then exits
        try:
            self.proc.wait(30)
        except subprocess.TimeoutExpired:
            subprocess.run(['/usr/bin/systemctl', '--user', 'kill', '-s', 'KILL', f'{self.scope}.scope'],
                           capture_output=True)
            self.proc.wait(30)
        # the transient scope belongs to this test only: never leave it listed in the real user manager
        subprocess.run(['/usr/bin/systemctl', '--user', 'reset-failed', f'{self.scope}.scope'], capture_output=True)


def wait_for(cond, timeout, what):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if cond():
            return time.time()
        time.sleep(0.2)
    raise AssertionError(f'timed out waiting for {what}')


class Lifecycle(unittest.TestCase):
    def test_guard_vm_lifecycle(self):
        root = tempfile.mkdtemp(dir=SANDBOX)
        home = os.path.join(root, 'home')
        pv = load_pv(home)
        pv.NAME, pv.UNIT, pv.GUARD_UNIT = 'sdltest-rpc', 'sdltest-vm.service', 'sdltest-guard.service'
        pv.UNIT_PATH = pv.UNIT_PATH.parent / pv.UNIT
        xdg = tempfile.mkdtemp(prefix='sdl-', dir='/tmp')
        log = open(os.path.join(root, 'nested-systemd.log'), 'w')
        n = None
        try:
            m, msha, vmdir = build_v2_state(pv, root, xdg, TINY)
            p = m['paths']
            ud = os.path.dirname(p['unitPath'])
            for t in ('sdltest-idle.target', 'basic.target', 'shutdown.target', 'exit.target'):
                with open(os.path.join(ud, t), 'w') as f:
                    f.write('[Unit]\nDescription=sdltest stub\n')
            with open(os.path.join(ud, 'sdltest-other.service'), 'w') as f:
                f.write('[Service]\nExecStart=/usr/bin/sleep infinity\n')
            stop = os.path.join(root, 'fake_vm_stop.py')
            with open(stop, 'w') as f:
                f.write(FAKE_STOP)
            os.makedirs(os.path.join(ud, pv.UNIT + '.d'))
            with open(os.path.join(ud, pv.UNIT + '.d', '50-sdltest-fake-child.conf'), 'w') as f:
                f.write('[Service]\nExecStart=\nExecStart=/usr/bin/qemu-system-x86_64 -machine none -nodefaults '
                        f"-display none -qmp unix:{p['qmp']},server=on,wait=off -chardev socket,id=qmpg,"
                        f"path={p['guardQmp']},server=on,wait=off -mon chardev=qmpg,mode=control\n"
                        f'ExecStop=\nExecStop=/usr/bin/python3 -I {stop} {p["qmp"]}\n')
            n = Nested(home, xdg, ud, log)
            vm, guard, other = pv.UNIT, pv.GUARD_UNIT, 'sdltest-other.service'
            for prod in ('enclave-rpc-production-vm.service', 'enclave-guestd.service'):
                self.assertEqual(n.prop(prod, 'LoadState'), 'not-found', 'not the isolated manager')
            self.assertEqual(n.prop(guard, 'LoadState'), 'loaded', n.sc('status', guard).stdout)
            n.sc('start', other, check=True)

            def status():
                try:
                    return json.load(open(p['guardStatus']))
                except (OSError, ValueError):
                    return {}

            # 1. start: guard READY (Type=notify) before the VM process starts; guard connects to its monitor
            r = n.sc('start', vm)
            self.assertEqual(r.returncode, 0, r.stderr + n.sc('status', guard, vm).stdout)
            self.assertEqual((n.prop(vm, 'ActiveState'), n.prop(guard, 'ActiveState')), ('active', 'active'))
            self.assertLessEqual(int(n.prop(guard, 'ActiveEnterTimestampMonotonic')),
                                 int(n.prop(vm, 'ExecMainStartTimestampMonotonic')))
            wait_for(lambda: status().get('qemuSeen') and status().get('state') == 'armed', 15, 'guard armed+seen')
            # 2. watchdog satisfied for > WatchdogSec
            time.sleep(40)
            self.assertEqual((n.prop(guard, 'ActiveState'), n.prop(guard, 'NRestarts')), ('active', '0'))
            # 3. QEMU exits on its own -> VM inactive, guard exits 0, both clean; other app untouched
            q = pv.Qmp(p['qmp'])
            try:
                q.cmd('quit')
            except OSError:
                pass
            wait_for(lambda: n.prop(vm, 'ActiveState') == 'inactive' and n.prop(guard, 'ActiveState') == 'inactive',
                     30, 'both units inactive after QEMU exit')
            self.assertEqual([n.prop(u, 'Result') for u in (vm, guard)], ['success', 'success'])
            self.assertEqual(n.prop(guard, 'ExecMainStatus'), '0')
            self.assertEqual(n.prop(other, 'ActiveState'), 'active')
            # 4. guard killed -> BindsTo stops the VM (through its ExecStop); other app untouched
            n.sc('reset-failed', guard, vm)
            n.sc('start', vm, check=True)
            wait_for(lambda: status().get('qemuSeen'), 15, 'guard sees QEMU')
            n.sc('kill', '-s', 'KILL', guard, check=True)
            wait_for(lambda: n.prop(vm, 'ActiveState') == 'inactive', 60, 'VM stopped after guard SIGKILL')
            self.assertEqual(n.prop(other, 'ActiveState'), 'active')
            # 5. guard hangs -> watchdog -> guard killed -> VM stopped, bounded by WatchdogSec + TimeoutAbortSec
            n.sc('reset-failed', guard, vm)
            n.sc('start', vm, check=True)
            wait_for(lambda: status().get('qemuSeen'), 15, 'guard sees QEMU')
            t0 = time.time()
            os.kill(int(n.prop(guard, 'MainPID')), signal.SIGSTOP)
            t1 = wait_for(lambda: n.prop(vm, 'ActiveState') == 'inactive', 120, 'VM stopped after guard watchdog')
            self.assertEqual(n.prop(guard, 'Result'), 'watchdog')
            self.watchdog_stop_s = round(t1 - t0, 1)
            print(f'watchdog-to-VM-inactive seconds: {self.watchdog_stop_s}', flush=True)
            self.assertLess(t1 - t0, 30 + 10 + 30 + 15)
            self.assertEqual(n.prop(other, 'ActiveState'), 'active')
            # 6. runtime fail-closed: backing identity check fails -> guard pauses ONLY this VM, stays up
            n.sc('reset-failed', guard, vm)
            n.sc('start', vm, check=True)
            wait_for(lambda: status().get('qemuSeen'), 15, 'guard sees QEMU')
            os.rename(vmdir, vmdir + '.moved')
            try:
                wait_for(lambda: status().get('state') == 'paused', 15, 'guard paused')
                q = pv.Qmp(p['qmp'])
                self.assertEqual(q.cmd('query-status')['status'], 'paused')
                q.close()
                self.assertEqual((n.prop(vm, 'ActiveState'), n.prop(guard, 'ActiveState')), ('active', 'active'))
            finally:
                os.rename(vmdir + '.moved', vmdir)
            n.sc('stop', vm, check=True)
            wait_for(lambda: n.prop(guard, 'ActiveState') == 'inactive', 30, 'guard stopped with the VM (PartOf)')
            self.assertEqual(n.prop(vm, 'ActiveState'), 'inactive')
            # 7. startup guard failure: VM never starts, other app untouched
            n.sc('reset-failed', guard, vm)
            before = n.prop(vm, 'ExecMainStartTimestampMonotonic')
            os.rename(vmdir, vmdir + '.moved')
            try:
                r = n.sc('start', vm)
                self.assertNotEqual(r.returncode, 0)
                self.assertEqual((n.prop(guard, 'Result'), n.prop(guard, 'ExecMainStatus')), ('exit-code', '2'))
                self.assertEqual(n.prop(vm, 'ActiveState'), 'inactive')
                self.assertEqual(n.prop(vm, 'ExecMainStartTimestampMonotonic'), before)
            finally:
                os.rename(vmdir + '.moved', vmdir)
            self.assertEqual(n.prop(other, 'ActiveState'), 'active')
            n.sc('stop', other, check=True)
        finally:
            if n is not None:
                n.close()
            log.close()
            subprocess.run(['chmod', '-R', 'u+rwx', xdg], capture_output=True)
            shutil.rmtree(xdg, ignore_errors=True)
            leftover = subprocess.run(['/usr/bin/systemctl', '--user', 'list-units', '--all', '--no-legend',
                                       'sdltest*'], capture_output=True, text=True).stdout.strip()
            self.assertEqual(leftover, '', 'test scope left in the real user manager')
            self.assertFalse(os.path.exists(xdg))


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        shutil.rmtree(SANDBOX, ignore_errors=True)
