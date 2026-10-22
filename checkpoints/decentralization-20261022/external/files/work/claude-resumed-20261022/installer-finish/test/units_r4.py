#!/usr/bin/env python3
"""Unit tests of install-host r4's new functions, LOCAL ONLY (pwsh 7.4 on Linux; no native Windows).

Each function is taken from the script by the PowerShell AST (FunctionDefinitionAst text, never retyped) and defined in a
fresh pwsh process together with the script's own list assignments; Windows-only cmdlets are mocks.
  units_r4.py [SCRIPT] [--old]   (--old: run the Restore tests against an older revision as a negative control)
"""
import json, pathlib, subprocess, sys, tempfile, unittest, os

HERE = pathlib.Path(__file__).resolve().parent
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
SOURCE = HERE.parent / 'src/install-host.r4.ps1'
R3 = HERE.parent / 'ref/install-host.r3.ps1'

LOADER = r'''
param([string]$Source, [string]$Names)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw "parse errors: $($errors.Count)" }
$text = [IO.File]::ReadAllText($Source)
foreach ($line in $text -split "`n") { if ($line -match '^\$script:(ReleaseDirs|ReleaseFiles|CoreTasks) = ') { Invoke-Expression $line } }
$code = @()
foreach ($n in $Names.Split(',')) {
  $f = $ast.FindAll({ param($a) $a -is [Management.Automation.Language.FunctionDefinitionAst] -and $a.Name -eq $n }, $true) | Select-Object -First 1
  if (-not $f) { throw "function $n not found" }
  $code += $f.Extent.Text }
$code -join "`n"
'''


def ps(source, names, body):
    with tempfile.TemporaryDirectory(prefix='ih-units-') as tmp:
        loader = pathlib.Path(tmp) / 'loader.ps1'; loader.write_text(LOADER)
        defs = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(loader), '-Source', str(source), '-Names', ','.join(names)],
                              capture_output=True, text=True, timeout=60)
        if defs.returncode: raise RuntimeError(defs.stderr)
        lists = '\n'.join(l for l in pathlib.Path(source).read_text().splitlines() if l.startswith(('$script:ReleaseDirs = ', '$script:ReleaseFiles = ', '$script:CoreTasks = ')))
        script = pathlib.Path(tmp) / 't.ps1'
        script.write_text("$ErrorActionPreference = 'Stop'\n$TMP = '" + tmp + "'\n" + lists + '\n' + body[0] + '\n' + defs.stdout + '\n' + body[1])
        r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(script)], capture_output=True, text=True, timeout=60)
        if r.returncode: raise RuntimeError(r.stdout + r.stderr)
        return json.loads(r.stdout)


class ReleaseRef(unittest.TestCase):
    CASES = [
        (r'C:\Program Files\Enclave\network\relay.mjs', True),
        (r'"C:\Program Files\nodejs\node.exe" "C:\Program Files\Enclave\control\network\checker.mjs" --x', True),
        ('C:/Program Files/Enclave/control/x.mjs', True),
        ('file:///C:/Program%20Files/Enclave/network/x.mjs', True),
        (r'{"script":"C:\\Program Files\\Enclave\\bin\\x.exe"}', True),
        (r'c:\program files\enclave\RUNTIME\node\node.exe', True),
        (r'cd /d "C:\Program Files\Enclave\network"', True),
        (r'C:\Program Files\Enclave\update-host.ps1', True),
        (r'C:\Program Files\Enclave\tuna\x', True),
        (r'"C:\Program Files\nodejs\node.exe" "C:\Program Files\Enclave\host-services\hs2\app\main.mjs"', False),
        (r'C:\Program Files\Enclave\challenge-replica\release-3e1560f94542\dns.mjs', False),
        (r'C:\Program Files\Enclave\network-tools\x.mjs', False),
        (r'C:\Program Files\Enclave\networks\x.mjs', False),
        (r'C:\Program Files\Enclave\manifest.json.bak', False),
        (r'C:\Program Files\EnclaveX\network\x.mjs', False),
        (r'C:\ProgramData\Enclave\network\privacy-config.json', False),
        (r'D:\Program Files\Enclave\network\x.mjs', False),
        ('', False),
    ]

    def test_cases(self):
        texts = [c[0] for c in self.CASES]
        body = ("$PF = 'C:\\Program Files\\Enclave'\n$in = Get-Content -Raw (Join-Path $TMP 'in.json') | ConvertFrom-Json",
                "@($in | ForEach-Object { [bool](Test-ReleaseRef $_) }) | ConvertTo-Json -Compress")
        # the inputs go through a file: no quoting
        out = ps_with_input(SOURCE, ['Test-ReleaseRef'], body, texts)
        for (text, want), got in zip(self.CASES, out):
            self.assertEqual(got, want, text)


