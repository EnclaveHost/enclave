"""production-bootstrap-wiring-stage: offline tests (PREPARED; NOT run by Claude; root's job jobs/root-bootstrap-wiring.sh runs them in the
recovery-copy layout beside test_r3_launcher.py). Real code everywhere a decision is made:
  FirstCapture   the patched harness-first (capture-original-recheck) over the A2 fixture's fake base, the REAL capture module (the job's
                 CAPTURE_MODULE bytes) over the reviewed stub sources (a1-capture-binding r4 stubs + r7 capture stubs, as
                 test_finality_integration), the REAL pinned A1 gate, the REAL ledger, and the patched producer (produce/_initial_ok).
  Ordering       r3 Pipeline (legacy fixture launch, TEST seam A1_LEGACY_TEST_ONLY): produce's finality/ dir, permit_restart_auto on
                 armed -> real wrapper start -> consumed hazard refusals.
  HolderGate / ReleaseInstall / Units   the stage's bootstrap tools and unit files (WIRING_OVERLAY), with injected systemctl, /proc,
                 clock and chown seams only.
TEST-ONLY seams (each reset per test): TRUSTED_UID/OWNER = this uid (fixture), A1_FIRST_CAPTURE_REVIEWED / A1_CAPTURE_SOURCE /
A1_CAPTURE_TEST_PINS / A1_ADMISSION_LEDGER on the harness copy, the fixture's own initial receipt pin (as TA.Recheck), release/harness
binary shas of fake binaries."""
import contextlib, dataclasses, datetime, hashlib, importlib.util, json, os, pathlib, shutil, stat, sys, tempfile, types, unittest
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import test_r3_launcher as L3                        # loads TA (the harness-first copy under test), this layout's wrapper + producer
TA, T, P, W, A = L3.TA, L3.T, L3.P, L3.W, L3.TA.A
sha = L3.sha
OV = pathlib.Path(os.environ['WIRING_OVERLAY'])
R7 = L3.WORK / 'base-reanchor-recovery-stage/r7'; CAP_STAGE = L3.WORK / 'a1-capture-binding-stage/r4'
CAP_SRC = pathlib.Path(os.environ['CAPTURE_MODULE']); NODE = os.path.realpath(os.environ['FINALITY_NODE'])
assert hasattr(A, 'first_capture') and 'capture-original-recheck' in A.A1_MODES, 'the PATCHED harness-first is under test'


