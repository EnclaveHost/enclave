"""bootstrap-systemd-canary-stage: OFFLINE tests of the generated canary units, probes, verdict and scripts (no systemd, no guest).
Inputs (env, set by jobs/root-offline-tests.sh): CANARY_LIVE (the guest's captured `systemctl cat enclave-base-holder.service`),
CANARY_DROPIN / CANARY_REPROOF (the reviewed 60-release-mode.conf / reproof unit), CANARY_WRAPPER (the reviewed chain_service.py)."""
import importlib.util, json, os, pathlib, re, shutil, stat, subprocess, sys, tempfile, unittest
from unittest.mock import patch

S = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('canary_units', S / 'guest/canary_units.py'); CU = importlib.util.module_from_spec(spec); spec.loader.exec_module(CU)
ID = '20261026T090900Z-0123abcd'
cut = lambda t: t[:t.index('IPAddressDeny=10.0.2.2/32') + len('IPAddressDeny=10.0.2.2/32')] + '\n'   # the `systemctl cat` part only
LIVE = cut(pathlib.Path(os.environ['CANARY_LIVE']).read_text())
DROPIN = pathlib.Path(os.environ['CANARY_DROPIN']).read_text(); REPROOF = pathlib.Path(os.environ['CANARY_REPROOF']).read_text()
WRAPPER = os.environ['CANARY_WRAPPER']; B = f'/run/enclave-sdcanary-{ID}/bundle'


def props(argv):
    return [argv[i + 1] for i, a in enumerate(argv) if a == '-p']


class Render(unittest.TestCase):
    def setUp(self):
        self.u = CU.render(ID, LIVE, DROPIN, REPROOF, B)

    def test_every_unit_is_ours_transient_bounded_and_waited(self):
        self.assertEqual(set(self.u), {'busy', 'permit', 'holder', 'permitfail', 'holderfail', 'runtime', 'runtime2'})
        for n, a in self.u.items():
            self.assertEqual(a[:2], ['systemd-run', '--quiet']); self.assertIn(f'--unit=enclave-sdcanary-{ID}-{n}', a); self.assertIn('--wait', a)
            self.assertTrue(any(p.startswith('MemoryMax=') and p.split('=')[1] in ('512M', '64M', '128M') for p in props(a)), n)
            self.assertFalse(any(p.startswith(('Restart=', 'MemoryMax=28G')) for p in props(a)), n)

    def test_holder_sandbox_is_the_production_one_with_only_private_writable_paths(self):
        for n in ('busy', 'holder', 'holderfail'):
            p = props(self.u[n])
            for want in ('ProtectSystem=strict', 'ProtectHome=yes', 'PrivateTmp=yes', 'NoNewPrivileges=yes', 'UMask=0027', 'IPAddressDeny=10.0.2.2/32',
                         'MemorySwapMax=0', 'User=root', 'Group=root', 'Environment=ENCLAVE_BASE_LAUNCH_HANDSHAKE=1',
                         'CapabilityBoundingSet=CAP_SETUID CAP_SETGID CAP_DAC_READ_SEARCH CAP_CHOWN',
                         'InaccessiblePaths=-/srv/enclave-l1-pair -/var/lib/enclave-rpc -/etc/enclave-rpc/jwt.hex', 'MemoryMax=512M'):
                self.assertIn(want, p, (n, want))
            rw = [x for q in p if q.startswith('ReadWritePaths=') for x in q.split('=', 1)[1].split()]
            self.assertEqual(sorted(rw), sorted([f'/srv/enclave-sdcanary-{ID}/data', f'/srv/enclave-sdcanary-{ID}/tmp',
                                                 f'/etc/enclave-sdcanary-{ID}/base-bootstrap/journal', f'/etc/enclave-sdcanary-{ID}/base-bootstrap/journal.lock']))
            self.assertFalse(any('/etc/enclave-rpc/base-bootstrap' in q or '/srv/enclave-base-holder' in q for q in p), n)
        self.assertIn(f'ExecCondition=/usr/bin/python3 -I -B {B}/bootstrap/holder_gate.py datadir-idle', props(self.u['busy']))
        self.assertFalse(any(q.startswith('ExecCondition=') for q in props(self.u['holder'])), 'the probe holder never runs the busy gate')
        self.assertIn(f'Requires=enclave-sdcanary-{ID}-permit.service', props(self.u['holder']))
        self.assertIn(f'After=enclave-sdcanary-{ID}-permit.service', props(self.u['holder']))
        self.assertIn(f'Requires=enclave-sdcanary-{ID}-permitfail.service', props(self.u['holderfail']))

    def test_runtime_units_use_a_private_runtime_dir_with_the_reviewed_mode_and_preserve(self):
        for n in ('runtime', 'runtime2'):
            p = props(self.u[n])
            self.assertIn(f'RuntimeDirectory=enclave-sdcanary-{ID}-rt', p); self.assertNotIn('RuntimeDirectory=enclave-rpc', p)
            for want in ('RuntimeDirectoryMode=0755', 'RuntimeDirectoryPreserve=yes', 'User=root', 'NoNewPrivileges=yes', 'PrivateTmp=yes'):
                self.assertIn(want, p)

    def test_render_refuses_anything_that_would_not_test_production_or_would_expose_it(self):
        bad = [(LIVE.replace('User=rpcbase', 'User=nobody'), DROPIN, REPROOF), (LIVE.replace('ProtectSystem=strict', 'ProtectSystem=full'), DROPIN, REPROOF),
               (LIVE, DROPIN.replace('/etc/enclave-rpc/base-bootstrap/journal.lock', '/etc/enclave-rpc/base-bootstrap/journal.lock /etc/enclave-rpc'), REPROOF),
               (LIVE, DROPIN.replace('ENCLAVE_BASE_LAUNCH_HANDSHAKE=1', 'X=1'), REPROOF), (LIVE, DROPIN, REPROOF.replace('RuntimeDirectoryPreserve=yes', ''))]
        for live, drop, rep in bad:
            with self.assertRaises(SystemExit):
                CU.render(ID, live, drop, rep, B)
        with self.assertRaises(SystemExit):
            CU.render('../x', LIVE, DROPIN, REPROOF, B)


