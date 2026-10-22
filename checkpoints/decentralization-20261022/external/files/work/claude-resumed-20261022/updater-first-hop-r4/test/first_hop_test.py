#!/usr/bin/env python3
"""LOCAL tests of src/first-hop.ps1 (Linux pwsh 7.4; NOT Windows, NOT PS 5.1 evidence).
The REAL script text runs end to end, dot-sourced in its own pwsh process, with ProgramFiles/ProgramData pointed at a temp root.
Replaced: ONLY Test-Desktop51 (Linux is Core) and New-PrivateDir (Windows SDDL). Mocked: Task Scheduler reads, Win32_Process,
Get-Acl (per-path SDDL; the target keeps its SDDL across [IO.File]::Replace unless a scenario says otherwise). Every mutating
Task Scheduler / process / service / ACL / file cmdlet is a TRIPWIRE: the script may change files only through [IO.File]."""
import hashlib, json, os, pathlib, shutil, subprocess, sys, tempfile

HERE = pathlib.Path(__file__).resolve().parent; SRC = HERE.parent / 'src'; BASE = HERE.parent / 'baseline'
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
LIVE = (BASE / 'update-host.live-e0d9df1c.ps1').read_bytes(); CAND = (SRC / 'update-host.first-hop.ps1').read_bytes()
sha = lambda b: hashlib.sha256(b).hexdigest()
assert sha(LIVE).startswith('e0d9df1c') and sha(CAND).startswith('36f9e0d6')

