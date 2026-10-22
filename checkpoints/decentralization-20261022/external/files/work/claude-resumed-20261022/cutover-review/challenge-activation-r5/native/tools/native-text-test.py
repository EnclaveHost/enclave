"""r5: the EXACT validate / drain / remove texts of run-native.py executed by pwsh 7 on Linux against REAL own processes (NOT Windows
evidence). Only Get-CimInstance (exact-PID lookup, answered from the real process table), FileSha (the transport HEAD's) and, per case,
Get-ExecutionPolicy / Get-Process (a Kill that fails) are stubbed; 'powershell.exe' is a fake on PATH (refuses like a PSSecurityException,
hangs, passes, or prints and exits while a background child holds its stdout). Cleanup runs DRAIN then REMOVE, as the driver does.
OLD NEGATIVES run the frozen r4 texts (run-native.py b6741d88) in the same scenario. Every process a case starts is killed in tearDown."""
import hashlib, importlib.util, json, os, pathlib, shutil, signal, subprocess, tempfile, threading, time, unittest
N = pathlib.Path(__file__).resolve().parent.parent; PWSH = os.environ['PWSH']
def load(path, name):
    spec = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m); return m
d = load(N / 'run-native.py', 'driver')
R4 = N.parent.parent / 'challenge-activation-r4/native/run-native.py'
assert hashlib.sha256(R4.read_bytes()).hexdigest() == 'b6741d884760d03082eb6dab6b7e582a9b5da5428e66c881c081a7922c1e3161', 'the old negative must be the frozen r4 driver'
d4 = load(R4, 'driver_r4')
PRE = (r"$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue';"
       r"function FileSha($f){if(Test-Path -LiteralPath $f){(Get-FileHash -Algorithm SHA256 -LiteralPath $f).Hash.ToLower()}else{'absent'}};"
       r"function Get-CimInstance{param($ClassName,$Filter,$OperationTimeoutSec)if($Filter -match '^ProcessId=(\d+)$'){$p=Microsoft.PowerShell.Management\Get-Process -Id ([int]$matches[1]) -ErrorAction SilentlyContinue;"
       r"if($p){[pscustomobject]@{ProcessId=$p.Id;CreationDate=$p.StartTime}}}else{throw 'mock: only exact-PID queries are allowed'}};")
NOKILL = (r"function Get-Process{param($Id,$ErrorAction)$p=Microsoft.PowerShell.Management\Get-Process -Id $Id;"
          r"Add-Member -InputObject $p -MemberType ScriptMethod -Name Kill -Value {} -Force;$p};")     # the stop fails: the process survives
FAKES = {'refuse': "#!/bin/sh\necho 'File x.ps1 cannot be loaded because running scripts is disabled on this system. PSSecurityException' >&2\nexit 1\n",
         'hang': "#!/bin/sh\nexec sleep 300\n", 'pass': "#!/bin/sh\necho '{\"pass\":true,\"fake\":1}'\nexit 0\n",
         # F2: prints its result, persists it, leaves a background child holding stdout, exits 3
         'held': "#!/bin/sh\ns=''\nwhile [ $# -gt 0 ]; do [ \"$1\" = '-Stage' ] && s=\"$2\"; shift; done\ns=$(printf '%s' \"$s\" | tr '\\\\' '/')\n"
                 "echo '{\"pass\":false,\"held\":1}' > \"$s/fixture-result.json\"\necho '{\"pass\":false,\"held\":1}'\nsleep 30 &\necho $! > \"$s/../held.pid\"\nexit 3\n"}
alive = lambda pid: os.path.exists(f'/proc/{pid}') and open(f'/proc/{pid}/stat').read().split(')')[1].split()[0] != 'Z'
def start_of(pid):   # the 'o' start the fixture would record, read the way the texts read it (pwsh Get-Process StartTime)
    c = subprocess.run([PWSH, '-NoProfile', '-Command', f'(Get-Process -Id {pid}).StartTime.ToUniversalTime().ToString("o")'], capture_output=True, text=True, timeout=60)
    return c.stdout.strip()
