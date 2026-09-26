# hvnode-test1.ps1 - ROLLOUT.md step 8.1: the OPERATOR-OWNED test app. The operator key (already on the box, in
# hvnode\state\operator.key) creates and funds hello-world 1.0.4 requiring hyperv-partition-per-app, so this box, and
# only this box, can claim it: every other runner refuses the isolation namespace. The key is read into THIS process's
# environment for the one CLI call and cleared after. It is never printed, never written, never on a command line.
# Needs: the operator funded with USDC (usdc-to-operator.mjs), and the node advertising availability.isolation (P2),
# which the CLI's --isolation checks.
#   powershell -ExecutionPolicy Bypass -File hvnode-test1.ps1 -CliArchive …\cli-<cc8>.tar.gz -CliArchiveSha256 <sha> `
#     -CliManifest …\MANIFEST-cli-<cc8>.txt -CliManifestSha256 <sha>
param(
  [Parameter(Mandatory = $true)][string]$CliArchive, [Parameter(Mandatory = $true)][string]$CliArchiveSha256,
  [Parameter(Mandatory = $true)][string]$CliManifest, [Parameter(Mandatory = $true)][string]$CliManifestSha256,
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode', [string]$FundUsd = '0.05',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe', [string]$Npm = 'C:\Program Files\nodejs\npm.cmd'
)
$ErrorActionPreference = 'Stop'
function Sha256Of([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
function Die([string]$m) { Write-Output "REFUSED: $m"; exit 2 }
if ((Sha256Of $CliArchive) -ne $CliArchiveSha256.ToLower()) { Die 'the CLI archive is not the pinned one' }
if ((Sha256Of $CliManifest) -ne $CliManifestSha256.ToLower()) { Die 'the CLI manifest is not the pinned one' }
$cc8 = ([IO.Path]::GetFileName($CliArchive) -replace '^cli-([0-9a-f]{8})\.tar\.gz$', '$1')
$dir = Join-Path $Root "cli-$cc8"
if (-not (Test-Path $dir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  & "$env:SystemRoot\System32\tar.exe" -xzf $CliArchive -C $dir; if ($LASTEXITCODE -ne 0) { Die 'tar failed' }
}
foreach ($line in @(Get-Content $CliManifest | Where-Object { $_ -match '^[0-9a-f]{64}  ' })) {
  $p = Join-Path $dir ($line.Substring(66) -replace '/', '\')
  if ((Sha256Of $p) -ne $line.Substring(0, 64)) { Die "CLI file $($line.Substring(66)) does not match the manifest" }
}
Push-Location (Join-Path $dir 'cli')
try { & $Npm ci --omit=dev --ignore-scripts --no-audit --no-fund | Out-Null; if ($LASTEXITCODE -ne 0) { Die 'npm ci (cli) failed' } } finally { Pop-Location }

$keyFile = Join-Path $Root 'state\operator.key'
$k = (Get-Content -Raw $keyFile).Trim(); if ($k -notmatch '^0x') { $k = '0x' + $k }
if ($k -notmatch '^0x[0-9a-fA-F]{64}$') { Die 'the operator key file is not 64 hex' }
$home = Join-Path $env:TEMP ("hvnode-test1-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $home | Out-Null
$saved = @{ HOME = $env:HOME; USERPROFILE = $env:USERPROFILE }
try {
  $env:ENCLAVE_KEY = $k; $env:HOME = $home; $env:USERPROFILE = $home   # a fresh home: no key file can be picked up
  $out = & $NodeExe (Join-Path $dir 'cli\enclave.mjs') deploy 'hello-world:1.0.4' --cpu 0.01 --fund $FundUsd `
    --isolation hyperv-partition-per-app --no-wait --yes 2>&1
  $code = $LASTEXITCODE
} finally {
  Remove-Item Env:\ENCLAVE_KEY -ErrorAction SilentlyContinue; $k = $null
  $env:HOME = $saved.HOME; $env:USERPROFILE = $saved.USERPROFILE
  Remove-Item -Recurse -Force $home -ErrorAction SilentlyContinue
}
$out | ForEach-Object { Write-Output "cli> $_" }
if ($code -ne 0) { Die "the deploy exited $code" }
$id = @($out | ForEach-Object { "$_" } | Select-String -Pattern '^created (0x[0-9a-f]{64})$' | ForEach-Object { $_.Matches[0].Groups[1].Value })[0]
if (-not $id) { Die "no 'created 0x…' line" }
Write-Output "CREATED $id (operator-owned hello-world 1.0.4, requires hyperv-partition-per-app)."
Write-Output "Next: wait for this box to claim it, then hvnode-accept.ps1 -Commit <c> -DeploymentId $id, and on the workstation hvnode-accept-remote.sh $id <A7's transportKeySha256>"
