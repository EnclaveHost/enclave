"""Local assembly tests of run-native.py (no network: ssh/scp on PATH are recording fakes; execute() gets a fake transport)."""
import importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest
N = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('driver', N / 'run-native.py'); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
class Fakes(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='native-driver-')); (self.t / 'bin').mkdir()
        for tool in ('ssh', 'scp'):
            f = self.t / 'bin' / tool; f.write_text(f'#!/bin/sh\necho {tool} >> "{self.t}/called"\nexit 99\n'); f.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{self.t / 'bin'}:{os.environ['PATH']}")
        self.assertFalse((N / d.ATTEMPT).exists(), 'a real attempt file must never exist in the package directory during tests')
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)
    def drv(self, *a): return subprocess.run([sys.executable, str(N / 'run-native.py'), *a], capture_output=True, text=True, env=self.env, timeout=60)
    def no_side_effects(self):
        self.assertFalse((self.t / 'called').exists(), 'ssh/scp was invoked'); self.assertFalse((N / d.ATTEMPT).exists()); self.assertFalse((N / d.RESULT).exists())
    def test_default_is_plan_only(self):
        c = self.drv(); self.assertEqual(c.returncode, 0, c.stdout + c.stderr); p = json.loads(c.stdout)
        self.assertTrue(p['mode'].startswith('PLAN ONLY')); self.assertEqual(p['localMismatches'], {}); self.assertEqual(len(p['manifest']['files']), 5)
        self.assertEqual(p['manifestSha'], d.manifest_sha()); self.assertTrue(all(v < d.ENCODED_LIMIT for v in p['encodedSizes'].values()), p['encodedSizes'])
        self.no_side_effects()
    def test_execute_requires_the_reviewed_manifest(self):
        for args in (['--execute'], ['--execute', '--root-reviewed', '0' * 64]):
            c = self.drv(*args); self.assertEqual(c.returncode, 2); self.assertIn('root-reviewed', c.stdout); self.no_side_effects()
class Execute(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='native-exec-'))
        for f in d.FILES: shutil.copy2(N / f, self.t / f)
        self.calls = []; self.scps = []
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)
    def fake(self, validation=None, created=True):
        test = self
        class M:
            HEAD = d.load_transport().HEAD
            def ps(self, text, secs):
                test.assertTrue((test.t / d.ATTEMPT).exists(), 'attempt file must exist before ANY remote call')
                kind = 'create' if 'New-Item' in text else 'cleanup' if 'Remove-Item' in text else 'validate'
                test.calls.append((kind, secs, text))
                if kind == 'create': return {'created': text.split("'")[1]} if created else {'error': 'no output (ssh rc 255)'}
                if kind == 'validate': return validation if validation is not None else {'pass': True}
                return {'gone': True}
        return M()
    def scp(self, local, remote): self.scps.append((pathlib.Path(local).name, remote))
    def test_order_pins_and_cleanup(self):
        r, ok = d.execute(self.fake(), self.scp, d=self.t); self.assertTrue(ok, r)
        self.assertEqual([c[0] for c in self.calls], ['create', 'validate', 'cleanup'])
        self.assertTrue(r['stage'].startswith('C:\\ProgramData\\Enclave\\staging\\cutover-review-native-')); self.assertEqual(len(r['stage'].rsplit('-', 1)[1]), 12)
        self.assertEqual(sorted(n for n, _ in self.scps), sorted(d.FILES))
        self.assertTrue(all(rem.startswith('minipc:/C:/ProgramData/Enclave/staging/cutover-review-native-') for _, rem in self.scps))
        v = self.calls[1][2]; self.assertEqual(self.calls[1][1], d.VALIDATE_SECS)
        for f, h in d.FILES.items(): self.assertIn(f"'{h}'", v)
        self.assertIn("-ne 5){throw 'stage file count differs'}", v); self.assertIn("native-test.ps1') -Stage $s", v)
        self.assertEqual(json.loads((self.t / d.RESULT).read_text())['cleanup'], {'gone': True})
    def test_failed_validation_still_cleans(self):
        r, ok = d.execute(self.fake(validation={'error': 'ssh rc 3', 'result': {'pass': False}}), self.scp, d=self.t)
        self.assertFalse(ok); self.assertEqual(self.calls[-1][0], 'cleanup')
    def test_unconfirmed_creation_still_attempts_cleanup_and_uploads_nothing(self):
        r, ok = d.execute(self.fake(created=False), self.scp, d=self.t)
        self.assertFalse(ok); self.assertEqual([c[0] for c in self.calls], ['create', 'cleanup']); self.assertEqual(self.scps, [])
    def test_existing_attempt_refuses_before_any_call(self):
        (self.t / d.ATTEMPT).write_text('{}')
        with self.assertRaises(FileExistsError): d.execute(self.fake(), self.scp, d=self.t)
        self.assertEqual(self.calls, []); self.assertEqual(self.scps, [])
    def test_tampered_byte_is_a_mismatch(self):
        p = self.t / 'cutover.ps1'; p.write_bytes(p.read_bytes() + b' '); self.assertIn('cutover.ps1', d.check_local(self.t))
    def test_cleanup_text_refuses_foreign_paths(self):
        with self.assertRaises(AssertionError): d.texts(r'C:\ProgramData\Enclave')
        self.assertIn("StartsWith('C:\\ProgramData\\Enclave\\staging\\cutover-review-native-')", d.texts(d.new_stage())['cleanup'])
if __name__ == '__main__': unittest.main()
