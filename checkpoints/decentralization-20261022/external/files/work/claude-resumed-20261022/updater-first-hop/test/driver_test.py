"""Local tests of src/run-first-hop.py (no network: ssh/scp on PATH are recording fakes; execute() gets a fake transport)."""
import importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile, unittest
S = pathlib.Path(__file__).resolve().parent.parent / 'src'
spec = importlib.util.spec_from_file_location('driver', S / 'run-first-hop.py'); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
class Cli(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='fh-driver-')); (self.t / 'bin').mkdir()
        for tool in ('ssh', 'scp'):
            f = self.t / 'bin' / tool; f.write_text(f'#!/bin/sh\necho {tool} >> "{self.t}/called"\nexit 99\n'); f.chmod(0o755)
        self.env = dict(os.environ, PATH=f"{self.t / 'bin'}:{os.environ['PATH']}")
        self.assertEqual(list(S.glob('attempt-*')) + list(S.glob('result-*')), [], 'no real attempt/result may exist in src/')
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)
    def drv(self, *a): return subprocess.run([sys.executable, '-B', str(S / 'run-first-hop.py'), *a], capture_output=True, text=True, env=self.env, timeout=60)
    def quiet(self): self.assertFalse((self.t / 'called').exists()); self.assertEqual(list(S.glob('attempt-*')), [])
    def test_plan_only(self):
        c = self.drv(); self.assertEqual(c.returncode, 0, c.stdout + c.stderr); p = json.loads(c.stdout)
        self.assertTrue(p['mode'].startswith('PLAN ONLY')); self.assertEqual(p['localMismatches'], {}); self.assertEqual(p['manifestSha'], d.manifest_sha())
        self.assertTrue(all(v < d.ENCODED_LIMIT for v in p['encodedSizes'].values()), p['encodedSizes']); self.quiet()
    def test_token_and_runid_gates(self):
        for a in (['--mode', 'check'], ['--mode', 'apply', '--root-reviewed', '0' * 64], ['--mode', 'rollback', '--root-reviewed', d.manifest_sha()],
                  ['--mode', 'rollback', '--root-reviewed', d.manifest_sha(), '--run-id', '20261022000000-00000000'],
                  ['--mode', 'apply', '--root-reviewed', d.manifest_sha(), '--run-id', '20261022000000-00000000']):
            c = self.drv(*a); self.assertEqual(c.returncode, 2, (a, c.stdout)); self.quiet()
    def test_pins(self):
        self.assertEqual(d.FILES['update-host.first-hop.ps1'][:8], '36f9e0d6'); self.assertEqual(d.LIVE[:8], 'e0d9df1c')
        fh = (S / 'first-hop.ps1').read_text()
        self.assertIn(d.LIVE, fh); self.assertIn(d.FILES['update-host.first-hop.ps1'], fh); self.assertEqual(d.check_local(), {})
class Execute(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='fh-exec-'))
        for f in d.FILES: shutil.copy2(S / f, self.t / f)
        self.calls = []; self.scps = []
    def tearDown(self): shutil.rmtree(self.t, ignore_errors=True)
    def fake(self, result=None, created=True, gone=True):
        test = self
        class M:
            HEAD = d.load_transport().HEAD
            def ps(self, text, secs):
                test.assertTrue(list(test.t.glob('attempt-*')), 'attempt file must exist before ANY remote call')
                kind = 'create' if 'New-Item' in text else 'cleanup' if 'Remove-Item' in text else 'run'
                test.calls.append((kind, secs, text))
                if kind == 'create': return {'created': text.split("'")[1]} if created else {'error': 'no output (ssh rc 255)'}
                if kind == 'run': return result if result is not None else {'ok': True, 'exit': 0}
                return {'gone': gone}
        return M()
    def scp(self, local, remote): self.scps.append((pathlib.Path(local).name, remote))
    def test_apply_order_pins_and_cleanup(self):
        rid = d.new_run_id(); r, ok = d.execute(self.fake(), self.scp, 'apply', rid, d=self.t); self.assertTrue(ok, r)
        self.assertEqual([c[0] for c in self.calls], ['create', 'run', 'cleanup']); self.assertTrue((self.t / 'attempt-apply.json').exists())
        self.assertTrue(r['stage'].startswith('C:\\ProgramData\\Enclave\\staging\\updater-first-hop-'))
        self.assertTrue(all(rem.startswith('minipc:/C:/ProgramData/Enclave/staging/updater-first-hop-') for _, rem in self.scps)); self.assertEqual(sorted(n for n, _ in self.scps), sorted(d.FILES))
        run = self.calls[1][2]
        for h in d.FILES.values(): self.assertIn(f"'{h}'", run)
        self.assertIn(f"-Mode Apply -Stage $s -WindowSec 600 -RunId '{rid}'", run); self.assertIn("System32\\WindowsPowerShell\\v1.0\\powershell.exe", run)
        self.assertEqual(self.calls[1][1], d.SECS['apply'])
    def test_second_apply_refused_before_any_call(self):
        (self.t / 'attempt-apply.json').write_text('{}')
        with self.assertRaises(FileExistsError): d.execute(self.fake(), self.scp, 'apply', d.new_run_id(), d=self.t)
        self.assertEqual(self.calls, []); self.assertEqual(self.scps, [])
    def test_refusal_or_wrapped_error_is_not_ok_and_cleans(self):
        for res in ({'ok': False, 'exit': 1}, {'error': 'ssh rc 2', 'result': {'ok': False, 'exit': 2}}, {'error': 'ssh rc 3', 'result': {'ok': True, 'exit': 0}}):
            self.calls = []; [p.unlink() for p in self.t.glob('attempt-*')]
            r, ok = d.execute(self.fake(result=res), self.scp, 'apply', d.new_run_id(), d=self.t); self.assertFalse(ok, res); self.assertEqual(self.calls[-1][0], 'cleanup')
    def test_unverified_cleanup_is_not_ok(self):
        r, ok = d.execute(self.fake(gone=False), self.scp, 'check', '', d=self.t); self.assertFalse(ok)
    def test_unconfirmed_create_cleans_and_uploads_nothing(self):
        r, ok = d.execute(self.fake(created=False), self.scp, 'apply', d.new_run_id(), d=self.t)
        self.assertFalse(ok); self.assertEqual([c[0] for c in self.calls], ['create', 'cleanup']); self.assertEqual(self.scps, [])
    def test_texts_refuse_foreign_stage_and_bad_runid(self):
        with self.assertRaises(AssertionError): d.texts(r'C:\ProgramData\Enclave', 'check')
        with self.assertRaises(AssertionError): d.texts(d.new_stage(), 'apply', 'x')
        with self.assertRaises(AssertionError): d.texts(d.new_stage(), 'check', '20261022000000-00000000')
    def test_tampered_bytes(self):
        p = self.t / 'update-host.first-hop.ps1'; p.write_bytes(p.read_bytes() + b' '); self.assertIn('update-host.first-hop.ps1', d.check_local(self.t))
if __name__ == '__main__': unittest.main()
