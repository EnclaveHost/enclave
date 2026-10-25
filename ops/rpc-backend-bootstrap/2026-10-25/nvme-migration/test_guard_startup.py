#!/usr/bin/env python3
"""Guard startup regressions (root 17:41 failure: QEMU preallocating 64 GiB never greeted within the guard's 60 s,
leaked half-open QMP connections filled the monitor backlog -> EAGAIN, powerdown died with a greeting traceback).
Run: python3 -m unittest -v test_guard_startup   (no VM; the real-QEMU case uses `-machine none`, no KVM, tiny RAM)."""
import contextlib
import gc
import importlib.util
import io as iomod
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
LAUNCHER = os.path.abspath(os.environ.get('PROVISION_VM_LAUNCHER') or os.path.join(HERE, '..', 'provision_vm.py'))
SANDBOX = tempfile.mkdtemp(prefix='guard-start-', dir=os.environ.get('TEST_TMP', '/tmp'))
os.environ['HOME'] = os.path.join(SANDBOX, 'home')          # the launcher derives its state paths from HOME at import
os.makedirs(os.environ['HOME'])
spec = importlib.util.spec_from_file_location('pv_guard_startup', LAUNCHER)
pv = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pv)
SOCKDIR = tempfile.mkdtemp(prefix='gs-', dir='/tmp')   # AF_UNIX paths must stay < 108 bytes: never under TEST_TMP
QEMU = shutil.which('qemu-system-x86_64')
CAP = {'floorBytes': 100, 'pauseMarginBytes': 100, 'shutdownMarginBytes': 100, 'startHeadroomBytes': 100,
       'shutdownLeadSeconds': 1, 'pollSeconds': 1}          # floor 100, pause 200, shutdown 300, start 400


def tearDownModule():
    shutil.rmtree(SANDBOX, ignore_errors=True)
    shutil.rmtree(SOCKDIR, ignore_errors=True)


def v2_min(qmp_path='/nonexistent/qmp'):
    b = {'kind': 'nvme', 'growth': 'bounded', 'mount': '/vm', 'dir': '/vm/x', 'discard': 'ignore', 'fstype': 'ext4',
         'source': '/dev/x', 'fsUuid': 'u', 'leafDisks': [{'name': 'n', 'model': 'm', 'rotational': False}],
         'guestRotationRate': 1, 'capacity': CAP}
    paths = {k: '/tmp/unused-' + k for k in pv.V2_PATHS}
    paths['guardQmp'] = qmp_path
    return {'format': pv.FORMAT_V2, 'paths': paths, 'backings': {'nvme': b},
            'disks': {'l1': {'path': '/vm/x/l1.qcow2', 'backing': 'nvme'}}}


def open_fds():
    gc.collect()                                         # earlier tests' dropped objects must not shift the count
    return len(os.listdir('/proc/self/fd'))


class FakeQmp:
    def __init__(self):
        self.log = []

    def cmd(self, name, args=None):
        self.log.append(name)
        return {'status': 'running'} if name == 'query-status' else {}


class ScriptIO:
    """1 s per loop. connect(i, handshake) -> FakeQmp or raises OSError."""

    def __init__(self, free=10**6, present=lambda i: True, connect=None, check_fail=False):
        self.i, self.t, self.free_v, self.present_f = -1, 0.0, free, present
        self.connect, self.check_fail = connect, check_fail
        self.handshakes, self.notes, self.states, self.lines = [], [], [], []

    def now(self):
        self.i += 1
        self.t += 1.0
        return self.t

    def check(self, b):
        if self.check_fail:
            raise pv.Refuse('identity changed')

    def free(self, mount):
        return self.free_v

    def qemu_present(self):
        return self.present_f(self.i)

    def qmp(self, handshake_timeout=None):
        self.handshakes.append(handshake_timeout)
        return self.connect(self.i, handshake_timeout)

    def mode(self):
        return None

    def notify(self, msg):
        self.notes.append(msg)

    def status(self, obj):
        self.states.append(obj['state'])

    def log(self, msg):
        self.lines.append(msg)

    def sleep(self, s):
        pass


def never(i, h):
    raise BlockingIOError(11, 'Resource temporarily unavailable')


