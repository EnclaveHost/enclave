# STAGING ONLY (no VM, registry, service or installed-file change): lay out a canary directory from a release bundle BUILT
# FROM THE COMMITTED SOURCE (windows/installer/stage-bundle.sh + build-bundle.ps1 at the Windows closure commit), unpacked,
# never installed. Verifies every bundle file against its manifest, pins the staged Shield-direct guest, copies the
# production VMGS master read-only, creates the scratch custody callback key with the INSTALLER's own block (same ACL), and
# writes canary-env.cmd for run-manager.ps1. Prints the pins it wrote.
param([Parameter(Mandatory)] [string]$CanaryDir, [Parameter(Mandatory)] [string]$Bundle, [Parameter(Mandatory)] [string]$Commit,
      [Parameter(Mandatory)] [string]$ManifestSha256, [Parameter(Mandatory)] [string]$DirectRuntimeSha256,
      [Parameter(Mandatory)] [string]$DirectRuntimeIdentity,      # runtime.json of the c7084346 guest's wasmtime (from the guest build)
      [string]$DirectImage = "C:\ProgramData\Enclave\staging\shield-direct-c7084346\vbs-linux-candidate.bin",
      [string]$DirectImageSha256 = "c7084346a908465404fdf6de332a76b3c2ca844101eb9e8071aa8a1468f197ec",
      [int]$Port = 18091, [int]$AppRamGb = 4, [switch]$CustodyTransport, [switch]$ValidateOnly)