class Texts(unittest.TestCase):
    def setUp(self):
        self.t = pathlib.Path(tempfile.mkdtemp(prefix='native-text-')); self.root = str(self.t / 'staging'); os.mkdir(self.root)
        self.stage = self.root + '\\' + d.PREFIX + 'abcdef012345'    # the driver's Windows join; PowerShell on Linux maps '\' to '/'
        self.real = pathlib.Path(self.root) / (d.PREFIX + 'abcdef012345'); self.real.mkdir()
        for f in d.FILES: shutil.copy2(N / f, self.real / f)
        self.pids = []
    def tearDown(self):
        held = pathlib.Path(self.root) / 'held.pid'
        if held.exists(): self.pids.append(int(held.read_text()))
        for p in self.pids:
            try: os.kill(p, signal.SIGKILL)
            except ProcessLookupError: pass
        shutil.rmtree(self.t, ignore_errors=True)
    def ps(self, which, extra='', fake=None, wait=(2, 2), fixture_ms=3000, mod=None):
        b = self.t / 'bin'; b.mkdir(exist_ok=True); env = dict(os.environ)
        if fake: (b / 'powershell.exe').write_text(FAKES[fake]); (b / 'powershell.exe').chmod(0o755); env['PATH'] = f"{b}:{env['PATH']}"
        f = self.t / f'{which}.ps1'; f.write_text(PRE + extra + (mod or d).texts(self.stage, root=self.root, wait=wait, fixture_ms=fixture_ms)[which])
        c = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(f)], capture_output=True, text=True, timeout=120, env=env)
        out = [l for l in c.stdout.splitlines() if l.startswith('{')]
        return (json.loads(out[-1]) if out else None), c
    def clean(self, extra='', wait=(2, 2), remove_extra=''):
        dr, c1 = self.ps('drain', extra, wait=wait); rm, c2 = self.ps('remove', extra + remove_extra); return dr, rm, c1, c2
    def reg(self):
        g = self.real / 'owned.jsonl'
        return [json.loads(l) for l in g.read_text().splitlines() if l.startswith('{')] if g.exists() else []
    def write_reg(self, *rows): (self.real / 'owned.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in rows))
    def detached(self):   # a sleep reparented to init (a direct child of this test would stay a zombie after a kill and look alive)
        p = subprocess.run(['sh', '-c', 'sleep 300 >/dev/null 2>&1 & echo $!'], capture_output=True, text=True, timeout=30); pid = int(p.stdout.strip()); self.pids.append(pid); return pid
    def sleeper(self):
        pid = self.detached(); return pid, start_of(pid)
    def dead(self):
        p = subprocess.Popen(['true']); p.wait(); return p.pid
    # ---------------------------------------------------------------- unchanged r4 behaviour, through DRAIN + REMOVE
    def test_policy_refused_before_launch(self):
        r, c = self.ps('validate', "function Get-ExecutionPolicy{'Restricted'};", fake='pass')
        self.assertEqual(c.returncode, 7, c.stderr); self.assertEqual(r, {'refused': 'execution-policy', 'executionPolicy': 'Restricted', 'launched': False})
        self.assertEqual(self.reg(), [], 'nothing was launched, no marker')
        dr, rm, _, _ = self.clean(); self.assertTrue(rm['gone'], rm)
    def test_policy_refusal_at_launch_is_recorded_not_worked_around(self):
        r, c = self.ps('validate', fake='refuse'); self.assertEqual(c.returncode, 7, c.stderr)
        self.assertEqual((r['refused'], r['launched'], r['executionPolicy']), ('execution-policy', True, 'Unrestricted'))
        self.assertEqual([x.get('role', 'launching' if x.get('launching') else '?') for x in self.reg()], ['launching', 'fixture-host'])
        dr, rm, _, _ = self.clean(); self.assertTrue(rm['gone'], rm)      # the fixture script never ran: no 'fixture' row
    def test_passing_fixture_output_is_relayed(self):
        r, c = self.ps('validate', fake='pass'); self.assertEqual(c.returncode, 0, c.stderr); self.assertEqual(r, {'pass': True, 'fake': 1})
        dr, rm, _, _ = self.clean(); self.assertTrue(rm['gone'], rm); self.assertFalse(self.real.exists())
    def test_hung_fixture_times_out_then_drain_stops_exactly_it_by_handle(self):
        t0 = time.time(); r, c = self.ps('validate', fake='hang'); self.assertEqual(c.returncode, 8, c.stderr); self.assertTrue(r['timeout'])
        self.assertLess(time.time() - t0, 30); pid = r['fixturePid']; self.pids.append(pid); self.assertTrue(alive(pid))
        foreign = subprocess.Popen(['sleep', '300']); self.pids.append(foreign.pid)
        dr, rm, c1, c2 = self.clean(); self.assertEqual(dr['stopped'], [f'fixture-host:{pid}'], (dr, c1.stderr)); self.assertEqual(dr['alive'], [])
        self.assertTrue(rm['gone'], (rm, c2.stderr)); self.assertFalse(alive(pid)); self.assertFalse(self.real.exists())
        self.assertTrue(alive(foreign.pid), 'an unregistered process is never touched')
    def test_unkillable_registered_child_keeps_the_stage(self):
        r, c = self.ps('validate', fake='hang'); pid = r['fixturePid']; self.pids.append(pid)
        dr, rm, c1, c2 = self.clean(NOKILL)
        self.assertEqual(dr['alive'], [f'fixture-host:{pid}'], (dr, c1.stderr)); self.assertIs(rm['gone'], False, (rm, c2.stderr)); self.assertIn('not confirmed exited', rm['kept'])
        self.assertTrue(self.real.exists()); self.assertTrue(alive(pid))
    def test_pid_reuse_and_unknown_start(self):
        pid, _ = self.sleeper()
        self.write_reg({'role': 'edit', 'pid': pid, 'start': '2020-01-01T00:00:00.0000000Z'})                 # same PID, other start: not ours
        dr, rm, _, _ = self.clean(); self.assertEqual(dr['stopped'], []); self.assertTrue(rm['gone'], rm); self.assertTrue(alive(pid))
        self.real.mkdir(); self.write_reg({'role': 'edit', 'pid': pid, 'start': 'unknown'})                    # identity unknown: never stopped, kept
        dr, rm, _, _ = self.clean(); self.assertEqual(dr['stopped'], []); self.assertIs(rm['gone'], False, rm); self.assertTrue(alive(pid)); self.assertTrue(self.real.exists())
    def test_cleanup_failure_is_an_error_not_gone(self):
        self.write_reg({'role': 'edit', 'pid': os.getpid(), 'start': '2020-01-01T00:00:00Z'})
        dr, rm, c1, c2 = self.clean("function Get-CimInstance{throw 'mock: WMI unavailable'};")
        self.assertNotEqual(c2.returncode, 0); self.assertTrue(rm is None or rm.get('gone') is not True); self.assertTrue(self.real.exists())
    # ---------------------------------------------------------------- r5: F1 a registry that grows during cleanup
    def grow_later(self, delay, role='edit'):
        def go():
            time.sleep(delay); self.grown = self.detached()
            with (self.real / 'owned.jsonl').open('a') as f: f.write(json.dumps({'role': role, 'pid': self.grown, 'start': start_of(self.grown)}) + '\n')
        th = threading.Thread(target=go); th.start(); return th
    def test_f1_a_child_registered_during_drain_keeps_the_stage(self):
        a, sa = self.sleeper(); self.write_reg({'launching': True}, {'role': 'fixture-host', 'pid': a, 'start': sa})
        th = self.grow_later(1.5); dr, c1 = self.ps('drain', wait=(6, 2)); th.join(); rm, c2 = self.ps('remove')   # appended mid-drain, after its read
        self.assertEqual(dr['stopped'], [f'fixture-host:{a}']); self.assertTrue(alive(self.grown), 'the late child still runs')
        self.assertIs(rm['gone'], False, (rm, c2.stderr)); self.assertIn('not confirmed exited', rm['kept']); self.assertTrue(self.real.exists(), 'never deleted under a live registered child')
    def test_f1_old_negative_r4_deletes_under_the_late_child(self):
        a, sa = self.sleeper(); self.write_reg({'role': 'fixture-host', 'pid': a, 'start': sa})
        th = self.grow_later(1.5); r, c = self.ps('cleanup', wait=(6, 2), mod=d4); th.join()
        self.assertTrue(r['gone'], (r, c.stderr)); self.assertTrue(alive(self.grown)); self.assertFalse(self.real.exists(), 'OLD r4: stage deleted while a registered child runs')
    def test_f1_a_registry_change_during_remove_keeps_the_stage(self):
        g = str(self.real / 'owned.jsonl').replace("'", "''"); self.write_reg({'role': 'edit', 'pid': self.dead(), 'start': '2020-01-01T00:00:00Z'})
        late = (r"$script:once=$false;function Get-CimInstance{param($ClassName,$Filter,$OperationTimeoutSec)if(-not $script:once){$script:once=$true;"
                f"Add-Content -LiteralPath '{g}' -Value '{{\"role\":\"edit\",\"pid\":1,\"start\":\"2020-01-01T00:00:00Z\"}}'" r"};@()};")
        rm, c = self.ps('remove', late); self.assertIs(rm['gone'], False, (rm, c.stderr)); self.assertIn('registry changed', rm['kept']); self.assertEqual(rm['registeredNow'], 2)
        self.assertTrue(self.real.exists())
    # ---------------------------------------------------------------- r5: F5 fail closed on what the fixture did not confirm
    def test_f5_fixture_cleanup_record_is_required(self):
        fx = {'role': 'fixture', 'pid': self.dead(), 'start': '2020-01-01T00:00:00Z'}
        for final, gone, why in ((None, False, 'recorded no confirmed cleanup'), ({'cleanup': 'fixture', 'allExited': True, 'children': 3, 'queryCleanupFailed': True}, False, 'recorded no confirmed cleanup'),
                                 ({'cleanup': 'fixture', 'allExited': False, 'children': 3, 'queryCleanupFailed': False}, False, 'recorded no confirmed cleanup'),
                                 ({'cleanup': 'fixture', 'allExited': True, 'children': 3, 'queryCleanupFailed': False}, True, None)):
            self.real.mkdir(exist_ok=True); self.write_reg(*([fx] + ([final] if final else [])))
            rm, c = self.ps('remove'); self.assertIs(rm['gone'], gone, (final, rm, c.stderr))
            if why: self.assertIn(why, rm['kept']); self.assertTrue(self.real.exists())
        self.real.mkdir(); self.write_reg({'launching': True})
        rm, c = self.ps('remove'); self.assertIs(rm['gone'], False); self.assertIn('launch has no registered identity', rm['kept'])
    # ---------------------------------------------------------------- r5: F2 a held stdout keeps the fixture's result
    def test_f2_a_held_stdout_falls_back_to_the_persisted_result(self):
        t0 = time.time(); r, c = self.ps('validate', fake='held'); self.assertLess(time.time() - t0, 25)
        self.assertEqual(c.returncode, 10, (r, c.stderr)); self.assertEqual(r, {'fixtureResultFile': True, 'exit': 3, 'result': {'pass': False, 'held': 1}})
        self.assertNotIn('pass', r, 'a result recovered from the file is never a top-level pass')
    def test_f2_old_negative_r4_loses_the_result(self):
        for f in d4.FILES: shutil.copy2(R4.parent / f, self.real / f)          # the frozen r4 bytes its own pins expect
        r, c = self.ps('validate', fake='held', mod=d4); self.assertEqual(c.returncode, 9, c.stderr)
        self.assertEqual(r, {'noFixtureOutput': True, 'launched': True, 'exit': 3}, 'OLD r4: the fixture result is lost')
    # ---------------------------------------------------------------- r5: F4 every wait and CIM timeout capped by the budget
    def test_f4_drain_stays_inside_its_budget(self):
        a, sa = self.sleeper(); self.write_reg({'role': 'edit', 'pid': a, 'start': sa})
        old = d.DRAIN_BUDGET; d.DRAIN_BUDGET = 3
        try:
            t0 = time.time(); dr, c = self.ps('drain', NOKILL + "$global:ots=@();function Get-CimInstance{param($ClassName,$Filter,$OperationTimeoutSec)$global:ots+=$OperationTimeoutSec;"
                                         r"if($Filter -match '^ProcessId=(\d+)$'){$p=Microsoft.PowerShell.Management\Get-Process -Id ([int]$matches[1]) -ErrorAction SilentlyContinue;"
                                         r"if($p){[pscustomobject]@{ProcessId=$p.Id;CreationDate=$p.StartTime}}}};", wait=(30, 30)); el = time.time() - t0
        finally: d.DRAIN_BUDGET = old
        self.assertEqual(dr['alive'], [f'edit:{a}'], (dr, c.stderr)); self.assertLess(el, 15, 'the 30 s waits are cut by the 3 s budget')
if __name__ == '__main__': unittest.main()