class WrapperCode(unittest.TestCase):
    def test_reviewed_functions_run_verbatim_legacy_refusal_and_release_lock_as_root(self):
        self.assertEqual(os.geteuid(), 0, 'the offline job runs under unshare -Ur (uid 0 in the namespace)')
        W = CU.wrapper_ns(WRAPPER); t = pathlib.Path(tempfile.mkdtemp(prefix='sdc-')); self.addCleanup(shutil.rmtree, t, True); os.chmod(t, 0o755)
        (t / 'bb').mkdir(mode=0o755); lock = t / 'bb/journal.lock'; lock.touch(); os.chmod(lock, 0o600)
        W['BOOTSTRAP_DIR'] = t / 'bb'; W['TRUSTED_TOP'] = t
        with patch.dict(os.environ, {'ENCLAVE_BASE_LAUNCH_HANDSHAKE': '1'}):
            with self.assertRaisesRegex(AssertionError, 'legacy bin/base'):
                W['release_launch_lock']({})
            fd = W['release_launch_lock']({'baseRelease': {'path': 'x', 'sha256': 'y'}}); self.assertIsInstance(fd, int); os.close(fd)
        with self.assertRaisesRegex(AssertionError, 'handshake'):
            W['release_launch_lock']({'baseRelease': {'path': 'x', 'sha256': 'y'}})        # no env: refused
        os.chmod(lock, 0o644)
        with patch.dict(os.environ, {'ENCLAVE_BASE_LAUNCH_HANDSHAKE': '1'}), self.assertRaises(AssertionError):
            W['release_launch_lock']({'baseRelease': {'path': 'x', 'sha256': 'y'}})        # a non-private lock refuses
        self.assertEqual(W['BASE_SERVICE_USER'], 'rpcbase')


