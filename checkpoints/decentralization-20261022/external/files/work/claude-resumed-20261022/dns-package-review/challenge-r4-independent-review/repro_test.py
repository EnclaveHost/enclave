"""Independent repro (Claude, review only). Runs the EXACT validate/cleanup texts of challenge-activation-r4 native/run-native.py
(b6741d88, imported read-only) under Linux pwsh 7 with the SAME stubs as its own tools/native-text-test.py (PRE: exact-PID CIM from the
real process table). NOT Windows evidence. Every process started is killed in tearDown."""
import importlib.util, json, os, pathlib, shutil, signal, subprocess, tempfile, time, unittest
T = pathlib.Path('/home/steven/Documents/Codex/2026-10-18/wo/work/claude-resumed-20261022/cutover-review/challenge-activation-r4/native')
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
spec = importlib.util.spec_from_file_location('driver', T / 'run-native.py'); d = importlib.util.module_from_spec(spec); spec.loader.exec_module(d)
PRE = (r"$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
       r"function FileSha($f){if(Test-Path -LiteralPath $f){(Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()}else{'absent'}};"
       r"function Get-CimInstance{param($ClassName,$Filter,$OperationTimeoutSec)if($Filter -match '^ProcessId=(\d+)$'){$p=Get-Process -Id ([int]$matches[1]) -ErrorAction SilentlyContinue;"
       r"if($p){[pscustomobject]@{ProcessId=$p.Id;CreationDate=$p.StartTime}}}else{throw 'mock: only exact-PID queries are allowed'}};")
alive = lambda pid: os.path.exists(f'/proc/{pid}') and open(f'/proc/{pid}/stat').read().split(')')[1].split()[0] != 'Z'
def iso(pid):   # the process start as the fixture registers it ('o', UTC), from pwsh itself
    return subprocess.run([PWSH, '-NoProfile', '-Command', f"(Get-Process -Id {pid}).StartTime.ToUniversalTime().ToString('o')"], capture_output=True, text=True, timeout=60).stdout.strip()
class Repro(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='chr4-review-')); self.root = str(self.t / 'staging'); os.mkdir(self.root)
        self.stage = self.root + '\\' + d.PREFIX + 'abcdef012345'; self.real = pathlib.Path(self.root) / (d.PREFIX + 'abcdef012345'); self.real.mkdir()
        for f in d.FILES: shutil.copy2(T / f, self.real / f)
        self.pids = []
    def tearDown(self):
        for p in self.pids:
            try: os.kill(p, signal.SIGKILL)
            except ProcessLookupError: pass
        shutil.rmtree(self.t, ignore_errors=True)
    def run_text(self, which, fake=None, wait=(2, 2), fixture_ms=3000):
        env = dict(os.environ)
        if fake:
            b = self.t / 'bin'; b.mkdir(exist_ok=True); (b / 'powershell.exe').write_text(fake); (b / 'powershell.exe').chmod(0o755); env['PATH'] = f"{b}:{env['PATH']}"
        f = self.t / f'{which}.ps1'; f.write_text(PRE + d.texts(self.stage, root=self.root, wait=wait, fixture_ms=fixture_ms)[which])
        c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(f)], capture_output=True, text=True, timeout=120, env=env)
        out = [l for l in c.stdout.splitlines() if l.startswith('{')]
        return (json.loads(out[-1]) if out else None), c
    def test_F1_child_registered_after_cleanup_read_survives_stage_deletion(self):
        # a still-running fixture (e.g. after a validate timeout or a dropped ssh) registers a NEW own child after cleanup read owned.jsonl
        g = self.real / 'owned.jsonl'
        # detached (re-parented to init, as the validate-launched fixture is once validate exits), so a stop is reaped, not a zombie
        fxpid = int(subprocess.run(['sh', '-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], capture_output=True, text=True).stdout); self.pids.append(fxpid); time.sleep(0.5)
        g.write_text(json.dumps({'role': 'fixture', 'pid': fxpid, 'start': iso(fxpid)}) + '\n')
        kidpid = int(subprocess.run(['sh', '-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], capture_output=True, text=True).stdout); self.pids.append(kidpid); time.sleep(0.3); kst = iso(kidpid)
        kid = type('K', (), {'pid': kidpid})
        def late():   # registered 1 s after cleanup starts (cleanup reads rows once, before its 2 s wait)
            time.sleep(1.0)
            with g.open('a') as h: h.write(json.dumps({'role': 'edit', 'pid': kid.pid, 'start': kst}) + '\n')
        import threading; th = threading.Thread(target=late); th.start()
        r, c = self.run_text('cleanup', wait=(4, 2)); th.join()
        print('F1 cleanup:', r)
        self.assertTrue(r and r.get('gone') is True, (r, c.stderr))            # the stage was deleted ...
        self.assertTrue(alive(kid.pid), 'expected: the late-registered own child is still alive after deletion')   # ... while a registered own child lives
        self.assertNotIn(f'edit:{kid.pid}', r.get('stopped', [])); self.assertFalse(alive(fxpid), 'the registered fixture itself was stopped')
    def test_F2_fixture_json_lost_when_a_child_holds_the_inherited_stdout(self):
        # fixture prints its JSON and exits, but a non-redirected own child (as Spawn ... $false does) still holds the inherited stdout pipe
        fake = "#!/bin/sh\nsleep 30 &\necho '{\"pass\":false,\"children\":{\"allExited\":false},\"fixtureReport\":1}'\nexit 3\n"
        t0 = time.time(); r, c = self.run_text('validate', fake=fake, fixture_ms=4000)
        print('F2 validate:', r, round(time.time() - t0, 1), 's')
        for pid in (int(x['pid']) for x in (json.loads(l) for l in (self.real / 'owned.jsonl').read_text().splitlines())): self.pids.append(pid)
        self.assertIsNotNone(r); self.assertTrue(r.get('noFixtureOutput'), r)  # the fixture's own report is replaced by noFixtureOutput
        self.assertNotIn('fixtureReport', r)
if __name__ == '__main__': unittest.main(verbosity=2)
