#!/usr/bin/env python3
"""Independent review tests (LOCAL ONLY: pwsh 7.4 on Linux, mocks; NOT native Windows, NOT Windows PowerShell 5.1).

Reuses the installer-finish worker's FROZEN harnesses read-only (../frozen/test/flow_r4.py, units_r4.py, ref/harness.r2.py);
nothing is written into ../frozen (flow_r4.main, which writes results beside itself, is not called).

  review_tests.py syntax                     AST scan: no PowerShell-7-only syntax in r4 installer, r4 updater, r5 installer
  review_tests.py flow   SCRIPT [--expect-bug]   W* scenarios (earlier PENDING role); --all also re-runs the worker's A-V scenarios
  review_tests.py units  SCRIPT              worker's 13 unit tests + new wrapper-detection cases, against SCRIPT
"""
import importlib.util, json, pathlib, subprocess, sys, unittest

HERE = pathlib.Path(__file__).resolve().parent
FROZEN = HERE.parent / 'frozen'
def load(name, path):
    sp = importlib.util.spec_from_file_location(name, path); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m); return m

SYNTAX = r'''
param([string]$FileList)
$bad = [ordered]@{}
foreach ($f in $FileList.Split('|')) {
  $t = $null; $e = $null; $ast = [Management.Automation.Language.Parser]::ParseFile($f, [ref]$t, [ref]$e)
  $hits = @()
  if ($e.Count) { $hits += "parse errors: $($e.Count)" }
  $hits += @($ast.FindAll({ param($a)
      $a -is [Management.Automation.Language.TernaryExpressionAst] -or $a -is [Management.Automation.Language.PipelineChainAst] -or
      ($a -is [Management.Automation.Language.BinaryExpressionAst] -and $a.Operator -eq 'QuestionQuestion') -or
      ($a -is [Management.Automation.Language.AssignmentStatementAst] -and $a.Operator -eq 'QuestionQuestionEquals') -or
      ($a -is [Management.Automation.Language.MemberExpressionAst] -and $a.NullConditional) -or
      ($a -is [Management.Automation.Language.IndexExpressionAst] -and $a.NullConditional) -or
      ($a -is [Management.Automation.Language.NamedBlockAst] -and [string]$a.BlockKind -eq 'Clean') -or
      ($a -is [Management.Automation.Language.CommandParameterAst] -and $a.ParameterName -in @('Parallel', 'AsHashtable', 'AsByteStream', 'SkipCertificateCheck', 'NoEnumerate'))
    }, $true) | ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Extent.Text)" })
  # .NET Core-only overloads used in scripts written for .NET Framework 4.x
  $hits += @($ast.FindAll({ param($a) $a -is [Management.Automation.Language.InvokeMemberExpressionAst] -and
      (($a.Member.Value -in @('Contains', 'Replace', 'Split', 'IndexOf') -and $a.Arguments.Count -ge 2 -and ($a.Arguments | Where-Object { $_.Extent.Text -match 'StringComparison' })) -or
       ($a.Member.Value -in @('GetRelativePath', 'ReadAllTextAsync', 'Join') -and $a.Expression.Extent.Text -match 'IO\.Path\]$')) }, $true) |
      ForEach-Object { "line $($_.Extent.StartLineNumber): $($_.Extent.Text)" })
  $static = @($ast.FindAll({ param($a) $a -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $a.Static }, $true) |
      ForEach-Object { "$($_.Expression.Extent.Text)::$($_.Member.Value)" } | Sort-Object -Unique)
  # Windows PowerShell 5.1: a native call whose stderr is merged (2>&1) must run with $ErrorActionPreference relaxed in its function
  $merged = @($ast.FindAll({ param($a) $a -is [Management.Automation.Language.CommandAst] -and $a.CommandElements[0].Extent.Text -match '^(powershell\.exe|\$node|\$exe)$' -and
      ($a.Redirections | Where-Object { $_.FromStream -eq 'Error' -and $_.ToStream -eq 'Output' }) }, $true) | ForEach-Object {
      $fn = $_; while ($fn -and -not ($fn -is [Management.Automation.Language.FunctionDefinitionAst])) { $fn = $fn.Parent }
      $relaxed = $fn -and $fn.Body.Extent.Text -match '\$ErrorActionPreference = "Continue"'
      "$(if ($fn) { $fn.Name } else { '<script>' }) line $($_.Extent.StartLineNumber): relaxed=$relaxed" })
  $bad[$f] = [ordered]@{ ps7Only = @($hits); mergedNativeStderr = $merged; staticCalls = $static; ascii = -not ([IO.File]::ReadAllBytes($f) | Where-Object { $_ -gt 127 } | Select-Object -First 1) }
}
$bad | ConvertTo-Json -Depth 4
'''

