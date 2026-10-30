"""Narrow tests of canary/run-canary.py (root review 2026-10-22; verifier-only adaptation 2026-10-25): acceptance cannot pass with any false check or service drift;
group signals only while ownership holds; the parent stops only its own scope and scrubs only after proven absence.
Every process here is a DISPOSABLE ordinary subprocess (sleep/bash) or a uniquely named transient test scope. No production
PID is ever signalled; no QEMU is started."""
import copy, importlib.util, json, os, pathlib, secrets, signal, subprocess, sys, tempfile, time, unittest
D = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rc', D / 'canary/run-canary.py'); rc = importlib.util.module_from_spec(spec); spec.loader.exec_module(rc)
PROTECTED = {int(p) for p in rc.qemus()}   # every QEMU running now: never a test's process

def good():
    return {'pinsAtLaunch': [], 'verifierExit': 0, 'acceptance': {'pass': True, 'failed': [], 'diagnostic': {'registry': 'pending'}},
            'qemuStarts': 1, 'qemuArgvChecks': [{'measuredCmdline': True, 'netdevRestrictedOneLoopbackForwardToControlFront': True}],
            'noKeyEvidence': {'fwRegistryKeyEmpty': True, 'hostConfigHasNoKeyOrRelayInput': True}, 'fwCfgModes': ['0o600', '0o700'],
            'cleanup': {'allOwnedAbsent': True, 'refused': False}, 'protectedQemuIdentitiesUnchanged': True, 'userServicesUnchanged': True,
            'collateralSourceUnchanged': True, 'privateRemoved': True, 'rpcStateUnchanged': True}

class Acceptance(unittest.TestCase):
    def test_all_promised_checks_true_passes_with_registry_pending(self):
        self.assertEqual(rc.accept(good()), (True, []))
    def test_any_false_check_or_drift_fails(self):
        cases = {
            'verifier acceptance false (e.g. runtime mismatch)': lambda r: r['acceptance'].update(passed=False, **{'pass': False}),
            'acceptance missing': lambda r: r.pop('acceptance'),
            'verifier exit 1': lambda r: r.update(verifierExit=1),
            'service drift': lambda r: r.update(userServicesUnchanged=False),
            'protected QEMU changed': lambda r: r.update(protectedQemuIdentitiesUnchanged=False),
            'RPC VM state changed during the run': lambda r: r.update(rpcStateUnchanged=False),
            'RPC state never recorded': lambda r: r.pop('rpcStateUnchanged'),
            'QEMU relaunched': lambda r: r.update(qemuStarts=2),
            'no QEMU record': lambda r: r.update(qemuStarts=0),
            'netdev not restricted': lambda r: r['qemuArgvChecks'][0].update(netdevRestrictedOneLoopbackForwardToControlFront=False),
            'argv checks absent': lambda r: r.update(qemuArgvChecks=[]),
            'registry key in fw_cfg': lambda r: r['noKeyEvidence'].update(fwRegistryKeyEmpty=False),
            'no-key evidence absent': lambda r: r.pop('noKeyEvidence'),
            'fw_cfg file world-readable': lambda r: r.update(fwCfgModes=['0o644', '0o700']),
            'owned process alive': lambda r: r['cleanup'].update(allOwnedAbsent=False),
            'cleanup refused ownership': lambda r: r['cleanup'].update(refused=True),
            'collateral source written': lambda r: r.update(collateralSourceUnchanged=False),
            'private not removed': lambda r: r.update(privateRemoved=False),
            'pins changed at launch': lambda r: r.update(pinsAtLaunch=['canary/qemu-restrict.sh']),
            'pins never checked': lambda r: r.pop('pinsAtLaunch'),
            'error': lambda r: r.update(error='KeyboardInterrupt: timeout'),
        }
        for name, mutate in cases.items():
            r = good(); mutate(r); ok, failed = rc.accept(r)
            self.assertFalse(ok, name); self.assertTrue(failed, name)

