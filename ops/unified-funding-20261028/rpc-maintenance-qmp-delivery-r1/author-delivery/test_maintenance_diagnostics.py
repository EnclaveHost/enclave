"""Offline regression tests for launch-path phase/errno diagnostics, QMP wiring and owned cleanup in maint_boot.py.
AUTHORED ONLY, NOT RUN by the source author. Drives the REAL cmd_launch/open_qmp/verify_prelaunch/wait_ssh/powerdown/cleanup
/main with the REAL QMP class over fake sockets (test_qmp_transport.FakePeer) and a fake monotonic clock. Only the checks that
need the live runtime (pins, host, backup, capacity, argv render) are replaced, per test, by unittest.mock context managers;
/proc, cgroup and meminfo are fixture files in a TemporaryDirectory. No QEMU, systemd, SSH, network, images or databases."""
import contextlib
import errno
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod
T = load('qmp_transport_fixture', HERE / 'test_qmp_transport.py')
M, FakeClock, FakePeer, GREETING, EOF, ok, event = T.M, T.FakeClock, T.FakePeer, T.GREETING, T.EOF, T.ok, T.event

SEED_LIMITS = {'copyS': 1800, 'qmpS': 180, 'sshS': 600, 'guestS': 480, 'powerdownS': 300, 'unitGoneS': 60, 'stopS': 180,
               'runtimeMaxS': 3000, 'consoleBytes': 16 << 20, 'outBytes': 1 << 20}
SEED_PROPERTIES = ['MemoryMax=10737418240', 'MemorySwapMax=0', 'TasksMax=512', 'LimitNOFILE=4096', 'NoNewPrivileges=yes',
                   'UMask=0077', 'KillMode=mixed', 'TimeoutStopSec=120', 'RuntimeMaxSec=3000', 'Restart=no', 'CollectMode=inactive']
EAGAIN = errno.errorcode[errno.EAGAIN]


class Seam:
    """the deadline-aware factory seam: each attempt is the REAL QMP constructor over the harness' next FakePeer"""
    DEADLINE_AWARE = True
    def __init__(self, h):
        self.h = h
    def __call__(self, path, *, end, clock):
        h = self.h
        h.ends.append(end)
        if h.on_connect is not None:
            h.on_connect()
        peer = h.peers.pop(0)
        return M.QMP(path, end=end, clock=clock, sock=lambda: peer)


