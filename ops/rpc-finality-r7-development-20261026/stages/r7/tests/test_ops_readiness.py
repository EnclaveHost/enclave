"""r6-ops-fixes: consumer gate (require_ready), settings-driven publisher, sampler startTime, consumer drop-in. Offline, private tmp."""
import datetime, importlib.util, json, os, pathlib, sys, tempfile, time, types, unittest

TREE = pathlib.Path(__file__).resolve().parents[1]
R6 = TREE.parents[1] / 'r6'


def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m


sys.dont_write_bytecode = True
RR = load(TREE / 'readiness/require_ready.py', 'rr_ops')
PUB = load(TREE / 'readiness/publish_readiness.py', 'pub_ops')
UID = os.getuid()
ENTRY, BH = 'e' * 64, '0x' + 'b' * 64
ACC = 'ac' * 32                     # r7: the recorded acceptance (the launch journal's `bootstrapped` sha)
PID, START = 4242, '987654'


def iso(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).isoformat()


class Gate(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='ops-ready-')); self.now = 1_800_000_000.0
        self.proc = self.d / 'proc'; self.set_proc(PID, START)
        self.report, self.status = self.d / 'latest.json', self.d / 'status.json'
        self.holder = {'ActiveState': 'active', 'MainPID': str(PID)}
        # a realistic full cycle: 8 samples x 120 s finished 950 s ago (the r6 helper's 600 s bound refused this)
        self.write_report(started=self.now - 950 - 960, finished=self.now - 950)
        self.write_status()

    def set_proc(self, pid, start):
        (self.proc / str(pid)).mkdir(parents=True, exist_ok=True)
        (self.proc / str(pid) / 'stat').write_text(f'{pid} (op-reth) S ' + ' '.join(['0'] * 18 + [start, '0', '0']) + '\n')

    def write_report(self, started, finished, info=None, overall='READY'):
        info = {'pid': PID, 'startTime': START, 'entrySha256': ENTRY, 'freshN': 100, 'freshBlockHash': BH, 'recordedAs': ACC} if info is None else info
        self.report.write_text(json.dumps({'overall': overall, 'acceptance': overall == 'READY', 'startedAt': started, 'finishedAt': finished,
                                           'gates': {'post-anchor-finality': {'status': 'pass', 'info': info}}}))
        os.chmod(self.report, 0o644)

    def write_status(self, **over):
        s = {'format': 'enclave-base-finality-status/v1', 'state': 'qualified', 'qualified': True, 'entrySha256': ENTRY, 'freshN': 100,
             'freshBlockHash': BH, 'process': {'pid': PID, 'startTime': START}, 'publishedAt': iso(self.now - 60), 'recordedAs': ACC}
        s.update(over); self.status.write_text(json.dumps(s)); os.chmod(self.status, 0o644)

    def ready(self, **kw):
        a = dict(report=self.report, status=self.status, owner_uid=UID, status_uid=UID, proc_root=str(self.proc),
                 show=lambda u, p: dict(self.holder), now=self.now); a.update(kw)
        return RR.ready(**a)

    def refuses(self, why_re, **kw):
        ok, why = self.ready(**kw); self.assertFalse(ok, why); self.assertRegex(why, why_re)

    def test_full_cycle_stays_ready_with_live_identity(self):
        self.assertEqual(self.ready(), (True, 'READY'))

    def test_r6_helper_flapped_on_the_same_healthy_report(self):
        if not (R6 / 'readiness/require_ready.py').exists():
            self.skipTest('r6 stage not beside this tree')
        old = load(R6 / 'readiness/require_ready.py', 'rr_r6')
        ok, why = old.ready(report=self.report, owner_uid=UID, now=self.now)
        self.assertFalse(ok); self.assertRegex(why, r'950 s old \(max 600\)')

    def test_fresh_old_ready_with_dead_holder_pid_refuses(self):
        (self.proc / str(PID) / 'stat').unlink()
        self.refuses(r'not the proven process')

    def test_fresh_old_ready_with_reused_pid_refuses(self):
        self.set_proc(PID, '111111')                     # same pid number, another process (another start time)
        self.write_report(started=self.now - 70, finished=self.now - 10)
        self.refuses(r'not the proven process')

    def test_fresh_old_ready_with_a_different_holder_pid_refuses(self):
        self.set_proc(5151, START); self.holder['MainPID'] = '5151'
        self.write_report(started=self.now - 70, finished=self.now - 10)
        self.refuses(r'not the proven process 4242')

    def test_stopped_or_failed_holder_refuses(self):
        for state in ('inactive', 'failed', 'activating', 'deactivating'):
            self.holder['ActiveState'] = state
            self.refuses(r'is .%s.' % state)

    def test_revoked_status_refuses_even_with_a_fresh_ready(self):
        self.write_report(started=self.now - 70, finished=self.now - 5)
        self.write_status(state='revoked', qualified=False)
        self.refuses(r"'revoked'")

    def test_changed_status_entry_or_block_refuses(self):
        self.write_status(entrySha256='f' * 64); self.refuses(r'another proof entry')

    def test_r7_proven_but_unrecorded_proof_is_never_admitted(self):
        self.write_report(self.now - 70, self.now - 10, info={'pid': PID, 'startTime': START, 'entrySha256': ENTRY, 'freshN': 100, 'freshBlockHash': BH,
                                                              'recordedAs': None})
        self.write_status(recordedAs=None); self.refuses(r'not durably recorded')

    def test_r7_changed_or_withdrawn_acceptance_is_refused(self):
        self.write_report(self.now - 70, self.now - 10); self.write_status(recordedAs='bd' * 32); self.refuses(r'acceptance changed')
        self.write_status(recordedAs=None); self.refuses(r'not durably recorded')
        self.write_status(freshBlockHash='0x' + 'c' * 64); self.refuses(r'another proof entry')

    def test_status_for_another_process_refuses(self):
        self.write_status(process={'pid': PID, 'startTime': '1'}); self.refuses(r'another process')

    def test_stopped_status_publisher_refuses(self):
        self.write_status(publishedAt=iso(self.now - 901)); self.refuses(r'not current')

    def test_status_not_root_owned_or_writable_refuses(self):
        self.refuses(r'no current root finality status', status_uid=UID + 1)
        os.chmod(self.status, 0o666); self.refuses(r'no current root finality status')

    def test_report_from_an_older_sampler_without_starttime_refuses(self):
        self.write_report(self.now - 70, self.now - 10, info={'pid': PID, 'entrySha256': ENTRY, 'freshN': 100, 'freshBlockHash': BH})
        self.refuses(r'no proven process')

    def test_report_beyond_one_cycle_refuses_and_age_alone_never_admits(self):
        self.write_report(started=self.now - 2000 - 960, finished=self.now - 2000)
        self.refuses(r'outside one sampling cycle')
        self.write_report(started=self.now - 5000, finished=self.now - 5)          # an implausible 83-minute run
        self.refuses(r'outside one sampling cycle')

    def test_not_ready_or_untrusted_report_refuses(self):
        self.write_report(self.now - 70, self.now - 10, overall='INCOMPLETE'); self.refuses(r'not READY')
        self.refuses(r'no readiness report', owner_uid=UID + 1)