class InitialGrace(unittest.TestCase):
    def test_absent_forever_fails_closed_after_exactly_300s(self):
        io = ScriptIO(connect=never)                     # loop k runs at t=k; first failed attempt at t=1
        self.assertIsNone(pv.guard_loop(v2_min(), 'S', io, max_loops=301))   # t=301: 300 s elapsed -> still allowed
        io = ScriptIO(connect=never)
        self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=400), 3)
        self.assertEqual(io.t, 302.0)                    # first moment past 300 s
        self.assertTrue(all(h == pv.QMP_INITIAL_HANDSHAKE_S == 1 for h in io.handshakes))
        self.assertEqual(len(io.handshakes), 302)        # one fresh short attempt per poll, no retry storm
        self.assertEqual(sum(n == 'WATCHDOG=1' for n in io.notes), 301)  # watchdog kept during the whole grace
        self.assertIn('no monitor within 300 s (QEMU startup)', io.lines[-1])

    def test_delayed_greeting_then_runtime_policy_unchanged(self):
        state = {'up': True}

        def connect(i, h):
            if i < 200 or not state['up']:
                raise TimeoutError('timed out')
            return FakeQmp()
        q_lost_at = []

        class LossyQmp(FakeQmp):
            def cmd(self, name, args=None):
                if io.i >= 230:
                    state['up'] = False
                    q_lost_at.append(io.i)
                    raise OSError('QMP closed during query-status')
                return super().cmd(name, args)
        io = ScriptIO(connect=lambda i, h: LossyQmp() if (i >= 200 and state['up']) else connect(i, h))
        # a QMP command failure while QEMU is present is the UNCHANGED immediate fail-closed runtime policy
        self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=1000), 3)
        self.assertEqual(q_lost_at[0], 230)
        self.assertIn('guard QMP failed', io.lines[-1])
        self.assertEqual(io.handshakes[:200], [1] * 200)
        self.assertEqual(io.handshakes[200], 1)          # the successful first connect used the short handshake

    def test_qemu_gone_after_seen_exits_0_unchanged(self):
        io = ScriptIO(present=lambda i: i < 5, connect=lambda i, h: FakeQmp())
        self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=1000), 0)
        self.assertEqual(io.handshakes, [1])

    def test_reconnect_after_seen_keeps_60s_not_300s(self):
        calls = iter([True, False] + [True] * 10_000)    # loop 0 present; re-check after the QMP failure: gone (continue)

        class Drop(FakeQmp):
            def cmd(self, name, args=None):
                raise OSError('QMP closed during query-status')
        io = ScriptIO(connect=lambda i, h: Drop() if i == 0 else never(i, h))
        io.qemu_present = lambda: next(calls)
        self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=1000), 3)
        self.assertEqual(io.handshakes[0], 1)            # first connect: short initial handshake
        self.assertTrue(all(h is None for h in io.handshakes[1:]))   # reconnects: the unchanged runtime Qmp()
        self.assertEqual(io.t, 2.0 + 61)                 # first reconnect failure at t=2; exits once > 60 s
        self.assertIn('no monitor within 60 s;', io.lines[-1])

    def test_qmp_command_failure_while_present_exits_3_unchanged(self):
        class Drop(FakeQmp):
            def cmd(self, name, args=None):
                raise OSError('closed')
        io = ScriptIO(connect=lambda i, h: Drop())
        self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=10), 3)
        self.assertEqual(io.t, 1.0)

    def test_capacity_shutdown_level_during_startup_refuses_immediately(self):
        io = ScriptIO(free=250, connect=never)           # pause 200 < 250 <= shutdown 300 -> 'shutdown'
        self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=400), 3)
        self.assertEqual(io.t, 1.0)
        self.assertIn('capacity shutdown', io.lines[-1])

    def test_capacity_pause_and_check_failure_during_startup_refuse_immediately(self):
        for io in (ScriptIO(free=150, connect=never), ScriptIO(check_fail=True, connect=never)):
            self.assertEqual(pv.guard_loop(v2_min(), 'S', io, max_loops=400), 3)
            self.assertEqual(io.t, 1.0)
            self.assertIn('capacity pause', io.lines[-1])

    def test_unsafe_capacity_after_connect_still_pauses(self):
        q = FakeQmp()
        io = ScriptIO(free=150, connect=lambda i, h: q)
        self.assertIsNone(pv.guard_loop(v2_min(), 'S', io, max_loops=2))
        self.assertIn('stop', q.log)
        self.assertEqual(io.states, ['paused', 'paused'])

    def test_waits_without_socket_and_without_deadline_as_before(self):
        io = ScriptIO(present=lambda i: False, connect=never)
        self.assertIsNone(pv.guard_loop(v2_min(), 'S', io, max_loops=600))
        self.assertEqual(io.handshakes, [])