class NoKeyEvidence(unittest.TestCase):
    ports = {'guestdStandInManager': 40001, 'guestdStandInData': 40002, 'proofStandIn': 40003}
    cv = {'format': 'enclave-chain-verifier/v1', 'unsafeSigner': '0x' + 'af' * 20, 'proofSources': ['http://10.0.2.2:40003/'], 'port': 50546, 'expose': 'attested'}
    owner = {'selling': {'cpuPrice6': None, 'payout': None}, 'x': 1, 'chainVerifier': cv}
    def fw(self, **o):
        f = {'registryKey': '', 'fleetSecret': '', 'relayUrl': '', 'tunnelToken': '', 'volumes': [], 'direct': self.owner,
             'isolation': {'managerUrl': 'http://10.0.2.2:40001', 'dataAddr': '10.0.2.2:40002', 'pairingKey': 'ab' * 32}}
        f.update(o); return f
    def test_clean_launch_inputs(self):
        self.assertTrue(all(rc.no_key_evidence({'mode': 'snp'}, self.fw(), self.owner, self.ports).values()))
    def test_each_key_or_relay_input_is_caught(self):
        bad = [({'registryKeyFile': '/k'}, self.fw()), ({'relayUrl': 'wss://x'}, self.fw()), ({}, self.fw(registryKey='0x' + '11' * 32)),
               ({}, self.fw(fleetSecret='s')), ({}, self.fw(relayUrl='wss://x')), ({}, self.fw(certsApi='https://c')),
               ({}, self.fw(isolation={'managerUrl': 'http://10.0.2.2:8095', 'dataAddr': '10.0.2.2:8096', 'pairingKey': 'ab' * 32})),
               ({}, self.fw(isolation={'managerUrl': 'http://10.0.2.2:40001', 'dataAddr': '10.0.2.2:40002', 'release': True})),
               ({}, self.fw(direct={'other': 1})), ({}, None),
               ({'chainVerifier': {}}, self.fw()), ({}, self.fw(chainVerifier=self.cv)), ({}, self.fw(platformPolicyCarriers={})),
               ({}, self.fw(direct={**self.owner, 'chainVerifier': {**self.cv, 'expose': None}})),
               ({}, self.fw(direct={**self.owner, 'chainVerifier': {**self.cv, 'txBackend': 'http://10.0.2.2:1/'}})),
               ({}, self.fw(direct={**self.owner, 'mcp': {}}))]
        for host, fw in bad:
            self.assertFalse(all(rc.no_key_evidence(host, fw, self.owner, self.ports).values()), (host, fw and {k: fw[k] for k in fw if k != 'direct'}))
        self.assertFalse(all(rc.no_key_evidence({}, self.fw(), {'selling': {'cpuPrice6': 1, 'payout': None}}, self.ports).values()))
        other = {**self.owner, 'chainVerifier': {**self.cv, 'proofSources': ['http://10.0.2.2:40999/']}}   # a proof source that is not the refused stand-in
        self.assertFalse(all(rc.no_key_evidence({}, self.fw(direct=other), other, self.ports).values()))

class Admission(unittest.TestCase):
    """root rule 2026-10-25: RPC active -> 16384 + 3072; RPC not active -> its 66 GiB reservation is held at admission AND as the run floor."""
    def with_rpc(self, state):
        old = rc.rpc_state; rc.rpc_state = lambda: state
        try: return rc.admission()
        finally: rc.rpc_state = old
    def test_rpc_running(self):
        need, floor, _ = self.with_rpc((True, 67584, 'active')); self.assertEqual((need, floor), (19456, 16384))
    def test_rpc_down_holds_its_reservation(self):
        need, floor, _ = self.with_rpc((False, 67584, 'inactive')); self.assertEqual((need, floor), (87040, 83968))
        need, floor, _ = self.with_rpc((False, 70000, 'failed')); self.assertEqual((need, floor), (70000 + 3072 + 16384, 16384 + 70000))
    def test_bounds(self):
        self.assertEqual((rc.MEM_MIB, rc.CAP_MIB, rc.FLOOR_MIB, rc.CPUS, rc.CPU_QUOTA), (2048, 3072, 16384, 4, '200%'))

class ArgvChecks(unittest.TestCase):
    hd = 'cd' * 32
    def argv(self, **o):
        import base64
        a = {'-append': rc.MEASURED_CMDLINE, '-smp': '4', '-m': '2048', '-bios': str(rc.OVMF), '-kernel': str(rc.IMAGE / 'vmlinuz'),
             '-initrd': str(rc.IMAGE / 'initramfs.cpio.gz'), '-netdev': 'user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:40000-:8444',
             '-object': f"sev-snp-guest,id=cx0,cbitpos=51,reduced-phys-bits=1,kernel-hashes=on,sev-device=/dev/sev,host-data={base64.b64encode(bytes.fromhex(self.hd)).decode()}"}
        a.update(o); return [str(rc.QEMU)] + [x for k, v in a.items() if v is not None for x in (k, v)]
    def test_measured_restricted_launch(self):
        self.assertTrue(all(rc.argv_checks([self.argv()], self.hd, 40000)[0].values()))
    def test_deviations_fail(self):
        for o in [{'-netdev': 'user,id=net0,hostfwd=tcp:127.0.0.1:40000-:8444'}, {'-netdev': 'user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:40000-:8080'},
                  {'-netdev': 'user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:40000-:8444,hostfwd=tcp:127.0.0.1:40009-:8080'},
                  {'-append': rc.MEASURED_CMDLINE.replace(' metal.control=direct', '')}, {'-smp': '2'}, {'-m': '4096'}, {'-drive': 'file=/x'},
                  {'-object': 'sev-snp-guest,id=cx0,kernel-hashes=on,host-data=AAAA'}, {'-bios': '/usr/share/edk2/x64/OVMF.4m.fd'}]:
            self.assertFalse(all(rc.argv_checks([self.argv(**o)], self.hd, 40000)[0].values()), o)
        self.assertFalse(all(rc.argv_checks([['/usr/bin/qemu-other'] + self.argv()[1:]], self.hd, 40000)[0].values()))

