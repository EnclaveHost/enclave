#!/usr/bin/env python3
"""r6 regressions, LOCAL ONLY (pwsh 7.4 on Linux; mocks; NOT native Windows / Windows PowerShell 5.1).
  regress_r6.py syntax   the r5 reviewer's PS7-only/.NET-Core-only AST scan (its exact text, run from HERE) on r6 + the migration script
  regress_r6.py flow     the r5 reviewer's flow scenarios W1-W4 + the worker's A-V (--all), against r6, read-only imports
  regress_r6.py units    the worker's units + the reviewer's wrapper cases, against r6
  regress_r6.py guard    the r6 refusal block itself: exit 0 + status under an updater, Fail by hand, names only, nothing else ran
Imports the sibling reviewer's test module read-only with bytecode writing OFF (nothing is written into another worker's dir)."""
import importlib.util, json, os, pathlib, shutil, subprocess, sys, tempfile
sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent; PKG = HERE.parent
REVIEW = PKG.parent / 'dns-package-review/installer-review/test/review_tests.py'
R6 = PKG / 'src/install-host.r6p.ps1'; MIG = PKG / 'root/migrate-local-config.ps1'   # installer-policy-composition: the MERGED file
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'


def review():
    sp = importlib.util.spec_from_file_location('review_tests', REVIEW); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m); return m


def syntax():
    m = review(); t = pathlib.Path(tempfile.mkdtemp(prefix='r6-syn-')); (t / 's.ps1').write_text(m.SYNTAX)
    r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(t / 's.ps1'), '-FileList', f'{R6}|{MIG}'], capture_output=True, text=True, timeout=120)
    shutil.rmtree(t, ignore_errors=True); print(r.stdout[-4000:], r.stderr[-1000:])
    out = json.loads(r.stdout)
    ok = r.returncode == 0 and len(out) == 2 and all(not v['ps7Only'] and v['ascii'] for v in out.values())
    unrelaxed = {k.split('/')[-1]: [m for m in v['mergedNativeStderr'] if 'relaxed=False' in m and not m.startswith('<script>')] for k, v in out.items()}
    ok = ok and not any(unrelaxed.values())
    print('SYNTAX', 'PASS' if ok else 'FAIL', json.dumps({k.split('/')[-1]: {'ps7Only': v['ps7Only'], 'ascii': v['ascii']} for k, v in out.items()}), 'unrelaxed', json.dumps(unrelaxed))
    return 0 if ok else 1


GUARD = r'''
param([string]$Dir, [string]$Updating)
$ErrorActionPreference = 'Stop'
$tk = $null; $er = $null; $ast = [Management.Automation.Language.Parser]::ParseFile($env:INST, [ref]$tk, [ref]$er); if ($er.Count) { throw 'parse' }
$text = [IO.File]::ReadAllText($env:INST)
$a = $text.IndexOf('$script:SetLine = '); $b = $text.IndexOf("`n# ---------------------------------------------------------------------------------------------------------------------`n# 1. the machine")
if ($a -lt 0 -or $b -lt $a) { throw 'guard block not found' }
$PD = $Dir; $env:ENCLAVE_UPDATING = $Updating
$script:Events = [Collections.Generic.List[string]]::new()
function Emit($step, $state, $message) { $script:Events.Add("emit $step $state $message") }
function Save-InstallStatus($result, $detail) { $script:Events.Add("status $result $detail") }
function Fail($step, $message) { $script:Events.Add("fail $step $message"); exit 1 }
$guard = $text.Substring($a, $b - $a)
try { Invoke-Expression $guard; $script:Events.Add('continued') }
finally { ConvertTo-Json -InputObject @($script:Events) | Write-Output }      # also on the block's own exit
exit 0
'''


def guard():
    sys.path.insert(0, str(HERE)); import test_persistence as tp
    failures = []
    for updating, want_exit in (('1', 0), ('', 1)):
        d = pathlib.Path(tempfile.mkdtemp(prefix='r6-guard-')); tp.make_pre(d)
        t = pathlib.Path(tempfile.mkdtemp(prefix='r6-g-')); (t / 'g.ps1').write_text(GUARD)
        r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(t / 'g.ps1'), '-Dir', str(d), '-Updating', updating],
                           capture_output=True, text=True, timeout=60, env=dict(os.environ, INST=str(R6)))
        ev = json.loads(r.stdout) if r.stdout.strip() else []
        ev = [ev] if isinstance(ev, str) else ev
        ok = r.returncode == want_exit and 'continued' not in ev and any(e.startswith('status refused-unpersisted-config') for e in ev) \
             and any(('ENCLAVE_HOST_OWNERSHIP' in e) for e in ev) and not any(s in json.dumps(ev) for s in tp.SECRETISH)
        if updating == '1': ok = ok and any(e.startswith('emit config fail NOT INSTALLED, nothing on this PC changed') for e in ev)
        else: ok = ok and any(e.startswith('fail config Nothing was changed') for e in ev)
        # after the migration the same block lets the install go on
        tp.migrate_ok(d)
        r2 = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(t / 'g.ps1'), '-Dir', str(d), '-Updating', updating],
                            capture_output=True, text=True, timeout=60, env=dict(os.environ, INST=str(R6)))
        ok = ok and r2.returncode == 0 and json.loads(r2.stdout) == ['continued']
        print('PASS' if ok else 'FAIL', f'guard updating={updating!r}', r.returncode, ev[:3], r2.stdout.strip()[:80], flush=True)
        if not ok: failures.append(updating)
        shutil.rmtree(d, ignore_errors=True); shutil.rmtree(t, ignore_errors=True)
    return 1 if failures else 0


if __name__ == '__main__':
    c = sys.argv[1]
    if c == 'syntax': sys.exit(syntax())
    if c == 'flow': sys.exit(review().flow(R6.resolve(), False, True))
    if c == 'units': sys.exit(review().units(str(R6)))
    if c == 'guard': sys.exit(guard())
