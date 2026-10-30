#!/usr/bin/python3 -I
"""Targeted exporter ownership / teardown / bounded-stderr regressions for offline_mask.py.
Injected effects only: fake processes, a fake /proc table, fake pidfds and mount state.  The only real OS objects are
os.pipe() pairs and one TemporaryDirectory file used as the 'exported' file; no native tool, no production path."""
import os, signal, sys, tempfile, types, unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import offline_mask as om  # noqa: E402  (import is inert by contract)

LEADER, CHILD, START, CHILD_START = 4242, 4243, 100, 200
FUSER = '/usr/bin/fusermount3'


class Proc:
    """Popen stand-in: real stderr pipe; wait() is the only reaping operation"""
    def __init__(self, hold_open=False):
        r, w = os.pipe()
        self.w = w if hold_open else None
        if not hold_open:
            os.close(w)
        self.stderr = os.fdopen(r, 'rb', 0)
        self.pid, self.returncode, self.waits, self.on_wait = LEADER, None, 0, None

    def wait(self, timeout=None):
        if self.on_wait:
            self.on_wait()
        self.waits += 1
        self.returncode = 0
        return 0


class Fx(om.OsEffects):
    def __init__(self, proc, child_pgrp=LEADER, child_ignores_term=False, leader_exits_on_unmount=True,
                 child_exits_on_unmount=True):
        self.proc, self.leader_alive, self.mounted, self.sent, self.runs, self.t = proc, True, True, [], [], 0.0
        self.table = {CHILD: ('S', LEADER, child_pgrp, LEADER, CHILD_START)}
        self.ignore, self.l_unmount, self.c_unmount, self.leader_start = (child_ignores_term, leader_exits_on_unmount,
                                                                          child_exits_on_unmount, START)
        super().__init__(popen=lambda argv, **kw: proc, killpg=self._killpg, proc_starttime=self._start,
                         clock=lambda: self.t, proc_table=lambda: dict(self.table), pidfd_open=self._pidfd_open,
                         pidfd_signal=self._pidfd_signal, ismount=lambda p: self.mounted)
        self.sleep, self.close, self.join_seconds = self._sleep, (lambda fd: None), 2

    def _sleep(self, s):
        self.t += s

    def _start(self, pid):
        if pid == LEADER:
            return self.leader_start
        r = self.table.get(pid)
        return r[4] if r else None

    def _exited(self, pid):
        return None if self.leader_alive else types.SimpleNamespace(si_code=os.CLD_EXITED, si_status=0)

    def _killpg(self, pid, sig):
        self.sent.append(('group', pid, sig))
        self.leader_alive = False
        for p, r in list(self.table.items()):
            if r[2] == pid and (sig == signal.SIGKILL or not self.ignore):
                del self.table[p]

    def _pidfd_open(self, pid):
        if pid not in self.table:
            raise ProcessLookupError
        return pid

    def _pidfd_signal(self, fd, sig):
        self.sent.append(('pidfd', fd, sig))
        if sig == signal.SIGKILL or not self.ignore:
            self.table.pop(fd, None)

    def run(self, argv, timeout, limit):
        self.runs.append(argv)
        if argv[:2] == [FUSER, '-u']:
            self.mounted = False
            if self.l_unmount:
                self.leader_alive = False
            if self.c_unmount:
                self.table.clear()
        return 0, b'', b''


def writer(fx):
    w = om.Writer.__new__(om.Writer)
    w.handles, w.fx, w.t, w.qlocks, w.ev = [], fx, {'fusermount3': FUSER}, [], {}
    return w