def syntax():
    files = [str(FROZEN / 'src/install-host.r4.ps1'), str(FROZEN / 'src/update-host.r4.ps1'), str(HERE.parent / 'src/install-host.r5.ps1'), str(HERE.parent / 'src/update-host.r5.ps1')]
    t = HERE / '.syntax.ps1'; t.write_text(SYNTAX)
    try:
        h = load('harness', FROZEN / 'ref/harness.r2.py')
        p = subprocess.run([h.PWSH, '-NoProfile', '-NonInteractive', '-File', str(t), '-FileList', '|'.join(files)], capture_output=True, text=True, timeout=120)
    finally: t.unlink()
    out = json.loads(p.stdout); print(json.dumps(out, indent=1))
    ok = len(out) == len(files) and all(not v['ps7Only'] and v['ascii'] for v in out.values())
    # '<script>' = the Hyper-V module probe, unchanged since legacy e3f8ff5f (reported as an INFO finding, not gated)
    unrelaxed = {k.split('/')[-1]: [m for m in v['mergedNativeStderr'] if 'relaxed=False' in m and not m.startswith('<script>')] for k, v in out.items()}
    print('UNRELAXED merged native stderr under Stop:', json.dumps(unrelaxed))
    ok = ok and not any(unrelaxed[n] for n in ('install-host.r5.ps1', 'update-host.r5.ps1'))   # r4 updater's Install is the known finding
    print('SYNTAX', 'PASS' if ok else 'FAIL'); return 0 if ok else 1

# ---------------------------------------------------------------- flow: a role an EARLIER install left stopped (PENDING)
def status_file(roles):
    return json.dumps({'at': '2026-10-22T02:00:00Z', 'result': 'RECOVERY-REQUIRED', 'detail': 'failed; not running again: Relay', 'updating': True,
                       'bundleVersion': '2026.10.22', 'otherRolesRestored': False, 'roles': roles})
PENDING = {'Relay': {'enabled': True, 'running': True, 'stopped': True, 'why': 'process 301 runs x', 'outcome': 'PENDING: scheduler denied start'},
           'enclave-host-services-hs2': {'enabled': True, 'running': True, 'stopped': False, 'why': None, 'outcome': None}}

