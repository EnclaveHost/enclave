"""Local tests of distribution-bootstrap native/run-native.py (no network: ssh/scp on PATH are recording fakes; execute() gets a
fake transport and a temp record directory, so no real attempt/result file is ever created in the package)."""
import hashlib, importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest
N = pathlib.Path(__file__).resolve().parent.parent; B = N.parent; W = next(p for p in N.parents if p.name == 'work')
spec = importlib.util.spec_from_file_location('driver', N / 'run-native.py'); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
sha = lambda p: hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
class Plan(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='bs-driver-')); (self.t / 'bin').mkdir()
        for tool in ('ssh', 'scp'):
            f = self.t / 'bin' / tool; f.write_text(f'#!/bin/sh\necho {tool} >> "{self.t}/called"\nexit 99\n'); f.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{self.t / 'bin'}:{os.environ['PATH']}")
        self.assertFalse((N / d.ATTEMPT).exists())
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)
    def drv(self, *a): return subprocess.run([sys.executable, '-B', str(N / 'run-native.py'), *a], capture_output=True, text=True, env=self.env, timeout=60)
    def quiet(self): self.assertFalse((self.t / 'called').exists()); self.assertFalse((N / d.ATTEMPT).exists()); self.assertFalse((N / d.RESULT).exists())
    def test_plan_only(self):
        c = self.drv(); self.assertEqual(c.returncode, 0, c.stdout + c.stderr); p = json.loads(c.stdout)
        self.assertTrue(p['mode'].startswith('PLAN ONLY')); self.assertEqual(p['localMismatches'], {}); self.assertEqual(len(p['manifest']['files']), 15)
        self.assertTrue(all(v < d.ENCODED_LIMIT for v in p['encodedSizes'].values()), p['encodedSizes']); self.quiet()
    def test_execute_needs_the_reviewed_manifest(self):
        for a in (['--execute'], ['--execute', '--root-reviewed', '0' * 64]):
            c = self.drv(*a); self.assertEqual(c.returncode, 2); self.assertIn('root-reviewed', c.stdout); self.quiet()
    def test_stage_is_the_reviewed_sources(self):
        S = d.STAGE_DIR
        self.assertEqual(sha(S / 'repo/windows/installer/EnclaveSetup.cs'), sha(B / 'src/EnclaveSetup.cs'))
        self.assertEqual(d.FILES['repo/windows/installer/install-host.ps1'][:8], '1d1580c8'); self.assertEqual(d.FILES['repo/windows/installer/update-host.ps1'][:8], '36f9e0d6')
        self.assertEqual(d.FILES['repo/windows/node/release-channel.mjs'][:8], 'f690c29b')
        fx = (S / 'native-bootstrap.ps1').read_text()
        for f, h in d.FILES.items():
            if f != 'native-bootstrap.ps1': self.assertIn(f"'{f.replace('/', chr(92))}' = '{h}'", fx, f)   # the fixture pins the other 14
    def test_fixture_refuses_outside_ps51(self):
        c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(d.STAGE_DIR / 'native-bootstrap.ps1'), '-Stage', str(self.t)], capture_output=True, text=True, timeout=60)
        self.assertEqual(c.returncode, 4, c.stdout + c.stderr); self.assertIn('not Windows PowerShell 5.1 Desktop', c.stdout)
class Execute(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='bs-exec-')); self.s = self.t / 'stage'; self.r = self.t / 'rec'; self.r.mkdir()
        shutil.copytree(d.STAGE_DIR, self.s); self.calls = []; self.scps = []
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)
    def fake(self, validation=None, created=True, gone=True):
        test = self
        class M:
            HEAD = d.load_transport().HEAD
            def ps(self, text, secs):
                test.assertTrue((test.r / d.ATTEMPT).exists(), 'attempt file must exist before ANY remote call')
                kind = 'create' if 'New-Item' in text else 'cleanup' if 'Remove-Item' in text else 'validate'
                test.calls.append((kind, secs, text))
                if kind == 'create': return {'created': text.split("'")[1]} if created else {'error': 'no output (ssh rc 255)'}
                if kind == 'validate': return validation if validation is not None else {'pass': True}
                return {'gone': gone}
        return M()
    def scp(self, local, remote): self.scps.append((str(pathlib.Path(local).relative_to(self.s)), remote))
    def run_(self, **k): return d.execute(self.fake(**k), self.scp, d=self.s, rec=self.r)
    def test_order_layout_pins_cleanup(self):
        r, ok = self.run_(); self.assertTrue(ok, r)
        self.assertEqual([c[0] for c in self.calls], ['create', 'validate', 'cleanup'])
        st = r['stage']; self.assertTrue(st.startswith('C:\\ProgramData\\Enclave\\staging\\distribution-bootstrap-native-'))
        for dd in ('repo', 'repo\\windows\\installer', 'repo\\test\\windows-native', 'repo\\windows\\tray', 'repo\\windows\\node', 'repo\\cli'): self.assertIn(f"($s+'\\{dd}')", self.calls[0][2])
        self.assertEqual(sorted(n for n, _ in self.scps), sorted(d.FILES))
        self.assertTrue(all(rem == 'minipc:/' + st.replace('\\', '/') + '/' + n for n, rem in self.scps))
        v = self.calls[1][2]; self.assertIn(f"-ne {len(d.FILES)}){{throw 'stage file count differs'}}", v); self.assertIn(d.FILES['native-bootstrap.ps1'], v)
        self.assertIn("native-bootstrap.ps1') -Stage $s", v); self.assertEqual(self.calls[1][1], d.VALIDATE_SECS)
        self.assertFalse((N / d.ATTEMPT).exists())
    def test_failed_validation_cleans_and_fails(self):
        r, ok = self.run_(validation={'error': 'ssh rc 1', 'result': {'pass': False}}); self.assertFalse(ok); self.assertEqual(self.calls[-1][0], 'cleanup')
    def test_unverified_cleanup_is_not_ok(self):
        r, ok = self.run_(gone=False); self.assertFalse(ok)
    def test_unconfirmed_create_uploads_nothing(self):
        r, ok = self.run_(created=False); self.assertFalse(ok); self.assertEqual([c[0] for c in self.calls], ['create', 'cleanup']); self.assertEqual(self.scps, [])
    def test_existing_attempt_refuses_before_any_call(self):
        (self.r / d.ATTEMPT).write_text('{}')
        with self.assertRaises(FileExistsError): self.run_()
        self.assertEqual(self.calls, [])
    def test_tampered_byte_detected(self):
        p = self.s / 'repo/windows/installer/EnclaveSetup.cs'; p.write_bytes(p.read_bytes() + b' '); self.assertIn('repo/windows/installer/EnclaveSetup.cs', d.check_local(self.s))
    def test_cleanup_refuses_foreign_paths(self):
        with self.assertRaises(AssertionError): d.texts(r'C:\ProgramData\Enclave')
        with self.assertRaises(AssertionError): d.texts(r'C:\ProgramData\Enclave\staging\updater-first-hop-r4-native-000000000000')
if __name__ == '__main__': unittest.main()