PRELUDE = r'''
$S = Get-Content -Raw $env:FH_SCENARIO | ConvertFrom-Json
foreach ($n in 'Start-ScheduledTask','Stop-ScheduledTask','Enable-ScheduledTask','Disable-ScheduledTask','Set-ScheduledTask','Register-ScheduledTask',
               'Unregister-ScheduledTask','Stop-Process','Start-Process','Set-Content','Add-Content','Out-File','Remove-Item','New-Item',
               'Move-Item','Copy-Item','Rename-Item','Restart-Service','Stop-Service','Start-Service','Invoke-WebRequest','Invoke-RestMethod') {
  . ([scriptblock]::Create("function $n { [IO.File]::AppendAllText(`$env:FH_TRIP, '$n' + [char]10); throw 'TRIPWIRE: $n' }")) }
$script:Cim = 0; $script:GetT = 0; $script:Exp = 0
function Get-ScheduledTask { param($TaskPath, $TaskName, $ErrorAction) $script:GetT++
  $state = $(if ($S.runningFromCall -and $script:GetT -ge [int]$S.runningFromCall) { 'Running' } elseif ($S.taskDisabled) { 'Disabled' } else { $S.taskState })
  $en = $(if ($S.PSObject.Properties.Name -contains 'enabledRaw') { $S.enabledRaw } else { -not $S.taskDisabled })
  [pscustomobject]@{ TaskName = 'Update'; State = $state; Settings = [pscustomobject]@{ Enabled = $en }
    Actions = @([pscustomobject]@{ Execute = 'powershell.exe'; Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $env:ProgramFiles 'Enclave\update-host.ps1')`"" }) } }
function Get-ScheduledTaskInfo { param($TaskPath, $TaskName, $ErrorAction)
  [pscustomobject]@{ NextRunTime = $(if ($S.nextRunNull -or $S.taskDisabled) { $null } else { (Get-Date).AddSeconds([double]$S.nextRunSec) }); LastTaskResult = 0 } }
function Export-ScheduledTask { param($TaskPath, $TaskName) $script:Exp++
  if (($S.exportThrowOn -and @($S.exportThrowOn) -contains $script:Exp) -or ($S.exportThrowFrom -and $script:Exp -ge [int]$S.exportThrowFrom)) { throw "mock: Task Scheduler query failed (call $script:Exp)" }
  '<Task>update</Task>' }
function Get-CimInstance { param($ClassName, $Filter, $OperationTimeoutSec) $script:Cim++
  if ($S.updaterOnCall -and $script:Cim -ge [int]$S.updaterOnCall) { [pscustomobject]@{ ProcessId = 4242; CommandLine = 'powershell.exe -File "C:\Program Files\Enclave\update-host.ps1"' } } }
# descriptor store: Set-Acl records a path's SDDL with its content sha; with replaceDropsAcl the TARGET's descriptor drifts
# (as root observed natively) once its content changes without a Set-Acl afterwards, and stays drifted until the next Set-Acl
$script:AclStore = @{}; $script:TargetFull = [IO.Path]::GetFullPath((Join-Path $env:ProgramFiles 'Enclave\update-host.ps1'))
$ORIG = 'O:SYG:SYD:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)(A;ID;0x1200a9;;;AC)(A;ID;0x1200a9;;;S-1-15-2-2)'
$DRIFT = 'O:BAG:S-1-5-21-1-2-3-513D:AI(A;;FA;;;SY)(A;ID;FA;;;SY)(A;ID;FA;;;BA)(A;ID;0x1200a9;;;BU)(A;ID;0x1200a9;;;AC)(A;ID;0x1200a9;;;S-1-15-2-2)'
function FSha($p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function Set-Acl { param($LiteralPath, $AclObject)
  if ($S.setAclFailsOnTemp -and $LiteralPath -like '*.first-hop-*') { throw 'mock: The security identifier is not allowed to be the owner of this object' }
  $p = [IO.Path]::GetFullPath($LiteralPath); $script:AclStore[$p] = @{ sddl = $AclObject.Sddl; sha = (FSha $p); drift = $false } }
function Get-Acl { param($LiteralPath)
  $p = [IO.Path]::GetFullPath($LiteralPath); $private = (Test-Path -LiteralPath "$p.private-mock") -or ($S.privateRoots -contains $p)
  $sd = 'O:SYG:SYD:PAI(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x1200a9;;;BU)'
  if ($p -eq $script:TargetFull -and -not $script:AclStore.ContainsKey($p)) { $script:AclStore[$p] = @{ sddl = $(if ($S.targetSddl) { $S.targetSddl } else { $ORIG }); sha = (FSha $p); drift = $false } }
  if ($script:AclStore.ContainsKey($p)) { $e = $script:AclStore[$p]
    if ($S.replaceDropsAcl -and $p -eq $script:TargetFull -and (FSha $p) -ne $e.sha) { $e.drift = $true }
    $sd = $(if ($e.drift) { $DRIFT } else { $e.sddl }) }
  elseif ($p -like '*.first-hop-*') { $sd = $DRIFT }
  if ($S.aclChangeOnCandidate -and $p -eq $script:TargetFull -and (Test-Path -LiteralPath $p -PathType Leaf) -and (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() -eq $S.cand) { $sd = 'O:BUG:SYD:(A;;FA;;;WD)' }
  $o = [pscustomobject]@{ Sddl = $sd; AreAccessRulesProtected = $private }
  $o | Add-Member ScriptMethod GetOwner { param($t) [pscustomobject]@{ Value = 'S-1-5-32-544' } }
  $o | Add-Member -NotePropertyName Priv -NotePropertyValue $private
  $o | Add-Member ScriptMethod GetAccessRules { param($a, $b, $t) $r = @([pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = 'S-1-5-18' } })
    if (-not $this.Priv) { $r += [pscustomobject]@{ IdentityReference = [pscustomobject]@{ Value = 'S-1-5-32-545' } } }; $r }
  $o }
'''
REPL = {'function Test-Desktop51 { $PSVersionTable.PSVersion.Major -eq 5 -and [string]$PSVersionTable.PSEdition -eq \'Desktop\' }':
        'function Test-Desktop51 { -not $S.notDesktop }   # TEST: Linux pwsh is Core',
        "function New-PrivateDir([string]$d) {": "function Real-New-PrivateDir([string]$d) {",
        "function Journal($dir, $j, [string]$phase = '') {": "function Real-Journal($dir, $j, [string]$phase = '') {"}
MOCK_NEW_PRIVATE = ('\nfunction New-PrivateDir([string]$d) { [void][IO.Directory]::CreateDirectory($d); [IO.File]::WriteAllText("$([IO.Path]::GetFullPath($d)).private-mock", "") }\n'
    "function Journal($dir, $j, [string]$phase = '') { if ($S.journalFailPhase -and $phase -eq $S.journalFailPhase) { $out.journalError = 'mock: journal write failed'; return $false }; Real-Journal $dir $j $phase }\n")