def flow(script, expect_bug, run_all):
    f = load('flow_r4', FROZEN / 'test/flow_r4.py'); T, LP = f.T, f.LP
    W = {
        # the rollback/re-run after a RECOVERY-REQUIRED install: Relay is Ready (left stopped by that install), still enabled
        'W1-earlier-pending-role-restarted': dict(delta=True, tasks=T(Relay=dict(state='Ready')), procs=[p for p in LP if p['pid'] not in (300, 301)],
                                                 files={'{PD}/logs/install-status.json': status_file(PENDING)}),
        # the same, but its operator disabled it meanwhile: left alone
        'W2-earlier-pending-now-disabled': dict(delta=True, tasks=T(Relay=dict(state='Ready', enabled=False)), procs=[p for p in LP if p['pid'] not in (300, 301)],
                                               files={'{PD}/logs/install-status.json': status_file(PENDING)}),
        # the update-guard refusal must not erase the earlier PENDING record
        'W3-refusal-keeps-earlier-pending': dict(delta=True, updater=f.LEGACY_UPDATER, target=f.LEGACY_TARGET, tasks=T(Relay=dict(state='Ready')),
                                                 procs=[p for p in LP if p['pid'] not in (300, 301)], files={'{PD}/logs/install-status.json': status_file(PENDING)}),
        # no earlier record: a Ready role stays untouched (the worker's J semantics)
        'W4-ready-role-without-record-untouched': dict(delta=True, tasks=T(Relay=dict(state='Ready')), procs=[p for p in LP if p['pid'] not in (300, 301)]),
    }
    f.h.SCENARIOS.update(W)
    res, fails = {}, []
    def chk(name, cond, why):
        if not cond: fails.append(f'{name}: {why}')
    for name in W:
        r = res[name] = f.run(script, name); ev, st = r['events'], r['status'] or {}
        relay = (st.get('roles') or {}).get('Relay') or {}
        if name.startswith('W1'):
            chk(name, r['exit'] == 0, f"exit {r['exit']} {r['stderr'][-300:]}")
            chk(name, 'start Relay' in ev, f'Relay not started: {ev}')
            chk(name, st.get('result') == 'installed' and relay.get('outcome') == 'running', f'status {st.get("result")} relay {relay}')
            chk(name, 'stop enclave-host-services-hs2' not in ev and 'start enclave-host-services-hs2' not in ev, 'hs2 touched')
        elif name.startswith('W2'):
            chk(name, r['exit'] == 0 and 'start Relay' not in ev and 'start-refused-disabled Relay' not in ev, f'{r["exit"]} {ev}')
            chk(name, relay.get('outcome') == 'operator-disabled', f'relay {relay}')
        elif name.startswith('W3'):
            chk(name, r['exit'] == 0 and ev == [] and st.get('result') == 'refused-unsafe-rollback', f'{r["exit"]} {ev} {st.get("result")}')
            chk(name, str(relay.get('outcome', '')).startswith('PENDING'), f'earlier PENDING record lost: {relay}')
        else:
            chk(name, r['exit'] == 0 and 'start Relay' not in ev and 'stop Relay' not in ev, f'{r["exit"]} {ev}')
        print(('FAIL ' if any(x.startswith(name) for x in fails) else 'PASS ') + name, flush=True)
    if run_all:   # the worker's scenarios A-V unchanged, against SCRIPT (r5 changed, so this is not a repeat)
        for name in [n for n in f.h.SCENARIOS if n not in W]:
            r = f.run(script, name)
            try: f.check(name, r); print('PASS', name, flush=True)
            except AssertionError as e: fails.append(f'{name}: {str(e)[:300]}'); print('FAIL', name, str(e)[:300], flush=True)
    print(json.dumps({'script': str(script), 'failures': fails}, indent=1))
    if expect_bug:   # negative control: r4 must fail exactly W1, W2 (label only) and W3
        # W2 on r4: Relay is (correctly) not started, but r4 records no reason (outcome null) because it never saw the earlier record
        want = {'W1-earlier-pending-role-restarted', 'W2-earlier-pending-now-disabled', 'W3-refusal-keeps-earlier-pending'}
        got = {x.split(':')[0] for x in fails}
        print('negative control', 'OK' if got == want else f'MISMATCH {sorted(got ^ want)}'); return 0 if got == want else 1
    return 0 if not fails else 1