def ps_with_input(source, names, body, data):
    pre, post = body
    import shutil
    tmp = tempfile.mkdtemp(prefix='ih-in-')
    try:
        (pathlib.Path(tmp) / 'in.json').write_text(json.dumps(data))
        return ps(source, names, ("$TMP = '" + tmp + "'\n" + pre, post))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


DEP_PRE = r'''
$PF = 'C:\Program Files\Enclave'; $env:ProgramFiles = 'C:\Program Files'
function task($exe, $args2, $wd) { [pscustomobject]@{ Actions = @([pscustomobject]@{ Execute = $exe; Arguments = $args2; WorkingDirectory = $wd }) } }
function proc($id, $exe, $cmd) { [pscustomobject]@{ pid = $id; created = "c$id"; exe = $exe; cmd = $cmd } }
$ext = 'C:\Program Files\nodejs\node.exe'
Set-Content -LiteralPath (Join-Path $TMP 'dep.cmd') -Value "@echo off`r`n`"$ext`" `"C:\Program Files\Enclave\network\agent.mjs`""
Set-Content -LiteralPath (Join-Path $TMP 'own.cmd') -Value "@echo off`r`n`"$ext`" `"C:\Program Files\Enclave\host-services\hs2\main.mjs`""
$big = Join-Path $TMP 'big.cmd'; [IO.File]::WriteAllBytes($big, (New-Object byte[] (1MB + 1)))
'''
DEP_POST = r'''
$own = @(proc 101 $ext "`"$ext`" `"C:\Program Files\Enclave\host-services\hs2\main.mjs`"")
$r = [ordered]@{
  noTree = Get-ReleaseDependency (task 'x.exe' '' '') $null
  emptyTree = Get-ReleaseDependency (task 'x.exe' '' '') @()
  ownedExe = Get-ReleaseDependency (task 'x.exe' '' '') @(proc 5 'C:\Program Files\Enclave\runtime\node\node.exe' '')
  extNodeReleaseScript = Get-ReleaseDependency (task 'x.exe' '' '') @(proc 7 $ext "`"$ext`" C:\Program Files\Enclave\network\relay.mjs")
  hs2 = Get-ReleaseDependency (task 'C:\Program Files\Enclave\host-services\hs2\bin\hostsvc-supervisor.exe' '--config C:\ProgramData\Enclave\host-services\hs2.json' 'C:\Program Files\Enclave\host-services\hs2') $own
  actionArg = Get-ReleaseDependency (task $ext '"%ProgramFiles%\Enclave\control\x.mjs"' '') $own
  cwdRoot = Get-ReleaseDependency (task $ext 'x.mjs' 'C:\Program Files\Enclave\') $own
  cwdRelease = Get-ReleaseDependency (task $ext 'x.mjs' 'C:\Program Files\Enclave\network') $own
  wrapperDep = Get-ReleaseDependency (task 'cmd.exe' "/c `"$(Join-Path $TMP 'dep.cmd')`"" '') $own
  wrapperOwn = Get-ReleaseDependency (task 'cmd.exe' "/c `"$(Join-Path $TMP 'own.cmd')`"" '') $own
  wrapperMissing = Get-ReleaseDependency (task 'cmd.exe' "/c `"$(Join-Path $TMP 'gone.cmd')`"" '') $own
  wrapperBig = Get-ReleaseDependency (task 'cmd.exe' "/c $big" '') $own
}
$r | ConvertTo-Json -Compress
'''


class Dependency(unittest.TestCase):
    def test_dependencies(self):
        r = ps(SOURCE, ['Test-ReleaseOwned', 'Test-ReleaseRef', 'Get-ReleaseDependency'], (DEP_PRE, DEP_POST))
        self.assertIn('could not say', r['noTree']); self.assertIn('could not say', r['emptyTree'])
        self.assertIn('runs C:\\Program Files\\Enclave\\runtime', r['ownedExe'])
        self.assertIn('command line', r['extNodeReleaseScript'])
        self.assertIsNone(r['hs2'], 'hs2: external node on its own top-level source must stay untouched')
        self.assertIn('task action names', r['actionArg'])
        self.assertIn('works in', r['cwdRoot']); self.assertIn('task action', r['cwdRelease'])
        self.assertIn('names a release file', r['wrapperDep'])
        self.assertIsNone(r['wrapperOwn'])
        self.assertIn('could not be read', r['wrapperMissing'])
        self.assertIn('too large', r['wrapperBig'])


