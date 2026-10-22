#!/usr/bin/env python3
"""Control-flow tests of install-host.ps1 (revision2 vs the base 0dc5a801), LOCAL ONLY (pwsh 7.4 on Linux).

The script under test is ASSEMBLED FROM THE REAL FILE TEXT (no retyping): its definitions (Emit/Fail/... and revision2's
helpers), section 5 (stop/kill/files) up to the file verification, section 7 (services), section 8 (join) and its real
closing (revision2: `} finally {...}` + `exit 0`; base: `exit 0`). Only the unchanged Windows-only stretches between them
(registry entries, config/keys, tray) are replaced by INJECTION POINTS a scenario can make fail. Every scenario runs in its
own pwsh process: real exit codes, real try/finally/exit semantics, real temp Program Files/bundle dirs; Task Scheduler,
processes and Shield health are mocks that append ordered events to a log.

  harness.py run SCRIPT SCENARIO   -> JSON {exit, events, emits}
  harness.py suite SCRIPT          -> JSON {scenario: result}
"""
import json, os, pathlib, re, shutil, subprocess, sys, tempfile, hashlib

PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
HERE = pathlib.Path(__file__).resolve().parent


def assemble(text):
    """the real text, cut at section headers; returns the script body (without the prelude)"""
    def at(pat, start=0):
        m = re.compile(pat, re.M).search(text, start)
        if not m: raise SystemExit(f'marker not found: {pat}')
        return m.start()
    hdr = lambda n: at(r'^# -+\n# ' + str(n) + r'\. ')
    defs = text[at(r'^function Emit\('):hdr(1)]
    s5a = hdr(5)
    m = re.search(r'^Restore-OtherTasks "as soon as the files were in place"\n', text, re.M) or \
        re.search(r'^if \(\$bad\.Count\) \{ Fail "files".*\n', text, re.M)
    s5 = text[s5a:m.end()]
    s7 = text[hdr(7):hdr(8)]
    s8 = text[hdr(8):hdr(9)]
    fin = text.rfind('} finally { Restore-OtherTasks')                # revision2's closing; the base ends with a bare exit 0
    close = text[fin:] if fin > 0 else '\nexit 0\n'
    return (defs + '\nInject "pre"\n' + s5 + '\nInject "after-files"\n' + s7 + '\n' + s8 + '\nInject "tail"\n' + close)


PRELUDE = r'''
param([string]$MockScenario, [string]$MockRoot)
$ErrorActionPreference = 'Stop'
$MockScn = Get-Content -Raw (Join-Path $MockRoot 'scenario.json') | ConvertFrom-Json
$PF = Join-Path $MockRoot 'PF'; $PD = Join-Path $MockRoot 'PD'; $Bundle = Join-Path $MockRoot 'bundle'
$Delta = [bool]$MockScn.delta; $NoStart = [bool]$MockScn.noStart
$Name = 'nucbox-k11-4'; $Owner = 'owner'; $independent = $false; $want = [pscustomobject]@{ publicUrl = '' }; $operator = '0x0'
$env:ENCLAVE_UPDATING = '1'
$script:MockEv = Join-Path $MockRoot 'events.log'
function Ev($m) { Add-Content -LiteralPath $script:MockEv -Value $m }
function Inject($point) { if ($MockScn.inject -and $MockScn.inject.point -eq $point) { Ev "inject $point $($MockScn.inject.kind)"; if ($MockScn.inject.kind -eq 'fail') { Fail "injected" "injected failure at $point" } else { throw "injected exception at $point" } } }
# ---- Task Scheduler ----
$script:MockT = @{}; foreach ($t in $MockScn.tasks) { $script:MockT[$t.name] = [pscustomobject]@{ TaskName = $t.name; State = $t.state; Settings = [pscustomobject]@{ Enabled = [bool]$t.enabled }; engine = $t.engine } }
function Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) if ($TaskName) { $script:MockT[$TaskName] } else { @($script:MockT.Values | Sort-Object TaskName) } }
function Stop-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) Ev "stop $TaskName"; if ($script:MockT[$TaskName]) { $script:MockT[$TaskName].State = 'Ready' } }
function Start-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) $t = $script:MockT[$TaskName]; if (-not $t.Settings.Enabled) { Ev "start-refused-disabled $TaskName"; return }; Ev "start $TaskName"; $t.State = 'Running' }
function Disable-ScheduledTask { param($TaskPath, $TaskName) Ev "disable $TaskName"; $script:MockT[$TaskName].Settings.Enabled = $false; $script:MockT[$TaskName] }
function Register-ScheduledTask { param($TaskPath, $TaskName, $Action, $Trigger, $Principal, $Settings, [switch]$Force)
  Ev "register $TaskName"; if (-not $script:MockT[$TaskName]) { $script:MockT[$TaskName] = [pscustomobject]@{ TaskName = $TaskName; State = 'Ready'; Settings = [pscustomobject]@{ Enabled = $true }; engine = $null } } else { $script:MockT[$TaskName].Settings.Enabled = $true }; $script:MockT[$TaskName] }
function New-ScheduledTaskAction { param($Execute, $Argument) [pscustomobject]@{} }
function New-ScheduledTaskTrigger { param([switch]$AtStartup, [switch]$Once, $At, $RepetitionInterval) [pscustomobject]@{ Delay = $null } }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel) [pscustomobject]@{} }
function New-ScheduledTaskSettingsSet { param($ExecutionTimeLimit, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, [switch]$StartWhenAvailable, $MultipleInstances) [pscustomobject]@{} }
# ---- processes + Task Scheduler's running instances (COM) ----
$script:MockP = @{}; foreach ($p in $MockScn.procs) { $script:MockP[[int]$p.pid] = [pscustomobject]@{ ProcessId = [int]$p.pid; ParentProcessId = [int]$p.ppid; ExecutablePath = ($p.exe -replace '^PF', $PF) } }
function Get-CimInstance { param($ClassName) @($script:MockP.Values) }
function Stop-Process { param($Id, [switch]$Force, $ErrorAction) Ev "kill $Id"; $script:MockP.Remove([int]$Id) }
function New-Object { param([string]$ComObject, [Parameter(Position = 0)]$TypeName, [Parameter(Position = 1)]$ArgumentList)
  if ($ComObject -eq 'Schedule.Service') {
    $o = [pscustomobject]@{}
    $o | Add-Member ScriptMethod Connect { if ($MockScn.comBroken) { throw 'no Task Scheduler COM' } }
    $o | Add-Member ScriptMethod GetRunningTasks { param($f) @($script:MockT.Values | Where-Object { $_.State -eq 'Running' -and $_.engine } | ForEach-Object { [pscustomobject]@{ Path = "\Enclave\$($_.TaskName)"; EnginePID = [int]$_.engine } }) }
    return $o }
  if ($ArgumentList) { Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName -ArgumentList $ArgumentList } else { Microsoft.PowerShell.Utility\New-Object -TypeName $TypeName } }
function Start-Sleep { param($Seconds, $Milliseconds) }
function Invoke-RestMethod { param($Uri, [switch]$UseBasicParsing, $TimeoutSec) if ($MockScn.shieldTimeout) { throw 'connection refused' }; [pscustomobject]@{ ok = $true } }
'''