SERVER = r"""
import json, os, socket, sys, time
path, accept, delay, greet, reply, log = sys.argv[1], sys.argv[2] == '1', float(sys.argv[3]), sys.argv[4] == '1', sys.argv[5], sys.argv[6]
def note(m):
    with open(log, 'a') as f:
        f.write(m + '\n')
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path)
s.listen(1)
note('listening')
if not accept:
    time.sleep(3600)
time.sleep(delay)
while True:
    c, _ = s.accept()
    note('accepted')
    try:
        if greet:
            c.sendall(b'{"QMP": {"version": {}, "capabilities": []}}\n')
        c.settimeout(5)
        f = c.makefile('rb')
        while True:
            line = f.readline()
            if not line:
                note('eof')
                break
            c.sendall(b'{"return": {"status": "running"}}\n' if reply == 'ok' else reply.encode() + b'\n')
    except OSError as e:
        note('error ' + type(e).__name__)
    c.close()
"""


class Listener:
    """A real AF_UNIX monitor endpoint in a CHILD process (so this process's FD count is the client's alone): backlog 1,
    optionally accepting and greeting after `delay` s; it logs accepted/eof per connection."""

    def __init__(self, path, accept=True, delay=0.0, greet=True, reply='ok'):
        self.path, self.log = path, path + '.log'
        self.p = subprocess.Popen([sys.executable, '-c', SERVER, path, '1' if accept else '0', str(delay),
                                   '1' if greet else '0', reply, self.log])
        deadline = time.monotonic() + 10
        while not os.path.exists(self.log) and time.monotonic() < deadline:
            time.sleep(0.02)

    def events(self):
        with contextlib.suppress(FileNotFoundError):
            return open(self.log).read().split()
        return []

    def close(self):
        if self.p.poll() is None:
            self.p.kill()
        self.p.wait(timeout=10)
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.path)


class RealSocketQmp(unittest.TestCase):
    def setUp(self):
        self.d = tempfile.mkdtemp(prefix='q', dir=SOCKDIR)
        self.path = os.path.join(self.d, 'm')

    def test_never_accepted_backlog_full_no_fd_leak(self):
        lst = Listener(self.path, accept=False)          # QEMU busy: listening, never accepting
        try:
            before = open_fds()
            errs = set()
            for _ in range(40):
                with self.assertRaises(OSError) as cm:
                    pv.Qmp(self.path, handshake_timeout=0.05)
                errs.add(type(cm.exception).__name__)
            self.assertEqual(open_fds(), before)        # every failed __init__ closed socket + makefile
            self.assertTrue(errs <= {'TimeoutError', 'BlockingIOError'}, errs)
        finally:
            lst.close()

    def test_accepted_no_greeting_times_out_and_closes(self):
        lst = Listener(self.path, accept=True, greet=False)
        try:
            before = open_fds()
            t0 = time.monotonic()
            with self.assertRaises(TimeoutError):
                pv.Qmp(self.path, handshake_timeout=0.3)
            self.assertLess(time.monotonic() - t0, 1.5)
            self.assertEqual(open_fds(), before)
            time.sleep(0.5)
            self.assertEqual(lst.events()[-2:], ['accepted', 'eof'])   # the server saw our side CLOSED, not dangling
        finally:
            lst.close()

    def test_malformed_reply_is_oserror_and_closes(self):
        lst = Listener(self.path, reply='not json')
        try:
            before = open_fds()
            with self.assertRaises(OSError) as cm:
                pv.Qmp(self.path, handshake_timeout=1)
            self.assertIn('malformed', str(cm.exception))
            self.assertEqual(open_fds(), before)
        finally:
            lst.close()

    def test_success_restores_runtime_timeout(self):
        lst = Listener(self.path)
        try:
            q = pv.Qmp(self.path, timeout=10, handshake_timeout=1)
            self.assertEqual(q.s.gettimeout(), 10)
            self.assertEqual(q.cmd('query-status')['status'], 'running')
            q.close()
        finally:
            lst.close()

    def test_guard_loop_real_delayed_greeting(self):
        lst = Listener(self.path, accept=True, delay=2.5)   # accepts + greets only after 2.5 s

        class IO(pv.GuardIO):
            def __init__(s, m):
                super().__init__(m)
                s.notes, s.states = [], []

            def check(s, b):
                pass

            def free(s, mount):
                return 10**6

            def mode(s):
                return None

            def notify(s, msg):
                s.notes.append(msg)

            def status(s, obj):
                s.states.append(obj.get('qemuSeen'))
                if len(s.states) > 2 and all(s.states[-3:]):
                    lst.close()                          # QEMU "exits" after a few connected polls

            def log(s, msg):
                pass

            sleep = staticmethod(lambda s: time.sleep(0.2))
        io = IO(v2_min(self.path))
        before = open_fds()
        t0 = time.monotonic()
        rc = pv.guard_loop(v2_min(self.path), 'S', io, max_loops=200)
        self.assertEqual(rc, 0)
        self.assertGreater(time.monotonic() - t0, 2.4)
        self.assertIn(False, io.states)                  # polled (and fed the watchdog) before the greeting
        self.assertGreaterEqual(sum(n == 'WATCHDOG=1' for n in io.notes), io.states.index(True) + 1)
        self.assertLessEqual(open_fds(), before + 1)     # no growth with the number of failed attempts