. (Join-Path $PSScriptRoot "lib.ps1")
function Sha($p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() }
if ($Commit -cnotmatch '^[0-9a-f]{40}$') { throw "-Commit must be the full 40-hex Windows closure commit" }
if ($Port -ne 18091 -or $AppRamGb -lt 1 -or $AppRamGb -gt 4) { throw 'canary port must be 18091 and RAM 1-4 GiB' }
function SafePath([string]$Value) {
  if ($Value -notmatch '^[A-Za-z]:\\' -or $Value -match '[%!&|<>^"\r\n]' -or [IO.Path]::GetFullPath($Value) -cne $Value) { throw "unsafe or non-canonical staging path" }
  $walk = $Value
  while ($walk) {
    if ((Test-Path -LiteralPath $walk) -and ((Get-Item -LiteralPath $walk -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'staging paths cannot traverse reparse points' }
    $next = Split-Path -Parent $walk; if ($next -eq $walk) { break }; $walk = $next
  }
}
foreach ($value in $CanaryDir, $Bundle, $DirectImage, $DirectRuntimeIdentity) { SafePath $value }
$expectedDir = "C:\ProgramData\Enclave\staging\canary-$($Commit.Substring(0,8))"
if ($CanaryDir -cne $expectedDir) { throw "CanaryDir must be exactly $expectedDir" }
if (Test-Path -LiteralPath (Join-Path $CanaryDir 'stage.json')) { throw 'this canary is already staged; verify it instead of overwriting its state' }
foreach ($h in $ManifestSha256, $DirectRuntimeSha256, $DirectImageSha256) { if ($h -cnotmatch '^[0-9a-f]{64}$') { throw 'every supplied artifact pin must be 64 lowercase hex' } }
$manifestFile = Join-Path $Bundle 'manifest.json'
if ((Sha $manifestFile) -cne $ManifestSha256) { throw 'bundle manifest differs from the reviewed pin' }
$m = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
if ($m.commit -cne $Commit) { throw 'bundle manifest must name the exact full source commit' }
if (-not $m.files -or $m.controlManifestSha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'bundle has no complete source manifest provenance' }
$pins = @{}
foreach ($entry in $m.files) {
  $rel = [string]$entry.path
  if ($rel -notmatch '^[A-Za-z0-9_@+., -]+(/[A-Za-z0-9_@+., -]+)*$' -or @($rel.Split('/') | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count -or $pins.ContainsKey($rel)) { throw 'unsafe or duplicate manifest path' }
  if ($entry.sha256 -cnotmatch '^[0-9a-f]{64}$') { throw 'invalid manifest hash' }
  $file = Join-Path $Bundle ($rel -replace '/', '\'); SafePath $file
  if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Sha $file) -cne $entry.sha256) { throw "bundle file differs from manifest: $rel" }
  $pins[$rel] = $entry.sha256
}
$pin = { param($rel) if (-not $pins.ContainsKey($rel)) { throw "required bundle file is absent: $rel" }; $pins[$rel] }
foreach ($rel in 'control-source.json','install-host.ps1','guest/runtime.bin','guest/runtime.json','guest/hyperv.psm1','guest/utilities.psm1',
    'bin/shield-host.exe','bin/shield-egress.exe','bin/shielded-bridge.exe','runtime/node/node.exe','runtime/python/python.exe',
    'control/windows/vbslike/manager/main.mjs') { [void](& $pin $rel) }
$source = Get-Content -LiteralPath (Join-Path $Bundle 'control-source.json') -Raw | ConvertFrom-Json
if ($source.format -cne 'enclave-control-source/1' -or $source.commit -cne $Commit) { throw 'hashed control source identity differs from commit' }
if ((Sha $DirectImage) -cne $DirectImageSha256 -or (Sha $DirectRuntimeIdentity) -cne $DirectRuntimeSha256) { throw 'direct image or runtime identity differs from its pin' }
if ($DirectImageSha256 -ceq (& $pin 'guest/runtime.bin')) { throw 'direct image equals legacy image' }
if ((& $pin 'bin/shielded-bridge.exe') -ceq '87caf7e9486eb4c55c141982f5858936ff56070bbcaec7d019876ece0208824a') { throw 'old bridge lacks callback authentication support; rebuild it from the reviewed source' }
$installer = Get-Content -LiteralPath (Join-Path $Bundle 'install-host.ps1') -Raw
$begin = $installer.IndexOf('# THE CUSTODY CALLBACK KEY ')
$end = $installer.IndexOf('Emit "files" "ok" ("Enclave ', [Math]::Max(0,$begin))
if ($begin -lt 0 -or $end -le $begin) { throw 'installer callback key block could not be identified' }
$keyBlock = $installer.Substring($begin, $end - $begin)
$reviewedKeyBlock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'installer-key-block.ps1') -Raw
if ($keyBlock.Replace("`r",'').Trim() -cne $reviewedKeyBlock.Replace("`r",'').Trim()) { throw 'installer key block differs from the reviewed staging helper' }
if ($ValidateOnly) { Write-Output 'VALIDATED: no files or system state changed'; return }
foreach ($d in "", "shield", "vmgs-run", "vmgs-archive", "bundles", "logs") { New-Item -ItemType Directory -Force (Join-Path $CanaryDir $d) | Out-Null }
# the canary's shield\ is protected like the installer's (SYSTEM + Administrators only): the scratch key inherits from it
icacls (Join-Path $CanaryDir "shield") /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /q | Out-Null
if ($LASTEXITCODE -ne 0) { throw "staging directory ACL failed" }
$master = Join-Path $CanaryDir "shield\type1.vmgs"
Copy-Item -LiteralPath "C:\ProgramData\Enclave\shield\type1.vmgs" -Destination $master     # read-only use of production's blank master
$masterSha = Sha $master
# the scratch callback key, by the installer's exact block ($PD = the canary dir), so it carries the installer's ACL
function Emit($step, $state, $message) { if ($state -eq "warn") { throw $message }; Write-Output "key: $state $message" }
$PD = $CanaryDir; . ([ScriptBlock]::Create($keyBlock))
$key = Join-Path $CanaryDir "shield\custody-callback.key"
Copy-Item -LiteralPath $DirectRuntimeIdentity -Destination (Join-Path $CanaryDir "direct-runtime.json")
$C = Join-Path $Bundle "control"; $B = $Bundle
$custodyEnv = if ($CustodyTransport) {
  "set ENCLAVE_SHIELD_CUSTODY_V2=1`r`nset ENCLAVE_SHIELD_CUSTODY_IMAGE_SHA256=$DirectImageSha256`r`nset ENCLAVE_CUSTODY_CALLBACK_KEY_FILE=$key"
} else { "rem custody transport is disabled in this stage" }
@"
@echo off
rem SHIELD HARDWARE CANARY manager (work/shield-hardware-canary). Commit $Commit. NOT the production manager.
set VMMGR_PORT=$Port
set ENCLAVE_VM_PREFIX=$CanaryPrefix
set ENCLAVE_DATAPLANE_PORT=0
set ENCLAVE_GUEST_IGVM=$B\guest\runtime.bin
set ENCLAVE_GUEST_IGVM_SHA256=$(& $pin 'guest/runtime.bin')
set ENCLAVE_BOOT_FORM=linux-direct
set ENCLAVE_GUEST_STATE_MASTER=$master
set ENCLAVE_GUEST_STATE_MASTER_SHA256=$masterSha
set ENCLAVE_GUEST_STATE_RUN_DIR=$CanaryDir\vmgs-run
set ENCLAVE_GUEST_STATE_ARCHIVE_DIR=$CanaryDir\vmgs-archive
set ENCLAVE_HYPERV_MODULE=$B\guest\hyperv.psm1
set ENCLAVE_HYPERV_MODULE_SHA256=$(& $pin 'guest/hyperv.psm1')
set ENCLAVE_RUNTIME_IDENTITY=$B\guest\runtime.json
set ENCLAVE_SHIELD_DIRECT=1
set ENCLAVE_SHIELD_DIRECT_IGVM=$DirectImage
set ENCLAVE_SHIELD_DIRECT_IGVM_SHA256=$DirectImageSha256
set ENCLAVE_SHIELD_DIRECT_RUNTIME_IDENTITY=$CanaryDir\direct-runtime.json
set PYTHON_BIN=$B\runtime\python\python.exe
set ENCLAVE_BUNDLE_DIR=$CanaryDir\bundles
set ENCLAVE_WMISERVE_EXE=$B\bin\shield-host.exe
set ENCLAVE_WMISERVE_EXE_SHA256=$(& $pin 'bin/shield-host.exe')
set ENCLAVE_LIVENESS_MS=15000
set ENCLAVE_CONFIG_BUNDLE_V5=1
set ENCLAVE_SECRETS_V1=1
set ENCLAVE_EGRESS_V1=1
set ENCLAVE_EGRESS_APP_ROUTES=$CanaryDir\egress-routes.json
set ENCLAVE_EGRESS_EXE=$B\bin\shield-egress.exe
set ENCLAVE_EGRESS_EXE_SHA256=$(& $pin 'bin/shield-egress.exe')
set ENCLAVE_EGRESS_BRIDGE_EXE=$B\bin\shielded-bridge.exe
set ENCLAVE_EGRESS_BRIDGE_EXE_SHA256=$(& $pin 'bin/shielded-bridge.exe')
set NODE_APP_RAM_GB=$AppRamGb
$custodyEnv
"$B\runtime\node\node.exe" "$C\windows\vbslike\manager\main.mjs" >> "$CanaryDir\logs\manager.log" 2>&1
"@ | Set-Content -Encoding ASCII (Join-Path $CanaryDir "canary-env.cmd")
$stageRecord = [ordered]@{ format = "enclave-shield-hardware-canary-stage/2"; canaryDir = $CanaryDir; bundle = $Bundle; manifestSha256 = $ManifestSha256;
            marker = "enclave-canary-vbslike-domain"; nodeSha256 = (& $pin 'runtime/node/node.exe'); directRuntimeSha256 = $DirectRuntimeSha256;
            managerCommandSha256 = (Sha (Join-Path $CanaryDir 'canary-env.cmd')); custodyTransport = [bool]$CustodyTransport; commit = $Commit; bundleVersion = $m.version; legacyIgvmSha256 = (& $pin 'guest/runtime.bin'); directIgvmSha256 = $DirectImageSha256;
            bridgeSha256 = (& $pin 'bin/shielded-bridge.exe'); vmgsMasterSha256 = $masterSha; port = $Port; prefix = $CanaryPrefix }
# Windows PowerShell's Tee-Object writes UTF-16LE. The native Node driver reads UTF-8, so name the encoding explicitly.
$stageJson = $stageRecord | ConvertTo-Json
$stageJson | Set-Content -LiteralPath (Join-Path $CanaryDir 'stage.json') -Encoding UTF8
Write-Output $stageJson