def make_root(sc):
    r = pathlib.Path(tempfile.mkdtemp(prefix='ih-r2-'))
    pf, pd, b = r / 'PF', r / 'PD', r / 'bundle'
    for d in (pf, pd / 'logs', b): d.mkdir(parents=True)
    (pd / 'logs' / 'node.log').write_text('[x] registry: registered\n')
    files = {'runtime/node/node.exe': b'node-new', 'control/windows/node/host.mjs': b'host-new', 'network/privacy-agent.mjs': b'pa-new',
             'bin/enclave-shield.exe': b'shield-new', 'guest/uki.efi': b'guest-new', 'tray/EnclaveTray.exe': b'tray-new'}
    sha = lambda x: hashlib.sha256(x).hexdigest()
    man = {'version': '2026.10.22', 'files': [{'path': p, 'sha256': sha(c), 'bytes': len(c)} for p, c in files.items()]}
    if sc.get('badManifest'): man['files'][1]['sha256'] = '0' * 64
    for p, c in files.items(): (b / p).parent.mkdir(parents=True, exist_ok=True); (b / p).write_bytes(c)
    (b / 'manifest.json').write_text(json.dumps(man)); (b / 'update-host.ps1').write_text('#u'); (b / 'uninstall-host.ps1').write_text('#x')
    # the installed release + content a release does not own
    old = {'runtime/node/node.exe': b'node-old', 'control/windows/node/host.mjs': b'host-old', 'network/privacy-agent.mjs': b'pa-old', 'bin/enclave-shield.exe': b'shield-old', 'guest/uki.efi': b'guest-old', 'tray/EnclaveTray.exe': b'tray-old'}
    for p, c in old.items(): (pf / p).parent.mkdir(parents=True, exist_ok=True); (pf / p).write_bytes(c)
    (pf / 'manifest.json').write_text(json.dumps({'version': '2026.10.12.47', 'files': [{'path': p, 'sha256': sha(c)} for p, c in old.items()]}))
    for p in ('host-services/hs2/bin/hostsvc-supervisor.exe', 'challenge-replica/release-3e1560f94542/dns.mjs', 'network/challenge-replica/release-3e1560f94542/dns.mjs'):
        (pf / p).parent.mkdir(parents=True, exist_ok=True); (pf / p).write_text('keep?')
    (r / 'scenario.json').write_text(json.dumps(sc))
    return r


LIVE_TASKS = [dict(name=n, enabled=True, state='Running', engine=e) for n, e in
              [('Card', 700), ('enclave-host-services-hs2', 100), ('Network', 500), ('NetworkChecker', 200), ('Node', 400), ('Relay', 300), ('Shield', 600)]] + \
             [dict(name='Update', enabled=True, state='Ready', engine=None)]