ACL_PRE = r'''
$script:Acl = $null
function Get-Acl { param($LiteralPath) $a = $script:Acl; $o = [pscustomobject]@{ AreAccessRulesProtected = $a.protected }
  $o | Add-Member NoteProperty Ow $a.owner; $o | Add-Member NoteProperty Ids $a.ids
  $o | Add-Member ScriptMethod GetOwner { param($t) [pscustomobject]@{ Value = $this.Ow } }
  $o | Add-Member ScriptMethod GetAccessRules { param($x, $y, $t) @($this.Ids | ForEach-Object { [pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = $_ } } }) }
  $o }
$dir = Join-Path $TMP 'logs'; New-Item -ItemType Directory $dir | Out-Null
$link = Join-Path $TMP 'link'; New-Item -ItemType SymbolicLink -Path $link -Target $dir | Out-Null
'''
ACL_POST = r'''
function t($acl, $p) { $script:Acl = $acl; [bool](Test-PrivateDir $p) }
$good = @{ protected = $true; owner = 'S-1-5-32-544'; ids = @('S-1-5-18', 'S-1-5-32-544') }
[ordered]@{
  good = t $good $dir
  ownerSystem = t @{ protected = $true; owner = 'S-1-5-18'; ids = @('S-1-5-18') } $dir
  inherited = t @{ protected = $false; owner = 'S-1-5-32-544'; ids = @('S-1-5-18') } $dir
  userOwner = t @{ protected = $true; owner = 'S-1-5-21-1-2-3-1001'; ids = @('S-1-5-18') } $dir
  usersAce = t @{ protected = $true; owner = 'S-1-5-32-544'; ids = @('S-1-5-18', 'S-1-5-32-545') } $dir
  missing = t $good (Join-Path $TMP 'nope')
  symlink = t $good $link
  file = t $good (Join-Path $TMP 'loader.ps1')
} | ConvertTo-Json -Compress
'''


class PrivateDir(unittest.TestCase):
    def test_private_dir(self):
        r = ps(SOURCE, ['Test-PrivateDir'], (ACL_PRE, ACL_POST))
        self.assertEqual(r, {'good': True, 'ownerSystem': True, 'inherited': False, 'userOwner': False, 'usersAce': False,
                             'missing': False, 'symlink': False, 'file': False})


RESTORE_PRE = r'''
$PD = $TMP
$script:PriorTasks = @{ Relay = @{ enabled = $true }; Checker = @{ enabled = $true } }
$script:StoppedOthers = [Collections.Generic.List[string]]::new(); $script:StoppedOthers.Add('Relay'); $script:StoppedOthers.Add('Checker')
$script:OthersRestored = $false; $script:RestoredOthers = @{}; $script:PendingWhy = @{}; $script:StopReasons = @{}
$script:Attempts = @{ Relay = 0; Checker = 0 }; $script:Reports = [Collections.Generic.List[object]]::new(); $script:Saved = [Collections.Generic.List[object]]::new()
$script:Tasks = @{ Relay = @{ State = 'Ready'; Settings = @{ Enabled = $true } }; Checker = @{ State = 'Ready'; Settings = @{ Enabled = $true } } }
$script:Failures = 0; $script:StaysReady = 0
function Emit($step, $state, $message) { $script:Reports.Add(@{ state = $state; message = $message }) }
function Save-InstallStatus($result, $detail) { $script:Saved.Add($result) }
function Start-Sleep { param($Seconds) }
function Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) $t = $script:Tasks[$TaskName]; if ($null -eq $t) { return $null }; [pscustomobject]@{ State = $t.State; Settings = [pscustomobject]$t.Settings } }
function Start-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction)
  $script:Attempts[$TaskName]++
  if ($TaskName -eq 'Checker' -and $script:Attempts[$TaskName] -le $script:Failures) { throw 'scheduler denied request' }
  if ($TaskName -eq 'Checker' -and $script:Attempts[$TaskName] -le $script:StaysReady) { return }
  $script:Tasks[$TaskName].State = 'Running' }
'''
RESTORE_POST = r'''
Restore-OtherTasks 'first attempt'
$firstDone = $script:OthersRestored
Restore-OtherTasks 'cleanup retry'
[ordered]@{ attempts = $script:Attempts; firstDone = $firstDone; done = $script:OthersRestored; reports = @($script:Reports.ToArray())
  restored = $script:RestoredOthers; pending = $script:PendingWhy; saved = @($script:Saved.ToArray()) } | ConvertTo-Json -Depth 6 -Compress
'''