def build(sc):
    t = pathlib.Path(tempfile.mkdtemp(prefix='first-hop-')); pf = t / 'PF/Enclave'; pd = t / 'PD'; st = t / 'stage'
    for d in (pf, pd / 'Enclave/node', pd / 'Enclave-setup/2026.10.12.46', pd / 'Enclave-setup/2026.10.12.47', st): d.mkdir(parents=True, exist_ok=True)
    (pf / 'update-host.ps1').write_bytes(sc.get('targetBytes', LIVE))
    (pf / 'manifest.json').write_text(json.dumps({'version': sc.get('version', '2026.10.12.47'), 'files': []}))
    (pd / 'Enclave/node/host.json').write_text(json.dumps({'name': 'nucbox', 'owner': 'o', **({'identity': {'mode': 'independent'}} if sc.get('independent') else {})}))
    cand = sc.get('candBytes', CAND); (st / 'update-host.first-hop.ps1').write_bytes(cand)
    script = pathlib.Path(os.environ.get('FH_SCRIPT', SRC / 'first-hop.ps1')).read_text()   # FH_SCRIPT: mutant runs only
    for a, b in REPL.items():
        if a.startswith('function Journal') and a not in script and os.environ.get('FH_SCRIPT'): continue   # pre-review negative control: no journal hook
        assert script.count(a) == 1, a; script = script.replace(a, b)
    mock = MOCK_NEW_PRIVATE if 'function Real-Journal' in script else MOCK_NEW_PRIVATE.split('\n')[1] + '\n'
    script = script.replace("\n# ---------------------------------------------------------------- run\n", '\n' + mock + "\n# ---------------------------------------------------------------- run\n", 1)
    (t / 'first-hop.test.ps1').write_text(script)
    if sc.get('backupRootPublic'): (pd / 'Enclave/update-host-first-hop').mkdir(parents=True)
    scen = {'taskState': 'Ready', 'nextRunSec': 3000, 'cand': sha(CAND), 'privateRoots': [], **{k: v for k, v in sc.items() if k not in ('targetBytes', 'candBytes')}}
    (t / 'scenario.json').write_text(json.dumps(scen))
    (t / 'wrapper.ps1').write_text(PRELUDE + "\n. (Join-Path $env:FH_ROOT 'first-hop.test.ps1') @args\nexit $global:LASTEXITCODE\n")
    return t

def run(t, *args):
    env = dict(os.environ, ProgramFiles=str(t / 'PF'), ProgramData=str(t / 'PD'), FH_SCENARIO=str(t / 'scenario.json'), FH_ROOT=str(t), FH_TRIP=str(t / 'trip.log'))
    p = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(t / 'wrapper.ps1'), '-Stage', str(t / 'stage'), '-WindowSec', '600', *args], capture_output=True, text=True, env=env, timeout=120)
    try: j = json.loads([l for l in p.stdout.splitlines() if l.strip().startswith('{')][-1])
    except Exception: j = {'unparsed': p.stdout[-600:], 'stderr': p.stderr[-600:]}
    return p.returncode, j

def target(t): return sha((t / 'PF/Enclave/update-host.ps1').read_bytes())[:8]
def leftovers(t): return [x.name for x in (t / 'PF/Enclave').iterdir() if '.first-hop-' in x.name]
def trips(t): return (t / 'trip.log').read_text().split() if (t / 'trip.log').exists() else []
RID = '20261022030000-0123abcd'; results = []
def why_in(j, w): return w in j.get('failedGates', [])
def case(name, cond, info=''):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name, '' if cond else info, flush=True)

def scenario(name, sc, mode, want_exit, want_target, extra=None, then=None):
    t = build(sc)
    try:
        rc, j = run(t, '-Mode', mode, *(['-RunId', RID] if mode != 'Check' else []))
        ok = rc == want_exit and target(t) == want_target and not leftovers(t) and not trips(t)
        info = json.dumps({'rc': rc, 'target': target(t), 'left': leftovers(t), 'trips': trips(t), 'j': j})[:1500]
        if ok and extra: ok = extra(t, j)
        case(name, ok, info)
        if then: then(t)
    finally: shutil.rmtree(t, ignore_errors=True)

