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
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode', [ValidatePattern('^0\.\d{1,2}$')][string]$FundUsd = '0.05',
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe', [string]$Npm = 'C:\Program Files\nodejs\npm.cmd'
)
$ErrorActionPreference = 'Stop'
function Sha256Of([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
function Die([string]$m) { Write-Output "REFUSED: $m"; exit 2 }
# A native command runs under ErrorActionPreference Continue and is judged by its EXIT CODE only: with Stop, PowerShell
# 5.1 turns a native command's stderr line into a terminating NativeCommandError when the host redirects stderr, as an
# ssh session does (enclave-d1's review, item 3).
function Invoke-Native([scriptblock]$b) { $e = $ErrorActionPreference; $ErrorActionPreference = 'Continue'; try { & $b } finally { $ErrorActionPreference = $e } }
if ((Sha256Of $CliArchive) -ne $CliArchiveSha256.ToLower()) { Die 'the CLI archive is not the pinned one' }
if ((Sha256Of $CliManifest) -ne $CliManifestSha256.ToLower()) { Die 'the CLI manifest is not the pinned one' }
$cc8 = ([IO.Path]::GetFileName($CliArchive) -replace '^cli-([0-9a-f]{8})\.tar\.gz$', '$1')
$dir = Join-Path $Root "cli-$cc8"
if (-not (Test-Path $dir)) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  Invoke-Native { & "$env:SystemRoot\System32\tar.exe" -xzf $CliArchive -C $dir 2>&1 | Out-Null }; if ($LASTEXITCODE -ne 0) { Die 'tar failed' }
}
foreach ($line in @(Get-Content $CliManifest | Where-Object { $_ -match '^[0-9a-f]{64}  ' })) {
  $p = Join-Path $dir ($line.Substring(66) -replace '/', '\')
  if ((Sha256Of $p) -ne $line.Substring(0, 64)) { Die "CLI file $($line.Substring(66)) does not match the manifest" }
}
Push-Location (Join-Path $dir 'cli')
try { Invoke-Native { & $Npm ci --omit=dev --ignore-scripts --no-audit --no-fund 2>&1 | Out-Null }; if ($LASTEXITCODE -ne 0) { Die 'npm ci (cli) failed' } } finally { Pop-Location }

$keyFile = Join-Path $Root 'state\operator.key'
$k = (Get-Content -Raw $keyFile).Trim(); if ($k -notmatch '^0x') { $k = '0x' + $k }
if ($k -notmatch '^0x[0-9a-fA-F]{64}$') { Die 'the operator key file is not 64 hex' }
# $tmpHome, never $home: PowerShell names are case-insensitive, and $HOME is a read-only automatic variable (enclave-d1).
$tmpHome = Join-Path $env:TEMP ("hvnode-test1-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $tmpHome | Out-Null
# The CLI runs through Start-Process with its stdout and stderr REDIRECTED TO FILES: PowerShell never turns a line of its
# stderr into a (terminating) NativeCommandError, and its own `created <id>` line is on disk the moment it prints it, so
# whatever happens to this script after the on-chain create, what was created is recorded (enclave-d1's review, item 3).
$stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$outF = Join-Path $Root "logs\test1-$stamp.out"; $errF = Join-Path $Root "logs\test1-$stamp.err"
Write-Output "the CLI's output goes to $outF (and $errF); a 'created 0x…' line there is the deployment, whatever follows"
$saved = @{ HOME = $env:HOME; USERPROFILE = $env:USERPROFILE }
$code = $null
try {
  $env:ENCLAVE_KEY = $k; $env:HOME = $tmpHome; $env:USERPROFILE = $tmpHome   # a fresh home: no key file can be picked up
  $argv = @(('"' + (Join-Path $dir 'cli\enclave.mjs') + '"'), 'deploy', 'hello-world:1.0.4', '--cpu', '0.01', '--fund', $FundUsd,
            '--isolation', 'hyperv-partition-per-app', '--no-wait', '--yes')
  $p = Start-Process -FilePath $NodeExe -ArgumentList $argv -NoNewWindow -PassThru -RedirectStandardOutput $outF -RedirectStandardError $errF
  $null = $p.Handle          # without it, PowerShell 5.1 reports an empty ExitCode after the wait
  $p.WaitForExit()
  $code = $p.ExitCode
} finally {
  Remove-Item Env:\ENCLAVE_KEY -ErrorAction SilentlyContinue; $k = $null
  $env:HOME = $saved.HOME; $env:USERPROFILE = $saved.USERPROFILE
  Remove-Item -Recurse -Force $tmpHome -ErrorAction SilentlyContinue
}
$out = @(Get-Content $outF -ErrorAction SilentlyContinue) + @(Get-Content $errF -ErrorAction SilentlyContinue)
$out | ForEach-Object { Write-Output "cli> $_" }
$id = @($out | ForEach-Object { "$_" } | Select-String -Pattern '^created (0x[0-9a-f]{64})$' | ForEach-Object { $_.Matches[0].Groups[1].Value })[0]
if ($id) { Set-Content -Path (Join-Path $Root 'test1-created.txt') -Value "$id created $stamp (operator-owned hello-world 1.0.4)" -Encoding ASCII }
if ($code -ne 0) { Die ("the deploy exited $code" + $(if ($id) { "; it DID create $id (recorded in test1-created.txt): fund or stop it by hand" } else { '' })) }
if (-not $id) { Die "no 'created 0x…' line (see $outF)" }
Write-Output "CREATED $id (operator-owned hello-world 1.0.4, requires hyperv-partition-per-app)."
Write-Output "Next: wait for this box to claim it, then hvnode-accept.ps1 -Commit <c> -DeploymentId $id, and on the workstation hvnode-accept-remote.sh $id <A7's transportKeySha256>"
