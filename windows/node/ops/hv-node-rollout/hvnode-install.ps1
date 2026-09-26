# hvnode-install.ps1 - install the hv node (from main) and its manager (from the staged v40 package) on the NucBox, as
# two NEW boot tasks, WITHOUT starting them (ROLLOUT.md step 4). The manager runs from a verified COPY of the package's
# control\ (hvnode\manager-<pkg8>\). The retired legacy node is left exactly as it is: its
# task \EnclaveWindowsNode stays DISABLED and is never deleted; C:\Users\claude\vbs\node is only READ (its operator and
# proof keys and its box-built tpmattest.exe are COPIED, never moved).
#   powershell -ExecutionPolicy Bypass -File hvnode-install.ps1 -Pkg C:\Users\claude\vbs-like\pkg\15f39ae4d1fab954 `
#     -NodeArchive C:\Users\claude\vbs-like\hvnode\stage\hvnode-<c8>.tar.gz -NodeArchiveSha256 <sha> `
#     -NodeManifest C:\Users\claude\vbs-like\hvnode\stage\MANIFEST-hvnode-<c8>.txt -NodeManifestSha256 <sha> `
#     -LockSha256 <sha> -TpmattestSha256 <sha from the preflight>
# Everything it writes is under -Root (default C:\Users\claude\vbs-like\hvnode), plus the two tasks. Nothing prints a key.
param(
  [Parameter(Mandatory = $true)][string]$Pkg,
  [Parameter(Mandatory = $true)][string]$NodeArchive, [Parameter(Mandatory = $true)][string]$NodeArchiveSha256,
  [Parameter(Mandatory = $true)][string]$NodeManifest, [Parameter(Mandatory = $true)][string]$NodeManifestSha256,
  [Parameter(Mandatory = $true)][string]$LockSha256, [Parameter(Mandatory = $true)][string]$TpmattestSha256,
  [string]$LegacyDir = 'C:\Users\claude\vbs\node',
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe', [string]$Npm = 'C:\Program Files\nodejs\npm.cmd',
  [string]$Python = 'C:\Python314\python.exe',
  [int]$ManagerPort = 8091, [int]$DataPort = 8092, [int]$LocalPort = 9600,
  [switch]$Replace
)
$ErrorActionPreference = 'Stop'
function Sha256Of([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
function Die([string]$m) { Write-Output "REFUSED: $m"; exit 2 }
function Note([string]$m) { Write-Output "ok   $m" }
# A native command runs under ErrorActionPreference Continue and is judged by its EXIT CODE only: with Stop, PowerShell
# 5.1 turns a native command's stderr line into a terminating NativeCommandError when the host redirects stderr, as an
# ssh session does (enclave-d1's review, item 3).
function Invoke-Native([scriptblock]$b) { $e = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & $b } finally { $ErrorActionPreference = $e } }

# ---- 0. inputs are the pinned ones ----
if ((Sha256Of $NodeArchive) -ne $NodeArchiveSha256.ToLower()) { Die "$NodeArchive is not $NodeArchiveSha256" }
if ((Sha256Of $NodeManifest) -ne $NodeManifestSha256.ToLower()) { Die "$NodeManifest is not $NodeManifestSha256" }
$c8 = ([IO.Path]::GetFileName($NodeArchive) -replace '^hvnode-([0-9a-f]{8})\.tar\.gz$', '$1')
if ($c8 -notmatch '^[0-9a-f]{8}$') { Die "the archive name must be hvnode-<8 hex>.tar.gz" }
$pins = [ordered]@{
  'guest\igvm-vbs\vbs-linux-candidate-1539-b7ba7731.bin' = 'b7ba7731240ec9025f8c92651be17ecf8af17764e2c3eb0bd20af60f00923748'
  'control\vbslike-host.exe'                               = '435717def62bb5c9a632f80210b5c3fbcbeb7cb8c1047f9beef4ca578ebe99e7'
  'guest\runtime.json'                                     = 'ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8' }
foreach ($k in $pins.Keys) { if ((Sha256Of (Join-Path $Pkg $k)) -ne $pins[$k]) { Die "package $k is not $($pins[$k])" } }
foreach ($t in 'EnclaveHvManager', 'EnclaveHvNode') {
  if ((Get-ScheduledTask -TaskName $t -TaskPath '\' -ErrorAction SilentlyContinue) -and -not $Replace) { Die "task \$t exists (-Replace to re-register it)" }
}
$legacy = Get-ScheduledTask -TaskName 'EnclaveWindowsNode' -TaskPath '\' -ErrorAction SilentlyContinue
if (-not $legacy -or $legacy.State -ne 'Disabled') { Die 'the legacy task \EnclaveWindowsNode must exist and be Disabled (it is never deleted, never enabled)' }
if ((Sha256Of (Join-Path $LegacyDir 'tpmattest.exe')) -ne $TpmattestSha256.ToLower()) { Die 'the legacy tpmattest.exe is not the pinned one' }

# ---- 1. the node tree: expanded, then every file checked against the manifest ----
$tree = Join-Path $Root $c8
if (Test-Path $tree) { if (-not $Replace) { Die "$tree exists (-Replace to reuse it)" } } else { New-Item -ItemType Directory -Force -Path $tree | Out-Null }
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
$nodeDir = Join-Path $tree 'windows\node'
if ((Sha256Of (Join-Path $nodeDir 'package-lock.json')) -ne $LockSha256.ToLower()) { Die 'package-lock.json is not the pinned one' }
Push-Location $nodeDir
try { Invoke-Native { & $Npm ci --omit=dev --ignore-scripts --no-audit --no-fund 2>&1 | Out-Null }; if ($LASTEXITCODE -ne 0) { Die 'npm ci failed' } } finally { Pop-Location }
# the lockfile's pinned versions, read from its TEXT: PowerShell 5.1's ConvertFrom-Json refuses an object with an
# EMPTY-STRING key, and lockfile v2/v3 has "packages": { "": ... } (enclave-d1's box run of 7a02c1bf stopped here).
# npm writes "version" first in each packages entry; the installed package.json files have no such key and parse fine.
$lockText = Get-Content -Raw (Join-Path $nodeDir 'package-lock.json')
foreach ($pkgName in 'ws', 'viem', 'tweetnacl') {
  $m = [regex]::Match($lockText, '"node_modules/' + [regex]::Escape($pkgName) + '":\s*\{\s*"version":\s*"([^"]+)"')
  if (-not $m.Success) { Die "the lockfile pins no version for $pkgName" }
  $wantV = $m.Groups[1].Value
  $gotV = (Get-Content -Raw (Join-Path $nodeDir "node_modules\$pkgName\package.json") | ConvertFrom-Json).version
  if ($gotV -ne $wantV) { Die "$pkgName $gotV installed, the lockfile pins $wantV" }
}
Note 'npm ci from the pinned lockfile (ws, viem, tweetnacl at the locked versions)'

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
$man = Get-Content -Raw (Join-Path $Pkg 'MANIFEST.json') | ConvertFrom-Json
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
$nmPkg = NodeModulesList (Join-Path $Pkg 'control'); $nmCopy = NodeModulesList $cbase
if ($nmPkg.Count -eq 0) { Die "the package's control\ has no node_modules (was it staged?)" }
if (($nmPkg -join "`n") -ne ($nmCopy -join "`n")) { Die "the manager copy's node_modules differs from the staged package's" }
Note "manager copy $mcopy = the package MANIFEST's control/ ($($ctl.Count) files) + its node_modules byte for byte ($($nmPkg.Count) files)"

# ---- 4. configuration: the manager from its copy (the package's managerEnv), the node from main ----
$mgrDir = Join-Path $mcopy 'control\windows\vbslike\manager'
$mgrCfg = @(
  '@echo off', 'rem the v40 manager (package control/ = e3acc392, manager 76af33b4); nucbox-ownguest-40.json profiles.vbsLinux.managerEnv',
  "set VMMGR_PORT=$ManagerPort",
  "set ENCLAVE_GUEST_IGVM=$(Join-Path $Pkg 'guest\igvm-vbs\vbs-linux-candidate-1539-b7ba7731.bin')",
  'set ENCLAVE_GUEST_IGVM_SHA256=b7ba7731240ec9025f8c92651be17ecf8af17764e2c3eb0bd20af60f00923748',
  'set ENCLAVE_BOOT_FORM=linux-direct',
  'set ENCLAVE_GUEST_STATE_MASTER=C:\Users\claude\vbs-like\type1.vmgs',
  'set ENCLAVE_GUEST_STATE_MASTER_SHA256=4f051697a74dc72d60e7b36d7cc80554493d64038ea6e146d72b454585ae930d',
  "set ENCLAVE_GUEST_STATE_ARCHIVE_DIR=$(Join-Path $Root 'vmgs-archive')",
  'set ENCLAVE_HYPERV_MODULE=C:\Users\claude\hyperv.psm1',
  'set ENCLAVE_HYPERV_MODULE_SHA256=17ca4352c500d3498f71be420ddfa418c7ed1d1b5f455856c24e633a4635e49c',
  "set ENCLAVE_RUNTIME_IDENTITY=$(Join-Path $Pkg 'guest\runtime.json')",
  "set PYTHON_BIN=$Python", 'set IPFS_GATEWAY=https://ipfs.enclave.host',
  "set PYTHONPATH=$(Join-Path $mcopy 'control\wasm')", 'set PYTHONDONTWRITEBYTECODE=1',
  "set ENCLAVE_WMISERVE_EXE=$(Join-Path $Pkg 'control\vbslike-host.exe')",
  'set ENCLAVE_WMISERVE_EXE_SHA256=435717def62bb5c9a632f80210b5c3fbcbeb7cb8c1047f9beef4ca578ebe99e7',
  "set ENCLAVE_BUNDLE_DIR=$(Join-Path $Root 'bundles')",
  "set ENCLAVE_DATAPLANE_PORT=$DataPort",
  'set ENCLAVE_LIVENESS_MS=15000', 'set ENCLAVE_ANSWER_CHECK_MS=30000')
$nodeCfg = @(
  '@echo off', "rem the hv node from main at $c8 (engine retired: ENCLAVE_ENGINE unset). No key is in this file: NODE_DIR holds them.",
  'set APPS=1', 'set NODE_NAME=nucbox-k11', 'set PUBLIC_URL=https://api.enclave.host/t/nucbox-k11',
  'set RELAY_URL=wss://api.enclave.host/v1/fleet-tunnel',
  "set NODE_DIR=$state", "set TPMATTEST_EXE=$(Join-Path $bin 'tpmattest.exe')",
  "set ENCLAVE_ISOLATION_MANAGER=http://127.0.0.1:$ManagerPort",
  'set ENCLAVE_ISOLATION_RUNTIME_ID=ccadb38a6779615597f0614311a631c70810916c1bbeb9f5706ee3a637fd90c8',
  "set ENCLAVE_ISOLATION_DATA_ADDR=127.0.0.1:$DataPort",
  'rem owner-only is forced on an engine-retired node anyway (host.mjs scope()); stated for the reader',
  'set CLAIM_SCOPE=owner-only',
  'rem served owners = {operator} + {owners of valid delegations} (enclave-87, final); OWNER_WALLET is not set: it no longer authorizes',
  'rem delegations: NODE_DIR\delegations\*.json ({message, signature}; enclave-host-delegation-v1), re-read every tick (ROLLOUT.md step 8)',
  "set LOCAL_HTTP_PORT=$LocalPort",
  "set PYTHON_BIN=$Python", 'set IPFS_GATEWAY=https://ipfs.enclave.host')
# each runs its process in a loop: Task Scheduler's restart-on-failure does not reliably fire on a process that EXITS
# (enclave-d1's review, item 5). Ending or disabling the task ends the loop (hvnode-rollback.ps1 kills the loop's
# cmd.exe before the node.exe). The script path is ABSOLUTE, so the process is matched by its path, never by a name.
function RunLoop([string]$cfg, [string]$dir, [string]$script, [string]$log) {
  @('@echo off', "call `"$cfg`"", "cd /d `"$dir`"", ':loop',
    "`"$NodeExe`" `"$(Join-Path $dir $script)`" >> `"$log`" 2>&1",
    "echo %date% %time% [run] $script exited %errorlevel%; restarting in 10 s >> `"$log`"",
    'ping -n 11 127.0.0.1 >nul', 'goto loop')   # not timeout.exe: it exits at once with no console (a SYSTEM task; enclave-d1)
}
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
