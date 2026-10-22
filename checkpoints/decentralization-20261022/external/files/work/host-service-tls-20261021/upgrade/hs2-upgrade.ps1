#Requires -RunAsAdministrator
# PREPARED FOR ROOT REVIEW (not yet reviewed or approved; never run by Claude). Windows PowerShell 5.1.
# Transactional IN-PLACE upgrade of the installed Windows host-services stage hs2 (work/host-service-tls-20261021/upgrade).
# It replaces program files and the configuration named in a PINNED upgrade manifest (make-upgrade-bundle.py), nothing else:
#   - data\ and state\ are never written, copied or restored. The replay floors (route, policy, management) live in state\
#     and therefore only move forward, on success AND on rollback. They are fingerprinted (names, sizes, write times) only
#     while the stage is STOPPED, to prove this helper did not touch them.
#   - Only program files, host-services.json and install-receipt.txt are backed up (root\upgrades\<runId>\backup), and
#     restored only on failure, on -Mode Recover or on -Mode Revert.
#   - Every write is temp-in-same-directory + sha256 check + [IO.File]::Replace (keeps the target's ACL) or a Move for a
#     new file. Every restore is compare-and-swap: a file is restored only from a KNOWN digest (the pinned new one, or the
#     receipt digest this run generated and journaled BEFORE writing it); anything else is reported and left alone.
#   - The scheduled task is never modified (export XML compared): it stays manual, with no trigger. It is stopped ONCE, only
#     if running, with the INSTALLED pinned windows\stop.ps1, and restarted only if it was running, with the installed
#     pinned windows\start.ps1 (start + health). Both, and the runner check, run as bounded subprocesses (timeout, then
#     tree kill).
#   - Crash safety: run dir + journal are written first; the lock (root\upgrades\active.lock) is then created atomically
#     WITH its content; installation files change only after that. An interrupted run is resolved by -Mode Recover.
# Modes:
#   Upgrade  (default) preflight (no change) -> journal -> lock -> stop if running -> backup -> replace/add -> config ->
#            receipt -> stopped-window invariants -> runner check -> start + health if it was running -> done.
#            On failure: restore files (CAS), restart the OLD code if it was running, and give a clean verdict (exit 2) only
#            if the old code is HEALTHY again; otherwise exit 3 with the lock and journal kept.
#   Recover  resolve an interrupted run (lock present): restore files by CAS. A missing/empty journal or lock is safe only
#            when every target already holds its old digest (then: no write, the lock is removed). The task stays stopped.
#   Revert   after a COMPLETED upgrade (-RevertRunId): the same CAS restore from the new digests, with the stop/start rule.
#            It never restores older state.
# Exit codes: 0 done; 1 refused or aborted before any installation change; 2 failed, files restored, old code healthy (or
#             it was not running); 3 needs root: restore refused/incomplete, or the old code is not healthy (lock kept).
# Isolated (fixture) install: -InstallRoot <dir under C:\ProgramData> -TaskName <name>, exactly as the r3 stage scripts.
# -FaultAt (fixture only) injects a throw (<point>) or a hard crash (crash:<point>). Production paths refuse -FaultAt.
param(
  [Parameter(Mandatory = $true)][string]$Bundle,
  [Parameter(Mandatory = $true)][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ManifestSha256,
  [ValidateSet('Upgrade', 'Recover', 'Revert')][string]$Mode = 'Upgrade',
  [string]$RevertRunId = '',
  [int]$HealthWaitSeconds = 600,
  [int]$StopTimeoutSeconds = 120,
  [string]$InstallRoot = '',
  [string]$TaskName = '',
  [string]$FaultAt = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3

# ---------------------------------------------------------------- paths (the r3 Use-StageRoot rules)
$Iso = $InstallRoot
if ($Iso -or $TaskName) {
  if (-not ($Iso -and $TaskName)) { Write-Output 'RESULT {"ok":false,"exit":1,"error":"-InstallRoot and -TaskName go together"}'; exit 1 }
  if ($Iso -notmatch '^C:\\ProgramData\\[^\\]' -or $Iso.EndsWith('\') -or [IO.Path]::GetFullPath($Iso) -ne $Iso -or $Iso.Contains('/')) {
    Write-Output 'RESULT {"ok":false,"exit":1,"error":"-InstallRoot must be a canonical path under C:\\ProgramData"}'; exit 1 }
  $low = $Iso.ToLowerInvariant() + '\'
  foreach ($p in 'C:\ProgramData\Enclave\host-services\', 'C:\Program Files\Enclave\') {
    $q = $p.ToLowerInvariant(); if ($low.StartsWith($q) -or $q.StartsWith($low)) { Write-Output 'RESULT {"ok":false,"exit":1,"error":"-InstallRoot overlaps a production path"}'; exit 1 } }
  if ($TaskName -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' -or $TaskName -like 'enclave-host-services-*') { Write-Output 'RESULT {"ok":false,"exit":1,"error":"-TaskName is not a distinct task name"}'; exit 1 }
  $OptDir = $Iso + '\program'; $RootDir = $Iso + '\root'; $TaskFolder = '\'; $TaskLeaf = $TaskName
  $IsoArgs = @('-InstallRoot', $Iso, '-TaskName', $TaskName)
} else {
  if ($FaultAt) { Write-Output 'RESULT {"ok":false,"exit":1,"error":"-FaultAt is for an isolated fixture install only"}'; exit 1 }
  $OptDir = 'C:\Program Files\Enclave\host-services\hs2'; $RootDir = 'C:\ProgramData\Enclave\host-services\hs2'
  $TaskFolder = '\Enclave\'; $TaskLeaf = 'enclave-host-services-hs2'; $IsoArgs = @()
}
$CfgDir = $RootDir + '\config'; $DataDir = $RootDir + '\data'; $StateDir = $RootDir + '\state'
$ConfigPath = $CfgDir + '\host-services.json'; $ReceiptPath = $CfgDir + '\install-receipt.txt'
$UpDir = $RootDir + '\upgrades'; $LockPath = $UpDir + '\active.lock'
$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# ---------------------------------------------------------------- helpers
$Out = [ordered]@{ ok = $false; mode = $Mode; installRoot = $RootDir; task = $TaskFolder + $TaskLeaf; steps = @(); restoreRefused = @() }
$RunId = ''; $RunDir = ''; $J = $null
function Note([string]$s) { $Out.steps += ((Get-Date).ToUniversalTime().ToString('HH:mm:ss') + ' ' + $s) }
function Finish([int]$code) { $Out.exit = $code; Write-Output ('RESULT ' + ($Out | ConvertTo-Json -Compress -Depth 6)); exit $code }
function Refuse([string]$msg) { $Out.error = $msg; Finish 1 }
function Sha([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() }
# the text of a file, '' when it is empty, missing or unreadable. Windows PowerShell 5.1: Get-Content -Raw on an EMPTY
# file yields no object at all, and ([string](...)).Trim() then throws (root's native fixture, emptylock, 2026-10-21).
function ReadTextOrEmpty([string]$p) { try { if (Test-Path -LiteralPath $p -PathType Leaf) { return [string][IO.File]::ReadAllText($p) } } catch {}; return '' }
function ShaOrAbsent([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { Sha $p } else { 'absent' } }
function ShaText([string]$t) { $h = [Security.Cryptography.SHA256]::Create(); -join ($h.ComputeHash((New-Object System.Text.UTF8Encoding $false).GetBytes($t)) | ForEach-Object { $_.ToString('x2') }) }
function Get-Task { Get-ScheduledTask -TaskPath $TaskFolder -TaskName $TaskLeaf -ErrorAction SilentlyContinue }
function TaskXmlSha { ShaText ([string](Export-ScheduledTask -TaskPath $TaskFolder -TaskName $TaskLeaf)) }
function Fingerprint([string]$dir) {
  # names, sizes and write times only, never the content (data is 9+ GB; state belongs to the service)
  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return 'absent' }
  $base = (Resolve-Path -LiteralPath $dir).ProviderPath.TrimEnd('\') + '\'
  ShaText ((Get-ChildItem -LiteralPath $dir -Recurse -Force -File | Sort-Object FullName | ForEach-Object { $_.FullName.Substring($base.Length) + '|' + $_.Length + '|' + $_.LastWriteTimeUtc.Ticks }) -join "`n")
}
function WriteAtomicText([string]$path, [string]$text) {
  $tmp = $path + '.tmp-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
  [IO.File]::WriteAllText($tmp, $text, (New-Object System.Text.UTF8Encoding $false))
  if (Test-Path -LiteralPath $path) { [IO.File]::Replace($tmp, $path, [NullString]::Value) } else { [IO.File]::Move($tmp, $path) }
}
# copy src -> temp beside target, verify, then atomically replace (ACL kept) or create the target
function Put-File([string]$src, [string]$dest, [string]$expect) {
  $tmp = $dest + '.upgrade-' + $RunId
  Copy-Item -LiteralPath $src -Destination $tmp -Force
  if ((Sha $tmp) -ne $expect) { Remove-Item -LiteralPath $tmp -Force; throw "staged copy for $dest is not $expect" }
  if (Test-Path -LiteralPath $dest) { [IO.File]::Replace($tmp, $dest, [NullString]::Value) } else { [IO.File]::Move($tmp, $dest) }
  if ((Sha $dest) -ne $expect) { throw "$dest is not $expect after the replacement" }
}
# a bounded subprocess; on timeout the whole process tree is killed. -> exit code (-1 = timed out)
function Invoke-Bounded([string]$exe, [string[]]$argList, [int]$seconds, [string]$tag) {
  $log = Join-Path $RunDir ($tag + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.log')
  $p = Start-Process -FilePath $exe -ArgumentList $argList -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError ($log + '.err')
  $null = $p.Handle   # cache the handle now, or Windows PowerShell may report a null ExitCode
  if (-not $p.WaitForExit($seconds * 1000)) {
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $p.Id /T /F 2>&1 | Out-Null
    if (-not $p.WaitForExit(30000)) { Note "$tag TIMED OUT after $seconds s and did NOT end after the tree kill"; return -2 }
    Note "$tag TIMED OUT after $seconds s (tree killed, ended)"; return -1
  }
  $p.WaitForExit(); Note "$tag exit $($p.ExitCode)"
  return $p.ExitCode
}
# run an INSTALLED stage script, re-verifying its pinned sha immediately before
function Invoke-StageScript([string]$rel, [string[]]$extra, [int]$seconds) {
  $path = Join-Path $OptDir ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Sha $path) -ne [string]$M.scripts.$rel) { throw "installed $rel is not its pinned sha" }
  $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $path + '"')) + @($IsoArgs | ForEach-Object { '"' + $_ + '"' }) + $extra
  return (Invoke-Bounded $PsExe $argList $seconds ($rel -replace '[/\\]', '_'))
}
function Save-Journal { WriteAtomicText (Join-Path $RunDir $JournalName) ($J | ConvertTo-Json -Depth 6) }
function Fault([string]$at) { if ($FaultAt -eq $at) { throw "injected fault at $at" } }
function Crash([string]$at) { if ($FaultAt -eq ('crash:' + $at)) { [Environment]::Exit(9) } }

# ---------------------------------------------------------------- manifest (pinned)
$ManifestPath = Join-Path $Bundle 'upgrade-manifest.json'
if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) { Refuse 'no upgrade-manifest.json in the bundle' }
if ((Sha $ManifestPath) -ne $ManifestSha256.ToLowerInvariant()) { Refuse 'the manifest is not the pinned sha256' }
$M = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
# every field is required (StrictMode refuses reading an absent property, so check presence first)
foreach ($k in 'format', 'label', 'id', 'scripts', 'replace', 'add', 'unchanged', 'config', 'receipt') { if ($M.PSObject.Properties.Name -notcontains $k) { Refuse "the manifest has no '$k'" } }
if ($M.format -ne 'enclave-hs2-upgrade/v1' -or $M.label -ne 'hs2') { Refuse 'not an enclave-hs2-upgrade/v1 manifest for hs2' }
foreach ($k in 'windows/stop.ps1', 'windows/start.ps1', 'windows/health.ps1') { if ($M.scripts.PSObject.Properties.Name -notcontains $k) { Refuse "the manifest pins no $k" } }
foreach ($k in 'old', 'new') { if ($M.config.PSObject.Properties.Name -notcontains $k) { Refuse "the manifest config has no $k" } }
if ($M.receipt.PSObject.Properties.Name -notcontains 'old') { Refuse 'the manifest pins no receipt' }
$RelOk = '^((bin|packages|windows)/[A-Za-z0-9._-]+|STAGE-SHA256SUMS|ACTIVATION-WINDOWS\.txt)$'
$Shaq = '^[0-9a-f]{64}$'
$Replace = @($M.replace | Where-Object { $_ }); $Add = @($M.add | Where-Object { $_ })
foreach ($r in $Replace) { if ([string]$r.path -notmatch $RelOk -or [string]$r.old -notmatch $Shaq -or [string]$r.new -notmatch $Shaq -or $r.old -eq $r.new) { Refuse "bad replace entry $($r.path)" } }
foreach ($a in $Add) { if ([string]$a.path -notmatch $RelOk -or [string]$a.new -notmatch $Shaq) { Refuse "bad add entry $($a.path)" } }
foreach ($k in 'windows/stop.ps1', 'windows/start.ps1', 'windows/health.ps1') { if ([string]$M.scripts.$k -notmatch $Shaq) { Refuse "bad pin for $k" } }
$Touched = @($Replace | ForEach-Object { $_.path }) + @($Add | ForEach-Object { $_.path })
foreach ($k in 'windows/stop.ps1', 'windows/start.ps1', 'windows/health.ps1', 'windows/common.ps1') { if ($Touched -contains $k) { Refuse "the upgrade may not replace $k (it runs the stop/start)" } }
if ([string]$M.config.old -notmatch $Shaq -or [string]$M.config.new -notmatch $Shaq -or [string]$M.receipt.old -notmatch $Shaq) { Refuse 'bad config/receipt pins' }
$Out.manifest = $ManifestSha256.ToLowerInvariant(); $Out.upgradeId = [string]$M.id
$TargetOf = { param($rel) Join-Path $OptDir ($rel -replace '/', '\') }
$JournalName = if ($Mode -eq 'Revert') { 'revert-journal.json' } else { 'journal.json' }

# ---------------------------------------------------------------- CAS restore: FILES ONLY
# Each target: old -> skip; a KNOWN digest (pinned new, or the journaled generated receipt) -> restore from the verified
# backup; anything else -> refused and reported (never overwritten). Temp leftovers of the run are removed.
function Restore-Files([string]$fromDir, [string]$receiptNew) {
  $bk = Join-Path $fromDir 'backup'; $ok = $true
  $plan = @()
  foreach ($r in $Replace) { $plan += , @((& $TargetOf $r.path), $r.old, @($r.new), (Join-Path $bk ('opt\' + ($r.path -replace '/', '\')))) }
  $plan += , @($ConfigPath, $M.config.old, @($M.config.new), (Join-Path $bk 'config\host-services.json'))
  $plan += , @($ReceiptPath, $M.receipt.old, @($(if ($receiptNew) { $receiptNew } else { 'none' })), (Join-Path $bk 'config\install-receipt.txt'))
  # check everything first: a single unknown digest refuses the whole restore (no partial restore over unknown content)
  foreach ($x in $plan) { $cur = ShaOrAbsent $x[0]; if ($cur -ne $x[1] -and -not ($x[2] -contains $cur)) { $Out.restoreRefused += @("$($x[0]) has unknown sha $cur"); $ok = $false } }
  foreach ($a in $Add) { $t = & $TargetOf $a.path; $cur = ShaOrAbsent $t; if ($cur -ne 'absent' -and $cur -ne $a.new) { $Out.restoreRefused += @("$t has unknown sha $cur"); $ok = $false } }
  if (-not $ok) { return $false }
  foreach ($x in $plan) { if ((ShaOrAbsent $x[0]) -ne $x[1]) { Put-File $x[3] $x[0] $x[1] } }   # Put-File verifies the backup is the old digest
  foreach ($a in $Add) { $t = & $TargetOf $a.path; if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force } }
  $leaf = Split-Path -Leaf $fromDir
  foreach ($x in @($Touched | ForEach-Object { & $TargetOf $_ }) + @($ConfigPath, $ReceiptPath)) { $t = $x + '.upgrade-' + $leaf; if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force } }
  $t = $ReceiptPath + '.new-' + $leaf; if (Test-Path -LiteralPath $t) { Remove-Item -LiteralPath $t -Force }
  foreach ($x in $plan) { if ((ShaOrAbsent $x[0]) -ne $x[1]) { return $false } }
  foreach ($a in $Add) { if (Test-Path -LiteralPath (& $TargetOf $a.path)) { return $false } }
  return $true
}
function All-Old {
  foreach ($r in $Replace) { if ((ShaOrAbsent (& $TargetOf $r.path)) -ne $r.old) { return $false } }
  foreach ($a in $Add) { if (Test-Path -LiteralPath (& $TargetOf $a.path)) { return $false } }
  return ((ShaOrAbsent $ConfigPath) -eq $M.config.old) -and ((ShaOrAbsent $ReceiptPath) -eq $M.receipt.old)
}

# ---------------------------------------------------------------- Recover
if ($Mode -eq 'Recover') {
  if (-not (Test-Path -LiteralPath $LockPath)) { Refuse 'no active upgrade to recover' }
  $lockId = (ReadTextOrEmpty $LockPath).Trim()
  $jPath = if ($lockId -match '^[0-9]{14}-[0-9a-f]{8}$') { Join-Path (Join-Path $UpDir $lockId) 'journal.json' } else { '' }
  # a journal that is missing, empty or not JSON counts as no usable journal (same no-write rule below)
  $J = $null
  if ($jPath) { $jText = ReadTextOrEmpty $jPath; if ($jText.Trim()) { try { $J = $jText | ConvertFrom-Json } catch { $J = $null } } }
  if (-not $J -or $J.PSObject.Properties.Name -notcontains 'manifest') {
    # no usable lock content or journal: safe only if nothing in the installation changed
    if (All-Old) { Remove-Item -LiteralPath $LockPath -Force; $Out.ok = $true; Note 'lock without a usable journal; every target holds its old digest: lock removed, nothing written'; Finish 0 }
    $Out.error = 'lock without a usable journal and the installation differs from the old pins: root must inspect'; Finish 3
  }
  $RunId = $lockId; $RunDir = Join-Path $UpDir $RunId; $Out.runId = $RunId; $JournalName = 'journal.json'
  if ($J.manifest -ne $Out.manifest) { Refuse 'the active run used another manifest' }
  $rn = if ($J.PSObject.Properties.Name -contains 'receiptNew') { [string]$J.receiptNew } else { '' }
  $t = Get-Task
  if ($t -and $t.State -eq 'Running') { if ((Invoke-StageScript 'windows/stop.ps1' @() $StopTimeoutSeconds) -ne 0) { $Out.error = 'stop failed'; Finish 3 } }
  if (Restore-Files $RunDir $rn) { $J.phase = 'recovered'; Save-Journal; Remove-Item -LiteralPath $LockPath -Force; $Out.ok = $true; Note 'recovered: old files restored by CAS; state untouched; task left stopped'; Finish 0 }
  $Out.error = 'recover refused or incomplete (see restoreRefused)'; Finish 3
}

# ---------------------------------------------------------------- preflight (no change)
if (Test-Path -LiteralPath $LockPath) { Refuse 'an earlier upgrade is unresolved: run -Mode Recover first' }
$task = Get-Task
if (-not $task) { Refuse "task $TaskFolder$TaskLeaf is absent" }
foreach ($k in 'windows/stop.ps1', 'windows/start.ps1', 'windows/health.ps1') { $p = & $TargetOf $k; if ((ShaOrAbsent $p) -ne [string]$M.scripts.$k) { Refuse "installed $k is not pinned" } }
if (-not (Test-Path -LiteralPath $ReceiptPath) -or @(Get-Content -LiteralPath $ReceiptPath)[-1] -ne 'complete') { Refuse 'the install receipt is missing or incomplete' }
$receiptNewForRevert = ''
if ($Mode -eq 'Revert') {
  if ($RevertRunId -notmatch '^[0-9]{14}-[0-9a-f]{8}$') { Refuse '-RevertRunId <runId of a completed upgrade> is required' }
  $revertJournalPath = Join-Path (Join-Path $UpDir $RevertRunId) 'journal.json'
  if (-not (Test-Path -LiteralPath $revertJournalPath)) { Refuse 'no journal for that run' }
  $JR = $null; $jrText = ReadTextOrEmpty $revertJournalPath
  if ($jrText.Trim()) { try { $JR = $jrText | ConvertFrom-Json } catch { $JR = $null } }
  if (-not $JR -or $JR.PSObject.Properties.Name -notcontains 'phase') { Refuse 'that run journal is empty or unreadable' }
  if ($JR.manifest -ne $Out.manifest -or $JR.phase -ne 'complete') { Refuse 'that run is not a completed upgrade with this manifest' }
  $receiptNewForRevert = [string]$JR.receiptNew
  foreach ($r in $Replace) { if ((ShaOrAbsent (& $TargetOf $r.path)) -ne $r.new) { Refuse "revert: $($r.path) is not the upgraded sha" } }
  foreach ($a in $Add) { if ((ShaOrAbsent (& $TargetOf $a.path)) -ne $a.new) { Refuse "revert: $($a.path) is not the upgraded sha" } }
  if ((ShaOrAbsent $ConfigPath) -ne $M.config.new) { Refuse 'revert: the config is not the upgraded sha' }
  if ((ShaOrAbsent $ReceiptPath) -ne $receiptNewForRevert) { Refuse 'revert: the receipt is not the one that upgrade wrote' }
  $RunId = $RevertRunId
} else {
  foreach ($r in $Replace) {
    if ((ShaOrAbsent (& $TargetOf $r.path)) -ne $r.old) { Refuse "installed $($r.path) is not the pinned old sha" }
    if ((ShaOrAbsent (Join-Path $Bundle ('files\' + ($r.path -replace '/', '\')))) -ne $r.new) { Refuse "bundle $($r.path) is not the pinned new sha" }
  }
  foreach ($a in $Add) {
    if (Test-Path -LiteralPath (& $TargetOf $a.path)) { Refuse "$($a.path) already exists" }
    if ((ShaOrAbsent (Join-Path $Bundle ('files\' + ($a.path -replace '/', '\')))) -ne $a.new) { Refuse "bundle $($a.path) is not the pinned new sha" }
  }
  if ((ShaOrAbsent $ConfigPath) -ne $M.config.old) { Refuse 'the installed host-services.json is not the pinned old sha' }
  if ((ShaOrAbsent (Join-Path $Bundle 'config\host-services.json')) -ne $M.config.new) { Refuse 'the bundle host-services.json is not the pinned new sha' }
  if ((ShaOrAbsent $ReceiptPath) -ne $M.receipt.old) { Refuse 'the install receipt is not the pinned sha' }
  foreach ($u in @($M.unchanged | Where-Object { $_ })) { if ((ShaOrAbsent (& $TargetOf $u.path)) -ne $u.sha) { Refuse "$($u.path) is not its pinned unchanged sha" } }
  $RunId = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
}
$Out.runId = $RunId
$RunDir = Join-Path $UpDir $RunId
$aclBefore = @{}; foreach ($r in $Replace) { $aclBefore[$r.path] = (Get-Acl -LiteralPath (& $TargetOf $r.path)).Sddl }; $aclBefore['config'] = (Get-Acl -LiteralPath $ConfigPath).Sddl
$taskXml0 = TaskXmlSha
$wasRunning = ($task.State -eq 'Running'); $Out.wasRunning = $wasRunning

# ---------------------------------------------------------------- run dir + journal, THEN the lock (atomic, with content)
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null
$J = [ordered]@{ manifest = $Out.manifest; runId = $RunId; mode = $Mode; wasRunning = $wasRunning; phase = 'started'; receiptNew = '' }
Save-Journal
Crash 'journal'
$lockTmp = $LockPath + '.tmp-' + $RunId
[IO.File]::WriteAllText($lockTmp, $RunId)
try { [IO.File]::Move($lockTmp, $LockPath) } catch { Remove-Item -LiteralPath $lockTmp -Force -ErrorAction SilentlyContinue; Refuse 'another upgrade holds the lock' }
Crash 'lock'

$mutated = $false
try {
  # stop ONCE, only if running (no installation change has happened yet: a failure here is a no-write abort)
  if ($wasRunning) { if ((Invoke-StageScript 'windows/stop.ps1' @() $StopTimeoutSeconds) -ne 0) { throw 'stop.ps1 failed' } }
  Fault 'stop'
  if ((Get-Task).State -eq 'Running') { throw 'the task is still running after stop' }
  $state0 = Fingerprint $StateDir; $data0 = Fingerprint $DataDir

  if ($Mode -eq 'Revert') {
    $J.phase = 'reverting'; Save-Journal; $mutated = $true
    if (-not (Restore-Files $RunDir $receiptNewForRevert)) { throw 'revert refused or incomplete (see restoreRefused)' }
    $J.phase = 'reverted-files'; Save-Journal
  } else {
    # backup: program files, config and receipt only
    $bk = Join-Path $RunDir 'backup'; $i = 0
    foreach ($r in $Replace) {
      $dst = Join-Path $bk ('opt\' + ($r.path -replace '/', '\')); New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
      Copy-Item -LiteralPath (& $TargetOf $r.path) -Destination $dst -Force
      if ((Sha $dst) -ne $r.old) { throw "backup of $($r.path) is not the old sha" }
      $i++; Crash ('backup' + $i); Fault ('backup' + $i)
    }
    New-Item -ItemType Directory -Force -Path (Join-Path $bk 'config') | Out-Null
    Copy-Item -LiteralPath $ConfigPath -Destination (Join-Path $bk 'config\host-services.json') -Force
    Copy-Item -LiteralPath $ReceiptPath -Destination (Join-Path $bk 'config\install-receipt.txt') -Force
    if ((Sha (Join-Path $bk 'config\host-services.json')) -ne $M.config.old -or (Sha (Join-Path $bk 'config\install-receipt.txt')) -ne $M.receipt.old) { throw 'config backup mismatch' }
    # the new receipt is generated and its digest JOURNALED before anything is written
    $lines = New-Object System.Collections.Generic.List[string]
    $map = @{}; foreach ($r in $Replace) { $map[(& $TargetOf $r.path).ToLowerInvariant()] = $r.new }; $map[$ConfigPath.ToLowerInvariant()] = $M.config.new
    foreach ($l in Get-Content -LiteralPath $ReceiptPath) {
      if ($l -match '^file ([0-9a-f]{64}) (.+)$' -and $map.ContainsKey($Matches[2].ToLowerInvariant())) { $lines.Add('file ' + $map[$Matches[2].ToLowerInvariant()] + ' ' + $Matches[2]) }
      elseif ($l -like 'task *') { foreach ($a in $Add) { $lines.Add('file ' + $a.new + ' ' + (& $TargetOf $a.path)) }; $lines.Add($l) }
      else { $lines.Add($l) }
    }
    if ($lines[$lines.Count - 1] -ne 'complete') { throw 'receipt rewrite lost its complete line' }
    $receiptText = ($lines -join "`r`n") + "`r`n"
    $J.receiptNew = ShaText $receiptText; $J.phase = 'backed-up'; Save-Journal
    Note 'backed up program files, config and receipt (state and data are not backed up and not touched)'

    $mutated = $true; $n = 0
    foreach ($r in $Replace) {
      $J.phase = 'replacing ' + $r.path; Save-Journal
      Put-File (Join-Path $Bundle ('files\' + ($r.path -replace '/', '\'))) (& $TargetOf $r.path) $r.new
      $n++; Crash ('replace' + $n); Fault ('replace' + $n)
    }
    foreach ($a in $Add) { $J.phase = 'adding ' + $a.path; Save-Journal; Put-File (Join-Path $Bundle ('files\' + ($a.path -replace '/', '\'))) (& $TargetOf $a.path) $a.new }
    $J.phase = 'config'; Save-Journal
    Put-File (Join-Path $Bundle 'config\host-services.json') $ConfigPath $M.config.new
    Crash 'config'; Fault 'config'
    $rt = $ReceiptPath + '.new-' + $RunId; [IO.File]::WriteAllText($rt, $receiptText, (New-Object System.Text.UTF8Encoding $false))
    Put-File $rt $ReceiptPath $J.receiptNew; Remove-Item -LiteralPath $rt -Force
    Crash 'receipt'; Fault 'receipt'
    $J.phase = 'applied'; Save-Journal; Note ("replaced " + $Replace.Count + ", added " + $Add.Count + ", config and receipt updated")
  }

  # invariants of the STOPPED window: ACLs kept, task definition unchanged, state and data untouched by this helper
  if ($Mode -ne 'Revert') { foreach ($r in $Replace) { if ((Get-Acl -LiteralPath (& $TargetOf $r.path)).Sddl -ne $aclBefore[$r.path]) { throw "ACL changed on $($r.path)" } } }
  if ((Get-Acl -LiteralPath $ConfigPath).Sddl -ne $aclBefore['config']) { throw 'ACL changed on host-services.json' }
  if ((TaskXmlSha) -ne $taskXml0) { throw 'the scheduled task definition changed' }
  if ((Fingerprint $StateDir) -ne $state0) { throw 'state changed while the stage was stopped' }
  if ((Fingerprint $DataDir) -ne $data0) { throw 'data changed while the stage was stopped' }

  # the runner accepts the configuration and the pinned packages (as install.ps1 checks), bounded
  $sup = Get-Content -Raw -LiteralPath ($CfgDir + '\supervisor.json') | ConvertFrom-Json
  $rc = Invoke-Bounded ([string]$sup.node) @(('"' + (Join-Path $OptDir 'bin\host-services-runner.mjs') + '"'), 'check', ('"' + $ConfigPath + '"')) 120 'runner-check'
  Fault 'check'
  if ($rc -ne 0) { throw "runner check refused (exit $rc)" }
  $checkOut = ReadTextOrEmpty (Get-ChildItem -LiteralPath $RunDir -Filter 'runner-check-*.log' | Sort-Object LastWriteTime | Select-Object -Last 1).FullName
  if (-not $checkOut.Trim()) { throw 'runner check printed nothing' }
  $cj = $checkOut | ConvertFrom-Json
  if (-not $cj.ok -or @($cj.warnings).Count -gt 0) { throw 'runner check reported warnings' }

  if ($wasRunning) {
    $J.phase = 'starting'; Save-Journal
    if ((Invoke-StageScript 'windows/start.ps1' @('-WaitSeconds', [string]$HealthWaitSeconds) ($HealthWaitSeconds + 120)) -ne 0) { throw 'start/health failed on the new code' }
  }
  if ((TaskXmlSha) -ne $taskXml0) { throw 'the scheduled task definition changed' }
  $J.phase = if ($Mode -eq 'Revert') { 'reverted' } else { 'complete' }; Save-Journal
  Remove-Item -LiteralPath $LockPath -Force
  $Out.ok = $true; Note ($J.phase + '; state untouched, task definition unchanged')
  Finish 0
} catch {
  $Out.error = [string]$_.Exception.Message
  Note ('FAILED: ' + $Out.error)
  try {
    $t = Get-Task
    if ($t -and $t.State -eq 'Running' -and ($mutated -or -not $wasRunning)) { if ((Invoke-StageScript 'windows/stop.ps1' @() $StopTimeoutSeconds) -ne 0) { throw 'stop before restore failed' } }
    if (-not $mutated -and (($Mode -eq 'Revert') -or (All-Old))) {
      # nothing in the installation changed: no restore; what was installed (old, or for Revert the upgrade) stays
      $J.phase = 'aborted-no-change'; Save-Journal; Remove-Item -LiteralPath $LockPath -Force
      if ($wasRunning -and (Get-Task).State -ne 'Running') {
        $Out.restartOld = Invoke-StageScript 'windows/start.ps1' @('-WaitSeconds', [string]$HealthWaitSeconds) ($HealthWaitSeconds + 120)
        if ($Out.restartOld -ne 0) { $Out.rollback = 'aborted before any change, but the old code did not come back healthy: root attention'; Finish 3 }
      }
      $Out.rollback = 'aborted before any installation change'; Finish 1
    }
    $rn = if ($Mode -eq 'Revert') { $receiptNewForRevert } else { [string]$J.receiptNew }
    if ($Mode -eq 'Revert') { $restored = $false; $Out.revertNote = 'a failed revert keeps the lock: run -Mode Recover' }
    else { $restored = Restore-Files $RunDir $rn }
    if (-not $restored) { $J.phase = 'restore-refused-or-incomplete'; Save-Journal; $Out.rollback = 'incomplete (lock kept): run -Mode Recover or inspect'; Finish 3 }
    $J.phase = 'rolled-back-files'; Save-Journal
    $Out.rollback = 'program files, config and receipt restored by CAS; state and data untouched'
    if ($wasRunning) {
      $Out.restartOld = Invoke-StageScript 'windows/start.ps1' @('-WaitSeconds', [string]$HealthWaitSeconds) ($HealthWaitSeconds + 120)
      if ($Out.restartOld -ne 0) { $J.phase = 'rolled-back-old-unhealthy'; Save-Journal; $Out.rollback += '; the OLD code is NOT healthy: root attention (lock kept)'; Finish 3 }
    }
    $J.phase = 'rolled-back'; Save-Journal; Remove-Item -LiteralPath $LockPath -Force
    Finish 2
  } catch { $Out.rollback = 'incomplete: ' + [string]$_.Exception.Message; Finish 3 }
}