def load(name, p):
    s = importlib.util.spec_from_file_location(name, p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m


class FirstCapture(L3.Pipeline):
    def setUp(self):
        super().setUp()
        A.A1_LEGACY_TEST_ONLY = False; pl = patch.object(P, 'A1_LEGACY_TEST_ONLY', False); pl.start(); self.addCleanup(pl.stop)   # PRODUCTION
        self.uid = os.getuid(); self.ledger = self.d / 'etc/base-a1-admission.jsonl'
        st = contextlib.ExitStack(); self.addCleanup(st.close)
        for k, v in (('A1_FIRST_CAPTURE_REVIEWED', True), ('A1_CAPTURE_SOURCE', CAP_SRC), ('A1_CAPTURE_SHA256', sha(CAP_SRC.read_bytes())),
                     ('A1_CAPTURE_TEST_PINS', lambda: self.cpins), ('A1_ADMISSION_LEDGER', self.ledger), ('_A1_CAPTURE', None)):
            st.enter_context(patch.object(A, k, v))
        self.C = A.load_capture(); st.enter_context(patch.object(self.C, 'OWNER', self.uid))
        t = self.d / 'capsrc'; shutil.copytree(CAP_STAGE / 'tests/stubs', t / 'src')
        shutil.copyfile(R7 / 'tests/capture-stubs/a1-recheck-read.mjs', t / 'src/recheck/a1-recheck-read.mjs')
        shutil.copyfile(R7 / 'tests/capture-stubs/a1-read.mjs', t / 'src/initial/a1-read.mjs')          # as test_finality_integration.cap_setup
        tpl = t / 'receipt-template.json'; tpl.write_text(json.dumps(TA.fresh_a1()))
        ex = json.loads((t / 'src/initial/a1-config.example.json').read_text()); ex['fixtureReceipt'] = str(tpl)
        (t / 'src/initial/a1-config.example.json').write_text(json.dumps(ex))
        (t / 'checkpoint.json').write_text('{"stub": "checkpoint"}')
        (t / 'l1.json').write_text(json.dumps({'format': 'enclave-l1-authority/v1', 'binary': {'path': '/nonexistent/helios', 'sha256': 'ab' * 32},
                                               'listen': {'ip': '127.0.0.1', 'port': 28550}, 'checkpointFile': str(t / 'checkpoint.json')}))
        (t / 'portal.json').write_text(json.dumps({'readSucceeded': True, 'asr': self.C.MAINNET['asr'], 'block': {'hash': '0x' + '11' * 32}}))
        self.initial_path = t / 'initial-receipt.json'
        self.set_initial(json.dumps(TA.fresh_a1(TA.utcnow() - datetime.timedelta(hours=6))).encode())
        self.ncap = 0

    def set_initial(self, b):
        """the initial receipt the capture rechecks; its sha is the fixture's source pin (TA.Recheck's convention)"""
        self.initial_path.write_bytes(b); A.A1_INITIAL_SHA256 = sha(b); t = self.d / 'capsrc'
        self.csrc = self.C.Sources(initial_dir=t / 'src/initial', recheck_dir=t / 'src/recheck', l1_authority=t / 'src/l1_authority.py',
                                   l1_config=t / 'l1.json', portal_result=t / 'portal.json', initial_receipt=self.initial_path,
                                   deps_root=t / 'src/deps', node=NODE, el_url='http://127.0.0.1:18645')
        names = {'initial': ['a1-read.mjs', 'a1-anchor.mjs', 'vendor/anchor-bootstrap.mjs', 'test/deps.mjs'],
                 'recheck': ['a1-recheck-read.mjs', 'a1-recheck.mjs', 'a1-read.mjs', 'a1-anchor.mjs', 'vendor/anchor-bootstrap.mjs', 'test/deps.mjs']}
        mods = {m: {r: sha((d / r).read_bytes()) for r in names[m]} for m, d in (('initial', self.csrc.initial_dir), ('recheck', self.csrc.recheck_dir))}
        mods['recheck-capture'] = dict(mods['recheck'])
        libs = sorted({l.split()[-1] for l in pathlib.Path('/proc/self/maps').read_text().splitlines() if 'libpython' in l and '/' in l})
        pf = self.C.read_package(self.csrc.deps_root, 'fakehash')
        self.cpins = self.C.Pins(modules=mods, l1_authority=sha(self.csrc.l1_authority.read_bytes()), helios='ab' * 32,
                                 a1_example=sha((self.csrc.initial_dir / 'a1-config.example.json').read_bytes()), initial=A.A1_INITIAL_SHA256,
                                 lock=sha((self.csrc.deps_root / 'package-lock.json').read_bytes()),
                                 deps={'fakehash': ('1.0.0', self.C.tree_rows({r: sha(x) for r, x in pf.items()}))},
                                 node_accepted={sha(pathlib.Path(NODE).read_bytes()): {'provenance': 'test-observed'}},
                                 python_accepted={sha(pathlib.Path(os.path.realpath(sys.executable)).read_bytes()): {'provenance': 'test-observed'}},
                                 libpython_accepted={(sha(pathlib.Path(libs[0]).read_bytes()) if len(libs) == 1 else None): {'provenance': 'test-observed'}})

    def capture(self, mode='recheck'):
        self.ncap += 1; out = self.d / f'cap-{self.ncap}'
        ok, res = self.C.capture(mode, out, src=self.csrc, pins=self.cpins, hooks={'poll': 0.05}, helios_timeout=20, a1_timeout=60)
        self.assertTrue(ok, res); return out

    def use_capture(self, out):
        for k in A.A1_RECHECK_KEYS:
            self.cfg.pop(k, None)
        self.cfg.update(a1Mode='capture-original-recheck', a1CaptureOut=str(out), a1Evidence=str(out / 'capture/evidence.json'))

    def ledger_keys(self):
        return set() if not self.ledger.exists() else {k for l in self.ledger.read_text().splitlines() for k in json.loads(l)['keys']}

    def step_code(self, st):
        rc, rec = self.run_step(st); return rc, (rec.get('refused') or '').split(':')[0]

    def released_by_capture(self):
        c1 = self.capture(); self.use_capture(c1)
        self.assertEqual(self.step_code('plan'), (0, ''))
        self.assertEqual(self.ledger_keys(), set(), 'plan checks admissibility but admits nothing')
        TA.BytecodeGate.ready(self, TA.V2_GOOD); A.BYTECODE_CHECKER_V2_SHA256 = self.cfg['bytecodeCheckerSha256']   # a2 (admits c1), a3, a4
        self.assertEqual(self.run_step('bytecodes')[0], 0)
        self.assertEqual(self.step_code('release'), (1, 'a1_replayed'), 'A2\'s capture is never admitted twice')
        c2 = self.capture(); self.use_capture(c2)
        self.assertEqual(self.step_code('release'), (0, ''))
        return c1, c2

    def test_first_bootstrap_runs_only_on_verified_admitted_captures_and_the_producer_reverifies_both(self):
        c1, c2 = self.released_by_capture()
        a2 = json.loads((self.d / 'work/a2-authenticated.json').read_text())['a1Gate']
        self.assertEqual((a2['a1Mode'], a2['initialSha256'], a2['recheckCapture']['outPath']), ('capture-original-recheck', A.A1_INITIAL_SHA256, str(c1)))
        self.assertEqual(len(self.ledger_keys()), 6, 'two captures, each admitted once (capture, evidence, record)')
        r = self.produce(); self.assertTrue((self.out / 'finality').is_dir())
        self.assertEqual(self.launch['bindings']['a1']['initialSha256'], A.A1_INITIAL_SHA256)
        # the producer re-verifies BOTH recorded captures: tampering either refuses a new launch
        for victim in (c1, c2):
            with self.subTest(victim=victim.name):
                f = victim / 'capture/a1.stderr'; orig = f.read_bytes(); os.chmod(f, 0o600); f.write_bytes(orig + b'x')
                self.refused(lambda: self.produce_to(self.d / f'etc/bb-{victim.name}'), 'a1'); f.write_bytes(orig)

    def produce_to(self, out):
        return P.produce(self.d / 'cfg.json', out, A=A, coverage=self.cov, release_path=self.rel, release_sha=self.rel_sha,
                         harness_binary_sha=self.cfg['baseBinarySha256'], owner=self.uid, top=self.top)

    def test_legacy_receipt_files_are_refused_in_production_b1(self):
        TA.Recheck.use_recheck(self)                          # a forged-but-consistent legacy pair (no Helios run): B1, refused at load
        for mode in ('fresh-initial', 'original-game-recheck'):
            self.cfg['a1Mode'] = mode; self.write()
            with self.assertRaises(A.Refused) as e:
                A.load_config(self.d / 'cfg.json')
            self.assertTrue(str(e.exception).startswith('a1_legacy:'), str(e.exception))

    def test_a_legacy_first_launch_is_refused_by_the_producer(self):
        A.A1_LEGACY_TEST_ONLY = True        # the HARNESS fixture run is legacy (test seam); the PRODUCER flag stays False (production)
        self.released()
        self.refused(self.produce, 'a1'); self.assertFalse(self.out.exists())

    def test_capture_refusals(self):
        ini = self.capture('initial'); self.use_capture(ini)
        self.assertEqual(self.step_code('plan'), (1, 'a1_capture_binding'))           # not the original-game recheck
        c = self.capture(); self.use_capture(c); f = c / 'capture/helios.out'; os.chmod(f, 0o600); f.write_bytes(f.read_bytes() + b'x')
        self.assertEqual(self.step_code('plan'), (1, 'a1_capture'))                   # tampered after the run
        c = self.capture(); self.use_capture(c)
        late = TA.utcnow() + datetime.timedelta(seconds=self.cfg['a1MaxAgeSec'] + 5)
        with patch.object(A, 'now', lambda: late):
            with self.assertRaises(A.Refused) as e:                                # direct: a patched-clock run record would sort last
                A.first_capture(A.load_config(self.write() or self.d / 'cfg.json'))
            self.assertTrue(str(e.exception).startswith('a1_stale:'), str(e.exception))
        self.set_initial(json.dumps(TA.fresh_a1(TA.utcnow() - datetime.timedelta(hours=5))).encode())   # another initial receipt ...
        c = self.capture(); self.use_capture(c); A.A1_INITIAL_SHA256 = '00' * 32                      # ... than the source pin
        self.assertEqual(self.step_code('plan'), (1, 'a1_initial_pin'))
        for bad in ({'a1Evidence': str(self.d / 'a1.json')}, {'a1RecheckSha256': 'ab' * 32}, {'a1CaptureOut': 'relative'}):
            with self.subTest(bad=bad):
                self.use_capture(c); self.cfg.update(bad); self.write()
                with self.assertRaises(A.Refused) as e:
                    A.load_config(self.d / 'cfg.json')
                self.assertTrue(str(e.exception).startswith('bad_config:'), str(e.exception))

    def test_a3_a4_plan_accepts_the_a2_capture_without_readmitting_but_not_a_foreign_admitted_one(self):
        c1 = self.capture(); self.use_capture(c1); self.assertEqual(self.step_code('a2'), (0, ''))
        n = len(self.ledger_keys()); self.assertEqual(self.step_code('plan'), (0, '')); self.assertEqual(len(self.ledger_keys()), n)
        shutil.copytree(self.d / 'work', self.d / 'work2'); self.cfg['workdir'] = str(self.d / 'work2')
        (self.d / 'work2/a2-authenticated.json').unlink()                     # another workdir that never recorded c1
        rc, _ = self.run_step('plan')                                          # TA.run_step reads work/: read work2's own record
        rec = json.loads(sorted((self.d / 'work2').glob('run-plan-*.json'))[-1].read_text())
        self.assertEqual((rc, rec['refused'].split(':')[0]), (1, 'a1_replayed'))

    def test_production_launcher_from_settings_replace_and_recheck(self):
        s = self.d / 'sources.json'; c = self.csrc
        s.write_text(json.dumps({'format': self.C.SOURCES_FORMAT, 'initialDir': str(c.initial_dir), 'recheckDir': str(c.recheck_dir),
                                 'l1Authority': str(c.l1_authority), 'l1Config': str(c.l1_config), 'portalResult': str(c.portal_result),
                                 'depsRoot': str(c.deps_root), 'node': c.node, 'elUrl': 'http://127.0.0.1:18645'})); os.chmod(s, 0o644)
        src = dataclasses.replace(self.C.Sources.from_settings(s, owner=self.uid), initial_receipt=self.initial_path)
        self.assertIsNone(self.C.Sources.from_settings(s, owner=self.uid).initial_receipt, 'no generic Sources key: the fixed receipt comes from replace')
        rc, r = AO.run(self.d / 'cap-launcher', A, self.C, src, pins=self.cpins, hooks={'poll': 0.05})
        self.assertEqual(rc, 0, r); self.use_capture(pathlib.Path(r['config']['a1CaptureOut']))
        self.assertEqual(self.cfg['a1Evidence'], r['config']['a1Evidence']); self.assertEqual(self.step_code('plan'), (0, ''))

    def test_the_original_pinned_live_receipt_passes_plan(self):
        self.set_initial(TA.LIVE_BYTES); self.assertEqual(A.A1_INITIAL_SHA256, TA.REAL_INITIAL_SHA)
        c = self.capture(); self.use_capture(c); self.cfg['outputRoot'] = TA.REAL_ROOT
        rc, rec = self.run_step('plan'); self.assertEqual(rc, 0, rec)
        g = rec['result']['gates']['a1']
        self.assertEqual((g['N'], g['game'], g['outputRoot'], g['initialSha256']), ('52866960', TA.GAME, TA.REAL_ROOT, TA.REAL_INITIAL_SHA))
        self.assertEqual(self.ledger_keys(), set())


class Ordering(L3.Pipeline):
    """legacy fixture launch (TEST seam), then the production unit order: permit-restart-auto -> wrapper start -> (hazard)"""
    def F(self):
        return types.SimpleNamespace(OWNER=self.uid)                 # armed/consumed with no watermark: adopt_pending needs only OWNER

    def auto(self):
        return P.permit_restart_auto(self.out, self.d / 'cfg.json', A=A, W=W, F=self.F(), owner=self.uid, top=self.top,
                                     watermark=self.d / 'etc/base-finality-watermark')

    def test_produce_creates_a_private_finality_dir_atomically_and_never_overwrites(self):
        self.released()
        with patch.object(P.os, 'rename', side_effect=OSError('crash before publish')):
            with self.assertRaises(OSError):
                self.produce()
        self.assertFalse(self.out.exists(), 'nothing is published without its finality dir')
        for q in self.out.parent.glob(f'.{self.out.name}.partial-*'):
            shutil.rmtree(q)
        self.produce(); fd = self.out / 'finality'; st = os.lstat(fd)
        self.assertTrue(stat.S_ISDIR(st.st_mode) and stat.S_IMODE(st.st_mode) == 0o700 and st.st_uid == self.uid and not os.listdir(fd))
        before = sorted(p.name for p in self.out.iterdir())
        self.refused(self.produce, 'exists'); self.assertEqual(sorted(p.name for p in self.out.iterdir()), before)

    def test_armed_permit_then_start_consumes_and_a_restart_before_the_first_proof_refuses(self):
        self.launched()
        r = self.auto(); self.assertEqual((r['event'], r['state'], r['note']), (None, 'armed', 'nothing to permit'))
        self.assertEqual(self.states(), ['armed'])
        self.assertEqual(self.start(), 'exec'); self.assertIn('--bootstrap.anchor', self.execs()[-1][2])
        self.assertEqual(self.states(), ['armed', 'consumed'])
        self.refused(self.auto, 'not_restartable'); self.assertEqual(self.states(), ['armed', 'consumed'])
        self.assertIn('already consumed', self.start()); self.assertEqual(self.states(), ['armed', 'consumed'])


HG = load('holder_gate_wiring', OV / 'bootstrap/holder_gate.py')
AO = load('a1_capture_original_wiring', OV / 'bootstrap/a1_capture_original.py')


class CaptureHelper(unittest.TestCase):
    """the production launcher's explicit run limits reach capture() unchanged; a capture failure (e.g. Helios not fresh in time) is a
    TEMPFAIL with nothing verified or emitted; inputs are size-bounded"""
    def fake(self, ok):
        calls = {}
        def capture(mode, out, **kw):
            calls.update(mode=mode, **kw); return ok, ({} if ok else {'error': 'Helios did not reach fresh-finalized within 900 s'})
        def verify(out, **kw):
            calls['verified'] = True
            return {'mode': 'recheck', 'boundInputs': {'inputs/initial-a1-evidence.json': 'ab' * 32}, 'captureId': 'i', 'captureSha256': 'c',
                    'evidenceSha256': 'e', 'finishedAt': 'f'}
        return types.SimpleNamespace(capture=capture, verify=verify), calls

    def test_explicit_900s_cold_start_and_240s_run_pass_through(self):
        C, calls = self.fake(True); t = pathlib.Path(tempfile.mkdtemp(prefix='ao-')); self.addCleanup(shutil.rmtree, t, True)
        rc, r = AO.run(str(t / 'o'), types.SimpleNamespace(A1_INITIAL_SHA256='ab' * 32), C, types.SimpleNamespace(node='/n'))
        self.assertEqual((rc, calls['mode'], calls['helios_timeout'], calls['a1_timeout'], calls.get('verified')), (0, 'recheck', 900, 240, True))
        self.assertEqual((AO.HELIOS_COLD_START_SEC, AO.A1_RUN_SEC), (900, 240))
        rc, r = AO.run(str(t / 'o2'), types.SimpleNamespace(A1_INITIAL_SHA256='cd' * 32), C, types.SimpleNamespace(node='/n'))
        self.assertEqual(rc, 1, 'a capture of another initial receipt is refused')
        (t / 'o3').mkdir()
        with self.assertRaises(ValueError):
            AO.run(str(t / 'o3'), types.SimpleNamespace(A1_INITIAL_SHA256='ab' * 32), C, types.SimpleNamespace(node='/n'))

    def test_timeout_is_a_tempfail_with_nothing_verified(self):
        C, calls = self.fake(False); t = pathlib.Path(tempfile.mkdtemp(prefix='ao-')); self.addCleanup(shutil.rmtree, t, True)
        rc, r = AO.run(str(t / 'o'), types.SimpleNamespace(A1_INITIAL_SHA256='ab' * 32), C, types.SimpleNamespace(node='/n'))
        self.assertEqual((rc, r['ok'], 'verified' in calls), (75, False, False)); self.assertIn('900', r['error'])

    def test_read_root_is_bounded(self):
        t = pathlib.Path(tempfile.mkdtemp(prefix='ao-')); self.addCleanup(shutil.rmtree, t, True); f = t / 'r'
        f.write_bytes(b'x' * (AO.CAP_RECEIPT + 1)); os.chmod(f, 0o644)
        with patch.object(os, 'geteuid', return_value=os.getuid()):
            pass
        with self.assertRaises(ValueError):
            AO.read_root(f, AO.CAP_RECEIPT)                                 # oversize (or, unprivileged, not uid 0): refused either way

RI = load('release_install_wiring', OV / 'bootstrap/release_install.py')


class HolderGate(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='hg-')); self.addCleanup(shutil.rmtree, self.t, True); (self.t / 'proc').mkdir()

    def proc(self, pid, *argv):
        (self.t / 'proc' / str(pid)).mkdir(); (self.t / 'proc' / str(pid) / 'cmdline').write_bytes(b'\0'.join(a.encode() for a in argv) + b'\0')

    def run_state(self, s, rc=0):
        return lambda *a, **k: types.SimpleNamespace(returncode=rc, stdout=s + '\n', stderr='')

    def test_datadir_idle(self):
        self.proc(10, '/usr/bin/python3', '-I', '/opt/enclave-rpc/chain_service.py', 'el')
        self.assertEqual(HG.datadir_idle(self.run_state('inactive'), str(self.t / 'proc'), me=1)[0], 0)
        for s in ('active', 'activating', 'deactivating'):
            self.assertEqual(HG.datadir_idle(self.run_state(s), str(self.t / 'proc'), me=1)[0], 1, s)
        self.assertEqual(HG.datadir_idle(self.run_state('', 1), str(self.t / 'proc'), me=1)[0], 1, 'undeterminable is not idle')
        self.proc(11, '/opt/enclave-rpc/bin/base', 'snapshot', 'download', '--datadir', '/srv/enclave-base-holder/data')
        self.assertEqual(HG.datadir_idle(self.run_state('inactive'), str(self.t / 'proc'), me=1)[0], 1)
        shutil.rmtree(self.t / 'proc/11'); self.proc(12, '/x/base', 'db', '--datadir=/srv/enclave-base-holder/data')
        self.assertEqual(HG.datadir_idle(self.run_state('failed'), str(self.t / 'proc'), me=1)[0], 1)

    def test_own_datadir_two_passes_no_hardlink_no_symlink_follow(self):
        d = self.t / 'data'; (d / 'db').mkdir(parents=True); (d / 'db/mdbx.dat').write_bytes(b'x'); (d / 'static').mkdir()
        os.symlink('/etc/passwd', d / 'static/link'); calls = []
        pw = lambda u: types.SimpleNamespace(pw_uid=4242, pw_gid=4242)
        rc, msg = HG.own_datadir(str(d), chown=lambda q, u, g: calls.append(q), getpw=pw)
        self.assertEqual(rc, 0, msg)
        self.assertEqual(sorted(calls), sorted(str(x) for x in (d, d / 'db', d / 'db/mdbx.dat', d / 'static', d / 'static/link')))
        os.link(d / 'db/mdbx.dat', self.t / 'outside'); calls.clear()
        rc, msg = HG.own_datadir(str(d), chown=lambda q, u, g: calls.append(q), getpw=pw)
        self.assertEqual((rc, calls), (1, []), msg)                      # refused BEFORE any change
        self.assertEqual(HG.own_datadir(str(d), chown=lambda *a: None, getpw=lambda u: types.SimpleNamespace(pw_uid=0, pw_gid=0))[0], 1)

    def test_own_datadir_refuses_another_filesystem_before_any_change(self):
        d = self.t / 'data'; (d / 'db').mkdir(parents=True); (d / 'db/mdbx.dat').write_bytes(b'x'); calls = []; real = os.lstat
        def lstat(q):                                                   # fixture: db/ is a mount point (another st_dev)
            st = real(q)
            if str(q) == str(d / 'db'):
                return types.SimpleNamespace(st_dev=st.st_dev + 1, st_mode=st.st_mode, st_uid=st.st_uid, st_gid=st.st_gid, st_nlink=st.st_nlink)
            return st
        rc, msg = HG.own_datadir(str(d), chown=lambda q, u, g: calls.append(q), getpw=lambda u: types.SimpleNamespace(pw_uid=4242, pw_gid=4242), lstat=lstat)
        self.assertEqual((rc, calls), (1, []), msg); self.assertIn('another filesystem', msg)

    def test_wait_l1_is_bounded(self):
        clock = [0.0]; seq = iter([1, 1, 0])
        run = lambda *a, **k: types.SimpleNamespace(returncode=next(seq), stdout='', stderr='not synced')
        self.assertEqual(HG.wait_l1(600, run, sleep=lambda s: clock.__setitem__(0, clock[0] + s), clock=lambda: clock[0])[0], 0)
        clock[0] = 0.0; never = lambda *a, **k: types.SimpleNamespace(returncode=1, stdout='', stderr='not synced')
        rc, msg = HG.wait_l1(60, never, sleep=lambda s: clock.__setitem__(0, clock[0] + s), clock=lambda: clock[0])
        self.assertEqual(rc, 1); self.assertLessEqual(clock[0], 60)