class Launch:
    """hermetic cmd_launch fixture: unit/ssh via a recording fake run(), QEMU via a scripted QMP peer"""
    UNIT = 'enclave-rpc-maint-20261028T020000Z-abcdef.service'
    ARGV = [M.QEMU, '-S']
    NODES = [{'node-name': 'os0', 'file': '/fixture/os.qcow2', 'ro': False},
             {'node-name': 'seed0', 'file': '/fixture/seed.iso', 'ro': True}]

    def __init__(self, test):
        tmp = tempfile.TemporaryDirectory(); test.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        self.ev = root / 'ev'; self.ev.mkdir(mode=0o700)
        proc, cg = root / 'proc', root / 'cg'
        (proc / '4242').mkdir(parents=True)
        self.cmdline = proc / '4242' / 'cmdline'
        self.cmdline.write_bytes(b''.join(a.encode() + b'\0' for a in self.ARGV))
        (proc / '4242' / 'cgroup').write_text('0::/fixture.slice/maint.service\n')
        unitcg = cg / 'fixture.slice' / 'maint.service'; unitcg.mkdir(parents=True)
        (unitcg / 'memory.max').write_text(f'{M.MEMORY_MAX}\n'); (unitcg / 'memory.swap.max').write_text('0\n')
        (root / 'meminfo').write_text(f'MemAvailable: {1 << 30} kB\n')
        self.clock, self.calls, self.executed, self.override, self.status = FakeClock(1000.0), [], [], {}, 'prelaunch'
        self.unit = {'LoadState': 'not-found', 'ActiveState': 'inactive', 'Result': 'success', 'InvocationID': ''}
        self.peers, self.made, self.ends, self.on_connect, self.ssh_rc = [], [], [], None, 0
        self.cfg = dict(M.DEFAULT_CFG, proc=str(proc), cgroupRoot=str(cg), meminfo=str(root / 'meminfo'),
                        osDisk='/fixture/os.qcow2', seedIso='/fixture/seed.iso')
        self.c = M.Ctx(self.cfg, run=self.run, qmp=Seam(self), clock=self.clock, sleep=self.clock.sleep, free=lambda p: 1 << 50)
        self.script = b'# fixture guest script\n'
        self.plan = {'unit': self.UNIT, 'runDir': str(root / 'run'), 'argv': list(self.ARGV), 'properties': M.properties(self.c),
                     'ssh': ['ssh-fixture'], 'stamp': '20261028T020000Z-abcdef', 'guestScriptSha256': M.sha(self.script)}
        self.m = {'disks': {'os': {'bytes': 1}}, 'backings': {'nvme': {'mount': str(root), 'capacity': {'floorBytes': 0}}}}
        self.prep = {'os': {'ino': 1, 'size': 1, 'mtimeNs': 1, 'ctimeNs': 1, 'dev': 1}, 'backup': {}}

    def peer(self, **kw):
        kw.setdefault('rx', [GREETING])
        p = FakePeer(self.clock, handler=self.qemu, **kw)
        self.peers.append(p); self.made.append(p)
        return p

    def gone(self):
        self.unit.update(LoadState='not-found', ActiveState='inactive', InvocationID='', MainPID='0')
        self.cmdline.unlink(missing_ok=True)

    def qemu(self, req):
        name, rid = req['execute'], req['id']
        self.executed.append(name)
        if name in self.override:
            return self.override[name](req)
        if name == 'query-status':
            return [ok(rid, {'status': self.status, 'running': self.status == 'running'})]
        if name == 'query-named-block-nodes':
            return [ok(rid, self.NODES)]
        if name == 'cont':
            self.status = 'running'
            return [ok(rid)]
        if name == 'system_powerdown':
            self.gone()
            return [ok(rid), event('SHUTDOWN', guest=True, reason='guest-shutdown'), EOF]
        if name == 'quit':
            self.gone()
            return [ok(rid), EOF]
        return [ok(rid)]

    def run(self, argv, timeout=120, input=None):
        self.calls.append(list(argv)); rc, out = 0, b''
        if argv[0] == 'systemd-run':
            self.unit.update(LoadState='loaded', ActiveState='active', InvocationID='ours', MainPID='4242',
                             ControlGroup='/fixture.slice/maint.service')
        elif argv[:3] == ['systemctl', '--user', 'show']:
            out = ''.join(f'{k}={v}\n' for k, v in self.unit.items()).encode()
        elif argv[:3] == ['systemctl', '--user', 'stop']:
            self.gone()
        elif argv[:2] == ['ssh-fixture', 'true']:
            rc = self.ssh_rc
        elif argv[:2] == ['ssh-fixture', 'sudo']:
            out = json.dumps({'ok': True, 'verified': {u: True for u in M.MASK_UNITS}}).encode() + b'\n'
        else:
            raise AssertionError(f'unexpected command {argv[:3]}')
        return types.SimpleNamespace(returncode=rc, stdout=out, stderr=b'')

    def patches(self, **over):
        p = {'load_prepared': {'return_value': (self.prep, self.plan)}, 'load_pins': {'return_value': (None, self.m)},
             'host_checks': {'return_value': {}}, 'backup_intact': {'return_value': None}, 'nvme': {'return_value': {}},
             'read_nofollow': {'return_value': (self.script, None)}, 'derive': {'return_value': list(self.ARGV)},
             'validate': {'return_value': True}, **over}
        stack = contextlib.ExitStack()
        for name, kw in p.items():
            stack.enter_context(patch.object(M, name, **kw))
        return stack

    def launch(self):
        with self.patches():
            M.cmd_launch(self.c, str(self.ev))
        return json.loads((self.ev / 'RESULT.json').read_text())

    def stops(self):
        return [a for a in self.calls if a[:3] == ['systemctl', '--user', 'stop']]