class Pins(unittest.TestCase):
    def test_pins(self):
        t = {'a': lambda: 'x', 'b': lambda: 'y'}
        self.assertEqual(rc.verify_pins({'a': 'x', 'b': 'y'}, t), [])
        self.assertEqual(rc.verify_pins({'a': 'x', 'b': 'z'}, t), ['b'])
        self.assertEqual(rc.verify_pins({'a': 'x'}, t), ['b'])                     # an unpinned target
        self.assertEqual(rc.verify_pins({'a': 'x', 'b': 'y', 'c': 'q'}, t), ['c'])  # a pin with no target
        def boom(): raise OSError('gone')
        self.assertEqual(rc.verify_pins({'a': 'x'}, {'a': boom}), ['a'])
    def test_real_targets_cover_every_helper(self):
        names = set(rc.pin_targets())
        for n in ['canary/run-canary.py', 'canary/verify-canary.mjs', 'canary/owner-config.mjs', 'canary/qemu-restrict.sh', 'bin/ssh', 'bin/scp', 'bin/sftp',
                  'image/initramfs.cpio.gz', 'image/vmlinuz', 'image/cmdline', 'image/MEASUREMENT', 'image/manifest.json', 'ovmf', 'qemu', 'node', 'receipt', 'inputs',
                  'tools/env.sh', 'tree/source-files', 'tree/node_modules', 'expected-measurement']:
            self.assertIn(n, names)

def spawn(args, **kw):
    p = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **kw)
    for _ in range(100):
        if rc.starttime(p.pid) is not None: break
        time.sleep(0.01)
    assert p.pid not in PROTECTED
    return p
def children(pid, n, timeout=5):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        out = {str(c): (c, rc.starttime(c)) for c in (int(x) for x in os.listdir('/proc') if x.isdigit()) if rc.ppid(c) == pid}
        if len(out) >= n: return out
        time.sleep(0.05)
    raise AssertionError('children did not start')

class Ownership(unittest.TestCase):
    def test_owned_group_is_stopped_and_absence_proven(self):
        p = spawn(['bash', '-c', 'sleep 300 & sleep 300 & wait'], start_new_session=True)
        kids = children(p.pid, 2)
        owned = {'launcher': [p.pid, rc.starttime(p.pid)], 'pgid': p.pid, 'children': kids}
        out = rc.cleanup_group(p, owned, waits=(3, 1, 2, 3))
        self.assertTrue(out['allOwnedAbsent'], out); self.assertFalse(out['refused'])
        self.assertIn(f'killpg {p.pid} SIGTERM', out['steps'])
        self.assertFalse(any(rc.alive(k) for k in kids.values()))
    def test_term_ignoring_group_gets_sigkill_only_while_owned(self):
        p = spawn(['bash', '-c', 'trap "" TERM; sleep 300 & wait; sleep 300'], start_new_session=True)
        kids = children(p.pid, 1)
        out = rc.cleanup_group(p, {'launcher': [p.pid, rc.starttime(p.pid)], 'pgid': p.pid, 'children': kids}, waits=(1, 1, 2, 3))
        self.assertIn(f'killpg {p.pid} SIGKILL', out['steps']); self.assertTrue(out['allOwnedAbsent'], out)
    def test_stale_identity_is_never_signalled(self):
        p = spawn(['sleep', '300'], start_new_session=True)
        try:
            out = rc.cleanup_group(p, {'launcher': [p.pid, rc.starttime(p.pid) + 1], 'pgid': p.pid, 'children': {}}, waits=(1, 0.2, 0.2, 0.2))
            self.assertIsNone(p.poll(), 'a stale identity must not be signalled')
            self.assertFalse(any(s.startswith('killpg') and 'nothing' not in s and 'gone' not in s for s in out['steps']), out)
        finally:
            p.kill(); p.wait()
    def test_foreign_group_is_never_signalled(self):
        p = spawn(['sleep', '300'])                       # NO new session: its group is this test's group
        try:
            self.assertNotEqual(rc.pgid_of(p.pid), p.pid)
            out = rc.cleanup_group(p, {'launcher': [p.pid, rc.starttime(p.pid)], 'pgid': p.pid, 'children': {}}, waits=(1, 0.2, 0.2, 0.2))
            self.assertIsNone(p.poll()); self.assertFalse(any(s.startswith('killpg') for s in out['steps']), out)
            self.assertTrue(any('nothing signalled' in s for s in out['steps']), out)
            self.assertFalse(out['allOwnedAbsent'])
        finally:
            p.kill(); p.wait()
    def test_unbound_launcher_is_refused(self):
        p = spawn(['sleep', '300'], start_new_session=True)
        try:
            out = rc.cleanup_group(p, {'launcher': [p.pid, None], 'pgid': p.pid}, waits=(0.2, 0.2, 0.2, 0.2))
            self.assertTrue(out['refused']); self.assertIsNone(p.poll())
        finally:
            p.kill(); p.wait()
    def test_reaped_identity_is_not_alive(self):
        p = spawn(['true']); st = rc.starttime(p.pid); p.wait()
        self.assertFalse(rc.alive((p.pid, st)))