LIVE_PROCS = [dict(pid=100, ppid=1, exe='PF\\host-services\\hs2\\bin\\hostsvc-supervisor.exe'), dict(pid=101, ppid=100, exe='C:\\Program Files\\nodejs\\node.exe'),
              dict(pid=200, ppid=1, exe='PF\\runtime\\node\\node.exe'),
              dict(pid=300, ppid=1, exe='C:\\Windows\\System32\\cmd.exe'), dict(pid=301, ppid=300, exe='PF\\runtime\\node\\node.exe'),
              dict(pid=400, ppid=1, exe='C:\\Windows\\System32\\cmd.exe'), dict(pid=401, ppid=400, exe='PF\\runtime\\node\\node.exe'),
              dict(pid=500, ppid=1, exe='C:\\Windows\\System32\\cmd.exe'), dict(pid=501, ppid=500, exe='PF\\runtime\\node\\node.exe'),
              dict(pid=600, ppid=1, exe='C:\\Windows\\System32\\cmd.exe'), dict(pid=601, ppid=600, exe='PF\\bin\\enclave-shield.exe'),
              dict(pid=700, ppid=1, exe='C:\\Windows\\System32\\cmd.exe')]


def tasks(**over):
    out = []
    for t in LIVE_TASKS:
        t = dict(t); t.update(over.get(t['name'], {})); out.append(t)
    return out


SCENARIOS = {
    'A-success-delta': dict(delta=True, tasks=tasks(), procs=LIVE_PROCS),
    'B-manifest-verify-failure': dict(delta=True, badManifest=True, tasks=tasks(), procs=LIVE_PROCS),
    'C-shield-timeout-paused-node': dict(delta=True, shieldTimeout=True, tasks=tasks(Node=dict(enabled=False, state='Ready')), procs=LIVE_PROCS),
    'D-nostart': dict(delta=True, noStart=True, tasks=tasks(), procs=LIVE_PROCS),
    'E-exception-before-verify': dict(delta=True, inject=dict(point='pre-copy', kind='throw'), tasks=tasks(), procs=LIVE_PROCS),
    'F-fail-before-state': dict(delta=True, inject=dict(point='pre', kind='fail'), tasks=tasks(), procs=LIVE_PROCS),
    'G-com-unavailable': dict(delta=True, comBroken=True, tasks=tasks(), procs=LIVE_PROCS),
    'H-paused-shield': dict(delta=True, tasks=tasks(Shield=dict(enabled=False, state='Ready')), procs=LIVE_PROCS),
    'I-full-install': dict(delta=False, tasks=tasks(), procs=LIVE_PROCS),
    'J-stopped-and-disabled-roles': dict(delta=True, tasks=tasks(Relay=dict(state='Ready'), NetworkChecker=dict(enabled=False, state='Ready')), procs=LIVE_PROCS),
    'K-exception-after-files': dict(delta=True, inject=dict(point='after-files', kind='throw'), tasks=tasks(), procs=LIVE_PROCS),
}


def run(script_path, name):
    sc = SCENARIOS[name]; r = make_root(sc)
    body = assemble(pathlib.Path(script_path).read_text(encoding='utf-8'))
    if sc.get('inject', {}).get('point') == 'pre-copy':            # an exception INSIDE section 5, after Stop-ForInstall
        body = body.replace('$manifest = Get-Content (Join-Path $Bundle "manifest.json")', 'Inject "pre-copy"\n$manifest = Get-Content (Join-Path $Bundle "manifest.json")', 1)
    (r / 'assembled.ps1').write_text(PRELUDE + body, encoding='utf-8')
    p = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(r / 'assembled.ps1'), '-MockScenario', name, '-MockRoot', str(r)],
                       capture_output=True, text=True, timeout=120)
    ev = (r / 'events.log').read_text().splitlines() if (r / 'events.log').exists() else []
    emits = []
    for l in p.stdout.splitlines():
        try: emits.append(json.loads(l))
        except Exception: pass
    pf = r / 'PF'
    kept = {k: (pf / k).exists() for k in ('host-services/hs2/bin/hostsvc-supervisor.exe', 'challenge-replica/release-3e1560f94542/dns.mjs', 'network/challenge-replica/release-3e1560f94542/dns.mjs')}
    out = {'exit': p.returncode, 'events': ev, 'emits': emits, 'kept': kept, 'stderr': p.stderr[-600:]}
    shutil.rmtree(r, ignore_errors=True)
    return out


def parse_errors(path):
    p = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-Command',
                        f"$e=$null;$t=$null;[void][Management.Automation.Language.Parser]::ParseFile('{path}',[ref]$t,[ref]$e);@($e).Count"], capture_output=True, text=True)
    return int(p.stdout.strip() or -1)


if __name__ == '__main__':
    cmd, script = sys.argv[1], sys.argv[2]
    if cmd == 'run': print(json.dumps(run(script, sys.argv[3]), indent=1))
    else: print(json.dumps({n: run(script, n) for n in SCENARIOS}, indent=1))
