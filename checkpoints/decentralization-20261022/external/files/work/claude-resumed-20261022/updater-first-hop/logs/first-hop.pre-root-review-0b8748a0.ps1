# updater FIRST HOP (ROOT-ONLY; Windows PowerShell 5.1). Replaces ONLY C:\Program Files\Enclave\update-host.ps1, in place:
#   live legacy e0d9df1c (2026.10.12.47)  ->  role-preserving update-host r5 36f9e0d6 (staged beside this script)
# Nothing else changes: not the installed manifest, the release policy (none), the \Enclave\Update task or any other task,
# process, service, VM, network, installer or bundle. The task is never started, stopped or edited; it is only READ.
#   -Mode Check     read-only: every gate, as JSON (exit 0 = Apply would proceed)
#   -Mode Apply     fresh gates -> private backup (SYSTEM/Administrators only) -> staged temp copy beside the target -> CAS
#                   re-check right before -> [IO.File]::Replace (keeps the target's ACL) -> verify sha/ACL/parse/markers/task
#                   XML; any verification failure restores the backup AT ONCE (before the task can run it) -> exit 2
#   -Mode Rollback  -RunId of a completed Apply: the same gates, CAS from 36f9e0d6 back to the backed-up e0d9df1c
# Exit: 0 done (or Check passes); 1 refused, nothing changed; 2 applied then verification failed and RESTORED; 3 ROOT
#       (restore failed or unexpected state: journal kept); 4 not Windows PowerShell 5.1 Desktop.
param([ValidateSet('Check', 'Apply', 'Rollback')][string]$Mode = 'Check', [string]$Stage = '', [string]$RunId = '', [int]$WindowSec = 600)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$LiveSha = 'e0d9df1c271bf09cc21e8f00452fd0415087fb33b8030a7d16bbd717b7058531'
$CandSha = '36f9e0d61afe58b77e566033ad1155d5c771252874f622592837c33e0a990112'
$VERSION = '2026.10.12.47'
$MARKERS = @('ENCLAVE-ROLLBACK-GUARD-V1', 'ENCLAVE-RELEASE-POLICY-V1')
$SY = 'S-1-5-18'; $BA = 'S-1-5-32-544'
$PF = Join-Path $env:ProgramFiles 'Enclave'; $PDATA = $env:ProgramData
$Target = Join-Path $PF 'update-host.ps1'
$CandFile = Join-Path $Stage 'update-host.first-hop.ps1'
$BackupRoot = Join-Path $PDATA 'Enclave\update-host-first-hop'
$out = [ordered]@{ ok = $false; mode = $Mode; runId = $RunId; target = $Target }
function Finish([int]$code) { $out.exit = $code; $out | ConvertTo-Json -Compress -Depth 6; exit $code }
trap { $out.error = 'error: ' + $_.Exception.Message; Finish 3 }