journal = lambda t: json.loads((t / f'PD/Enclave/update-host-first-hop/{RID}/journal.json').read_text())
backup_ok = lambda t: sha((t / f'PD/Enclave/update-host-first-hop/{RID}/update-host.ps1.e0d9df1c').read_bytes()).startswith('e0d9df1c')
no_backup = lambda t: not (t / f'PD/Enclave/update-host-first-hop/{RID}').exists()

scenario('A check: all gates pass, nothing changed, no backup dir', {}, 'Check', 0, 'e0d9df1c',
         lambda t, j: j['ok'] and j['failedGates'] == [] and not (t / 'PD/Enclave/update-host-first-hop').exists() and j['facts']['setupDirPrivate'] is False and j['facts']['keptBundles'] == ['2026.10.12.46', '2026.10.12.47'])
def after_apply(t):
    rc, j = run(t, '-Mode', 'Rollback', '-RunId', RID)
    case('L rollback after A-apply: back to e0d9df1c, journal reverted, ACL same', rc == 0 and target(t) == 'e0d9df1c' and journal(t)['phase'] == 'reverted' and j['verify']['acl'] and not leftovers(t) and not trips(t), json.dumps(j)[:800])
    rc, j = run(t, '-Mode', 'Rollback', '-RunId', RID)
    case('L2 second rollback: target already live -> no-op exit 0', rc == 0 and target(t) == 'e0d9df1c' and 'nothing to roll back' in j.get('note', ''), json.dumps(j)[:500])
scenario('B apply: swapped to 36f9e0d6, private backup e0d9df1c, journal complete, ACL/parse/markers/task XML verified', {}, 'Apply', 0, '36f9e0d6',
         lambda t, j: backup_ok(t) and journal(t)['phase'] == 'complete' and all(j['verify'].values()), then=after_apply)
for name, sc, why in [('C refuse: target is not e0d9df1c (CAS)', {'targetBytes': b'# something else\n'}, 'targetIsExpected'),
                      ('D refuse: task Running', {'taskState': 'Running'}, 'taskWindow'),
                      ('E refuse: next scheduled run within the window', {'nextRunSec': 300}, 'taskWindow'),
                      ('F refuse: an updater/installer process is running', {'updaterOnCall': 1}, 'noUpdaterProcess'),
                      ('G refuse: staged candidate tampered', {'candBytes': CAND + b' '}, 'candidatePinnedParsed'),
                      ('H refuse: installed release is not 2026.10.12.47', {'version': '2026.10.20.1'}, 'installedRelease'),
                      ('I refuse: independent host (r5 would stop unsigned updates)', {'independent': True}, 'notIndependent'),
                      ('N refuse: existing backup root not private', {'backupRootPublic': True}, 'backupRootUsable')]:
    want_t = 'e0d9df1c' if name[0] != 'C' else sha(b'# something else\n')[:8]
    scenario(name, sc, 'Apply', 1, want_t, (lambda w: lambda t, j: why_in(j, w) and no_backup(t))(why))
scenario('J verification fails after replace (ACL changed) -> restored at once, exit 2', {'aclChangeOnCandidate': True}, 'Apply', 2, 'e0d9df1c',
         lambda t, j: journal(t)['phase'] == 'failed-restored' and j['verify']['acl'] is False and j['restore'] == 'restored' and backup_ok(t))
scenario('K updater appears between backup and replace -> abort, nothing changed', {'updaterOnCall': 2}, 'Apply', 1, 'e0d9df1c',
         lambda t, j: journal(t)['phase'] == 'aborted-no-change' and 'pre-replace' in j.get('error', ''))
scenario('M rollback refused: unknown target bytes', {'targetBytes': b'# unknown\n'}, 'Rollback', 1, sha(b'# unknown\n')[:8])
scenario('Q refuse: Update enabled but its next run is missing/invalid (UNKNOWN)', {'nextRunNull': True}, 'Apply', 1, 'e0d9df1c',
         lambda t, j: why_in(j, 'taskWindow') and no_backup(t))