class Enforce(unittest.TestCase):
    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='ops-enforce-'))
        self.dropin = self.d / 'consumer-requires-base-ready.conf'; self.dropin.write_bytes((TREE / 'units/consumer-requires-base-ready.conf').read_bytes())
        self.unit_dropin = self.d / 'api.d.conf'; self.unit_dropin.write_bytes(self.dropin.read_bytes())
        self.units = self.d / 'units'; self.calls = []

    def run_enforce(self, lines, ready=True, dropin_paths=None):
        self.units.write_text('\n'.join(lines) + '\n'); os.chmod(self.units, 0o644)
        show = lambda u, p: {'DropInPaths': dropin_paths if dropin_paths is not None else str(self.unit_dropin)}
        return RR.enforce(str(self.units), run=lambda c, **k: self.calls.append(c), show=show, ready_fn=lambda: (ready, 'x'),
                          file_uid=UID, dropin=self.dropin)

    def test_not_ready_stops_only_listed_consumers_and_never_starts(self):
        self.run_enforce(['enclave-api-relay.service', 'enclave-rpc-gateway.service'], ready=False)
        self.assertEqual([c[1] for c in self.calls], ['stop', 'stop'])
        self.assertEqual({c[3] for c in self.calls}, {'enclave-api-relay.service', 'enclave-rpc-gateway.service'})

    def test_ready_starts_consumers_never_the_holder(self):
        self.run_enforce(['enclave-api-relay.service'])
        self.assertEqual(self.calls, [['systemctl', 'start', '--no-block', 'enclave-api-relay.service']])

    def test_vm_hypervisor_and_base_units_are_never_controlled(self):
        for bad in ('libvirtd.service', 'virtqemud.service', 'qemu-guest-agent.service', 'enclave-app-vm-shop.service', 'machine-qemu.service',
                    'enclave-base-holder.service', 'enclave-base-restart-permit.service', 'systemd-networkd.service', 'app.vm.service', 'foo.scope'):
            self.calls.clear()
            with self.assertRaises(SystemExit, msg=bad):
                self.run_enforce(['enclave-api-relay.service', bad], ready=False)
            self.assertEqual(self.calls, [], f'{bad}: nothing may be touched')

    def test_unit_without_the_reviewed_dropin_is_refused_and_nothing_is_touched(self):
        other = self.d / 'other.conf'; other.write_text('[Unit]\nBindsTo=enclave-base-holder.service\n'); os.chmod(other, 0o644)
        for paths in ('', str(other)):
            with self.assertRaises(SystemExit):
                self.run_enforce(['enclave-api-relay.service'], ready=False, dropin_paths=paths)
            self.assertEqual(self.calls, [])

    def test_writable_units_file_is_refused(self):
        self.units.write_text('enclave-api-relay.service\n'); os.chmod(self.units, 0o666)
        with self.assertRaises(SystemExit):
            RR.enforce(str(self.units), run=lambda c, **k: self.calls.append(c), show=lambda u, p: {}, ready_fn=lambda: (True, ''),
                       file_uid=UID, dropin=self.dropin)
        self.assertEqual(self.calls, [])

    def test_consumer_dropin_cannot_pull_the_holder(self):
        lines = [l.strip() for l in (TREE / 'units/consumer-requires-base-ready.conf').read_text().splitlines() if not l.startswith('#')]
        self.assertIn('Requisite=enclave-base-holder.service', lines)
        self.assertFalse([l for l in lines if l.split('=', 1)[0] in ('Requires', 'BindsTo', 'Wants', 'Upholds') and 'holder' in l])
        self.assertIn('ExecCondition=/usr/bin/python3 -I -B /opt/enclave-rpc/readiness/require_ready.py check', lines)