function Test-Desktop51 { $PSVersionTable.PSVersion.Major -eq 5 -and [string]$PSVersionTable.PSEdition -eq 'Desktop' }
function Sha([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() } else { 'absent' } }
function TextSha([string]$t) { -join ([Security.Cryptography.SHA256]::Create().ComputeHash((New-Object Text.UTF8Encoding $false).GetBytes($t)) | ForEach-Object { $_.ToString('x2') }) }
function IsReparse([string]$p) { (Test-Path -LiteralPath $p) -and [bool]((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) }
function Sddl([string]$p) { (Get-Acl -LiteralPath $p).Sddl }
function ParseErrors([string]$p) { $t = $null; $e = $null; [void][Management.Automation.Language.Parser]::ParseFile($p, [ref]$t, [ref]$e); @($e).Count }
function Markers([string]$p) { $txt = [IO.File]::ReadAllText($p); @($MARKERS | Where-Object { -not $txt.Contains($_) }) }
# SYSTEM's and Administrators' alone (the rule update-host r5 SecureWorkDir and install-host Test-PrivateDir apply)
function IsPrivate([string]$d) {
  if (-not (Test-Path -LiteralPath $d -PathType Container) -or (IsReparse $d)) { return $false }
  $a = Get-Acl -LiteralPath $d; $sid = [Security.Principal.SecurityIdentifier]
  $others = @($a.GetAccessRules($true, $true, $sid) | Where-Object { @($SY, $BA) -notcontains $_.IdentityReference.Value })
  return $a.AreAccessRulesProtected -and @($SY, $BA) -contains $a.GetOwner($sid).Value -and $others.Count -eq 0 }
function New-PrivateDir([string]$d) {
  $ds = New-Object Security.AccessControl.DirectorySecurity; $ds.SetSecurityDescriptorSddlForm('O:BAD:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
  [void][IO.Directory]::CreateDirectory($d, $ds) }
function UpdaterProcesses {   # read-only: any powershell running update-host.ps1 / install-host.ps1 (not this process)
  @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -OperationTimeoutSec 30 |
    Where-Object { $_.ProcessId -ne $PID -and ([string]$_.CommandLine -match '(?i)(update-host|install-host)\.ps1') } | ForEach-Object { [int]$_.ProcessId }) }
function TaskFacts {
  $t = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction Stop
  $i = Get-ScheduledTaskInfo -TaskPath '\Enclave\' -TaskName 'Update' -ErrorAction Stop
  $next = $i.NextRunTime; $nextUtc = $(if ($next -and $next.Year -gt 2000) { $next.ToUniversalTime() } else { $null })
  [ordered]@{ state = [string]$t.State; enabled = [bool]$t.Settings.Enabled
    action = (@($t.Actions | ForEach-Object { "$($_.Execute) $($_.Arguments)" }) -join ' | ')
    nextRunUtc = $(if ($nextUtc) { $nextUtc.ToString('o') } else { $null }); secondsToNext = $(if ($nextUtc) { [math]::Floor(($nextUtc - (Get-Date).ToUniversalTime()).TotalSeconds) } else { $null })
    lastResult = $i.LastTaskResult; xmlSha = (TextSha ([string](Export-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Update'))) } }
function Window($task, [int]$sec) {   # the task is not running and its next scheduled run is not within $sec
  $task.state -ne 'Running' -and ($null -eq $task.secondsToNext -or $task.secondsToNext -gt $sec) }
function Gates([string]$want) {
  $g = [ordered]@{}; $f = [ordered]@{}
  $f.task = TaskFacts; $f.updaterProcesses = @(UpdaterProcesses)
  $f.targetSha = Sha $Target; $f.targetReparse = IsReparse $Target; $f.targetSddl = $(if (Test-Path -LiteralPath $Target) { Sddl $Target } else { $null })
  $f.manifestVersion = [string](Get-Content -LiteralPath (Join-Path $PF 'manifest.json') -Raw | ConvertFrom-Json).version
  $f.releasePolicy = Test-Path -LiteralPath (Join-Path $PDATA 'Enclave\node\release-policy.json')
  # ONE boolean from node\host.json (no other field is read or reported): r5 refuses the unsigned channel on an independent host
  $f.independent = $(try { $h = Get-Content -LiteralPath (Join-Path $PDATA 'Enclave\node\host.json') -Raw | ConvertFrom-Json; [bool]($h.identity -and $h.identity.mode -eq 'independent') } catch { 'unreadable' })
  $ws = Join-Path $PDATA 'Enclave-setup'
  $f.setupDirPrivate = IsPrivate $ws
  $f.keptBundles = @(if (Test-Path -LiteralPath $ws) { Get-ChildItem -LiteralPath $ws -Directory | ForEach-Object Name | Where-Object { $_ -match '^\d+(\.\d+){1,3}$' } })
  $f.backupRootExists = Test-Path -LiteralPath $BackupRoot; $f.backupRootPrivate = $(if ($f.backupRootExists) { IsPrivate $BackupRoot } else { $null })
  $f.candidateSha = Sha $CandFile; $f.candidateParseErrors = $(if (Test-Path -LiteralPath $CandFile) { ParseErrors $CandFile } else { -1 })
  # no $(...) here: it turns an empty list into $null, and @($null).Count is 1
  $miss = @('absent'); if (Test-Path -LiteralPath $CandFile) { $miss = @(Markers $CandFile) }; $f.candidateMissingMarkers = $miss
  $g.windowsPowerShell51 = Test-Desktop51
  $g.targetIsExpected = ($f.targetSha -eq $want) -and -not $f.targetReparse
  $g.candidatePinnedParsed = ($f.candidateSha -eq $CandSha) -and $f.candidateParseErrors -eq 0 -and $miss.Count -eq 0
  $g.installedRelease = ($f.manifestVersion -eq $VERSION)
  $g.taskRunsTarget = ($f.task.action -match [regex]::Escape($Target))
  $g.taskWindow = Window $f.task $WindowSec
  $g.noUpdaterProcess = (@($f.updaterProcesses).Count -eq 0)
  $g.notIndependent = ($f.independent -eq $false)
  $g.noReleasePolicy = ($f.releasePolicy -eq $false)
  $g.backupRootUsable = (-not $f.backupRootExists) -or ($f.backupRootPrivate -eq $true)
  @{ gates = $g; facts = $f } }
function Journal($dir, $j) { [IO.File]::WriteAllText((Join-Path $dir 'journal.json'), ($j | ConvertTo-Json -Depth 6)) }
function Swap([string]$from, [string]$expect, [string]$tag) {   # staged copy beside the target, verified, then atomic replace
  $tmp = "$Target.first-hop-$tag-$RunId"
  [IO.File]::Copy($from, $tmp, $true)
  if ((Sha $tmp) -ne $expect) { [IO.File]::Delete($tmp); throw "staged copy is not $expect" }
  [IO.File]::Replace($tmp, $Target, [NullString]::Value) }

# ---------------------------------------------------------------- run
if (-not (Test-Desktop51)) { $out.error = 'not Windows PowerShell 5.1 Desktop'; Finish 4 }
if ($Mode -ne 'Check' -and $RunId -notmatch '^[0-9]{14}-[0-9a-f]{8}$') { $out.error = '-RunId yyyyMMddHHmmss-<8 hex> is required'; Finish 1 }
$want = $(if ($Mode -eq 'Rollback') { $CandSha } else { $LiveSha })
$r = Gates $want; $out.gates = $r.gates; $out.facts = $r.facts
$failed = @($r.gates.Keys | Where-Object { -not $r.gates[$_] }); $out.failedGates = $failed
if ($Mode -eq 'Rollback' -and $r.facts.targetSha -eq $LiveSha) { $out.ok = $true; $out.note = 'the target already holds the live e0d9df1c: nothing to roll back'; Finish 0 }
if ($Mode -eq 'Rollback') { $failed = @($failed | Where-Object { $_ -ne 'candidatePinnedParsed' -and $_ -ne 'backupRootUsable' }) }   # rollback needs only the backup
if ($failed.Count) { $out.error = 'refused before any change'; Finish 1 }
if ($Mode -eq 'Check') { $out.ok = $true; Finish 0 }
$sddl0 = $r.facts.targetSddl; $xml0 = $r.facts.task.xmlSha
$run = Join-Path $BackupRoot $RunId; $backup = Join-Path $run 'update-host.ps1.e0d9df1c'

if ($Mode -eq 'Apply') {
  if (-not (Test-Path -LiteralPath $BackupRoot)) { New-PrivateDir $BackupRoot }
  if (-not (IsPrivate $BackupRoot)) { $out.error = "$BackupRoot is not SYSTEM's and Administrators' alone"; Finish 1 }
  if (Test-Path -LiteralPath $run) { $out.error = "run $RunId already exists"; Finish 1 }
  New-PrivateDir $run
  $j = [ordered]@{ runId = $RunId; from = $LiveSha; to = $CandSha; target = $Target; sddl = $sddl0; taskXmlSha = $xml0; phase = 'started' }; Journal $run $j
  [IO.File]::Copy($Target, $backup, $false)
  if ((Sha $backup) -ne $LiveSha) { $j.phase = 'backup-mismatch'; Journal $run $j; $out.error = 'backup is not e0d9df1c'; Finish 1 }
  $j.phase = 'backed-up'; Journal $run $j
  # CAS immediately before the replace: still the live bytes, the task still not running / not due, no updater running
  $t1 = TaskFacts
  if ((Sha $Target) -ne $LiveSha -or -not (Window $t1 120) -or @(UpdaterProcesses).Count -ne 0) {
    $j.phase = 'aborted-no-change'; Journal $run $j; $out.error = 'pre-replace re-check failed: nothing changed'; Finish 1 }
  $j.phase = 'replacing'; Journal $run $j
  Swap $CandFile $CandSha 'new'
  $j.phase = 'replaced'; Journal $run $j
  $v = [ordered]@{ sha = ((Sha $Target) -eq $CandSha); acl = ((Sddl $Target) -eq $sddl0); parse = ((ParseErrors $Target) -eq 0); markers = (@(Markers $Target).Count -eq 0)
                   notReparse = -not (IsReparse $Target); taskXml = ((TaskFacts).xmlSha -eq $xml0); noTemp = -not (Test-Path -LiteralPath "$Target.first-hop-new-$RunId") }
  $out.verify = $v
  if (@($v.Values | Where-Object { -not $_ }).Count -eq 0) { $j.phase = 'complete'; Journal $run $j; $out.ok = $true; $out.backup = $backup; Finish 0 }
  # restore NOW (seconds after the replace; the window gate left >= 120 s before the next scheduled run)
  try { Swap $backup $LiveSha 'restore' } catch { }
  $back = ((Sha $Target) -eq $LiveSha) -and ((Sddl $Target) -eq $sddl0)
  $j.phase = $(if ($back) { 'verify-failed-restored' } else { 'verify-failed-RESTORE-FAILED' }); Journal $run $j
  $out.error = 'post-replace verification failed: ' + (@($v.Keys | Where-Object { -not $v[$_] }) -join ', ')
  Finish $(if ($back) { 2 } else { 3 })
}
# Rollback
$jf = Join-Path $run 'journal.json'
if (-not (Test-Path -LiteralPath $jf) -or -not (IsPrivate $run)) { $out.error = "no private journal for run $RunId"; Finish 1 }
$j = Get-Content -LiteralPath $jf -Raw | ConvertFrom-Json
if ($j.phase -ne 'complete' -or (Sha $backup) -ne $LiveSha) { $out.error = 'that run is not a completed first hop with an intact e0d9df1c backup'; Finish 1 }
$t1 = TaskFacts
if ((Sha $Target) -ne $CandSha -or -not (Window $t1 120) -or @(UpdaterProcesses).Count -ne 0) { $out.error = 'pre-replace re-check failed: nothing changed'; Finish 1 }
Swap $backup $LiveSha 'revert'
$v = [ordered]@{ sha = ((Sha $Target) -eq $LiveSha); acl = ((Sddl $Target) -eq $sddl0); parse = ((ParseErrors $Target) -eq 0); taskXml = ((TaskFacts).xmlSha -eq $xml0) }
$out.verify = $v
$j.phase = $(if (@($v.Values | Where-Object { -not $_ }).Count -eq 0) { 'reverted' } else { 'revert-verify-failed' }); Journal $run $j
if ($j.phase -eq 'reverted') { $out.ok = $true; Finish 0 }
$out.error = 'revert verification failed: ' + (@($v.Keys | Where-Object { -not $v[$_] }) -join ', '); Finish 3