class ExporterTests(unittest.TestCase):
    def setUp(self):
        om._CANCEL.update(deferred=False, pending=None)
        self.addCleanup(om._CANCEL.update, deferred=False, pending=None)
        d = tempfile.TemporaryDirectory()
        self.addCleanup(d.cleanup)
        self.dir, self.file, self.reg = d.name, os.path.join(d.name, 'disk.raw'), []

    def start(self, fx, on_disk=4096, want=4096, register=None):
        with open(self.file, 'wb') as f:
            f.truncate(on_disk)
        return fx.export_start(['/usr/bin/nbdfuse', '-r', self.file, '[', '/usr/bin/qemu-nbd', ']'], self.dir, self.file,
                               want, 30, 1024, register or self.reg.append, FUSER)

    def test_normal_termination_verifies_descendants_and_mount(self):
        fx = Fx(Proc())
        h = self.start(fx)
        self.assertEqual(self.reg, [h])                                  # registered at spawn
        self.assertIn((CHILD, CHILD_START), h['owned'])
        ev = fx.export_stop(h, FUSER, 10, 4096)
        self.assertTrue(ev['normal'])
        self.assertEqual((ev['signals'], ev['survivors'], ev['result']), ([], [], 'complete'))
        self.assertTrue(ev['drainerJoined'])
        self.assertEqual((fx.proc.waits, fx.mounted, fx.table), (1, False, {}))

    def test_mounted_wrong_size_startup_is_cleaned_up(self):
        fx = Fx(Proc())
        with self.assertRaisesRegex(om.Refusal, 'appeared with size 10'):
            self.start(fx, on_disk=10)
        h = self.reg[0]
        self.assertEqual(h['closed']['result'], 'complete')
        self.assertIn(('group', LEADER, signal.SIGTERM), fx.sent)
        self.assertIn([FUSER, '-u', self.dir], fx.runs)                  # pinned unmount tool reached the startup path
        self.assertEqual((fx.mounted, fx.proc.waits), (False, 1))

    def test_leader_exited_child_ignoring_term_is_escalated_before_reap(self):
        fx = Fx(Proc(), child_pgrp=CHILD, child_ignores_term=True, child_exits_on_unmount=False)
        h = self.start(fx)
        seen = []
        fx.proc.on_wait = lambda: seen.append(dict(fx.table))
        with self.assertRaisesRegex(om.Refusal, 'did not stop normally'):
            fx.export_stop(h, FUSER, 10, 4096)
        self.assertIn([int(signal.SIGKILL), 'pidfd', CHILD], h['closed']['signals'])
        self.assertEqual(seen, [{}])                    # leader reaped only once the owned child was gone
        self.assertLess(fx.t, 40)                       # bounded escalation

    def test_cancellation_reaches_the_same_cleanup(self):
        fx = Fx(Proc())
        w = writer(fx)
        h = self.start(fx, register=w.handles.append)
        with self.assertRaises(om.Refusal):
            om._cancel(signal.SIGTERM, None)            # outside cleanup: cancellation raises into execute
        orig = fx._killpg
        fx.killpg = lambda pid, sig: (om._cancel(signal.SIGTERM, None), orig(pid, sig))   # second signal mid-cleanup
        self.assertEqual(w.cleanup(), [])
        self.assertEqual(om._CANCEL['pending'], signal.SIGTERM)
        self.assertEqual((w.handles, h['closed']['result'], fx.mounted), ([], 'complete', False))

    def test_pid_identity_mismatch_never_signals(self):
        fx = Fx(Proc())
        h = self.start(fx)
        fx.leader_start = 999                           # recycled leader identity
        with self.assertRaisesRegex(om.Refusal, 'identity mismatch'):
            fx.export_force_cleanup(h, FUSER)
        self.assertEqual(fx.sent, [])
        fx.leader_start = START                         # member pid recycled between pidfd_open and the check
        fx.table[CHILD] = ('S', LEADER, CHILD, LEADER, CHILD_START)
        fx.ignore = True
        fx.proc_starttime = lambda pid: START if pid == LEADER else 999
        with self.assertRaisesRegex(om.Refusal, 'owned survivors'):
            fx.export_force_cleanup(h, FUSER)
        self.assertFalse([s for s in fx.sent if s[0] == 'pidfd'])
        self.assertIsNone(h['closed'])

    def test_unrelated_recycled_member_is_not_owned(self):
        fx = Fx(Proc())
        h = self.start(fx)
        fx.table[CHILD] = ('S', 1, CHILD, CHILD, 999)   # same pid, other start time and session: not ours
        ev = fx.export_force_cleanup(h, FUSER)
        self.assertFalse([s for s in ev['signals'] if s[1] == 'pidfd'])

    def test_stderr_overflow_during_unrelated_parent_work(self):
        fx = Fx(Proc(hold_open=True))
        w = writer(fx)
        h = self.start(fx, register=w.handles.append)
        os.write(fx.proc.w, b'x' * 4096)                # exporter floods stderr while the parent is busy elsewhere
        os.close(fx.proc.w)
        h['drainer'].join(2)
        self.assertIn('exceeded 1024', h['fault'])
        self.assertIn(('group', LEADER, signal.SIGTERM), fx.sent)    # stopped by the drainer, not by parent polling
        self.assertLessEqual(len(h['stderrKept']), 1024)
        d = om.Deadline(60, lambda: 0.0)
        d.probe = w.check_exporters
        with self.assertRaisesRegex(om.Refusal, 'background exporter failure'):
            d.left('copy', 1)                           # next hash/command step observes it
        problems = w.cleanup()
        self.assertTrue(any('exceeded' in p for p in problems))

    def test_no_ready_with_unjoined_or_failed_exporter(self):
        w = writer(Fx(Proc()))
        w.ev = {'exporters': [{'pid': 1, 'result': 'complete', 'fault': 'x', 'drainerJoined': True}]}
        with self.assertRaisesRegex(om.Refusal, 'failed teardown'):
            w.assert_quiesced()
        w.ev = {'exporters': [{'pid': 1, 'result': 'complete', 'fault': None, 'drainerJoined': True}]}
        w.assert_quiesced()
        fx = Fx(Proc(hold_open=True))                   # stray holder keeps the stderr pipe open
        fx.join_seconds = 0.05
        self.addCleanup(os.close, fx.proc.w)
        h = self.start(fx)
        with self.assertRaisesRegex(om.Refusal, 'drainer did not finish'):
            fx.export_stop(h, FUSER, 10, 4096)
        self.assertIsNone(h['closed'])
        w.handles = [h]
        with self.assertRaisesRegex(om.Refusal, 'still registered'):
            w.assert_quiesced()


if __name__ == '__main__':
    unittest.main()
