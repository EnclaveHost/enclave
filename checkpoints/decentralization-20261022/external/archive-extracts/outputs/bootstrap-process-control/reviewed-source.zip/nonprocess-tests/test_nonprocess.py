"""Pure tests of the non-process corrections (no network, no ssh/scp, no fixture run, no process management).
M1/L4: run-native.execute() with a MOCKED transport object and a no-op scp, record dir in a temp folder.
L2: the fixture's exact Quote function text (AST-extracted) evaluated as a pure function by pwsh. L3: static text check."""
import importlib.util, json, pathlib, subprocess, tempfile, unittest
N = pathlib.Path(__file__).resolve().parent.parent / 'native'
spec = importlib.util.spec_from_file_location('drv', N / 'run-native.py'); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
class Transport:
    HEAD = ''
    def __init__(self, validation, cleanup_raises=None, cleanup=None): self.v, self.cr, self.c, self.calls = validation, cleanup_raises, cleanup, []
    def ps(self, text, secs):
        kind = 'create' if 'New-Item' in text else 'cleanup' if 'Remove-Item' in text else 'validate'; self.calls.append(kind)
        if kind == 'create': return {'created': text.split("'")[1]}
        if kind == 'validate':
            if isinstance(self.v, BaseException): raise self.v
            return self.v
        if self.cr: raise self.cr
        return self.c if self.c is not None else {'gone': True}
class M1L4(unittest.TestCase):
    def run_(self, tr):
        rec = pathlib.Path(tempfile.mkdtemp(prefix='np-rec-')); err = None
        try: r, ok = d.execute(tr, lambda local, remote: None, d=N, rec=rec)
        except BaseException as e: r, ok, err = None, None, e
        res = json.loads((rec / d.RESULT).read_text()) if (rec / d.RESULT).exists() else None
        return r, ok, err, res
    PASSV = {'pass': True, 'status': 'PASS', 'childExitUnknown': False}
    def test_cleanup_runtime_error_still_persists_unknown(self):
        r, ok, err, res = self.run_(Transport(self.PASSV, cleanup_raises=RuntimeError('ssh binary missing')))
        self.assertIsNone(err); self.assertFalse(ok); self.assertIsNotNone(res, 'native-result.json must exist')
        self.assertEqual(res['cleanup']['gone'], 'unknown'); self.assertIn('RuntimeError', res['cleanup']['why'])
    def test_cleanup_system_exit_still_persists_unknown(self):
        r, ok, err, res = self.run_(Transport(self.PASSV, cleanup_raises=SystemExit('encoded step too long')))
        self.assertIsNone(err, 'SystemExit from the cleanup call is recorded, not propagated'); self.assertFalse(ok)
        self.assertEqual(res['cleanup']['gone'], 'unknown'); self.assertIn('SystemExit', res['cleanup']['why'])
    def test_validation_system_exit_is_recorded_and_leaves_the_stage(self):
        tr = Transport(SystemExit('watchdog')); r, ok, err, res = self.run_(tr)
        self.assertIsNone(err); self.assertFalse(ok); self.assertIn('SystemExit', res['error'])
        self.assertEqual(res['status'], 'NO-REPORT'); self.assertIn('recovery', res['cleanup'])   # fail closed: nothing removed
        self.assertEqual(tr.calls, ['create', 'validate'], 'no cleanup call while the fixture state is unknown')
    def test_keyboard_interrupt_in_cleanup_persists_then_reraises(self):
        r, ok, err, res = self.run_(Transport(self.PASSV, cleanup_raises=KeyboardInterrupt()))
        self.assertIsInstance(err, KeyboardInterrupt); self.assertIsNotNone(res); self.assertEqual(res['cleanup']['gone'], 'unknown')
    def test_non_dict_cleanup_is_unknown(self):
        r, ok, err, res = self.run_(Transport(self.PASSV, cleanup='garbage')); self.assertFalse(ok); self.assertEqual(res['cleanup']['gone'], 'unknown')
    def test_left_for_recovery_recorded_on_clean_status(self):
        v = {'error': 'ssh rc 3', 'result': {'pass': False, 'status': 'FAIL', 'childExitUnknown': False, 'leftForRecovery': ['C:\\T\\enclave-bootstrap-x']}}
        r, ok, err, res = self.run_(Transport(v)); self.assertFalse(ok)
        self.assertEqual(res['cleanup']['leftForRecovery'], ['C:\\T\\enclave-bootstrap-x']); self.assertTrue(res['cleanup']['gone'])
    def test_pass_with_clean_cleanup_is_ok(self):
        r, ok, err, res = self.run_(Transport(self.PASSV)); self.assertTrue(ok); self.assertNotIn('leftForRecovery', res['cleanup'])
    def test_execute_requires_exact_reviewed_manifest(self):
        self.assertEqual(d.main(['--execute', '--root-reviewed', '0' * 64]), 2)
class L2L3(unittest.TestCase):
    def test_quote_refuses_ambiguous_arguments(self):
        ps = (r"$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile('" + str(N / 'native-bootstrap.ps1') + r"',[ref]$t,[ref]$e);"
              r"$f=$a.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Quote'},$false)|Select-Object -First 1;. ([scriptblock]::Create($f.Extent.Text));"
              r"$o=[ordered]@{plain=(Quote @('/nologo','a b','C:\x y\f.cs'));"
              r"slash=$(try{Quote @('C:\dir with space\');'accepted'}catch{'refused'});quote=$(try{Quote @('say '+[char]34+'hi'+[char]34);'accepted'}catch{'refused'})};$o|ConvertTo-Json -Compress")
        c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-Command', ps], capture_output=True, text=True, timeout=120)
        o = json.loads(c.stdout.strip().splitlines()[-1])
        self.assertEqual(o['plain'], '/nologo "a b" "C:\\x y\\f.cs"'); self.assertEqual(o['slash'], 'refused'); self.assertEqual(o['quote'], 'refused')
    def test_late_output_waits_are_capped_by_the_remaining_budget(self):
        s = (N / 'native-bootstrap.ps1').read_text()
        self.assertNotIn('$h.o.Wait(2000)', s); self.assertIn('$h.o.Wait([int][math]::Min(2000, (HardLeftMs)))', s); self.assertIn('$h.e.Wait([int][math]::Min(1000, (HardLeftMs)))', s)
if __name__ == '__main__': unittest.main(verbosity=2)