class Probes(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='sdc-')); self.addCleanup(shutil.rmtree, self.t, True)
        real = CU.paths(ID); self.p = {k: (str(self.t / k) if k not in ('rt', 'unit') else v) for k, v in real.items()}
        for k in ('run', 'data', 'out'):
            pathlib.Path(self.p.get(k, self.t / k)).mkdir(parents=True, exist_ok=True)
        (self.t / 'out').mkdir(exist_ok=True)
        self.ctx = self.t / 'ctx.json'; self.ctx.write_text(json.dumps({'id': ID, 'bundle': B, 'out': str(self.t / 'out')}))
        pp = patch.object(CU, 'paths', lambda i: self.p); pp.start(); self.addCleanup(pp.stop)

    def test_mock_permit_flaky_then_ok_and_fail_always(self):
        with self.assertRaises(SystemExit):
            CU.mock_permit(self.ctx, 'permit', 'flaky')
        CU.mock_permit(self.ctx, 'permit', 'flaky')
        for _ in range(2):
            with self.assertRaises(SystemExit):
                CU.mock_permit(self.ctx, 'permitfail', 'fail')
        self.assertEqual(len((self.t / 'run/permit.stamps').read_text().split()), 2)

    def evidence(self, **over):
        rb = CU.pwd.getpwnam('rpcbase') if self._has_rpcbase() else None
        uid, gid = (rb.pw_uid, rb.pw_gid) if rb else (994, 985)
        bnd = sum(1 << CU.CAPS[x] for x in ('CAP_SETUID', 'CAP_SETGID', 'CAP_DAC_READ_SEARCH', 'CAP_CHOWN'))
        no = lambda e: {'ok': False, 'errno': e, 'msg': ''}
        root = {'probe': 'holder-root', 'identity': {'startNs': 10 ** 19, 'euid': 0, 'handshakeEnv': '1', 'capBnd': bnd, 'capEff': bnd, 'noNewPrivs': 1},
                'readRpcbaseSecret': {'ok': True}, 'journalAppend': {'ok': True}, 'releaseLock': {'ok': True}, 'roEtcWrite': no(30), 'launchBootstrapWrite': no(30),
                'inaccessible': {'a': no(13), 'b': no(2), 'c': no(13)}, 'ownDatadir': {'ok': True, 'value': [0, '1 entry']}, 'rootfileOwner': {'ok': True, 'value': uid},
                'legacyRefusal': {'ok': False, 'msg': 'legacy bin/base under the root release-mode unit drop-in: refusing'}, 'waitL1': {'ok': True, 'value': [0, 'L1 ready']}}
        dropped = {'probe': 'holder-dropped', 'identity': {'resuid': [uid] * 3, 'resgid': [gid] * 3, 'capEff': 0, 'capPrm': 0}, 'setuid0': no(1),
                   'dataWrite': {'ok': True}, 'tmpWrite': {'ok': True}, 'journalWrite': no(13), 'rootOnlyRead': no(13)}
        for k, v in over.get('root', {}).items():
            root[k] = v
        for k, v in over.get('dropped', {}).items():
            dropped[k] = v
        o = self.t / 'out'
        (o / 'journal-holder.txt').write_text(f'SDCANARY {json.dumps(root)}\nSDCANARY {json.dumps(dropped)}\n')
        (o / 'journal-runtime.txt').write_text(''.join('SDCANARY ' + json.dumps({'probe': 'runtime', 'before': {'ok': True}, 'fileBefore': fb, 'publish': {'ok': True}}) + '\n'
                                                       for fb in (False, True)))
        (o / 'runtime.json').write_text(json.dumps({'mode': '0o755', 'uid': 0, 'fileMode': '0o644'}))
        (o / 'busy.json').write_text(json.dumps({'downloaderActive': over.get('dl', True), 'startRan': over.get('startRan', False), 'conditionMsg': True}))
        (o / 'invariants.json').write_text(json.dumps({'pidsUnchanged': over.get('pids', True), 'configUnchanged': True, 'minAvailMiB': 17000}))
        (self.t / 'run/permit.stamps').write_text('1\n2\n'); (self.t / 'run/permitfail.stamps').write_text('1\n2\n')
        if over.get('holderfailRan'):
            (self.t / 'data/holderfail-start-ran').touch()
        with patch.object(CU.pwd, 'getpwnam', lambda n: type('pw', (), {'pw_uid': uid, 'pw_gid': gid})()):
            return CU.verdict(self.ctx)

    def _has_rpcbase(self):
        try:
            CU.pwd.getpwnam('rpcbase'); return True
        except KeyError:
            return False

    def test_verdict_passes_only_complete_evidence(self):
        self.assertEqual(self.evidence(), 0)
        v = json.loads((self.t / 'out/verdict.json').read_text()); self.assertTrue(v['pass']); self.assertGreaterEqual(len(v['required']), 18)
        for bad in ({'pids': False}, {'startRan': True}, {'holderfailRan': True}, {'root': {'roEtcWrite': {'ok': True}}},
                    {'root': {'identity': {'startNs': 10 ** 19, 'euid': 0, 'handshakeEnv': '1', 'capBnd': -1, 'capEff': 0, 'noNewPrivs': 1}}},
                    {'dropped': {'identity': {'resuid': [0, 0, 0], 'resgid': [0, 0, 0], 'capEff': 1, 'capPrm': 1}}}, {'dropped': {'journalWrite': {'ok': True}}},
                    {'root': {'legacyRefusal': {'ok': True}}}, {'root': {'releaseLock': {'ok': False, 'errno': 30}}}):
            with self.subTest(bad=bad):
                self.assertEqual(self.evidence(**bad), 1)

    def test_a_downloader_that_is_not_running_is_reported_not_exercised(self):
        self.assertEqual(self.evidence(dl=False), 0)
        v = json.loads((self.t / 'out/verdict.json').read_text())
        self.assertIn('NOT EXERCISED', v['informational']['datadir-idle busy refusal'])