class Publisher(unittest.TestCase):
    GOOD = {'coverage-receipt': '/etc/enclave-rpc/coverage/receipt.json', 'coverage-verdict': '/etc/enclave-rpc/coverage/verdict.json',
            'coverage-origin': '/etc/enclave-rpc/coverage/origin.json', 'finality-status': '/run/enclave-rpc/base-finality-status.json',
            'expect-snapshot-manifest-sha256': '1' * 64, 'expect-chain-config-sha256': '2' * 64}

    def setUp(self):
        self.d = pathlib.Path(tempfile.mkdtemp(prefix='ops-pub-')); self.out = self.d / 'out'; self.out.mkdir()
        self.settings = self.d / 'settings.json'; self.called = []
        (self.out / 'latest.json').write_text(json.dumps({'overall': 'READY'}))           # an older READY that must not survive bad config

    def sampler(self, argv):
        self.called.append(argv); pathlib.Path(argv[1]).write_text(json.dumps({'overall': 'READY', 'from': 'sampler'})); return 0

    def run_pub(self, doc=None, mode=0o644):
        if doc is not None:
            self.settings.write_text(json.dumps(doc)); os.chmod(self.settings, mode)
        return PUB.main([str(self.out), '--settings', str(self.settings)], sampler=self.sampler, settings_uid=UID)

    def latest(self):
        return json.loads((self.out / 'latest.json').read_text())

    def test_valid_settings_pass_every_required_input_to_the_sampler(self):
        self.assertEqual(self.run_pub(self.GOOD), 0)
        argv = self.called[0]
        for k, v in self.GOOD.items():
            self.assertEqual(argv[argv.index(f'--{k}') + 1], v)
        self.assertEqual(self.latest()['from'], 'sampler')

    def test_missing_invalid_or_untrusted_settings_fail_closed(self):
        cases = [None, {k: v for k, v in self.GOOD.items() if k != 'coverage-verdict'}, {**self.GOOD, 'continue-on-fail': True},
                 {**self.GOOD, 'expect-chain-config-sha256': 'XYZ'}, {**self.GOOD, 'coverage-origin': 'relative.json'}]
        for doc in cases:
            self.called.clear()
            if doc is None and self.settings.exists():
                self.settings.unlink()
            self.assertEqual(self.run_pub(doc), 4, doc)
            self.assertEqual(self.called, []); self.assertEqual(self.latest()['overall'], 'INCOMPLETE')
        self.assertEqual(self.run_pub(self.GOOD, mode=0o664), 4)                        # group-writable settings
        self.settings.unlink(); os.symlink(self.d / 'nowhere', self.settings); self.assertEqual(self.run_pub(), 4)

    def test_not_ready_stub_is_refused_by_the_consumer_gate(self):
        self.run_pub({})
        ok, why = RR.ready(report=self.out / 'latest.json', status=self.d / 'none', owner_uid=UID, show=lambda u, p: {}, now=time.time())
        self.assertFalse(ok); self.assertRegex(why, 'not READY')

    def test_unit_uses_only_the_settings_file(self):
        exe = [l for l in (TREE / 'units/enclave-base-readiness.service').read_text().splitlines() if l.startswith('ExecStart=')]
        self.assertEqual(exe, ['ExecStart=/usr/bin/python3 -I -B /opt/enclave-rpc/readiness/publish_readiness.py /run/enclave-rpc-readiness '
                               '--settings /etc/enclave-rpc/readiness-settings.json'])


