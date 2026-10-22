"""r4: the EXACT validate/cleanup texts of run-native.py executed by pwsh 7 on Linux against REAL own processes (NOT Windows evidence).
Only Get-CimInstance (exact-PID lookup, answered from the real process table), FileSha (the transport HEAD's) and, per case,
Get-ExecutionPolicy / Stop-Process are stubbed; 'powershell.exe' is a fake on PATH (refuses like a PSSecurityException, hangs, or passes).
Every process a case starts is killed in tearDown, whatever happens."""
import importlib.util, json, os, pathlib, shutil, signal, subprocess, tempfile, time, unittest
N = pathlib.Path(__file__).resolve().parent.parent; PWSH = os.environ['PWSH']
spec = importlib.util.spec_from_file_location('driver', N / 'run-native.py'); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
PRE = (r"$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
       r"function FileSha($f){if(Test-Path -LiteralPath $f){(Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()}else{'absent'}};"
       r"function Get-CimInstance{param($ClassName,$Filter,$OperationTimeoutSec)if($Filter -match '^ProcessId=(\d+)$'){$p=Get-Process -Id ([int]$matches[1]) -ErrorAction SilentlyContinue;"
       r"if($p){[pscustomobject]@{ProcessId=$p.Id;CreationDate=$p.StartTime}}}else{throw 'mock: only exact-PID queries are allowed'}};")
FAKES = {'refuse': "#!/bin/sh\necho 'File x.ps1 cannot be loaded because running scripts is disabled on this system. PSSecurityException' >&2\nexit 1\n",
         'hang': "#!/bin/sh\nexec sleep 300\n", 'pass': "#!/bin/sh\necho '{\"pass\":true,\"fake\":1}'\nexit 0\n"}
alive = lambda pid: os.path.exists(f'/proc/{pid}') and open(f'/proc/{pid}/stat').read().split(')')[1].split()[0] != 'Z'
class Texts(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='native-text-')); self.root = str(self.t / 'staging'); os.mkdir(self.root)
        self.stage = self.root + '\\' + d.PREFIX + 'abcdef012345'    # the driver's Windows join; PowerShell on Linux maps '\' to '/'
        self.real = pathlib.Path(self.root) / (d.PREFIX + 'abcdef012345'); self.real.mkdir()
        for f in d.FILES: shutil.copy2(N / f, self.real / f)
        self.pids = []
    def tearDown(self):
        for p in self.pids:
            try: os.kill(p, signal.SIGKILL)
            except ProcessLookupError: pass
        shutil.rmtree(self.t, ignore_errors=True)
    def ps(self, which, extra='', fake=None, wait=(2, 2), fixture_ms=3000):
        b = self.t / 'bin'; b.mkdir(exist_ok=True); env = dict(os.environ)
        if fake: (b / 'powershell.exe').write_text(FAKES[fake]); (b / 'powershell.exe').chmod(0o755); env['PATH'] = f"{b}:{env['PATH']}"
        f = self.t / f'{which}.ps1'; f.write_text(PRE + extra + d.texts(self.stage, root=self.root, wait=wait, fixture_ms=fixture_ms)[which])
        c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(f)], capture_output=True, text=True, timeout=120, env=env)
        out = [l for l in c.stdout.splitlines() if l.startswith('{')]
        return (json.loads(out[-1]) if out else None), c
    def reg(self):
        g = self.real / 'owned.jsonl'
        return [json.loads(l) for l in g.read_text().splitlines() if l.startswith('{')] if g.exists() else []
    def test_policy_refused_before_launch(self):
        r, c = self.ps('validate', "function Get-ExecutionPolicy{'Restricted'};", fake='pass')
        self.assertEqual(c.returncode, 7, c.stderr); self.assertEqual(r, {'refused': 'execution-policy', 'executionPolicy': 'Restricted', 'launched': False})
        self.assertEqual(self.reg(), [], 'nothing was launched')
    def test_policy_refusal_at_launch_is_recorded_not_worked_around(self):
        r, c = self.ps('validate', fake='refuse'); self.assertEqual(c.returncode, 7, c.stderr)
        self.assertEqual((r['refused'], r['launched'], r['executionPolicy']), ('execution-policy', True, 'Unrestricted'))
        self.assertEqual(len(self.reg()), 1)
    def test_passing_fixture_output_is_relayed(self):
        r, c = self.ps('validate', fake='pass'); self.assertEqual(c.returncode, 0, c.stderr); self.assertEqual(r, {'pass': True, 'fake': 1})
        r, c = self.ps('cleanup'); self.assertTrue(r['gone']); self.assertFalse(self.real.exists())
    def test_hung_fixture_times_out_then_cleanup_stops_exactly_it_and_deletes(self):
        t0 = time.time(); r, c = self.ps('validate', fake='hang'); self.assertEqual(c.returncode, 8, c.stderr); self.assertTrue(r['timeout'])
        self.assertLess(time.time() - t0, 30); pid = r['fixturePid']; self.pids.append(pid); self.assertTrue(alive(pid))
        self.assertEqual([x['pid'] for x in self.reg()], [pid])
        foreign = subprocess.Popen(['sleep', '300']); self.pids.append(foreign.pid)
        r, c = self.ps('cleanup'); self.assertTrue(r['gone'], (r, c.stderr)); self.assertEqual(r['stopped'], [f'fixture-host:{pid}'])
        self.assertFalse(alive(pid)); self.assertFalse(self.real.exists()); self.assertTrue(alive(foreign.pid), 'an unregistered process is never touched')
    def test_unkillable_registered_child_keeps_the_stage(self):
        r, c = self.ps('validate', fake='hang'); pid = r['fixturePid']; self.pids.append(pid)
        r, c = self.ps('cleanup', "function Stop-Process{param($Id,[switch]$Force)};")
        self.assertIs(r['gone'], False, (r, c.stderr)); self.assertEqual(r['unconfirmed'], [f'fixture-host:{pid}']); self.assertIn('kept', r)
        self.assertTrue(self.real.exists(), 'the stage is kept until its own processes are confirmed gone'); self.assertTrue(alive(pid))
    def test_pid_reuse_and_unknown_start(self):
        other = subprocess.Popen(['sleep', '300']); self.pids.append(other.pid)
        g = self.real / 'owned.jsonl'
        g.write_text(json.dumps({'role': 'edit', 'pid': other.pid, 'start': '2020-01-01T00:00:00.0000000Z'}) + '\n')   # same PID, different start = not ours
        r, c = self.ps('cleanup'); self.assertTrue(r['gone'], (r, c.stderr)); self.assertEqual(r['stopped'], []); self.assertTrue(alive(other.pid))
        self.real.mkdir(); g.write_text(json.dumps({'role': 'fixture', 'pid': other.pid, 'start': 'unknown'}) + '\n')    # identity unknown: never stopped, never deleted
        r, c = self.ps('cleanup'); self.assertIs(r['gone'], False, (r, c.stderr)); self.assertEqual(r['stopped'], []); self.assertTrue(alive(other.pid)); self.assertTrue(self.real.exists())
    def test_cleanup_failure_is_an_error_not_gone(self):
        (self.real / 'owned.jsonl').write_text(json.dumps({'role': 'fixture', 'pid': os.getpid(), 'start': '2020-01-01T00:00:00Z'}) + '\n')
        r, c = self.ps('cleanup', "function Get-CimInstance{throw 'mock: WMI unavailable'};")
        self.assertNotEqual(c.returncode, 0); self.assertTrue(r is None or r.get('gone') is not True); self.assertTrue(self.real.exists())
if __name__ == '__main__': unittest.main()