class PowerdownHandshake(unittest.TestCase):
    def test_no_greeting_is_controlled_failure_not_traceback(self):
        d = tempfile.mkdtemp(prefix='p', dir=SOCKDIR)
        path = os.path.join(d, 'm')
        lst = Listener(path, accept=False)
        orig = pv.load_manifest
        pv.load_manifest = lambda manifest, want=None: ({'paths': {'qmp': path}, 'format': 'x'}, 'S')
        out = iomod.StringIO()
        try:
            before = open_fds()
            t0 = time.monotonic()
            with contextlib.redirect_stdout(out):
                rc = pv.cmd_powerdown('ignored')
            self.assertEqual(rc, 1)
            self.assertLess(time.monotonic() - t0, 12)   # bounded by the unchanged 10 s socket timeout
            self.assertIn('powerdown: QMP handshake failed', out.getvalue())
            self.assertEqual(open_fds(), before)
        finally:
            pv.load_manifest = orig
            lst.close()


@unittest.skipUnless(QEMU and os.environ.get('GUARD_REAL_QEMU') == '1', 'real QEMU case needs GUARD_REAL_QEMU=1')
class RealQemuStalledMonitor(unittest.TestCase):
    """Real QEMU (-machine none, no KVM, no disks) with its monitor stalled by SIGSTOP for ~4 s, as QEMU is while
    preallocating RAM: the guard's 1 s attempts fail without leaking, then it connects to the real monitor."""

    def test_guard_survives_stalled_real_monitor(self):
        d = tempfile.mkdtemp(prefix='r', dir=SOCKDIR)
        path = os.path.join(d, 'qmp')
        p = subprocess.Popen([QEMU, '-machine', 'none', '-nodefaults', '-display', 'none', '-S', '-m', '16',
                              '-qmp', f'unix:{path},server=on,wait=off'], stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        try:
            deadline = time.monotonic() + 20
            while not os.path.exists(path) and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertTrue(os.path.exists(path))
            os.kill(p.pid, signal.SIGSTOP)
            threading.Timer(4.0, lambda: os.kill(p.pid, signal.SIGCONT)).start()
            seen = []

            class IO(pv.GuardIO):
                def check(s, b):
                    pass

                def free(s, mount):
                    return 10**6

                def mode(s):
                    return None

                def notify(s, msg):
                    pass

                def status(s, obj):
                    seen.append(obj.get('qemuSeen'))
                    if len(seen) >= 3 and all(seen[-3:]) and p.poll() is None:
                        p.send_signal(signal.SIGTERM)   # QEMU exits -> socket gone -> guard exits 0
                        p.wait(timeout=10)
                        with contextlib.suppress(FileNotFoundError):
                            os.unlink(path)             # as the unit's cleanup would, if QEMU left the path

                def log(s, msg):
                    pass

                sleep = staticmethod(lambda s: time.sleep(0.3))
            before = open_fds()
            rc = pv.guard_loop(v2_min(path), 'S', IO(v2_min(path)), max_loops=200)
            self.assertEqual(rc, 0)
            self.assertIn(False, seen)
            self.assertIn(True, seen)
            self.assertLessEqual(open_fds(), before + 1)
        finally:
            if p.poll() is None:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(p.pid, signal.SIGCONT)
                p.kill()
            p.wait(timeout=10)


if __name__ == '__main__':
    unittest.main()