class SamplerStartTime(unittest.TestCase):
    def test_finality_gate_info_carries_the_proven_start_time(self):
        rs = load(TREE / 'readiness/readiness_sampler.py', 'rs_ops')
        d = pathlib.Path(tempfile.mkdtemp(prefix='ops-rs-')); (d / str(PID)).mkdir()
        (d / str(PID) / 'stat').write_text(f'{PID} (op-reth) S ' + ' '.join(['0'] * 18 + [START, '0']) + '\n')
        st = d / 'status.json'
        st.write_text(json.dumps({'format': rs.FINALITY_STATUS_FORMAT, 'state': 'qualified', 'qualified': True, 'entrySha256': ENTRY,
                                  'freshN': 100, 'freshBlockHash': BH, 'process': {'pid': PID, 'startTime': START}, 'recordedAs': ACC,
                                  'publishedAt': iso(time.time() - 5)})); os.chmod(st, 0o644)
        a = types.SimpleNamespace(finality_status=str(st), finality_status_uid=UID, proc_root=str(d), max_finality_status_age=900)
        info = rs.validate_finality_status(a)
        self.assertEqual((info['pid'], info['startTime'], info['entrySha256']), (PID, START, ENTRY))


if __name__ == '__main__':
    unittest.main(verbosity=2)