# ---------------------------------------------------------------- units: worker's 13 + new wrapper cases
NEW_PRE = r'''
$PF = 'C:\Program Files\Enclave'; $env:ProgramFiles = 'C:\Program Files'
function task($exe, $args2, $wd) { [pscustomobject]@{ Actions = @([pscustomobject]@{ Execute = $exe; Arguments = $args2; WorkingDirectory = $wd }) } }
function proc($id, $exe, $cmd) { [pscustomobject]@{ pid = $id; created = "c$id"; exe = $exe; cmd = $cmd } }
$ext = 'C:\Program Files\nodejs\node.exe'
Set-Content -LiteralPath (Join-Path $TMP 'dep.ps1') -Value "& '$ext' 'C:\Program Files\Enclave\network\agent.mjs'"
# Windows-shaped fixture paths on Linux: C:\fix\<name> -> the temp file (Get-Item only; ReadAllText then reads the real FullName)
function Get-Item { param($LiteralPath, $ErrorAction) if ([string]$LiteralPath -like 'C:\fix\*') { $LiteralPath = Join-Path $TMP ([string]$LiteralPath).Substring(7) }; Microsoft.PowerShell.Management\Get-Item -LiteralPath $LiteralPath -ErrorAction Stop }
Set-Content -LiteralPath (Join-Path $TMP 'envdep.cmd') -Value "@echo off`r`n`"$ext`" `"%ProgramFiles%\Enclave\control\checker.mjs`""
Set-Content -LiteralPath (Join-Path $TMP 'own.cmd') -Value "@echo off`r`n`"$ext`" `"%ProgramFiles%\Enclave\host-services\hs2\main.mjs`""
'''
NEW_POST = r'''
$own = @(proc 101 $ext "`"$ext`" `"C:\Program Files\Enclave\host-services\hs2\main.mjs`"")
$r = [ordered]@{
  singleQuotedCommand = Get-ReleaseDependency (task 'powershell.exe' "-NoProfile -Command `"& 'C:\fix\dep.ps1'`"" '') $own
  envVarInWrapper = Get-ReleaseDependency (task 'cmd.exe' "/c `"$(Join-Path $TMP 'envdep.cmd')`"" '') $own
  envVarOwnSource = Get-ReleaseDependency (task 'cmd.exe' "/c `"$(Join-Path $TMP 'own.cmd')`"" '') $own
  hs2 = Get-ReleaseDependency (task 'C:\Program Files\Enclave\host-services\hs2\bin\hostsvc-supervisor.exe' '--config C:\ProgramData\Enclave\host-services\hs2.json' 'C:\Program Files\Enclave\host-services\hs2') $own
}
$r | ConvertTo-Json -Compress
'''
def units(script):
    u = load('units_r4', FROZEN / 'test/units_r4.py'); src = pathlib.Path(script).resolve()
    u.SOURCE = src; u.restore.__defaults__ = (src,)
    class Wrapper(unittest.TestCase):
        def test_new_wrapper_cases(self):
            r = u.ps(src, ['Test-ReleaseOwned', 'Test-ReleaseRef', 'Get-ReleaseDependency'], (NEW_PRE, NEW_POST))
            print(json.dumps(r))
            self.assertIn('names a release file', r['singleQuotedCommand'] or '')
            self.assertIn('names a release file', r['envVarInWrapper'] or '')
            self.assertIsNone(r['envVarOwnSource']); self.assertIsNone(r['hs2'])
    suite = unittest.TestSuite()
    for c in (u.ReleaseRef, u.Dependency, Wrapper):
        suite.addTests(unittest.defaultTestLoader.loadTestsFromTestCase(c))
    for c in [v for k, v in vars(u).items() if isinstance(v, type) and issubclass(v, unittest.TestCase) and v not in (u.ReleaseRef, u.Dependency)]:
        for t in unittest.defaultTestLoader.getTestCaseNames(c):
            if 'r3_negative' in t or t in ('test_parses', 'test_markers'): continue   # r3 control and r4-path checks: not about SCRIPT
            suite.addTest(c(t))
    r = unittest.TextTestRunner(verbosity=2).run(suite)
    return 0 if r.wasSuccessful() else 1

if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'syntax': sys.exit(syntax())
    if cmd == 'flow': sys.exit(flow(pathlib.Path(sys.argv[2]).resolve(), '--expect-bug' in sys.argv, '--all' in sys.argv))
    if cmd == 'units': sys.exit(units(sys.argv[2]))