class Supervise(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR')); self.run = pathlib.Path(self.tmp.name) / 'run'
        self.run.mkdir(mode=0o700); (self.run / 'private').mkdir(mode=0o700); (self.run / 'private' / 'fwcfg.json').write_text('{"pairingKey":"test-only"}')
        self.unit = f'canary-harness-test-{secrets.token_hex(4)}'
    def tearDown(self):
        subprocess.run(['systemctl', '--user', 'stop', f'{self.unit}.scope'], capture_output=True)
        self.tmp.cleanup()
    def driver(self, mode):
        return subprocess.Popen([sys.executable, str(D / 'test/supervise_driver.py'), str(self.run), self.unit, mode], stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    def test_interrupted_parent_stops_only_its_scope_proves_absence_and_scrubs(self):
        d = self.driver('sleep')
        end = time.monotonic() + 15
        while time.monotonic() < end and not (self.run / 'inner.pid').exists(): time.sleep(0.05)
        inner = int((self.run / 'inner.pid').read_text())
        time.sleep(0.3); ident = (inner, rc.starttime(inner)); self.assertTrue(rc.alive(ident))
        d.send_signal(signal.SIGTERM); outp, _ = d.communicate(timeout=60)
        t = json.loads((self.run / 'terminal.json').read_text())
        self.assertTrue(t['interrupted'], t); self.assertIn(t['scopeStop'], (0, 5)); self.assertTrue(t['cgroup'], t)
        self.assertTrue(t['cgroupEmpty'], t); self.assertEqual(t['survivors'], []); self.assertTrue(t['ownedAbsenceProven'], t)
        self.assertTrue(t['privatePresentAfterChild']); self.assertTrue(t['privateAbsent']); self.assertNotEqual(t['code'], 0)
        self.assertFalse(rc.alive(ident)); self.assertTrue((self.run / 'execution.log').exists()); self.assertNotEqual(d.returncode, 0)
    def test_normal_exit_keeps_code_and_scrubs_leftover_private(self):
        d = self.driver('exit3'); d.communicate(timeout=60)
        t = json.loads((self.run / 'terminal.json').read_text())
        self.assertEqual(t['exitCode'], 3); self.assertEqual(t['code'], 3); self.assertIsNone(t['interrupted'])
        self.assertTrue(t['ownedAbsenceProven'], t); self.assertTrue(t['privateAbsent'])
    def test_unproven_absence_keeps_private_and_fails(self):
        s = spawn([sys.executable, '-c', 'import time; time.sleep(300)', str(self.run)])   # a process naming this run, OUTSIDE the scope
        try:
            d = self.driver('exit3'); d.communicate(timeout=60)
            t = json.loads((self.run / 'terminal.json').read_text())
            self.assertIn(str(s.pid), t['survivors']); self.assertFalse(t['ownedAbsenceProven'])
            self.assertFalse(t['privateAbsent'], 'private must NOT be scrubbed before absence is proven'); self.assertNotEqual(t['code'], 0)
        finally:
            s.kill(); s.wait()

class Sanitize(unittest.TestCase):
    def test_redaction(self):
        key = 'ab' * 32
        out = rc.sanitize(f'line {key}\nSECRET=xyz\n"pairingKey": "{key}"\nok line\n', [key])
        self.assertNotIn(key, out); self.assertNotIn('xyz', out); self.assertIn('ok line', out)

if __name__ == '__main__': unittest.main(verbosity=2)