class LaunchFailures(unittest.TestCase):
    def test_greeting_eagain_before_pid_records_phase_and_runs_owned_cleanup(self):
        h = Launch(self)
        peer = h.peer(rx=[BlockingIOError(errno.EAGAIN, 'Resource temporarily unavailable')])
        r = h.launch()
        self.assertFalse(r['success'])
        self.assertNotIn('pid', r)
        d = r['diagnostics']
        self.assertEqual((d['phase'], d['preLaunch'], d['unitRequested'], d['pidVerified'], d['cont']),
                         ('qmp-ready', False, True, False, 'not-attempted'))
        self.assertEqual(d['error']['class'], 'QMPError')
        q = d['error']['qmp']
        self.assertEqual((q['stage'], q['op'], q['errno'], q['errnoName'], q['expired']), ('greeting', 'recv', errno.EAGAIN, EAGAIN, False))
        self.assertEqual(d['error']['cause'], {'class': 'BlockingIOError', 'errno': errno.EAGAIN, 'errnoName': EAGAIN})
        self.assertEqual(d['readiness'], {'attempts': 1, 'connectErrnos': {}, 'sleeps': 0})   # not retried
        self.assertEqual((d['error']['where'][-1]['file'], d['error']['where'][-1]['func']), ('maint_boot.py', '_io'))
        for f in d['error']['where']:
            self.assertEqual(set(f), {'file', 'func', 'line'})
        self.assertNotIn('Resource temporarily unavailable', json.dumps(d))
        self.assertIn(EAGAIN, r['error'])
        self.assertEqual(peer.closes, 1)
        self.assertEqual(h.executed, [])
        self.assertEqual(h.stops(), [['systemctl', '--user', 'stop', h.UNIT]])               # exact owned unit only
        self.assertEqual(r['cleanup']['final']['LoadState'], 'not-found')

    def test_connect_eagain_retried_in_one_end_then_identity_failure_never_conts(self):
        h = Launch(self)
        peers = [h.peer(rx=[], connect_error=BlockingIOError(errno.EAGAIN, 'x')) for _ in range(2)] + [h.peer()]
        h.cmdline.write_bytes(b'/usr/bin/not-the-planned-qemu\0')
        r = h.launch()
        d = r['diagnostics']
        self.assertEqual((d['phase'], d['pidVerified'], d['cont'], d['error']['class']), ('prelaunch-verify', False, 'not-attempted', 'Refuse'))
        self.assertEqual(d['readiness'], {'attempts': 3, 'connectErrnos': {EAGAIN: 2}, 'sleeps': 2})
        self.assertEqual(h.clock.sleeps[:2], [1, 1])
        self.assertEqual(len(set(h.ends)), 1)                                               # ONE readiness end
        self.assertEqual([p.closes for p in peers], [1, 1, 1])
        self.assertEqual(d['qmpClose'], {'closed': True, 'closeErrno': None})
        self.assertEqual(h.executed, ['qmp_capabilities', 'query-status', 'query-status', 'quit'])
        self.assertEqual((r['cleanup']['qmpStatus'], h.stops()), ('prelaunch', []))

    def test_running_before_cont_is_refused_and_never_continued(self):
        h = Launch(self); h.peer(); h.status = 'running'
        r = h.launch()
        self.assertEqual(r['diagnostics']['phase'], 'prelaunch-verify')
        self.assertNotIn('cont', h.executed)
        self.assertEqual(h.executed[-1], 'system_powerdown')                                 # existing observed-state cleanup

    def test_foreign_invocation_never_stopped(self):
        h = Launch(self)
        h.peer(rx=[BlockingIOError(errno.EAGAIN, 'x')])
        h.on_connect = lambda: h.unit.update(InvocationID='foreign')
        r = h.launch()
        self.assertIn('refused', r['cleanup']['stop'])
        self.assertEqual(h.stops(), [])

    def test_cont_without_reply_is_unknown_and_never_resent(self):
        h = Launch(self); h.peer()
        h.override['cont'] = lambda req: (setattr(h, 'status', 'running'), [])[1]
        r = h.launch()
        d = r['diagnostics']
        self.assertEqual((d['phase'], d['cont'], d['pidVerified']), ('cont', 'outcome-unknown', True))
        e = d['error']['qmp']
        self.assertEqual((e['command'], e['requestId'], e['sent'], e['outcome'], e['expired']), ('cont', 'maint-4', 'full', 'unknown', True))
        self.assertEqual((d['qmp']['outcomeUnknown'], d['qmp']['abandoned']), ({'cont': 'maint-4'}, ['maint-4']))
        self.assertEqual(h.executed.count('cont'), 1)
        self.assertTrue(r['cleanup']['shutdownEvent'])

    def test_powerdown_without_reply_not_resent_by_cleanup(self):
        h = Launch(self); h.peer()
        h.override['system_powerdown'] = lambda req: []
        r = h.launch()
        self.assertEqual(r['diagnostics']['phase'], 'powerdown')
        self.assertEqual(h.executed.count('system_powerdown'), 1)
        self.assertEqual(r['cleanup']['notResent'], 'system_powerdown')
        self.assertFalse(r['cleanup']['shutdownEvent'])
        self.assertEqual(h.stops(), [['systemctl', '--user', 'stop', h.UNIT]])

    def test_pre_launch_refusal_is_labelled_pre_launch(self):
        h = Launch(self)
        with h.patches(host_checks={'side_effect': M.Refuse('fixture: production VM is active')}), \
                contextlib.redirect_stdout(io.StringIO()):
            rc = M.main(['launch', '--evidence', str(h.ev)], c=h.c)
        self.assertEqual(rc, 2)
        [refused] = list(h.ev.glob('REFUSED-launch-*.json'))
        d = json.loads(refused.read_text())['diagnostics']
        self.assertEqual((d['phase'], d['preLaunch'], d['unitRequested'], d['cont'], d['error']['class']),
                         ('host-checks', True, False, 'not-attempted', 'Refuse'))
        self.assertFalse((h.ev / 'RESULT.json').exists())
        self.assertTrue((h.ev / 'LAUNCHED.json').exists())
        self.assertEqual(h.calls, [])


