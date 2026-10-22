"""r4 local tests: fixture helper faults (fixture-helpers.ps1) and the positive verbatim sections run (sections-local.ps1), real node
children, pwsh 7 on Linux (NOT Windows evidence)."""
import json, os, pathlib, shutil, subprocess, tempfile, unittest
N = pathlib.Path(__file__).resolve().parent.parent; T = N / 'tools'; PWSH = os.environ['PWSH']; NODE = shutil.which('node')
def run(script, *args):
    c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(T / script), *args], capture_output=True, text=True, timeout=240)
    return [json.loads(l) for l in c.stdout.splitlines() if l.startswith('{')], c
class Helpers(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.s = pathlib.Path(tempfile.mkdtemp(prefix='fixture-helpers-'))
        out, cls.c = run('fixture-helpers.ps1', '-Fixture', str(N / 'native-challenge-test.ps1'), '-Cutover', str(N / 'node-hold-cutover.ps1'), '-Node', NODE, '-Scratch', str(cls.s))
        cls.r = {o['case']: o for o in out}
    @classmethod
    def tearDownClass(cls): shutil.rmtree(cls.s, ignore_errors=True)
    def case(self, k): self.assertIn(k, self.r, self.c.stderr[-800:]); return self.r[k]
    def test_ok(self):
        r = self.case('ok'); self.assertEqual((r['ok'], r['exit'], r['exited'], r['stdoutHasJson'], r['reg'], r['regHasStart']), (True, 0, True, True, 1, True)); self.assertLess(r['sec'], 20)
    def test_timeout_is_killed_and_confirmed_within_the_bound(self):
        r = self.case('timeout'); self.assertEqual((r['ok'], r['timedOut'], r['exited'], r['stdoutNull'], r['procGone']), (False, True, True, True, True)); self.assertLess(r['sec'], 4.8)
    def test_failed_kill_is_bounded_unclaimed_and_retried_by_cleanup(self):
        r = self.case('killfails'); f = r['first']
        self.assertEqual((f['ok'], f['timedOut'], f['exited'], f['stdoutNull'], f['stillRunning']), (False, True, False, True, True)); self.assertIn('NOT confirmed', f['reason'])
        self.assertLess(f['sec'], 4.8, 'no unbounded wait/.Result on a child that did not terminate')
        self.assertIs(r['cleanupWhileFaulty'], False); self.assertIs(r['cleanupAfter'], True); self.assertTrue(r['procGone']); self.assertEqual(r['regFinal'], 2)
    def test_spawn_failure(self):
        r = self.case('spawnfail'); self.assertFalse(r['ok']); self.assertTrue(r['reason'].startswith('spawn failed')); self.assertEqual((r['owned'], r['reg']), (0, 0))
    def test_decoy_spawn_failure_leaves_no_replica(self):
        r = self.case('decoyfail'); self.assertEqual((r['thrown'], r['owned'], r['allExited'], r['replicaGone']), (True, 1, True, True)); self.assertEqual(r['regRoles'], ['replica'])
    def test_deadline_and_quoting(self):
        r = self.case('need'); self.assertTrue(r['needThrew']); self.assertEqual(r['argRefused'], [True, True]); self.assertEqual(r['quoted'], '"C:\\Program Files\\x.mjs" "-e"')
class Sections(unittest.TestCase):
    def test_sections_3_4_5_verbatim_pass(self):
        base = pathlib.Path(tempfile.mkdtemp(prefix='fixture-sections-')); stage = base / 'staging dir' / 'chact-native-0123456789ab'   # a space: argv quoting
        try:
            stage.mkdir(parents=True)
            for f in ('edit-privacy-config.mjs', 'challengeReplica.json'): shutil.copy2(N / f, stage / f)
            out, c = run('sections-local.ps1', '-Dir', str(N), '-Stage', str(stage), '-NodeExe', NODE)
            self.assertEqual(c.returncode, 0, (out, c.stderr[-800:])); r = out[-1]
            self.assertTrue(r['spaceInStage']); self.assertTrue(r['renderOk'] and r['declOk'] and r['idsOk'] and r['allExited'], r)
            self.assertEqual(r['render']['lastTwo'], 'challengeReplica,walletAdmission'); self.assertEqual(r['registered'], ['edit'])
            self.assertEqual([x['case'] for x in r['ids'] if x['expected']], ['normal', 'wrongBinding', 'expiredGrant', 'futureStatus', 'freshFalse', 'freshString', 'walletHeld'])
        finally: shutil.rmtree(base, ignore_errors=True)
if __name__ == '__main__': unittest.main()