def restore(setup, source=SOURCE):
    return ps(source, ['Restore-OtherTasks'], (RESTORE_PRE + setup, RESTORE_POST))


class Restore(unittest.TestCase):
    def test_transient_refusal_retries_only_failed_role(self):
        r = restore('$script:Failures = 1')
        self.assertFalse(r['firstDone']); self.assertTrue(r['done'])
        self.assertEqual(r['attempts'], {'Relay': 1, 'Checker': 2})
        self.assertEqual([x['state'] for x in r['reports']], ['warn', 'ok'])
        self.assertEqual(r['restored'], {'Relay': 'running', 'Checker': 'running'})
        self.assertEqual(r['saved'], ['roles-pending', 'roles-restored'])

    def test_persistent_refusal_stays_pending_with_reason(self):
        r = restore('$script:Failures = 100')
        self.assertFalse(r['done']); self.assertNotIn('Checker', r['restored'])
        self.assertIn('scheduler denied request', r['pending']['Checker'])
        self.assertTrue(all(x['state'] == 'warn' for x in r['reports']))
        self.assertIn('Checker (scheduler denied request)', r['reports'][-1]['message'])

    def test_start_accepted_but_never_running_is_not_restored(self):
        r = restore('$script:StaysReady = 100')
        self.assertFalse(r['firstDone']); self.assertFalse(r['done'])
        self.assertEqual(r['attempts']['Checker'], 2)
        self.assertIn('not Running', r['pending']['Checker'])

    def test_start_accepted_late_running_on_retry_counts_once(self):
        r = restore('$script:StaysReady = 1')
        self.assertFalse(r['firstDone']); self.assertTrue(r['done']); self.assertEqual(r['attempts']['Checker'], 2)
        self.assertNotIn('Checker', r['pending'])

    def test_operator_disable_now_or_before_is_preserved(self):
        for setup in ('$script:Tasks.Checker.Settings.Enabled = $false', '$script:PriorTasks.Checker.enabled = $false'):
            r = restore(setup)
            self.assertEqual(r['attempts']['Checker'], 0); self.assertTrue(r['done']); self.assertEqual(r['restored']['Checker'], 'operator-disabled')

    def test_removed_task_remains_pending(self):
        r = restore('$script:Tasks.Remove("Checker")')
        self.assertEqual(r['attempts']['Checker'], 0); self.assertFalse(r['done'])
        self.assertIn('no longer exists', r['pending']['Checker'])

    def test_running_role_is_not_started_twice(self):
        r = restore('$script:Tasks.Checker.State = "Running"')
        self.assertEqual(r['attempts']['Checker'], 0); self.assertTrue(r['done'])

    def test_r3_negative_control_reports_never_running_role_restored(self):
        # r3 marks a role restored as soon as Start-ScheduledTask returns: the defect r4 fixes
        r = restore('$script:StaysReady = 100', R3)
        self.assertTrue(r['firstDone']); self.assertEqual(r['attempts']['Checker'], 1)


class Parse(unittest.TestCase):
    def test_parses(self):
        for f in (SOURCE, HERE.parent / 'src/update-host.r4.ps1'):
            r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-Command',
                f"$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile('{f}',[ref]$t,[ref]$e);@($e).Count"], capture_output=True, text=True, timeout=30)
            self.assertEqual(r.stdout.strip(), '0', (f, r.stdout, r.stderr))

    def test_markers(self):
        t = SOURCE.read_text(); u = (HERE.parent / 'src/update-host.r4.ps1').read_text()
        self.assertIn('ENCLAVE-ROLE-PRESERVATION-V1', t); self.assertIn('ENCLAVE-IDENTITY-RECORD-V1', t)
        self.assertIn('ENCLAVE-ROLLBACK-GUARD-V1', u); self.assertIn('ENCLAVE-RELEASE-POLICY-V1', u)


if __name__ == '__main__':
    unittest.main(verbosity=2)
