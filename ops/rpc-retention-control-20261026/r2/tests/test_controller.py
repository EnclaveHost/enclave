"""OFFLINE integration tests of the ACTUAL r2 shell controller (bash retention-live-controller.sh) against tests/fake_guest.py
(stateful fake guest via the SSH override), a controlled MemAvailable file and scaled time (POLL 1 s, 1 h = RLC_TEST_HOUR s).
They prove the controller's orchestration and ownership rules only; they are NOT evidence about the real guest, the real unit or
the real download. The real activation-r2 files are read (pins) and never written. Run by root (jobs/root-controller-offline.sh)."""
import fcntl, json, os, shutil, signal, subprocess, tempfile, time, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
CTRL = os.path.join(os.path.dirname(HERE), 'retention-live-controller.sh')
FAKE = os.path.join(HERE, 'fake_guest.py')
A_SUMS = '409b8ed25a2f5096783c5a8d9acf3e330450d37265850d68d5c4f9a58160bc92'
U, FIRST = 'enclave-base-retention.service', 'enclave-rpc-base-snapshot.service'


def unit(active, sub, result='success', status='0', pid='0', ufs='static', inv=''):
    return {'ActiveState': active, 'SubState': sub, 'Result': result, 'ExecMainStatus': status, 'MainPID': pid, 'UnitFileState': ufs,
            'InvocationID': inv}