class ReleaseInstall(unittest.TestCase):
    REL, BIN = b'release-bytes', b'harness-bytes'

    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='ri-')); self.addCleanup(shutil.rmtree, self.root, True); self.uid = os.getuid()
        os.chmod(self.root, 0o755)
        for d in ('opt', 'opt/enclave-rpc', 'opt/enclave-rpc/bin', 'var', 'var/lib', 'var/lib/enclave-rpc', 'stage'):
            (self.root / d).mkdir(mode=0o755); os.chmod(self.root / d, 0o755)
        (self.root / 'opt/enclave-rpc/bin/base').write_bytes(self.BIN); self.src = self.root / 'stage/base'; self.src.write_bytes(self.REL)
        self.m = self.root / 'opt/enclave-rpc/manifest.json'
        self.m.write_text(json.dumps({'mounts': {'base': '/srv/enclave-base-holder'}, 'binaries': {'base': sha(self.BIN), 'reth': 'cd' * 32}, 'baseRelease': None}))
        os.chmod(self.m, 0o644)
        for k, v in (('BASE_RELEASE_SHA256', sha(self.REL)), ('HARNESS_BINARY_SHA256', sha(self.BIN))):
            p = patch.object(RI, k, v); p.start(); self.addCleanup(p.stop)
        self.kw = dict(root=str(self.root), owner=self.uid)
        self.ok = lambda: (0, ''); self.busy = lambda: (1, 'download active')

    def code(self, fn, *a, **k):
        with self.assertRaises(RI.Refused) as e:
            fn(*a, **k)
        return str(e.exception)

    def switch(self, **k):
        return RI.switch_manifest(**self.kw, commit=True, idle=self.ok, holder=self.ok, **k)

    def test_release_placement_never_overwrites(self):
        self.assertEqual(RI.place_release(self.src, **self.kw)['release'], 'dry-run')
        self.assertFalse((self.root / RI.BASE_RELEASE_PATH.lstrip('/')).exists())
        self.assertEqual(RI.place_release(self.src, **self.kw, commit=True)['release'], 'placed')
        dest = self.root / RI.BASE_RELEASE_PATH.lstrip('/'); self.assertEqual(stat.S_IMODE(os.stat(dest).st_mode), 0o555)
        self.assertEqual(RI.place_release(self.src, **self.kw, commit=True)['release'], 'present')
        os.chmod(dest, 0o755); dest.write_bytes(b'other'); os.chmod(dest, 0o555)
        self.assertIn('never overwritten', self.code(RI.place_release, self.src, **self.kw, commit=True)); self.assertEqual(dest.read_bytes(), b'other')
        with patch.object(RI, 'release_ok', return_value=False):          # a destination appearing after the check: link refuses
            self.assertIn('concurrently', self.code(RI.place_release, self.src, **self.kw, commit=True))
        self.assertEqual(dest.read_bytes(), b'other'); self.assertEqual(list(dest.parent.glob('.base.partial-*')), [])
        self.assertEqual((self.root / 'opt/enclave-rpc/bin/base').read_bytes(), self.BIN, 'bin/base is never touched')

    def test_secure_refuses_special_linked_writable_and_symlinked_paths(self):
        RI.place_release(self.src, **self.kw, commit=True)
        os.link(self.m, self.root / 'stage/m2'); self.assertIn('single-link', self.code(self.switch)); os.unlink(self.root / 'stage/m2')
        os.chmod(self.root / 'opt', 0o775); self.assertIn('writable', self.code(self.switch)); os.chmod(self.root / 'opt', 0o755)
        b = self.m.read_bytes(); self.m.unlink(); os.mkfifo(self.m); self.assertIn('regular', self.code(self.switch)); self.m.unlink(); self.m.write_bytes(b)
        os.chmod(self.m, 0o644)
        (self.root / 'opt/real').mkdir(); os.rename(self.root / 'opt/enclave-rpc', self.root / 'opt/real/e'); os.symlink('real/e', self.root / 'opt/enclave-rpc')
        self.assertIn('symlink', self.code(self.switch))

    def test_manifest_switch_needs_release_and_quiet_datadir(self):
        self.assertIn('not placed', self.code(self.switch)); RI.place_release(self.src, **self.kw, commit=True)
        self.assertIn('in use', self.code(RI.switch_manifest, **self.kw, commit=True, idle=self.busy, holder=self.ok))
        self.assertIn('in use', self.code(RI.switch_manifest, **self.kw, commit=True, idle=self.ok, holder=self.busy))
        self.assertFalse((self.root / RI.JOURNAL_DIR.lstrip('/')).exists(), 'a refusal writes nothing')
        r = self.switch(); doc = json.loads(self.m.read_text())
        self.assertEqual((doc['binaries']['base'], doc['baseRelease']['sha256'], doc['binaries']['reth']), (sha(self.REL), sha(self.REL), 'cd' * 32))
        self.assertEqual(stat.S_IMODE(os.stat(self.m).st_mode), 0o644); self.assertEqual(self.switch()['manifest'], 'already release mode')
        self.assertIn('in use', self.code(RI.revert_manifest, r['journal'], **self.kw, commit=True, idle=self.busy, holder=self.ok))
        self.assertEqual(json.loads(self.m.read_text())['baseRelease']['sha256'], sha(self.REL))
        RI.revert_manifest(r['journal'], **self.kw, commit=True, idle=self.ok, holder=self.ok)
        self.assertIsNone(json.loads(self.m.read_text())['baseRelease'])
        self.assertEqual((self.root / 'opt/enclave-rpc/bin/base').read_bytes(), self.BIN)

    def test_crash_points_recover_to_old_or_new_bytes(self):
        RI.place_release(self.src, **self.kw, commit=True); old = self.m.read_bytes()
        for point, want in (('after-journal', 'aborted'), ('after-backup', 'aborted'), ('after-replace', 'committed')):
            with self.subTest(point=point):
                def boom():
                    raise KeyboardInterrupt(point)
                with self.assertRaises(KeyboardInterrupt):
                    self.switch(hooks={point: boom})
                if want == 'aborted':
                    self.assertEqual(self.m.read_bytes(), old, 'the manifest is untouched before the replace')
                self.assertIn('recover first', self.code(self.switch))
                self.assertEqual([x['state'] for x in RI.recover(**self.kw)['recovered']], [want])      # dry run changes nothing
                self.assertEqual([x['state'] for x in RI.recover(**self.kw, commit=True)['recovered']], [want])
                self.assertEqual(RI.open_journals(str(self.root), self.uid), [])
                if want == 'committed':
                    self.assertIsNotNone(json.loads(self.m.read_text())['baseRelease'])
                    self.m.write_bytes(old); os.chmod(self.m, 0o644)                                    # back to legacy for the next point
                self.assertEqual(self.m.read_bytes(), old)
        self.assertFalse(list((self.root / 'opt/enclave-rpc').glob('.manifest.json.partial-*')))