class SuccessPath(unittest.TestCase):
    def test_successful_path_unaffected_and_no_resource_changes(self):
        h = Launch(self); peer = h.peer()
        r = h.launch()
        self.assertTrue(r['success'])
        self.assertTrue(r['shutdown']['verified'])
        self.assertEqual(r['pid'], 4242)
        self.assertEqual(h.executed, ['qmp_capabilities', 'query-status', 'query-named-block-nodes', 'cont', 'system_powerdown'])
        self.assertEqual([x['id'] for x in peer.requests], [f'maint-{i}' for i in range(1, 6)])
        self.assertEqual((h.stops(), peer.closes), ([], 1))
        d = r['diagnostics']
        self.assertEqual((d['phase'], d['cont'], d['pidVerified']), ('done', 'acknowledged', True))
        self.assertNotIn('error', d)
        self.assertTrue(d['qmp']['guestShutdownEvidence'])
        [run] = [a for a in h.calls if a[0] == 'systemd-run']
        self.assertEqual([a for a in run if a.startswith('--property=')], ['--property=' + p for p in SEED_PROPERTIES])
        self.assertEqual(run[run.index('--') + 1:], h.ARGV)
        self.assertEqual(M.properties(h.c), SEED_PROPERTIES)
        self.assertEqual(M.LIMITS, SEED_LIMITS)
        self.assertEqual((M.GUEST_MEM, M.VCPUS, M.MEMORY_MAX, M.HOST_FLOOR, M.MARGIN), (8 << 30, 2, 10 << 30, 16 << 30, 4 << 30))


