#Requires -RunAsAdministrator
# PREPARED FOR ROOT REVIEW (not yet reviewed or approved; never run by Claude). Windows PowerShell 5.1, elevated.
# Native fixture validation of hs2-upgrade.ps1 BEFORE any live use. Everything happens in a mocked isolated install:
#   C:\ProgramData\enclave-hs2-upgrade-fixture-<runTag>\<scenario>\{program,root}   (the r3 isolated layout; NO production path)
#   one manual (no trigger) LOCAL SERVICE task per scenario, \hs2upfx-<runTag>-<scenario> (refused if it exists), whose
#   action only sleeps. The stub windows\stop.ps1 / start.ps1 / health.ps1 sit where the real ones would.
#   - The stub health ADVANCES state\floors.json (as a running service advances its replay floors).
#   - The stub runner fails `check` / health on demand for the NEW code only.
# Scenarios (the base path contains SPACES on purpose):
#   ok            upgrade while running: new files/config/receipt; ACL and task XML kept; floors 5->6; data untouched
#   health        new code unhealthy (after it advanced the floor) -> files restored, old restarted healthy; floors 7, exit 2
#   oldunhealthy  new AND old unhealthy -> files restored, exit 3, lock + journal kept; floors 7 (never back to 5)
#   check         runner check refuses the new code -> restored before any start; floors 6
#   cas           an installed file differs from its pin -> refused before any stop (exit 1); nothing changes
#   stopfail      stop.ps1 fails -> no-write abort (exit 1), task still running, lock released
#   faultstop     failure right after a successful stop -> no-write abort, old restarted (exit 1); floors 6
#   crashjournal  crash after the journal, before the lock -> no lock; a new Upgrade succeeds
#   crashlock     crash right after the lock -> Upgrade refuses; Recover writes nothing, releases the lock
#   crashbackup   crash after a PARTIAL backup -> Recover writes nothing (all old), releases the lock
#   crashreplace  crash after 2 replacements -> Recover restores by CAS; task stays stopped; floors 5
#   drift         crash after 2 replacements, then host-services.json drifts -> Recover REFUSES (exit 3), keeps the
#                 drifted bytes and the lock
#   emptylock     an empty lock file -> Upgrade refuses; Recover (every target old) removes it without writing
#   revert        upgrade, then -Mode Revert -> old files back, state untouched; floors 5->6->7
#   revertdrift   upgrade, then the receipt drifts -> Revert refused (exit 1), nothing changes
#   stopped       upgrade with the task not running -> applied, not started; floors 5
#   guards        -FaultAt without an isolated install, and an -InstallRoot overlapping production, are refused
# Cleanup ALWAYS runs (finally): every fixture task unregistered, the fixture base removed.
# Supervision:
#   - -RunTag <yyyyMMddHHmmss-6hex> (optional) lets root know the tag BEFORE launch. It is refused if that tag's directory
#     or any of its tasks exists; a prior fixture is never overwritten or deleted.
#   - A watchdog process is REQUIRED: it is started before any fixture object exists, and the run refuses if it is not
#     alive. It bounds the whole run to -WatchdogMinutes (default 10). If the fixture is still alive then, it kills the
#     fixture's OWN process tree (descendants of the fixture PID created after it, leaves first, never itself), then
#     removes this tag's tasks and directory, and writes fixture-watchdog-<tag>.json next to this script.
#   - Every helper run is bounded (180 s); on timeout its process tree is killed and waited for.
#   - `-CleanupRunTag <tag>` (no -WatchdogParentPid) removes that tag's tasks and directory by hand.
# Output: one RESULT JSON line (per-scenario checks); exit 0 only if every scenario passed AND cleanup succeeded (every
# fixture task unregistered, the fixture directory removed).
#   powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File upgrade-fixture.ps1 -Helper <hs2-upgrade.ps1> -HelperSha256 <hex> -RunTag <yyyyMMddHHmmss-6hex> [-WatchdogMinutes 10]
#   cleanup by hand: ... -File upgrade-fixture.ps1 -CleanupRunTag <tag>
param(
  [string]$Helper = '',
  [string]$HelperSha256 = '',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe',
  [string]$RunTag = '',
  [string]$OnlyScenario = '',
  [ValidateRange(2, 30)][int]$WatchdogMinutes = 10,
  [string]$CleanupRunTag = '',
  [int]$WatchdogParentPid = 0,
  [long]$WatchdogParentCreatedTicks = 0
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$PsExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
function Remove-Fixture([string]$tag) {
  # only this run's objects: tasks \hs2upfx-<tag>-* and the directory C:\ProgramData\enclave hs2 upgrade fixture-<tag>
  if ($tag -notmatch '^[0-9]{14}-[0-9a-f]{6}$') { return 'bad tag' }
  foreach ($t in @(Get-ScheduledTask -TaskPath '\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like ('hs2upfx-' + $tag + '-*') })) {
    try { Stop-ScheduledTask -TaskPath '\' -TaskName $t.TaskName -ErrorAction SilentlyContinue } catch {}
    try { Unregister-ScheduledTask -TaskPath '\' -TaskName $t.TaskName -Confirm:$false } catch {}
  }
  $dir = 'C:\ProgramData\enclave hs2 upgrade fixture-' + $tag
  Start-Sleep -Seconds 1
  if (Test-Path -LiteralPath $dir) { try { Remove-Item -LiteralPath $dir -Recurse -Force } catch {} }
  $left = @(Get-ScheduledTask -TaskPath '\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like ('hs2upfx-' + $tag + '-*') }).Count
  return [ordered]@{ tasksLeft = $left; baseRemoved = -not (Test-Path -LiteralPath $dir) }
}
$TagRe = '^[0-9]{14}-[0-9a-f]{6}$'
function CreatedTicks([int]$procId) { $x = Get-CimInstance Win32_Process -Filter "ProcessId=$procId" -ErrorAction SilentlyContinue; if ($x) { $x.CreationDate.ToUniversalTime().Ticks } else { 0 } }
# kill the OWNED tree of $rootPid: its descendants (leaves first) and then itself, only processes created at or after
# $notBefore (PID-reuse guard), never the processes in $spare. Never anything outside that tree.
function Stop-OwnedTree([int]$rootPid, [long]$notBefore, [int[]]$spare) {
  $all = @(Get-CimInstance Win32_Process)
  $kids = @{}; foreach ($x in $all) { $pp = [int]$x.ParentProcessId; if (-not $kids.ContainsKey($pp)) { $kids[$pp] = New-Object System.Collections.Generic.List[object] }; $kids[$pp].Add($x) }
  $order = New-Object System.Collections.Generic.List[int]; $seen = @{}
  $stack = New-Object System.Collections.Generic.Stack[object]; $stack.Push(@($rootPid, $false))
  while ($stack.Count) {
    $top = $stack.Pop(); $id = [int]$top[0]
    if ($top[1]) { $order.Add($id); continue }
    if ($seen.ContainsKey($id)) { continue }; $seen[$id] = $true
    $stack.Push(@($id, $true))
    if ($kids.ContainsKey($id)) { foreach ($c in $kids[$id]) { $cid = [int]$c.ProcessId; if ($spare -notcontains $cid -and $c.CreationDate.ToUniversalTime().Ticks -ge $notBefore) { $stack.Push(@($cid, $false)) } } }
  }
  foreach ($id in $order) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }   # post-order: leaves first, the root last
  return $order.Count
}
if ($CleanupRunTag) {
  if ($CleanupRunTag -notmatch $TagRe) { Write-Output 'RESULT {"error":"bad -CleanupRunTag"}'; exit 1 }
  $wdOut = [ordered]@{ runTag = $CleanupRunTag; mode = $(if ($WatchdogParentPid) { 'watchdog' } else { 'manual' }); startedAt = (Get-Date).ToUniversalTime().ToString('o') }
  if ($WatchdogParentPid) {
    # watchdog: wait for the fixture to end, at most -WatchdogMinutes; then kill what is left of ITS tree, then clean
    $deadline = (Get-Date).AddMinutes($WatchdogMinutes)
    $alive = { (Get-Process -Id $WatchdogParentPid -ErrorAction SilentlyContinue) -and (CreatedTicks $WatchdogParentPid) -eq $WatchdogParentCreatedTicks }
    while ((& $alive) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 2 }
    if (& $alive) { $wdOut.deadlineHit = $true; $wdOut.killed = Stop-OwnedTree $WatchdogParentPid $WatchdogParentCreatedTicks @($PID); Start-Sleep -Seconds 2 }
    else { $wdOut.deadlineHit = $false }
  }
  $cl = Remove-Fixture $CleanupRunTag; $wdOut.tasksLeft = $cl.tasksLeft; $wdOut.baseRemoved = $cl.baseRemoved; $wdOut.endedAt = (Get-Date).ToUniversalTime().ToString('o')
  if ($WatchdogParentPid) { try { [IO.File]::WriteAllText((Join-Path (Split-Path -Parent $PSCommandPath) ('fixture-watchdog-' + $CleanupRunTag + '.json')), ($wdOut | ConvertTo-Json -Compress)) } catch {} }
  'RESULT ' + ($wdOut | ConvertTo-Json -Compress); exit 0
}
if (-not $Helper -or $HelperSha256 -notmatch '^[0-9a-fA-F]{64}$') { Write-Output 'RESULT {"pass":false,"error":"-Helper and -HelperSha256 are required"}'; exit 1 }
function Sha([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() }
function ShaText([string]$t) { $h = [Security.Cryptography.SHA256]::Create(); -join ($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($t)) | ForEach-Object { $_.ToString('x2') }) }
function Put([string]$path, [string]$text) { New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null; [IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding $false)) }
if ((Sha $Helper) -ne $HelperSha256.ToLowerInvariant()) { Write-Output 'RESULT {"pass":false,"error":"the helper is not the pinned sha256"}'; exit 1 }
if (-not (Test-Path -LiteralPath $NodeExe -PathType Leaf)) { Write-Output 'RESULT {"pass":false,"error":"node not found"}'; exit 1 }
if (-not $RunTag) { $RunTag = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 6) }
if ($RunTag -notmatch $TagRe) { Write-Output 'RESULT {"pass":false,"error":"-RunTag must be yyyyMMddHHmmss-6hex"}'; exit 1 }
$Base = 'C:\ProgramData\enclave hs2 upgrade fixture-' + $RunTag    # spaces on purpose
# collision refusal BEFORE anything is created: never reuse, overwrite or delete a prior fixture
if ((Test-Path -LiteralPath $Base) -or @(Get-ScheduledTask -TaskPath '\' -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -like ('hs2upfx-' + $RunTag + '-*') }).Count) {
  Write-Output ('RESULT {"pass":false,"error":"run tag ' + $RunTag + ' is already used (directory or tasks exist): nothing created"}'); exit 1 }
# -OnlyScenario a,b,c: run only those (focused native re-runs); default: all 17. Unknown names refuse before anything exists.
$AllScenarios = @('ok', 'health', 'check', 'cas', 'oldunhealthy', 'stopfail', 'faultstop', 'crashjournal', 'crashlock', 'crashbackup', 'crashreplace', 'drift', 'emptylock', 'revertdrift', 'revert', 'stopped', 'guards')
$Selected = @($OnlyScenario -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
foreach ($n in $Selected) { if ($AllScenarios -notcontains $n) { Write-Output ('RESULT {"pass":false,"error":"unknown scenario ' + $n + ': nothing created"}'); exit 1 } }
if (-not $Selected.Count) { $Selected = $AllScenarios }
Write-Output ('START {"runTag":"' + $RunTag + '","base":' + ($Base | ConvertTo-Json) + ',"scenarios":' + (ConvertTo-Json @($Selected) -Compress) + '}')
# the REQUIRED watchdog, started before any fixture object exists
$Started = Get-Date
$meTicks = CreatedTicks $PID
try {
  $wd = Start-Process -FilePath $PsExe -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $PSCommandPath + '"'), '-CleanupRunTag', $RunTag,
           '-WatchdogParentPid', $PID, '-WatchdogParentCreatedTicks', $meTicks, '-WatchdogMinutes', $WatchdogMinutes) -WindowStyle Hidden -PassThru
} catch { Write-Output ('RESULT {"pass":false,"error":"watchdog could not start: nothing created"}'); exit 1 }
Start-Sleep -Seconds 2
if (-not $meTicks -or -not (Get-Process -Id $wd.Id -ErrorAction SilentlyContinue)) { Write-Output 'RESULT {"pass":false,"error":"watchdog is not running: nothing created"}'; exit 1 }
New-Item -ItemType Directory -Path $Base | Out-Null
$Report = [ordered]@{ runTag = $RunTag; base = $Base; helper = $HelperSha256.ToLowerInvariant(); watchdogPid = $wd.Id; watchdogMinutes = $WatchdogMinutes; scenarios = [ordered]@{} }
$Tasks = New-Object System.Collections.Generic.List[string]

# ---------------------------------------------------------------- stub sources
$RunnerSrc = @'
// FIXTURE-RUNNER-@@V@@ (fixture only): `check <config>` answers like the real runner; the control file can refuse the NEW code
import fs from 'node:fs'; import path from 'node:path';
const [cmd, cfg] = process.argv.slice(2);
const control = JSON.parse(fs.readFileSync(path.resolve(path.dirname(cfg), '..', '..', 'control.json'), 'utf8'));
if (cmd === 'check') {
  if ('@@V@@' === 'NEW' && control.checkFailNew) { console.log(JSON.stringify({ ok: false, warnings: ['fixture refusal'] })); process.exit(1); }
  console.log(JSON.stringify({ ok: true, warnings: [] })); process.exit(0);
}
process.exit(2);
'@
$StopSrc = @'
param([string]$InstallRoot = '', [string]$TaskName = '')
$ErrorActionPreference = 'Stop'
if ((Get-Content -Raw -LiteralPath (Join-Path $InstallRoot 'control.json') | ConvertFrom-Json).stopFail) { exit 3 }
$t = Get-ScheduledTask -TaskPath '\' -TaskName $TaskName
if ($t.State -eq 'Running') { Stop-ScheduledTask -TaskPath '\' -TaskName $TaskName }
$d = (Get-Date).AddSeconds(30); while ((Get-ScheduledTask -TaskPath '\' -TaskName $TaskName).State -eq 'Running' -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 300 }
if ((Get-ScheduledTask -TaskPath '\' -TaskName $TaskName).State -eq 'Running') { exit 3 }
exit 0
'@
$StartSrc = @'
param([int]$WaitSeconds = 30, [string]$InstallRoot = '', [string]$TaskName = '')
$ErrorActionPreference = 'Stop'
Start-ScheduledTask -TaskPath '\' -TaskName $TaskName
& (Join-Path $PSScriptRoot 'health.ps1') -InstallRoot $InstallRoot -TaskName $TaskName
exit $LASTEXITCODE
'@
$HealthSrc = @'
param([int]$WaitSeconds = 0, [string]$InstallRoot = '', [string]$TaskName = '')
$ErrorActionPreference = 'Stop'
$d = (Get-Date).AddSeconds(15); while ((Get-ScheduledTask -TaskPath '\' -TaskName $TaskName).State -ne 'Running' -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 300 }
if ((Get-ScheduledTask -TaskPath '\' -TaskName $TaskName).State -ne 'Running') { exit 2 }
# a running service advances its replay floor (written by the SERVICE in state\, never by the upgrade helper)
$f = Join-Path $InstallRoot 'root\state\floors.json'
$seq = [int](Get-Content -Raw -LiteralPath $f | ConvertFrom-Json).sequence
[IO.File]::WriteAllText($f, ('{"sequence":' + ($seq + 1) + '}'))
$new = (Get-Content -Raw -LiteralPath (Join-Path $InstallRoot 'program\bin\host-services-runner.mjs')).Contains('FIXTURE-RUNNER-NEW')
$c = Get-Content -Raw -LiteralPath (Join-Path $InstallRoot 'control.json') | ConvertFrom-Json
if ($new -and $c.healthFailNew) { exit 2 }
if (-not $new -and $c.healthFailOld) { exit 2 }
exit 0
'@

# ---------------------------------------------------------------- one fixture
function New-Fixture([string]$name, [bool]$running, [hashtable]$control) {
  $iso = Join-Path $Base $name
  $task = 'hs2upfx-' + $RunTag + '-' + $name
  if (Get-ScheduledTask -TaskPath '\' -TaskName $task -ErrorAction SilentlyContinue) { throw "fixture task $task exists" }
  $opt = $iso + '\program'; $root = $iso + '\root'
  $old = [ordered]@{
    'bin/host-services-runner.mjs' = $RunnerSrc.Replace('@@V@@', 'OLD'); 'bin/hostsvc-supervisor.exe' = 'fixture supervisor (never executed)'
    'packages/directory-replica.mjs' = 'dir v1'; 'packages/directory-replica.package.json' = '{"dir":1}'
    'windows/common.ps1' = '# fixture common'; 'windows/stop.ps1' = $StopSrc; 'windows/start.ps1' = $StartSrc; 'windows/health.ps1' = $HealthSrc
    'STAGE-SHA256SUMS' = 'old sums'; 'ACTIVATION-WINDOWS.txt' = 'old activation'
  }
  $new = [ordered]@{ 'bin/host-services-runner.mjs' = $RunnerSrc.Replace('@@V@@', 'NEW'); 'packages/directory-replica.mjs' = 'dir v2'
    'packages/directory-replica.package.json' = '{"dir":2}'; 'STAGE-SHA256SUMS' = 'new sums'; 'ACTIVATION-WINDOWS.txt' = 'new activation' }
  $added = [ordered]@{ 'packages/service-tls.mjs' = 'tls v1'; 'packages/service-tls.package.json' = '{"tls":1}' }
  foreach ($k in $old.Keys) { Put (Join-Path $opt ($k -replace '/', '\')) $old[$k] }
  $pinOld = 'sha256:' + (ShaText $old['packages/directory-replica.package.json']); $pinNew = 'sha256:' + (ShaText $new['packages/directory-replica.package.json'])
  $cfgOld = "{`n  `"format`": `"enclave-host-services/v1`",`n  `"services`": [`n    {`n      `"role`": `"directory-replica`",`n      `"package`": `"$pinOld`"`n    }`n  ]`n}`n"
  Put ($root + '\config\host-services.json') $cfgOld
  Put ($root + '\config\supervisor.json') ('{"node":' + ($NodeExe | ConvertTo-Json) + '}')
  Put ($root + '\data\artifacts\obj1.bin') 'artifact one'; Put ($root + '\data\bootstrap-manifest.json') '{"m":1}'
  Put ($root + '\state\floors.json') '{"sequence":5}'; Put ($root + '\state\directory-replica-state\route-floors.json') '{"floor":"kept"}'
  $ctl = [ordered]@{ checkFailNew = $false; healthFailNew = $false; healthFailOld = $false; stopFail = $false }; foreach ($k in $control.Keys) { $ctl[$k] = $control[$k] }
  Put ($iso + '\control.json') ($ctl | ConvertTo-Json -Compress)
  $lines = New-Object System.Collections.Generic.List[string]
  foreach ($d in $iso, $opt, "$opt\bin", "$opt\packages", "$opt\windows", $root, "$root\config", "$root\data", "$root\data\artifacts", "$root\state") { $lines.Add("dir $d") }
  foreach ($k in $old.Keys) { $p = Join-Path $opt ($k -replace '/', '\'); $lines.Add("file $(Sha $p) $p") }
  foreach ($k in 'host-services.json', 'supervisor.json') { $p = "$root\config\$k"; $lines.Add("file $(Sha $p) $p") }
  $lines.Add("task \$task $opt\bin\hostsvc-supervisor.exe"); $lines.Add('complete')
  [IO.File]::WriteAllLines("$root\config\install-receipt.txt", [string[]]$lines)
  # bundle + manifest (the make-upgrade-bundle.py format)
  $bundle = $iso + '-bundle'
  foreach ($k in $new.Keys) { Put (Join-Path $bundle ('files\' + ($k -replace '/', '\'))) $new[$k] }
  foreach ($k in $added.Keys) { Put (Join-Path $bundle ('files\' + ($k -replace '/', '\'))) $added[$k] }
  Put ($bundle + '\config\host-services.json') $cfgOld.Replace($pinOld, $pinNew)
  $m = [ordered]@{ format = 'enclave-hs2-upgrade/v1'; label = 'hs2'; id = 'fixture-' + $name
    scripts = [ordered]@{ 'windows/stop.ps1' = (ShaText $StopSrc); 'windows/start.ps1' = (ShaText $StartSrc); 'windows/health.ps1' = (ShaText $HealthSrc); 'windows/common.ps1' = (ShaText '# fixture common') }
    replace = @($new.Keys | ForEach-Object { [ordered]@{ path = $_; old = (ShaText $old[$_]); new = (ShaText $new[$_]) } })
    add = @($added.Keys | ForEach-Object { [ordered]@{ path = $_; new = (ShaText $added[$_]) } })
    unchanged = @([ordered]@{ path = 'bin/hostsvc-supervisor.exe'; sha = (ShaText $old['bin/hostsvc-supervisor.exe']) })
    config = [ordered]@{ old = (Sha ($root + '\config\host-services.json')); new = (Sha ($bundle + '\config\host-services.json')) }
    receipt = [ordered]@{ old = (Sha ($root + '\config\install-receipt.txt')) } }
  Put ($bundle + '\upgrade-manifest.json') ($m | ConvertTo-Json -Depth 6)
  $action = New-ScheduledTaskAction -Execute (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Argument '-NoProfile -NonInteractive -Command Start-Sleep -Seconds 3600'
  $principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskPath '\' -TaskName $task -Action $action -Principal $principal -Settings $settings | Out-Null
  $Tasks.Add($task)
  if ($running) {
    Start-ScheduledTask -TaskPath '\' -TaskName $task
    $d = (Get-Date).AddSeconds(15); while ((Get-ScheduledTask -TaskPath '\' -TaskName $task).State -ne 'Running' -and (Get-Date) -lt $d) { Start-Sleep -Milliseconds 300 }
  }
  @{ iso = $iso; task = $task; opt = $opt; root = $root; bundle = $bundle; msha = (Sha ($bundle + '\upgrade-manifest.json')); m = $m; old = $old; new = $new; added = $added }
}
# one bounded child (an OWNED process): on timeout its whole tree is killed and waited for; a live process's ExitCode is
# never read. -> @{ exit (-1 timed out and gone, -2 timed out and NOT gone); timedOut }
function Invoke-Owned([string[]]$argList, [string]$log, [int]$seconds) {
  $p = Start-Process -FilePath $PsExe -ArgumentList $argList -PassThru -NoNewWindow -RedirectStandardOutput $log -RedirectStandardError ($log + '.err'); $null = $p.Handle
  if (-not $p.WaitForExit($seconds * 1000)) {
    & (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $p.Id /T /F 2>&1 | Out-Null
    $gone = $p.WaitForExit(30000)
    return @{ exit = $(if ($gone) { -1 } else { -2 }); timedOut = $true }
  }
  $p.WaitForExit()
  return @{ exit = $p.ExitCode; timedOut = $false }
}
function Run-Helper([hashtable]$fx, [string[]]$extra) {
  $log = $fx.iso + '-helper-' + [guid]::NewGuid().ToString('N').Substring(0, 6) + '.log'
  $argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $Helper + '"'), '-Bundle', ('"' + $fx.bundle + '"'), '-ManifestSha256', $fx.msha,
               '-InstallRoot', ('"' + $fx.iso + '"'), '-TaskName', $fx.task, '-HealthWaitSeconds', '30') + $extra
  $o = Invoke-Owned $argList $log 180
  $tail = { param($f, $n) $t = ''; try { if (Test-Path -LiteralPath $f) { $t = [string][IO.File]::ReadAllText($f) } } catch {}; if ($t.Length -gt $n) { $t.Substring($t.Length - $n) } else { $t } }
  $script:RunLogs.Add([ordered]@{ args = ($extra -join ' '); exit = $o.exit; timedOut = $o.timedOut; stdoutTail = (& $tail $log 3000); stderrTail = (& $tail ($log + '.err') 1500) })
  if ($o.timedOut) { return @{ exit = $o.exit; result = $null } }
  $line = @((& $tail $log 1000000) -split "`r?`n" | Where-Object { $_ -like 'RESULT *' }) | Select-Object -Last 1
  @{ exit = $o.exit; result = $(if ($line) { $line.Substring(7) | ConvertFrom-Json } else { $null }) }
}
function Files-Are([hashtable]$fx, [string]$which) {
  foreach ($k in $fx.new.Keys) { $want = if ($which -eq 'new') { ShaText $fx.new[$k] } else { ShaText $fx.old[$k] }; if ((Sha (Join-Path $fx.opt ($k -replace '/', '\'))) -ne $want) { return $false } }
  foreach ($k in $fx.added.Keys) { $p = Join-Path $fx.opt ($k -replace '/', '\'); if (($which -eq 'new') -ne (Test-Path -LiteralPath $p)) { return $false } }
  $cfgWant = if ($which -eq 'new') { $fx.m.config.new } else { $fx.m.config.old }
  if ((Sha ($fx.root + '\config\host-services.json')) -ne $cfgWant) { return $false }
  if ($which -eq 'old' -and (Sha ($fx.root + '\config\install-receipt.txt')) -ne $fx.m.receipt.old) { return $false }
  return $true
}
function Floors([hashtable]$fx) { [int](Get-Content -Raw -LiteralPath ($fx.root + '\state\floors.json') | ConvertFrom-Json).sequence }
function Running([hashtable]$fx) { (Get-ScheduledTask -TaskPath '\' -TaskName $fx.task).State -eq 'Running' }
function TaskXml([hashtable]$fx) { ShaText ([string](Export-ScheduledTask -TaskPath '\' -TaskName $fx.task)) }
function DataPrint([hashtable]$fx) { ShaText ((Get-ChildItem -LiteralPath ($fx.root + '\data') -Recurse -File | Sort-Object FullName | ForEach-Object { $_.FullName + '|' + $_.Length + '|' + $_.LastWriteTimeUtc.Ticks }) -join "`n") }
function Scenario([string]$name, [scriptblock]$body) {
  if ($Selected -notcontains $name) { return }
  $checks = [ordered]@{}
  $script:RunLogs = New-Object System.Collections.Generic.List[object]
  if (((Get-Date) - $Started).TotalMinutes -gt ($WatchdogMinutes - 1.5)) { $Report.scenarios[$name] = [ordered]@{ pass = $false; checks = [ordered]@{ skipped = 'run budget exhausted (watchdog deadline near)' } }; return }
  try { & $body $checks } catch { $checks['exception'] = [string]$_.Exception.Message }
  $pass = $checks.Count -gt 0 -and -not ($checks.Values | Where-Object { $_ -ne $true })
  $Report.scenarios[$name] = [ordered]@{ pass = $pass; checks = $checks }
  # a failed scenario carries every helper run's exit and output tails, captured BEFORE cleanup removes the logs
  if (-not $pass) { $Report.scenarios[$name].helperRuns = @($script:RunLogs) }
}

try {
Scenario 'ok' { param($c)
  $fx = New-Fixture 'ok' $true @{}
  $acl0 = (Get-Acl -LiteralPath ($fx.opt + '\bin\host-services-runner.mjs')).Sddl; $x0 = TaskXml $fx; $d0 = DataPrint $fx
  $r = Run-Helper $fx @()
  $c.exit0 = ($r.exit -eq 0); $c.newFiles = (Files-Are $fx 'new'); $c.running = (Running $fx); $c.floors6 = ((Floors $fx) -eq 6)
  $c.aclKept = ((Get-Acl -LiteralPath ($fx.opt + '\bin\host-services-runner.mjs')).Sddl -eq $acl0); $c.taskUnchanged = ((TaskXml $fx) -eq $x0); $c.dataUnchanged = ((DataPrint $fx) -eq $d0)
  $rc = Get-Content -LiteralPath ($fx.root + '\config\install-receipt.txt')
  $c.receiptNew = ([bool]($rc -match [regex]::Escape((ShaText $fx.new['bin/host-services-runner.mjs']))) -and [bool]($rc -match [regex]::Escape((ShaText $fx.added['packages/service-tls.mjs']))) -and $rc[-1] -eq 'complete' -and -not [bool]($rc -match [regex]::Escape((ShaText $fx.old['bin/host-services-runner.mjs']))))
  $c.backupOld = ((Sha (Join-Path $fx.root ('upgrades\' + $r.result.runId + '\backup\opt\bin\host-services-runner.mjs'))) -eq (ShaText $fx.old['bin/host-services-runner.mjs']))
  $c.noLock = (-not (Test-Path -LiteralPath ($fx.root + '\upgrades\active.lock')))
  $c.routeFloorsUntouched = ((Get-Content -Raw -LiteralPath ($fx.root + '\state\directory-replica-state\route-floors.json')) -eq '{"floor":"kept"}')
}
Scenario 'health' { param($c)
  $fx = New-Fixture 'health' $true @{ healthFailNew = $true }
  $r = Run-Helper $fx @()
  $c.exit2 = ($r.exit -eq 2); $c.oldFiles = (Files-Are $fx 'old'); $c.running = (Running $fx); $c.floors7 = ((Floors $fx) -eq 7); $c.noLock = (-not (Test-Path -LiteralPath ($fx.root + '\upgrades\active.lock')))
}
Scenario 'check' { param($c)
  $fx = New-Fixture 'check' $true @{ checkFailNew = $true }
  $r = Run-Helper $fx @()
  $c.exit2 = ($r.exit -eq 2); $c.oldFiles = (Files-Are $fx 'old'); $c.running = (Running $fx); $c.floors6 = ((Floors $fx) -eq 6)
}
Scenario 'cas' { param($c)
  $fx = New-Fixture 'cas' $true @{}
  Put ($fx.opt + '\packages\directory-replica.mjs') 'tampered'
  $r = Run-Helper $fx @()
  $c.exit1 = ($r.exit -eq 1); $c.tamperedKept = ((Sha ($fx.opt + '\packages\directory-replica.mjs')) -eq (ShaText 'tampered'))
  $c.runnerOld = ((Sha ($fx.opt + '\bin\host-services-runner.mjs')) -eq (ShaText $fx.old['bin/host-services-runner.mjs'])); $c.running = (Running $fx); $c.floors5 = ((Floors $fx) -eq 5)
  $c.noUpgradesDir = (-not (Test-Path -LiteralPath ($fx.root + '\upgrades')))
}
function LockOn([hashtable]$fx) { Test-Path -LiteralPath ($fx.root + '\upgrades\active.lock') }
function SetControl([hashtable]$fx, [string]$k, $v) { $c0 = Get-Content -Raw -LiteralPath ($fx.iso + '\control.json') | ConvertFrom-Json; $c0.$k = $v; Put ($fx.iso + '\control.json') ($c0 | ConvertTo-Json -Compress) }
Scenario 'oldunhealthy' { param($c)
  $fx = New-Fixture 'oldunhealthy' $true @{ healthFailNew = $true; healthFailOld = $true }
  $r = Run-Helper $fx @()
  $c.exit3 = ($r.exit -eq 3); $c.oldFiles = (Files-Are $fx 'old'); $c.lockKept = (LockOn $fx); $c.floors7 = ((Floors $fx) -eq 7)
  $c.journalSaysUnhealthy = ((Get-Content -Raw -LiteralPath (Join-Path $fx.root ('upgrades\' + $r.result.runId + '\journal.json')) | ConvertFrom-Json).phase -eq 'rolled-back-old-unhealthy')
}
Scenario 'stopfail' { param($c)
  $fx = New-Fixture 'stopfail' $true @{ stopFail = $true }
  $r = Run-Helper $fx @()
  $c.exit1 = ($r.exit -eq 1); $c.oldFiles = (Files-Are $fx 'old'); $c.running = (Running $fx); $c.noLock = (-not (LockOn $fx)); $c.floors5 = ((Floors $fx) -eq 5)
}
Scenario 'faultstop' { param($c)
  $fx = New-Fixture 'faultstop' $true @{}
  $r = Run-Helper $fx @('-FaultAt', 'stop')
  $c.exit1 = ($r.exit -eq 1); $c.oldFiles = (Files-Are $fx 'old'); $c.running = (Running $fx); $c.noLock = (-not (LockOn $fx)); $c.floors6 = ((Floors $fx) -eq 6)
}
Scenario 'crashjournal' { param($c)
  $fx = New-Fixture 'crashjournal' $true @{}
  $r = Run-Helper $fx @('-FaultAt', 'crash:journal'); $c.crashed9 = ($r.exit -eq 9); $c.noLock = (-not (LockOn $fx)); $c.oldFiles = (Files-Are $fx 'old')
  $r2 = Run-Helper $fx @(); $c.upgrade0 = ($r2.exit -eq 0); $c.newFiles = (Files-Are $fx 'new')
}
Scenario 'crashlock' { param($c)
  $fx = New-Fixture 'crashlock' $true @{}
  $r = Run-Helper $fx @('-FaultAt', 'crash:lock'); $c.crashed9 = ($r.exit -eq 9); $c.lockKept = (LockOn $fx); $c.stillRunning = (Running $fx)
  $r2 = Run-Helper $fx @(); $c.upgradeRefused = ($r2.exit -eq 1)
  $r3 = Run-Helper $fx @('-Mode', 'Recover'); $c.recover0 = ($r3.exit -eq 0); $c.oldFiles = (Files-Are $fx 'old'); $c.noLock = (-not (LockOn $fx))
}
Scenario 'crashbackup' { param($c)
  $fx = New-Fixture 'crashbackup' $true @{}
  $r = Run-Helper $fx @('-FaultAt', 'crash:backup2'); $c.crashed9 = ($r.exit -eq 9); $c.lockKept = (LockOn $fx)
  $r3 = Run-Helper $fx @('-Mode', 'Recover'); $c.recover0 = ($r3.exit -eq 0); $c.oldFiles = (Files-Are $fx 'old'); $c.noLock = (-not (LockOn $fx)); $c.stopped = (-not (Running $fx)); $c.floors5 = ((Floors $fx) -eq 5)
}
Scenario 'crashreplace' { param($c)
  $fx = New-Fixture 'crashreplace' $true @{}
  $r = Run-Helper $fx @('-FaultAt', 'crash:replace2')
  $c.crashed9 = ($r.exit -eq 9); $c.lockKept = (LockOn $fx)
  $r2 = Run-Helper $fx @(); $c.upgradeRefused = ($r2.exit -eq 1)
  $r3 = Run-Helper $fx @('-Mode', 'Recover'); $c.recover0 = ($r3.exit -eq 0)
  $c.oldFiles = (Files-Are $fx 'old'); $c.stopped = (-not (Running $fx)); $c.floors5 = ((Floors $fx) -eq 5); $c.noLock = (-not (LockOn $fx))
  $c.noTemp = (-not (Get-ChildItem -LiteralPath $fx.iso -Recurse -File | Where-Object { $_.Name -like '*.upgrade-*' -or $_.Name -like '*.new-*' }))
}
Scenario 'drift' { param($c)
  $fx = New-Fixture 'drift' $true @{}
  $r = Run-Helper $fx @('-FaultAt', 'crash:replace2'); $c.crashed9 = ($r.exit -eq 9)
  Put ($fx.root + '\config\host-services.json') '{"drifted":true}'
  $r3 = Run-Helper $fx @('-Mode', 'Recover'); $c.recover3 = ($r3.exit -eq 3)
  $c.driftKept = ((Get-Content -Raw -LiteralPath ($fx.root + '\config\host-services.json')) -eq '{"drifted":true}'); $c.lockKept = (LockOn $fx)
  $c.replacedLeftAlone = ((Sha ($fx.opt + '\bin\host-services-runner.mjs')) -eq (ShaText $fx.new['bin/host-services-runner.mjs']))
}
Scenario 'emptylock' { param($c)
  $fx = New-Fixture 'emptylock' $true @{}
  New-Item -ItemType Directory -Force -Path ($fx.root + '\upgrades') | Out-Null; [IO.File]::WriteAllText($fx.root + '\upgrades\active.lock', '')
  $r = Run-Helper $fx @(); $c.upgradeRefused = ($r.exit -eq 1)
  $r3 = Run-Helper $fx @('-Mode', 'Recover'); $c.recover0 = ($r3.exit -eq 0); $c.noLock = (-not (LockOn $fx)); $c.oldFiles = (Files-Are $fx 'old'); $c.running = (Running $fx)
}
Scenario 'revertdrift' { param($c)
  $fx = New-Fixture 'revertdrift' $true @{}
  $r = Run-Helper $fx @(); $c.upgrade0 = ($r.exit -eq 0)
  Add-Content -LiteralPath ($fx.root + '\config\install-receipt.txt') -Value 'drift'
  $r2 = Run-Helper $fx @('-Mode', 'Revert', '-RevertRunId', $r.result.runId); $c.revertRefused = ($r2.exit -eq 1); $c.newFiles = (Files-Are $fx 'new'); $c.running = (Running $fx)
}
Scenario 'revert' { param($c)
  $fx = New-Fixture 'revert' $true @{}
  $r = Run-Helper $fx @(); $c.upgrade0 = ($r.exit -eq 0); $c.floors6 = ((Floors $fx) -eq 6)
  $r2 = Run-Helper $fx @('-Mode', 'Revert', '-RevertRunId', $r.result.runId)
  $c.revert0 = ($r2.exit -eq 0); $c.oldFiles = (Files-Are $fx 'old'); $c.running = (Running $fx); $c.floors7 = ((Floors $fx) -eq 7)
}
Scenario 'stopped' { param($c)
  $fx = New-Fixture 'stopped' $false @{}
  $r = Run-Helper $fx @()
  $c.exit0 = ($r.exit -eq 0); $c.newFiles = (Files-Are $fx 'new'); $c.notStarted = (-not (Running $fx)); $c.floors5 = ((Floors $fx) -eq 5)
}
Scenario 'guards' { param($c)
  $log = Join-Path $Base 'guards-a.log'
  $o = Invoke-Owned @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $Helper + '"'), '-Bundle', ('"' + $Base + '"'), '-ManifestSha256', ('0' * 64), '-FaultAt', 'check') $log 60
  $c.faultWithoutIsolationRefused = (-not $o.timedOut) -and ($o.exit -eq 1) -and [bool]((Get-Content -Raw -LiteralPath $log) -match 'FaultAt')
  $log = Join-Path $Base 'guards-b.log'
  $o = Invoke-Owned @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ('"' + $Helper + '"'), '-Bundle', ('"' + $Base + '"'), '-ManifestSha256', ('0' * 64), '-InstallRoot', '"C:\ProgramData\Enclave\host-services\x"', '-TaskName', 'x1') $log 60
  $c.productionOverlapRefused = (-not $o.timedOut) -and ($o.exit -eq 1) -and [bool]((Get-Content -Raw -LiteralPath $log) -match 'overlaps')
}

} finally {
  # ---------------------------------------------------------------- cleanup (ALWAYS; part of pass)
  $cl = Remove-Fixture $RunTag; $Report.tasksLeft = $cl.tasksLeft; $Report.baseRemoved = $cl.baseRemoved
}
$Report.selected = @($Selected)
# diagnostic only: whether the watchdog process is still alive now (it ends ~2 s after this script; over SSH it may be
# ended together with the session before writing fixture-watchdog-<tag>.json - that is NOT counted as a pass or a fail)
$Report.watchdogAliveAtEnd = [bool](Get-Process -Id $wd.Id -ErrorAction SilentlyContinue)
$Report.pass = ($Report.tasksLeft -eq 0) -and $Report.baseRemoved -and ($Report.scenarios.Count -eq $Selected.Count) -and -not ($Report.scenarios.Values | Where-Object { -not $_.pass })
'RESULT ' + ($Report | ConvertTo-Json -Compress -Depth 6)
if ($Report.pass) { exit 0 } else { exit 1 }