class Units(unittest.TestCase):
    def kv(self, p):
        out = {}
        for l in pathlib.Path(p).read_text().splitlines():
            if l and not l.startswith(('#', '[')):
                k, v = l.split('=', 1); out.setdefault(k, []).append(v)
        return out

    def test_release_drop_in_changes_identity_and_adds_only_the_journal_paths(self):
        d = self.kv(OV / 'units/enclave-base-holder.service.d/60-release-mode.conf')
        self.assertEqual((d['User'], d['Group'], d['Environment']), (['root'], ['root'], ['ENCLAVE_BASE_LAUNCH_HANDSHAKE=1']))
        self.assertEqual(d['ReadWritePaths'], ['/etc/enclave-rpc/base-bootstrap/journal /etc/enclave-rpc/base-bootstrap/journal.lock'])
        self.assertEqual(set(d), {'User', 'Group', 'Environment', 'CapabilityBoundingSet', 'ReadWritePaths', 'InaccessiblePaths',
                                  'ExecCondition', 'ExecStartPre', 'TimeoutStartSec'}, 'no resource cap, sandbox, network or restart key is touched')
        self.assertEqual(d['ExecCondition'], ['/usr/bin/python3 -I -B /opt/enclave-rpc/bootstrap/holder_gate.py datadir-idle'])
        self.assertEqual([x.split()[-1] for x in d['ExecStartPre']], ['own-datadir', '3600'])
        self.assertTrue(all(x.startswith('/usr/bin/python3 -I -B /opt/enclave-rpc/bootstrap/holder_gate.py ') for x in d['ExecStartPre']))
        self.assertEqual(W.HANDSHAKE_ENV, 'ENCLAVE_BASE_LAUNCH_HANDSHAKE')

    def test_reproof_creates_the_status_runtime_dir_exactly_as_the_status_unit(self):
        rp = self.kv(OV / 'units/enclave-base-finality-reproof.service')
        st = self.kv(pathlib.Path(os.environ['R12_UNITS']) / 'enclave-base-finality-status.service')
        for k in ('RuntimeDirectory', 'RuntimeDirectoryMode', 'RuntimeDirectoryPreserve'):
            self.assertEqual(rp[k], st[k], k)
        self.assertEqual((rp['User'], rp['Requisite']), (['root'], ['enclave-base-holder.service']))


if __name__ == '__main__':
    unittest.main(verbosity=2)