class Scripts(unittest.TestCase):
    def test_scripts_parse_and_never_touch_production(self):
        for f in ('guest/systemd_canary.sh', 'guest/cleanup.sh'):
            self.assertEqual(subprocess.run(['bash', '-n', str(S / f)]).returncode, 0, f)
            t = (S / f).read_text(); code = '\n'.join(l for l in t.splitlines() if not l.lstrip().startswith('#'))
            self.assertNotIn('daemon-reload', code)
            self.assertIsNone(re.search(r'systemctl\s+(start|restart|stop|kill|enable|disable|mask)\s+(?!"\$UNIT-)', code), f)
            self.assertNotIn('/srv/enclave-base-holder', code); self.assertNotIn('/etc/enclave-rpc/', code.replace('/etc/enclave-rpc -maxdepth', ''))
            self.assertNotRegex(code, r'\bchown\b(?!.*(\$B|\$SRV|-o rpcbase))')
        c = (S / 'guest/cleanup.sh').read_text()
        self.assertIn('[[ $d =~ ^/(run|etc|srv)/enclave-sdcanary-(in-)?$ID(-rt)?$ ]] || exit 21', c)
        self.assertIn('rm -rf --one-file-system', c)

    def test_assembly_refuses_while_final_pins_are_null(self):
        pins = json.loads((S / 'FINAL-PINS.json').read_text())
        self.assertTrue(pins['stage'] is None and pins['stageSha256sums'] is None and not any(pins['files'].values()))
        r = subprocess.run([sys.executable, '-I', str(S / 'tools/assemble_canary_bundle.py'), str(pathlib.Path(tempfile.mkdtemp()) / 'o')], capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0); self.assertIn('not qualified', r.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
