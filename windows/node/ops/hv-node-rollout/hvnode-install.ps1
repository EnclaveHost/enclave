# hvnode-install.ps1 - install the hv node (from main) and its manager (from the staged v40 package) on the NucBox, as
# two NEW boot tasks, WITHOUT starting them (ROLLOUT.md step 4). The manager runs from a verified COPY of the package's
# control\ (hvnode\manager-<pkg8>\). The retired legacy node is left exactly as it is: its
# task \EnclaveWindowsNode stays DISABLED and is never deleted; C:\Users\claude\vbs\node is only READ (its operator and
# proof keys and its box-built tpmattest.exe are COPIED, never moved).
#   powershell -ExecutionPolicy Bypass -File hvnode-install.ps1 -Pkg C:\Users\claude\vbs-like\pkg\<first 16 hex of the manifest sha> `
#     -ManifestSha256 <the package MANIFEST.json's sha256> -NodeArchive C:\Users\claude\vbs-like\hvnode\stage\hvnode-<c8>.tar.gz -NodeArchiveSha256 <sha> `
#     -NodeManifest C:\Users\claude\vbs-like\hvnode\stage\MANIFEST-hvnode-<c8>.txt -NodeManifestSha256 <sha> `
#     -LockSha256 <sha> -TpmattestSha256 <sha from the preflight>
# NODE ONLY (enclave-d1, 87's order 09-26: a node fix during the soak): only the node moves; the manager, its copy, its task,
# manager-config.cmd, run-manager.cmd, node-config.cmd, the keys and state\ are untouched, so test 1's partition keeps
# running under the manager and the new node ADOPTS it:
#   powershell -ExecutionPolicy Bypass -File hvnode-install.ps1 -NodeOnly -NodeArchive <...\hvnode-<c8>.tar.gz> -NodeArchiveSha256 <sha> `
#     -NodeManifest <...\MANIFEST-hvnode-<c8>.txt> -NodeManifestSha256 <sha> -LockSha256 <sha> [-DryRun]
#   It stages hvnode\<c8> exactly as the full install does, refuses unless \EnclaveHvManager is Running and its /health reads
#   canStart, stops ONLY \EnclaveHvNode's loop (its cmd.exe, then its node.exe, matched by absolute path), rewrites
#   run-node.cmd for the new tree (the old one kept as run-node.cmd.bak-<old c8>), starts \EnclaveHvNode, and waits for the
#   new agent and its loopback /availability. -DryRun checks and stages, and stops nothing. The old tree is never deleted:
#   ROLLBACK = the same -NodeOnly with the old tree's archive and pins.
# THE PACKAGE's pins come from the package's OWN MANIFEST.json, verified against -ManifestSha256 (the operator's pin),
# never from constants here: the guest firmware, the launcher, runtime.json and every managerEnv value (the profile's
# managerEnv, each file checked against the manifest's files[] sha256 and each box file against hostChecks.<profile>.boxFiles)
# (enclave-53 / enclave-87: the v40 constants refused a staged v42). A shape it does not know refuses.
# Everything it writes is under -Root (default C:\Users\claude\vbs-like\hvnode), plus the two tasks. Nothing prints a key.
[CmdletBinding(DefaultParameterSetName = 'Full')]
param(
  [Parameter(Mandatory = $true, ParameterSetName = 'Full')][string]$Pkg,
  [Parameter(Mandatory = $true, ParameterSetName = 'Full')][ValidatePattern('^[0-9a-fA-F]{64}$')][string]$ManifestSha256,
  [Parameter(ParameterSetName = 'Full')][string]$PkgProfile = 'vbsLinux',
  [Parameter(Mandatory = $true)][string]$NodeArchive, [Parameter(Mandatory = $true)][string]$NodeArchiveSha256,
  [Parameter(Mandatory = $true)][string]$NodeManifest, [Parameter(Mandatory = $true)][string]$NodeManifestSha256,
  [Parameter(Mandatory = $true)][string]$LockSha256,
  [Parameter(Mandatory = $true, ParameterSetName = 'Full')][string]$TpmattestSha256,
  [string]$LegacyDir = 'C:\Users\claude\vbs\node',
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe', [string]$Npm = 'C:\Program Files\nodejs\npm.cmd',
  [string]$Python = 'C:\Python314\python.exe',
  [int]$ManagerPort = 8091, [int]$DataPort = 8092, [int]$LocalPort = 9600,
  # the interactive account the hosting tray runs as (windows/tray): the node grants it READ on its admin token at start.
  # Written into node-config.cmd BEFORE the node starts, e.g. NUCBOX_K11\srbat (the NetBIOS name has an underscore).
  [ValidatePattern('^(|[A-Za-z0-9_.-]{1,64}\\[A-Za-z0-9_.-]{1,64})$')][string]$HostingTrayUser = '',
  [Parameter(ParameterSetName = 'Full')][switch]$Replace,
  [Parameter(Mandatory = $true, ParameterSetName = 'NodeOnly')][switch]$NodeOnly,
  [Parameter(ParameterSetName = 'NodeOnly')][switch]$DryRun
)
$ErrorActionPreference = 'Stop'
function Sha256Of([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
function Die([string]$m) { Write-Output "REFUSED: $m"; exit 2 }
function Note([string]$m) { Write-Output "ok   $m" }
# A native command runs under ErrorActionPreference Continue and is judged by its EXIT CODE only: with Stop, PowerShell
# 5.1 turns a native command's stderr line into a terminating NativeCommandError when the host redirects stderr, as an
# ssh session does (enclave-d1's review, item 3).
function Invoke-Native([scriptblock]$b) { $e = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & $b } finally { $ErrorActionPreference = $e } }

# each runs its process in a loop: Task Scheduler's restart-on-failure does not reliably fire on a process that EXITS
# (enclave-d1's review, item 5). Ending or disabling the task ends the loop (hvnode-rollback.ps1 kills the loop's
# cmd.exe before the node.exe). The script path is ABSOLUTE, so the process is matched by its path, never by a name.
function RunLoop([string]$cfg, [string]$dir, [string]$script, [string]$log) {
  @('@echo off', "call `"$cfg`"", "cd /d `"$dir`"", ':loop',
    "`"$NodeExe`" `"$(Join-Path $dir $script)`" >> `"$log`" 2>&1",
    "echo %date% %time% [run] $script exited %errorlevel%; restarting in 10 s >> `"$log`"",
    'ping -n 11 127.0.0.1 >nul', 'goto loop')   # not timeout.exe: it exits at once with no console (a SYSTEM task; enclave-d1)
}
# ---- the node tree (steps 1-2), shared by the full install and -NodeOnly: hvnode\<c8> expanded from the pinned archive,
#      every file checked against the pinned manifest, then its npm tree from the pinned lockfile only. It sets
#      $script:nodeDir and returns nothing (a PowerShell function's Write-Output would become its return value). ----
function StageNodeTree([bool]$reuse) {
  # ---- 1. the node tree: expanded, then every file checked against the manifest ----
  $tree = Join-Path $Root $c8
  if (Test-Path $tree) { if (-not $reuse) { Die "$tree exists (-Replace to reuse it)" } } else { New-Item -ItemType Directory -Force -Path $tree | Out-Null }
  Invoke-Native { & "$env:SystemRoot\System32\tar.exe" -xzf $NodeArchive -C $tree 2>&1 | Out-Null }
  if ($LASTEXITCODE -ne 0) { Die "tar could not expand $NodeArchive" }
  $want = @(Get-Content $NodeManifest | Where-Object { $_ -match '^[0-9a-f]{64}  ' })
  foreach ($line in $want) {
    $h = $line.Substring(0, 64); $rel = $line.Substring(66)
    $p = Join-Path $tree ($rel -replace '/', '\')
    if (-not (Test-Path -LiteralPath $p) -or (Sha256Of $p) -ne $h) { Die "tree file $rel does not match the manifest" }
  }
  $have = @(Get-ChildItem -Recurse -File $tree | Where-Object { $_.FullName -notlike '*\node_modules\*' })
  if ($have.Count -ne $want.Count) { Die "the tree has $($have.Count) files, the manifest $($want.Count)" }
  Note "node tree $tree = the manifest ($($want.Count) files)"

  # ---- 2. its npm tree, from the pinned lockfile only ----
  $script:nodeDir = Join-Path $tree 'windows\node'
  if ((Sha256Of (Join-Path $script:nodeDir 'package-lock.json')) -ne $LockSha256.ToLower()) { Die 'package-lock.json is not the pinned one' }
  Push-Location $script:nodeDir
  try { Invoke-Native { & $Npm ci --omit=dev --ignore-scripts --no-audit --no-fund 2>&1 | Out-Null }; if ($LASTEXITCODE -ne 0) { Die 'npm ci failed' } } finally { Pop-Location }
  # the lockfile's pinned versions, read from its TEXT: PowerShell 5.1's ConvertFrom-Json refuses an object with an
  # EMPTY-STRING key, and lockfile v2/v3 has "packages": { "": ... } (enclave-d1's box run of 7a02c1bf stopped here).
  # npm writes "version" first in each packages entry; the installed package.json files have no such key and parse fine.
  $lockText = Get-Content -Raw (Join-Path $script:nodeDir 'package-lock.json')
  foreach ($pkgName in 'ws', 'viem', 'tweetnacl') {
    $m = [regex]::Match($lockText, '"node_modules/' + [regex]::Escape($pkgName) + '":\s*\{\s*"version":\s*"([^"]+)"')
    if (-not $m.Success) { Die "the lockfile pins no version for $pkgName" }
    $wantV = $m.Groups[1].Value
    $gotV = (Get-Content -Raw (Join-Path $script:nodeDir "node_modules\$pkgName\package.json") | ConvertFrom-Json).version
    if ($gotV -ne $wantV) { Die "$pkgName $gotV installed, the lockfile pins $wantV" }
  }
  Note 'npm ci from the pinned lockfile (ws, viem, tweetnacl at the locked versions)'
}

# ---- 0. inputs are the pinned ones ----
if ((Sha256Of $NodeArchive) -ne $NodeArchiveSha256.ToLower()) { Die "$NodeArchive is not $NodeArchiveSha256" }
if ((Sha256Of $NodeManifest) -ne $NodeManifestSha256.ToLower()) { Die "$NodeManifest is not $NodeManifestSha256" }
$c8 = ([IO.Path]::GetFileName($NodeArchive) -replace '^hvnode-([0-9a-f]{8})\.tar\.gz$', '$1')
if ($c8 -notmatch '^[0-9a-f]{8}$') { Die "the archive name must be hvnode-<8 hex>.tar.gz" }

# ---- NODE ONLY: the node moves, nothing else (enclave-d1's spec; 87's order 09-26) ----
if ($NodeOnly) {
  function Procs([string]$name, [string]$like) { @(Get-CimInstance Win32_Process -Filter "Name='$name'" | Where-Object { $_.CommandLine -like $like }) }
  $runNodeCmd = Join-Path $Root 'run-node.cmd'; $nodeCfgCmd = Join-Path $Root 'node-config.cmd'
  # the box is an INSTALLED hv node with its manager serving: this is an upgrade of the node alone, never a first install
  foreach ($f in $runNodeCmd, $nodeCfgCmd, (Join-Path $Root 'run-manager.cmd'), (Join-Path $Root 'manager-config.cmd')) {
    if (-not (Test-Path -LiteralPath $f)) { Die "$f is missing: -NodeOnly upgrades an installed node (run the full install)" }
  }
  $mgrTask = Get-ScheduledTask -TaskName 'EnclaveHvManager' -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $mgrTask -or $mgrTask.State -ne 'Running') { Die 'the manager task \EnclaveHvManager is not Running: -NodeOnly never touches the manager, and moves the node only beside a serving one' }
  try { $health = Invoke-RestMethod -Uri "http://127.0.0.1:$ManagerPort/health" -TimeoutSec 15 -UseBasicParsing } catch { Die "the manager's /health did not answer: $($_.Exception.Message)" }
  if ($health.canStart -ne $true) { Die "the manager's /health does not read canStart" }
  $nodeTask = Get-ScheduledTask -TaskName 'EnclaveHvNode' -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $nodeTask) { Die 'the node task \EnclaveHvNode is not registered: -NodeOnly upgrades an installed node' }
  $legacy = Get-ScheduledTask -TaskName 'EnclaveWindowsNode' -TaskPath '\' -ErrorAction SilentlyContinue
  if (-not $legacy -or $legacy.State -ne 'Disabled') { Die 'the legacy task \EnclaveWindowsNode must exist and be Disabled (it is never deleted, never enabled)' }
  # the tree the loop runs NOW (run-node.cmd's `cd /d "<tree>\windows\node"`), and the new one: never the same
  $cdLine = @(Get-Content -LiteralPath $runNodeCmd | Where-Object { $_ -match '^cd /d "(.+)"$' })
  if ($cdLine.Count -ne 1) { Die "run-node.cmd does not name exactly one node directory" }
  $oldNodeDir = [regex]::Match($cdLine[0], '^cd /d "(.+)"$').Groups[1].Value
  $newNodeDir = Join-Path (Join-Path $Root $c8) 'windows\node'
  if ($oldNodeDir.ToLower() -eq $newNodeDir.ToLower()) { Die "the node already runs ${newNodeDir}: nothing to move" }
  $old8 = Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $oldNodeDir))
  Note ("manager Running and canStart; the node runs {0}; it moves to {1}" -f $oldNodeDir, $newNodeDir)
  StageNodeTree $true
  if ($script:nodeDir.ToLower() -ne $newNodeDir.ToLower()) { Die "staged $($script:nodeDir), expected $newNodeDir" }
  $newRun = RunLoop $nodeCfgCmd $newNodeDir 'agent.mjs' (Join-Path $Root 'logs\node.log')
  if ($DryRun) {
    Note "DRY RUN: every check passed and $newNodeDir is staged; the node was NOT stopped and run-node.cmd was NOT rewritten"
    Write-Output ("run-node.cmd would name: {0}" -f ($newRun | Where-Object { $_ -like 'cd /d *' }))
    exit 0
  }
  # stop ONLY the node: its task, then its loop's cmd.exe BEFORE its node.exe (or the loop brings it back), by absolute path
  Stop-ScheduledTask -TaskName 'EnclaveHvNode' -TaskPath '\' -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  $agentLike = "*$Root\*\windows\node\agent.mjs*"
  foreach ($p in (Procs 'cmd.exe' "*$runNodeCmd*")) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Note "node loop (cmd.exe pid $($p.ProcessId)) stopped" }
  foreach ($p in (Procs 'node.exe' $agentLike)) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue; Note "node agent (node.exe pid $($p.ProcessId)) stopped" }
  $gone = $false
  for ($i = 0; $i -lt 30; $i++) {
    if (-not (Procs 'cmd.exe' "*$runNodeCmd*").Count -and -not (Procs 'node.exe' $agentLike).Count) { $gone = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $gone) { Die 'the node loop or agent is still running after 60 s: run-node.cmd was NOT rewritten; start \EnclaveHvNode again (Start-ScheduledTask) to resume the old tree' }
  $mgrTask = Get-ScheduledTask -TaskName 'EnclaveHvManager' -TaskPath '\'
  if ($mgrTask.State -ne 'Running') { Write-Output 'WARNING: the manager task is no longer Running (it was not touched): tell d1' }
  # only now (no cmd.exe reads it) run-node.cmd names the new tree; the old one is kept beside it
  Copy-Item -LiteralPath $runNodeCmd -Destination "$runNodeCmd.bak-$old8" -Force
  Set-Content -Path $runNodeCmd -Value $newRun -Encoding ASCII
  Note ("run-node.cmd sha256 {0} (names {1}; the previous one kept as run-node.cmd.bak-{2})" -f (Sha256Of $runNodeCmd), $newNodeDir, $old8)
  Start-ScheduledTask -TaskName 'EnclaveHvNode' -TaskPath '\'
  $up = $false; $newLike = "*$newNodeDir\agent.mjs*"
  for ($i = 0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    if ((Procs 'node.exe' $newLike).Count) {
      try { $null = Invoke-RestMethod -Uri "http://127.0.0.1:$LocalPort/availability" -TimeoutSec 5 -UseBasicParsing; $up = $true; break } catch { }
    }
  }
  if (-not $up) {
    Write-Output "NOT UP: no agent from $newNodeDir answered http://127.0.0.1:$LocalPort/availability within 90 s. Read logs\node.log; ROLLBACK = -NodeOnly with the $old8 archive and pins"
    exit 3
  }
  Note ("the node runs {0} and answers /availability; the manager, its task, test 1's partition, node-config.cmd, the keys and state\ were not touched" -f $newNodeDir)
  Write-Output "NODE-ONLY INSTALLED: $old8 -> $c8. ROLLBACK = the same -NodeOnly with hvnode-$old8.tar.gz and its pins (its tree $oldNodeDir is kept)"
  exit 0
}
# the package: its MANIFEST.json is the operator's pin, and the staged directory is named by that pin
$manFile = Join-Path $Pkg 'MANIFEST.json'
if (-not (Test-Path -LiteralPath $manFile)) { Die "no MANIFEST.json in $Pkg" }
if ((Sha256Of $manFile) -ne $ManifestSha256.ToLower()) { Die "$manFile is not $ManifestSha256" }
if ((Split-Path -Leaf $Pkg).ToLower() -ne $ManifestSha256.Substring(0, 16).ToLower()) { Die "$Pkg is not the staged directory of $($ManifestSha256.Substring(0, 16))" }
$man = Get-Content -Raw $manFile | ConvertFrom-Json
$fileSha = @{}; foreach ($f in @($man.files)) { $fileSha["$($f.path)"] = "$($f.sha256)".ToLower() }
$boxSha = @{}; $boxPath = @{}
foreach ($b in @($man.hostChecks.$PkgProfile.boxFiles)) { $boxSha["$($b.name)"] = "$($b.sha256)".ToLower(); $boxPath["$($b.name)"] = "$($b.path)" }
# a package file: listed in the manifest, and on disk exactly as listed
function PkgFile([string]$rel) {
  if (-not $fileSha.ContainsKey($rel)) { Die "the package manifest lists no file $rel" }
  $p = Join-Path $Pkg ($rel -replace '/', '\')
  if (-not (Test-Path -LiteralPath $p) -or (Sha256Of $p) -ne $fileSha[$rel]) { Die "package file $rel is not the manifest's $($fileSha[$rel])" }
  return $p
}
# a box file the manifest pins (hostChecks.<profile>.boxFiles): on disk exactly as pinned
function BoxFile([string]$name) {
  if (-not $boxSha.ContainsKey($name)) { Die "the package manifest pins no box file $name" }
  if (-not (Test-Path -LiteralPath $boxPath[$name]) -or (Sha256Of $boxPath[$name]) -ne $boxSha[$name]) { Die "box file $($boxPath[$name]) is not the manifest's $($boxSha[$name])" }
  return $boxPath[$name]
}
$prof = $man.profiles.$PkgProfile
if (-not $prof -or -not $prof.managerEnv) { Die "the package manifest has no profiles.$PkgProfile.managerEnv" }
$runtimeId = "$($man.runtime.runtimeId)".ToLower()
if ($runtimeId -notmatch '^[0-9a-f]{64}$') { Die 'the package manifest states no runtime.runtimeId' }
$null = PkgFile "$($man.runtime.file)"
# every file and box file the managerEnv names is checked HERE, before anything is written (step 4 writes them)
foreach ($e in @($prof.managerEnv)) {
  $names = @($e.PSObject.Properties.Name)
  if ($names -contains 'file') { $null = PkgFile "$($e.file)" }
  if ($names -contains 'sha256Of') { $null = PkgFile "$($e.sha256Of)" }
  if ($names -contains 'boxFile') { $null = BoxFile "$($e.boxFile)" }
  if ($names -contains 'boxFileSha256') { $null = BoxFile "$($e.boxFileSha256)" }
}
Note ("package {0} v{1}: MANIFEST.json = {2}; profile {3}: {4} managerEnv entries checked; runtime {5}" -f $man.name, $man.version, $ManifestSha256.Substring(0, 16), $PkgProfile, @($prof.managerEnv).Count, $runtimeId.Substring(0, 16))
foreach ($t in 'EnclaveHvManager', 'EnclaveHvNode') {
  if ((Get-ScheduledTask -TaskName $t -TaskPath '\' -ErrorAction SilentlyContinue) -and -not $Replace) { Die "task \$t exists (-Replace to re-register it)" }
}
# an UPGRADE (-Replace) rewrites run-node.cmd / run-manager.cmd, which a running loop's cmd.exe reads from disk as it
# goes: stop both first (hvnode-rollback.ps1 without -Unregister), then install, then start (enclave-d1, redeploy 4ef0e862)
foreach ($t in 'EnclaveHvManager', 'EnclaveHvNode') {
  $x = Get-ScheduledTask -TaskName $t -TaskPath '\' -ErrorAction SilentlyContinue
  if ($x -and $x.State -eq 'Running') { Die "task \$t is RUNNING: stop both first (hvnode-rollback.ps1, without -Unregister), then re-run the install" }
}
$legacy = Get-ScheduledTask -TaskName 'EnclaveWindowsNode' -TaskPath '\' -ErrorAction SilentlyContinue
if (-not $legacy -or $legacy.State -ne 'Disabled') { Die 'the legacy task \EnclaveWindowsNode must exist and be Disabled (it is never deleted, never enabled)' }
if ((Sha256Of (Join-Path $LegacyDir 'tpmattest.exe')) -ne $TpmattestSha256.ToLower()) { Die 'the legacy tpmattest.exe is not the pinned one' }

# ---- 1-2. the node tree and its npm tree (StageNodeTree, above: shared with -NodeOnly) ----
StageNodeTree ([bool]$Replace)

# ---- 3. the node's identity: COPIED from the legacy dir, never moved, never printed; owner-only ACL ----
$state = Join-Path $Root 'state'; New-Item -ItemType Directory -Force -Path $state | Out-Null
# the ACL FIRST, so no key ever sits there under inherited permissions (enclave-d1's review, item 7)
Invoke-Native { & icacls $state /inheritance:r /grant:r 'SYSTEM:(OI)(CI)F' 'BUILTIN\Administrators:(OI)(CI)F' 2>&1 | Out-Null }
if ($LASTEXITCODE -ne 0) { Die "icacls on $state failed" }
New-Item -ItemType Directory -Force -Path (Join-Path $state 'delegations') | Out-Null   # empty: test 1 serves the operator only
foreach ($f in 'operator.key', 'proof.key', 'node-transport.key') {
  $src = Join-Path $LegacyDir $f; $dst = Join-Path $state $f
  if (-not (Test-Path $src)) { if ($f -eq 'node-transport.key') { continue } else { Die "no $src" } }
  if (Test-Path $dst) {
    if ((Sha256Of $dst) -ne (Sha256Of $src)) { Die "$dst exists and DIFFERS from $src (decide by hand; nothing overwritten)" }
  } else { Copy-Item -LiteralPath $src -Destination $dst; if ((Sha256Of $dst) -ne (Sha256Of $src)) { Die "the copy of $f is not identical" } }
}
Note "keys copied into $state (identical to the legacy dir's; SYSTEM + Administrators only)"
$bin = Join-Path $Root 'bin'; New-Item -ItemType Directory -Force -Path $bin | Out-Null
Copy-Item -LiteralPath (Join-Path $LegacyDir 'tpmattest.exe') -Destination (Join-Path $bin 'tpmattest.exe') -Force
if ((Sha256Of (Join-Path $bin 'tpmattest.exe')) -ne $TpmattestSha256.ToLower()) { Die 'the tpmattest.exe copy is not the pinned one' }
foreach ($d in 'logs', 'bundles', 'vmgs-archive') { New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null }

# ---- 3b. the manager runs from a COPY of the package's control\ (enclave-d1's box rule: never from a staged package;
#      Python would write __pycache__ into it, and a later stage must never be something a running manager depends on).
#      Every copied file is checked against the package's MANIFEST.json; the IGVM, runtime.json and the launcher stay
#      read-only, hash-pinned references into the package. ----
$pkgId8 = (Split-Path -Leaf $Pkg).Substring(0, 8)
$mcopy = Join-Path $Root "manager-$pkgId8"
$ctl = @($man.files | Where-Object { "$($_.path)".StartsWith('control/') })
if (-not $ctl.Count) { Die 'the package MANIFEST.json lists no control/ files' }
if (-not (Test-Path $mcopy)) {
  New-Item -ItemType Directory -Force -Path $mcopy | Out-Null
  Invoke-Native { & robocopy (Join-Path $Pkg 'control') (Join-Path $mcopy 'control') /E /NFL /NDL /NJH /NJS /NP 2>&1 | Out-Null }
  if ($LASTEXITCODE -ge 8) { Die "robocopy of control\ failed ($LASTEXITCODE)" }
} elseif (-not $Replace) { Die "$mcopy exists (-Replace to reuse it)" }
$listed = @{}
foreach ($f in $ctl) {
  $rel = ("$($f.path)" -replace '/', '\'); $listed[$rel.ToLower()] = $true
  $p = Join-Path $mcopy $rel
  if (-not (Test-Path -LiteralPath $p) -or (Sha256Of $p) -ne "$($f.sha256)".ToLower()) { Die "manager copy file $($f.path) does not match the package MANIFEST" }
}
# every copied file outside node_modules must be one the MANIFEST lists (a __pycache__ or a stray file refuses) ...
$cbase = (Join-Path $mcopy 'control')
$unlisted = @(Get-ChildItem -Recurse -File $cbase | Where-Object { $_.FullName -notlike '*\node_modules\*' } |
  Where-Object { -not $listed.ContainsKey(('control' + $_.FullName.Substring($cbase.Length)).ToLower()) })
if ($unlisted.Count) { Die "the manager copy has $($unlisted.Count) file(s) the MANIFEST does not list, e.g. $($unlisted[0].FullName)" }
# ... and node_modules (installed at stage time, verified by stage.ps1; not in the MANIFEST: enclave-d1) must be a
# BYTE-IDENTICAL copy of the staged package's: the sorted (relative path, sha256) lists of both are equal
function NodeModulesList([string]$base) {
  @(Get-ChildItem -Recurse -File $base | Where-Object { $_.FullName -like '*\node_modules\*' } |
    ForEach-Object { $_.FullName.Substring($base.Length).ToLower() + ' ' + (Sha256Of $_.FullName) } | Sort-Object)
}
$nmPkg = @(NodeModulesList (Join-Path $Pkg 'control')); $nmCopy = @(NodeModulesList $cbase)   # @() at the call: PS 5.1 unrolls a 1-element return
if ($nmPkg.Count -eq 0) { Die "the package's control\ has no node_modules (was it staged?)" }
if (($nmPkg -join "`n") -ne ($nmCopy -join "`n")) { Die "the manager copy's node_modules differs from the staged package's" }
Note "manager copy $mcopy = the package MANIFEST's control/ ($($ctl.Count) files) + its node_modules byte for byte ($($nmPkg.Count) files)"

# ---- 4. configuration: the manager from its copy (the package's managerEnv), the node from main ----
$mgrDir = Join-Path $mcopy 'control\windows\vbslike\manager'
# every line from the package's managerEnv (checked in step 0): a literal value; a package file (`file`, and its manifest
# sha256 as `sha256Of`); a pinned box file and its sha256; a package directory (`dir`, under control/: the manager's
# verified COPY). The placeholders the manifest leaves to the install are the ports and the run-owned directories;
# anything else unknown refuses. PYTHONDONTWRITEBYTECODE=1 is the install's own (the copy stays as verified).
function EnvValue($e) {
  $names = @($e.PSObject.Properties.Name)
  if ($names -contains 'file') { return (PkgFile "$($e.file)") }
  if ($names -contains 'sha256Of') { $null = PkgFile "$($e.sha256Of)"; return $fileSha["$($e.sha256Of)"] }
  if ($names -contains 'boxFile') { return (BoxFile "$($e.boxFile)") }
  if ($names -contains 'boxFileSha256') { $null = BoxFile "$($e.boxFileSha256)"; return $boxSha["$($e.boxFileSha256)"] }
  if ($names -contains 'dir') {
    $d = "$($e.dir)"
    if (-not $d.StartsWith('control/')) { Die "managerEnv $($e.name): a dir outside control/ ($d)" }
    return (Join-Path $mcopy ($d -replace '/', '\'))
  }
  if ($names -contains 'value') {
    switch ("$($e.name)") {
      'VMMGR_PORT' { return "$ManagerPort" }
      'ENCLAVE_DATAPLANE_PORT' { return "$DataPort" }
      'ENCLAVE_BUNDLE_DIR' { return (Join-Path $Root 'bundles') }
      'ENCLAVE_GUEST_STATE_ARCHIVE_DIR' { return (Join-Path $Root 'vmgs-archive') }   # the install's own, beside the logs
      'PYTHON_BIN' { return $Python }
    }
    $v = "$($e.value)"
    if ($v -match '^<.*>$') { Die "managerEnv $($e.name): a placeholder this install does not fill ($v)" }
    return $v
  }
  Die "managerEnv $($e.name): an entry shape this install does not know ($($names -join ', '))"
}
$mgrCfg = @('@echo off', ("rem the manager from package {0} v{1} ({2}), profiles.{3}.managerEnv" -f $man.name, $man.version, $ManifestSha256.Substring(0, 16), $PkgProfile))
foreach ($e in @($prof.managerEnv)) {
  $n = "$($e.name)"
  if ($n -notmatch '^[A-Z][A-Z0-9_]*$') { Die "managerEnv has an entry named '$n'" }
  $v = EnvValue $e
  if ("$v" -match '[\r\n"%&|<>^]') { Die "managerEnv ${n}: a value this install will not write into a .cmd file" }
  $mgrCfg += "set $n=$v"
}
$mgrCfg += 'set PYTHONDONTWRITEBYTECODE=1'
$nodeCfg = @(
  '@echo off', "rem the hv node from main at $c8 (engine retired: ENCLAVE_ENGINE unset). No key is in this file: NODE_DIR holds them.",
  'set APPS=1', 'set NODE_NAME=nucbox-k11', 'set PUBLIC_URL=https://api.enclave.host/t/nucbox-k11',
  'set RELAY_URL=wss://api.enclave.host/v1/fleet-tunnel',
  "set NODE_DIR=$state", "set TPMATTEST_EXE=$(Join-Path $bin 'tpmattest.exe')",
  "set ENCLAVE_ISOLATION_MANAGER=http://127.0.0.1:$ManagerPort",
  "set ENCLAVE_ISOLATION_RUNTIME_ID=$runtimeId",
  "set ENCLAVE_ISOLATION_DATA_ADDR=127.0.0.1:$DataPort",
  'rem owner-only is forced on an engine-retired node anyway (host.mjs scope()); stated for the reader',
  'set CLAIM_SCOPE=owner-only',
  'rem served owners = {operator} + {owners of valid delegations} (enclave-87, final); OWNER_WALLET is not set: it no longer authorizes',
  'rem delegations: NODE_DIR\delegations\*.json ({message, signature}; enclave-host-delegation-v1), re-read every tick (ROLLOUT.md step 8)',
  "set LOCAL_HTTP_PORT=$LocalPort",
  $(if ($HostingTrayUser) { "set HOSTING_TRAY_USER=$HostingTrayUser" } else { 'rem HOSTING_TRAY_USER unset: only SYSTEM and elevated administrators can read the hosting token (the tray cannot)' }),
  "set PYTHON_BIN=$Python", 'set IPFS_GATEWAY=https://ipfs.enclave.host')
$runMgr = RunLoop (Join-Path $Root 'manager-config.cmd') $mgrDir 'main.mjs' (Join-Path $Root 'logs\manager.log')
$runNode = RunLoop (Join-Path $Root 'node-config.cmd') $nodeDir 'agent.mjs' (Join-Path $Root 'logs\node.log')
Set-Content -Path (Join-Path $Root 'manager-config.cmd') -Value $mgrCfg -Encoding ASCII
Set-Content -Path (Join-Path $Root 'node-config.cmd') -Value $nodeCfg -Encoding ASCII
Set-Content -Path (Join-Path $Root 'run-manager.cmd') -Value $runMgr -Encoding ASCII
Set-Content -Path (Join-Path $Root 'run-node.cmd') -Value $runNode -Encoding ASCII
foreach ($f in 'manager-config.cmd', 'node-config.cmd', 'run-manager.cmd', 'run-node.cmd') { Note ("{0} sha256 {1}" -f $f, (Sha256Of (Join-Path $Root $f))) }

# ---- 5. the two NEW boot tasks (SYSTEM, highest; no run-time limit), registered, NOT started ----
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew   # the run-*.cmd loop is the restart
foreach ($t in @(@{ n = 'EnclaveHvManager'; run = (Join-Path $Root 'run-manager.cmd'); delay = 'PT30S' },
                 @{ n = 'EnclaveHvNode'; run = (Join-Path $Root 'run-node.cmd'); delay = 'PT90S' })) {
  $action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\cmd.exe" -Argument ('/c "' + $t.run + '"')
  $trigger = New-ScheduledTaskTrigger -AtStartup; $trigger.Delay = $t.delay
  Register-ScheduledTask -TaskName $t.n -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  $x = Get-ScheduledTask -TaskName $t.n -TaskPath '\'
  Note "task \$($t.n) registered (state $($x.State); boot delay $($t.delay); not started)"
}
$legacy = Get-ScheduledTask -TaskName 'EnclaveWindowsNode' -TaskPath '\'
if ($legacy.State -ne 'Disabled') { Die 'the legacy task is no longer Disabled: STOP and tell d1' }
Note 'legacy task \EnclaveWindowsNode untouched (Disabled)'
Write-Output "INSTALLED (not started). Start: Start-ScheduledTask -TaskName EnclaveHvManager; then, once its /health reads canStart, Start-ScheduledTask -TaskName EnclaveHvNode"