scenario('Q2 explicitly disabled Update with no next run: Check passes (task left as is)', {'taskDisabled': True}, 'Check', 0, 'e0d9df1c',
         lambda t, j: j['ok'] and j['facts']['task']['enabled'] is False and j['facts']['task']['nextRunUtc'] is None)
scenario('R exception after the replace, before verification -> guarded restore, exit 2', {'exportThrowOn': [3]}, 'Apply', 2, 'e0d9df1c',
         lambda t, j: journal(t)['phase'] == 'failed-restored' and j['restore'] == 'restored' and 'post-replace error' in j['error'])
scenario('S exception after the replace AND the restore cannot read the task -> RECOVERY_REQUIRED, candidate NOT overwritten, exit 3', {'exportThrowFrom': 3}, 'Apply', 3, '36f9e0d6',
         lambda t, j: journal(t)['phase'] == 'RECOVERY_REQUIRED' and j['restore'].startswith('RECOVERY_REQUIRED: state unreadable') and backup_ok(t))
scenario('T verification fails and the task is Running at restore time -> RECOVERY_REQUIRED, no overwrite, exit 3', {'aclChangeOnCandidate': True, 'runningFromCall': 4}, 'Apply', 3, '36f9e0d6',
         lambda t, j: journal(t)['phase'] == 'RECOVERY_REQUIRED' and 'Update task is running' in j['restore'])
scenario('U journal write fails right after the replace -> treated as failure, guarded restore, exit 2', {'journalFailPhase': 'replaced'}, 'Apply', 2, 'e0d9df1c',
         lambda t, j: journal(t)['phase'] == 'failed-restored' and 'journal write failed after the replace' in j['error'])
# R3: only Ready+enabled+valid next, or Disabled+disabled+no next; everything else refuses BEFORE any write (next run 3000 s away)
for name, sc in [('V refuse: Update Queued (may start at once) although next run is far', {'taskState': 'Queued'}),
                 ('W refuse: Update state Unknown', {'taskState': 'Unknown'}),
                 ('X refuse: unrecognized scheduler state', {'taskState': 'Paused'}),
                 ('Y refuse: Enabled missing/non-boolean on a Ready task', {'enabledRaw': None}),
                 ('Z refuse: incoherent Disabled state with Enabled true', {'taskState': 'Disabled', 'enabledRaw': True})]:
    scenario(name, sc, 'Apply', 1, 'e0d9df1c', lambda t, j: why_in(j, 'taskWindow') and no_backup(t))
# r4: descriptor preservation (Windows Replace drift emulated as observed natively in root Apply 33600)
scenario('AA Replace drifts the descriptor -> r4 re-applies the original: exit 0, exact SDDL', {'replaceDropsAcl': True}, 'Apply', 0, '36f9e0d6',
         lambda t, j: j['verify']['acl'] is True and journal(t)['phase'] == 'complete')
scenario('AB the temp cannot carry the original descriptor -> refused BEFORE the replace, nothing changed', {'replaceDropsAcl': True, 'setAclFailsOnTemp': True}, 'Apply', 1, 'e0d9df1c',
         lambda t, j: 'the replace did not happen' in j.get('error', '') and journal(t)['phase'] == 'aborted-no-change')
scenario('AC target carries the r3 drift (not the original descriptor) -> refused at the gates', {'targetSddl': 'O:BAG:S-1-5-21-1-2-3-513D:AI(A;;FA;;;SY)(A;ID;FA;;;SY)'}, 'Apply', 1, 'e0d9df1c',
         lambda t, j: why_in(j, 'targetAclOriginal') and no_backup(t))
scenario('O not Windows PowerShell 5.1 Desktop -> exit 4 before anything', {'notDesktop': True}, 'Apply', 4, 'e0d9df1c', lambda t, j: no_backup(t))
t = build({})
try:
    env_rc, j = run(t, '-Mode', 'Apply')
    case('P apply without -RunId refused, nothing changed', env_rc == 1 and target(t) == 'e0d9df1c' and '-RunId' in j.get('error', '') and not trips(t), json.dumps(j)[:400])
finally: shutil.rmtree(t, ignore_errors=True)
print(json.dumps({'pass': sum(ok for _, ok in results), 'fail': sum(not ok for _, ok in results)}))
sys.exit(0 if all(ok for _, ok in results) else 1)