class Controller(unittest.TestCase):
    def setUp(self):
        self.t = tempfile.mkdtemp(dir=os.environ.get('TMPDIR', '/tmp'))
        self.addCleanup(shutil.rmtree, self.t, True)
        self.ssh = os.path.join(self.t, 'ssh'); shutil.copy(FAKE, self.ssh); os.chmod(self.ssh, 0o755)
        self.mem(30_000_000)
        self.state = {'units': {
            FIRST: unit('inactive', 'dead'), 'enclave-base-holder.service': unit('inactive', 'dead', ufs='disabled'),
            'enclave-base-holder.path': unit('inactive', 'dead', ufs='disabled'), U: unit('inactive', 'dead', inv='inv0'),
            'enclave-l1-el.service': unit('active', 'running', pid='111', ufs='enabled', inv='el'),
            'enclave-l1-cl.service': unit('active', 'running', pid='222', ufs='enabled', inv='cl')},
            'marker_snapshot': True, 'marker_retention': False, 'staged': False, 'check_refusals': [], 'start_mode': 'ok',
            'run_polls': 3, 'run_result': 'success', 'run_left': 0, 'since_start': 0}

    def mem(self, kib):
        with open(os.path.join(self.t, 'meminfo.tmp'), 'w') as f:
            f.write(f'MemTotal: 64000000 kB\nMemAvailable: {kib} kB\n')
        os.replace(os.path.join(self.t, 'meminfo.tmp'), os.path.join(self.t, 'meminfo'))

    def env(self, **kw):
        return {'PATH': '/usr/bin:/bin', 'TMPDIR': os.environ.get('TMPDIR', '/tmp'), 'HOME': self.t, 'RLC_TEST_ROOT': self.t,
                'RLC_TEST_SSH': self.ssh, 'RLC_A_SUMS': A_SUMS, 'RLC_TEST_POLL': '1', 'RLC_TEST_START_WINDOW': '5',
                'RLC_TEST_GTO': '5', 'RLC_TEST_STOP_TO': '10', **kw}

    def write_state(self):
        json.dump(self.state, open(os.path.join(self.t, 'state.json'), 'w'))

    def run_ctrl(self, *extra, maxh='1', **env):
        self.write_state()
        return subprocess.run(['bash', CTRL, '--resource-window=test-window', f'--max-hours={maxh}', *extra], env=self.env(**env),
                              capture_output=True, text=True, timeout=180)

    def start_ctrl(self, **env):
        self.write_state()
        return subprocess.Popen(['bash', CTRL, '--resource-window=test-window', '--max-hours=1'], env=self.env(**env),
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)

    def calls(self, kind=None):
        p = os.path.join(self.t, 'calls.jsonl')
        c = [json.loads(l) for l in open(p)] if os.path.exists(p) else []
        return [x for x in c if kind is None or x['kind'] == kind]

    def wait_for(self, pred, limit=60):
        end = time.time() + limit
        while not pred():
            self.assertLess(time.time(), end, 'condition never reached'); time.sleep(0.2)

    def owned_inv(self):
        return next(c['inv'] for c in self.calls('show') if c['state'] == 'activating/start')

    def assertNoStartOrStop(self):
        self.assertEqual(self.calls('start'), []); self.assertEqual(self.calls('stop'), [])

    # ---- success -----------------------------------------------------------------------------------------------------------------
    def test_success_new_invocation_completes_and_status_schema_validated(self):
        r = self.run_ctrl()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn('SUCCESS: our invocation', r.stdout)
        self.assertEqual(len(self.calls('start')), 1); self.assertEqual(self.calls('stop'), [])
        self.assertEqual([c['kind'] for c in self.calls() if c['kind'] in ('install', 'check', 'start', 'status')],
                         ['install', 'check', 'start', 'status'])

    def test_status_showing_incomplete_retention_is_not_success(self):
        self.state['status_override'] = {'retentionComplete': False}
        r = self.run_ctrl()
        self.assertEqual(r.returncode, 6, r.stdout); self.assertNotIn('SUCCESS', r.stdout); self.assertEqual(self.calls('stop'), [])

    # ---- refusals before anything is started ---------------------------------------------------------------------------------
    def test_existing_active_retention_is_refused_never_adopted_or_stopped(self):
        self.state['units'][U] = unit('activating', 'start', pid='999', inv='someone-elses')
        for extra in ((), ('--precheck-only',)):
            r = self.run_ctrl(*extra)
            self.assertEqual(r.returncode, 8, r.stdout); self.assertIn('never adopted or stopped', r.stdout)
        self.assertNoStartOrStop(); self.assertEqual(self.calls('install'), [])

    def test_retention_started_by_someone_else_before_our_start_is_refused(self):
        self.state['foreign_start_on_check'] = True
        r = self.run_ctrl()
        self.assertEqual(r.returncode, 8, r.stdout); self.assertNoStartOrStop()

    def test_first_active_no_marker_no_room_refuse_before_install_or_start(self):
        cases = [('first', lambda s: s['units'].__setitem__(FIRST, unit('activating', 'start', pid='4061'))),
                 ('marker', lambda s: s.__setitem__('marker_snapshot', False)),
                 ('room', lambda s: s.__setitem__('check_refusals', ['capacity preflight refused: need 1043 GB']))]
        for name, mutate in cases:
            with self.subTest(name):
                self.setUp(); mutate(self.state)
                r = self.run_ctrl()
                self.assertEqual(r.returncode, 3, r.stdout); self.assertNoStartOrStop()
                if name != 'room':
                    self.assertEqual(self.calls('install'), [])

    # ---- start outcomes ---------------------------------------------------------------------------------------------------------
    def test_start_refused_owns_nothing_and_stops_nothing(self):
        self.state['start_mode'] = 'refuse'
        r = self.run_ctrl()
        self.assertEqual(r.returncode, 3, r.stdout); self.assertEqual(self.calls('stop'), [])

    def test_lost_start_response_with_unit_started_stops_exactly_our_invocation(self):
        self.state['start_mode'] = 'lost-started'; self.state['run_polls'] = 1000
        r = self.run_ctrl()
        self.assertEqual(r.returncode, 5, r.stdout)
        stops = self.calls('stop'); self.assertEqual(len(stops), 1)
        self.assertEqual(stops[0]['inv'], self.owned_inv()); self.assertNotEqual(stops[0]['inv'], 'inv0')

    def test_lost_start_response_never_started_stops_nothing(self):
        self.state['start_mode'] = 'lost-not-started'
        r = self.run_ctrl()
        self.assertEqual(r.returncode, 5, r.stdout); self.assertEqual(self.calls('stop'), [])
        self.assertIn('nothing', r.stdout)

    def test_same_invocation_id_never_counts_as_completion(self):
        for pre in (unit('inactive', 'dead', inv='inv0'), unit('failed', 'failed', result='exit-code', status='1', inv='inv0')):
            with self.subTest(pre['ActiveState']):
                self.setUp(); self.state['units'][U] = pre; self.state['start_mode'] = 'noop'
                r = self.run_ctrl()
                self.assertEqual(r.returncode, 6, r.stdout); self.assertNotIn('SUCCESS', r.stdout); self.assertEqual(self.calls('stop'), [])
                self.assertIn('no new invocation', r.stdout)

    # ---- breaches while our invocation runs -------------------------------------------------------------------------------------
    def test_memory_breach_interrupts_a_blocking_guest_call_and_stops_only_ours(self):
        self.state['run_polls'] = 1000
        p = self.start_ctrl(RLC_TEST_GTO='30')
        self.wait_for(lambda: len(self.calls('show')) >= 4 and any(c['state'] == 'activating/start' for c in self.calls('show')))
        with open(os.path.join(self.t, 'state.lock'), 'w') as lk:          # the fake guest's own lock: no lost update
            fcntl.flock(lk, fcntl.LOCK_EX)
            sp = os.path.join(self.t, 'state.json'); s = json.load(open(sp)); s['delay_next_show'] = 20
            json.dump(s, open(sp + '.t', 'w')); os.replace(sp + '.t', sp)
        self.wait_for(lambda: any(c.get('delay') for c in self.calls('show')))      # the controller is now blocked in a 20 s call
        tb = time.time(); self.mem(1_000_000)
        out, _ = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 4, out)
        stops = self.calls('stop'); self.assertEqual(len(stops), 1)
        self.assertLess(stops[0]['t'] - tb, 10, 'the breach waited for the blocking guest call')
        self.assertEqual(stops[0]['inv'], self.owned_inv())

    def test_foreign_invocation_is_never_stopped(self):
        self.state['run_polls'] = 1000; self.state['hijack_at'] = 3
        r = self.run_ctrl()
        self.assertEqual(r.returncode, 6, r.stdout); self.assertIn('not ours', r.stdout); self.assertEqual(self.calls('stop'), [])

    def test_max_hours_timeout_stops_our_invocation(self):
        self.state['run_polls'] = 1000
        r = self.run_ctrl(RLC_TEST_HOUR='4')
        self.assertEqual(r.returncode, 7, r.stdout)
        self.assertEqual([c['inv'] for c in self.calls('stop')], [self.owned_inv()])

    def test_ssh_failure_mid_run_stops_our_invocation(self):
        self.state['run_polls'] = 1000; self.state['fail_show_at'] = 3
        r = self.run_ctrl()
        self.assertEqual(r.returncode, 5, r.stdout)
        self.assertEqual([c['inv'] for c in self.calls('stop')], [self.owned_inv()])

    def test_signal_stops_our_invocation_promptly(self):
        self.state['run_polls'] = 1000
        p = self.start_ctrl()
        self.wait_for(lambda: any(c['state'] == 'activating/start' for c in self.calls('show')))
        t0 = time.time(); p.send_signal(signal.SIGTERM); out, _ = p.communicate(timeout=60)
        self.assertEqual(p.returncode, 130, out); self.assertLess(time.time() - t0, 15)
        self.assertEqual([c['inv'] for c in self.calls('stop')], [self.owned_inv()])


if __name__ == '__main__':
    unittest.main()