class PhaseBounds(unittest.TestCase):
    PLAN = {'unit': Launch.UNIT, 'argv': Launch.ARGV}
    GONE = {'ActiveState': 'inactive', 'LoadState': 'not-found', 'Result': 'success', 'InvocationID': ''}

    def test_cleanup_graceful_part_bounded_under_endless_events(self):
        clock = FakeClock(1000.0)
        peer = FakePeer(clock, rx=[GREETING], step=0.5, idle=lambda: event('RTC_CHANGE', offset=0))
        q = T.open_fake(peer, clock)
        peer.replies.extend([lambda r: [ok(r['id'], {'status': 'running', 'running': True})], lambda r: [ok(r['id'])]])
        c = M.Ctx(run=lambda argv, **kw: None, clock=clock, sleep=clock.sleep)
        start = clock.t
        with patch.object(M, 'wait_unit_inactive', return_value=self.GONE):
            out = M.cleanup(c, q, self.PLAN, 'ours', 0)
        self.assertLessEqual(clock.t - start, 2 * M.QMP_CMD_S + SEED_LIMITS['powerdownS'])
        self.assertEqual((out['qmpStatus'], out['shutdownEvent']), ('running', False))
        self.assertGreater(q.events_seen, M.QMP_EVENTS_KEEP)
        self.assertLessEqual(len(q.recent), M.QMP_EVENTS_KEEP)

    def test_cleanup_does_not_resend_quit_of_unknown_outcome(self):
        clock = FakeClock(1000.0); peer = FakePeer(clock, rx=[GREETING]); q = T.open_fake(peer, clock)
        peer.replies.append(lambda r: [])
        with self.assertRaises(M.QMPError):
            q.cmd('quit')
        peer.replies.append(lambda r: [ok(r['id'], {'status': 'prelaunch', 'running': False})])
        with patch.object(M, 'wait_unit_inactive', return_value=self.GONE):
            out = M.cleanup(M.Ctx(run=lambda argv, **kw: None, clock=clock, sleep=clock.sleep), q, self.PLAN, 'ours', 0)
        self.assertEqual(out['notResent'], 'quit')
        self.assertEqual([x['execute'] for x in peer.requests].count('quit'), 1)

    def test_cleanup_qmp_failure_still_reaches_owned_stop(self):
        clock = FakeClock(1000.0); peer = FakePeer(clock, rx=[GREETING]); q = T.open_fake(peer, clock)
        peer.replies.append(lambda r: [b'[not an object]\n'])
        calls = []
        c = M.Ctx(run=lambda argv, **kw: calls.append(argv) or types.SimpleNamespace(returncode=0, stdout=b'', stderr=b''),
                  clock=clock, sleep=clock.sleep)
        with patch.object(M, 'wait_unit_inactive', return_value={'ActiveState': 'active', 'InvocationID': 'ours'}):
            out = M.cleanup(c, q, self.PLAN, 'ours', 0)
        self.assertEqual(out['qmpDiag']['qmp']['op'], 'decode')
        self.assertIn(['systemctl', '--user', 'stop', Launch.UNIT], calls)

    def test_wait_ssh_pump_never_extends_the_ssh_phase(self):
        h = Launch(self); h.ssh_rc = 255
        peer = FakePeer(h.clock, rx=[GREETING], step=0.25, idle=lambda: event('RTC_CHANGE', offset=0))
        q = T.open_fake(peer, h.clock)
        start = h.clock.t
        with self.assertRaises(M.Refuse) as cm:
            M.wait_ssh(h.c, q, h.plan, h.m)
        self.assertIn('did not come up', str(cm.exception))
        self.assertLessEqual(h.clock.t - start, SEED_LIMITS['sshS'] + 5 + 0.25)


if __name__ == '__main__': unittest.main()
