# hvnode-test1.ps1 - ROLLOUT.md step 8.1: the OPERATOR-OWNED test app. The operator key (already on the box, in
# hvnode\state\operator.key) creates and funds hello-world 1.0.4 requiring hyperv-partition-per-app, so this box, and
# only this box, can claim it: every other runner refuses the isolation namespace. The key is read into THIS process's
# environment for the one CLI call and cleared after. It is never printed, never written, never on a command line.
# Needs: the operator funded with USDC (usdc-to-operator.mjs), and the node advertising availability.isolation (P2),
# which the CLI's --isolation checks.
#   create + fund:  powershell -ExecutionPolicy Bypass -File hvnode-test1.ps1 -CliArchive …\cli-<cc8>.tar.gz `
#                     -CliArchiveSha256 <sha> -CliManifest …\MANIFEST-cli-<cc8>.txt -CliManifestSha256 <sha>
#   fund only:      … the same, plus -FundExisting 0x<64 hex>
# -FundExisting (enclave-d1, approved by enclave-87): when the deploy CREATED but did not FUND (the CLI can read the new
# row before its RPC shows it: the read-after-write risk), it funds that id. First it polls the ledger's get(id) on TWO
# RPCs (publicnode + blastapi) until BOTH return the operator as its owner, bounded. It refuses an id another owner holds.
# Then it runs `enclave fund <id> --usdc <amt> --yes` with the same key handling, and records the transaction.
param(
  [Parameter(Mandatory = $true)][string]$CliArchive, [Parameter(Mandatory = $true)][string]$CliArchiveSha256,
  [Parameter(Mandatory = $true)][string]$CliManifest, [Parameter(Mandatory = $true)][string]$CliManifestSha256,
  [string]$Root = 'C:\Users\claude\vbs-like\hvnode', [ValidatePattern('^0\.\d{1,2}$')][string]$FundUsd = '0.05',
  [ValidatePattern('^(|0x[0-9a-fA-F]{64})$')][string]$FundExisting = '',
  [string]$Operator = '0x389C3f030a209D04D026228D2D053fEB75DbadcA', [int]$VisibleTimeoutSec = 180,
  [string]$NodeExe = 'C:\Program Files\nodejs\node.exe', [string]$Npm = 'C:\Program Files\nodejs\npm.cmd'
)
$ErrorActionPreference = 'Stop'
function Sha256Of([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower() }
function Die([string]$m) { Write-Output "REFUSED: $m"; exit 2 }
# A native command runs under ErrorActionPreference Continue and is judged by its EXIT CODE only (the PS 5.1 stderr trap).
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
$cliDir = Join-Path $dir 'cli'
Push-Location $cliDir
try { Invoke-Native { & $Npm ci --omit=dev --ignore-scripts --no-audit --no-fund 2>&1 | Out-Null }; if ($LASTEXITCODE -ne 0) { Die 'npm ci (cli) failed' } } finally { Pop-Location }

# node <args> with the operator key ONLY in that child's environment, its output REDIRECTED TO FILES (nothing it prints
# is lost if this script dies after an on-chain step; PowerShell never turns its stderr into a terminating error); the
# child's exit code is the verdict.
function Invoke-WithKey([string[]]$argv, [string]$tag) {
  $k = (Get-Content -Raw (Join-Path $Root 'state\operator.key')).Trim(); if ($k -notmatch '^0x') { $k = '0x' + $k }
  if ($k -notmatch '^0x[0-9a-fA-F]{64}$') { Die 'the operator key file is not 64 hex' }
  # $tmpHome, never $home: PowerShell names are case-insensitive, and $HOME is a read-only automatic variable (enclave-d1)
  $tmpHome = Join-Path $env:TEMP ("hvnode-test1-" + [guid]::NewGuid().ToString('N')); New-Item -ItemType Directory -Path $tmpHome | Out-Null
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $outF = Join-Path $Root "logs\test1-$tag-$stamp.out"; $errF = Join-Path $Root "logs\test1-$tag-$stamp.err"
  Write-Host "the CLI's output goes to $outF (and $errF), line by line as it prints"
  $saved = @{ HOME = $env:HOME; USERPROFILE = $env:USERPROFILE }; $code = $null
  try {
    $env:ENCLAVE_KEY = $k; $env:HOME = $tmpHome; $env:USERPROFILE = $tmpHome   # a fresh home: no key file can be picked up
    $p = Start-Process -FilePath $NodeExe -ArgumentList $argv -NoNewWindow -PassThru -RedirectStandardOutput $outF -RedirectStandardError $errF
    $null = $p.Handle          # without it, PowerShell 5.1 reports an empty ExitCode after the wait
    $p.WaitForExit(); $code = $p.ExitCode
  } finally {
    Remove-Item Env:\ENCLAVE_KEY -ErrorAction SilentlyContinue; $k = $null
    $env:HOME = $saved.HOME; $env:USERPROFILE = $saved.USERPROFILE
    Remove-Item -Recurse -Force $tmpHome -ErrorAction SilentlyContinue
  }
  $out = @(Get-Content $outF -ErrorAction SilentlyContinue) + @(Get-Content $errF -ErrorAction SilentlyContinue)
  $out | ForEach-Object { Write-Host "cli> $_" }
  # a function's OUTPUT stream is its return value: everything above went to the host, only this hashtable returns
  return @{ code = $code; out = $out; stamp = $stamp }
}
$cli = '"' + (Join-Path $cliDir 'enclave.mjs') + '"'

if (-not $FundExisting) {
  $r = Invoke-WithKey @($cli, 'deploy', 'hello-world:1.0.4', '--cpu', '0.01', '--fund', $FundUsd,
                       '--isolation', 'hyperv-partition-per-app', '--no-wait', '--yes') 'deploy'
  $id = @($r.out | ForEach-Object { "$_" } | Select-String -Pattern '^created (0x[0-9a-f]{64})$' | ForEach-Object { $_.Matches[0].Groups[1].Value })[0]
  if ($id) { Set-Content -Path (Join-Path $Root 'test1-created.txt') -Value "$id created $($r.stamp) (operator-owned hello-world 1.0.4)" -Encoding ASCII }
  if ($r.code -ne 0) {
    Die ("the deploy exited $($r.code)" + $(if ($id) { "; it DID create $id (recorded in test1-created.txt): re-run with -FundExisting $id" } else { '' })) }
  if (-not $id) { Die "no 'created 0x…' line in the CLI's output" }
  Write-Output "CREATED and funded $id (operator-owned hello-world 1.0.4, requires hyperv-partition-per-app)."
} else {
  $id = $FundExisting.ToLower()
  # the id must be visible, and the OPERATOR's, on BOTH RPCs before any money moves (read-after-write; a stranger's refuses)
  $check = Join-Path $cliDir ("visible-" + [guid]::NewGuid().ToString('N') + '.mjs')   # inside cli\, so `viem` resolves
  Set-Content -Path $check -Encoding ASCII -Value @'
import { createPublicClient, http } from "viem"; import { base } from "viem/chains";
const [id, want, secs] = [process.argv[2], process.argv[3].toLowerCase(), Number(process.argv[4])];
const abi = [{ type: "function", name: "get", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "tuple", components: [
  { name: "id", type: "bytes32" }, { name: "owner", type: "address" }, { name: "appRef", type: "string" }, { name: "ports", type: "string" },
  { name: "configCid", type: "string" }, { name: "gpuMilli", type: "uint16" }, { name: "cpuMilli", type: "uint16" }, { name: "appPort", type: "uint32" },
  { name: "isPublic", type: "bool" }, { name: "active", type: "bool" }, { name: "createdAt", type: "uint64" }, { name: "rate", type: "uint256" },
  { name: "balance6", type: "uint256" }, { name: "spent6", type: "uint256" }, { name: "runner", type: "bytes32" },
  { name: "runnerOperator", type: "address" }, { name: "leaseUntil", type: "uint64" }] }] }];
const rpcs = ["https://base-rpc.publicnode.com", "https://base-mainnet.public.blastapi.io"].map((u) => createPublicClient({ chain: base, transport: http(u) }));
const zero = "0x0000000000000000000000000000000000000000", end = Date.now() + secs * 1000;
// no process.exit(): on Windows it can ABORT in libuv while the RPC client's sockets close (UV_HANDLE_CLOSING,
// src\win\async.c), turning a printed "visible" into a crash code (enclave-d1's box run). The verdict line is the result;
// the exit code is set, and the process ends by itself.
let code = 4;
for (;;) {
  const owners = await Promise.all(rpcs.map((c) => c.readContract({ address: "0xF9e71385C5cB49844F2457ba6567De0742f8B89a", abi, functionName: "get", args: [id] })
    .then((d) => String(d.owner).toLowerCase()).catch(() => "unreadable")));
  if (owners.every((o) => o === want)) { console.log(`visible ${owners.join(" ")}`); code = 0; break; }
  if (owners.some((o) => o !== want && o !== zero && o !== "unreadable")) { console.log(`not-operator ${owners.join(" ")}`); code = 3; break; }
  if (Date.now() > end) { console.log(`timeout ${owners.join(" ")}`); code = 4; break; }
  await new Promise((r) => setTimeout(r, 5000));
}
process.exitCode = code;
'@
  try {
    $v = Invoke-Native { & $NodeExe $check $id $Operator $VisibleTimeoutSec 2>&1 }
    # judged by the helper's own VERDICT line, not its exit code (a Windows libuv abort after the line is printed must
    # not turn "visible" into "not visible", nor anything else into "visible")
    $word = @($v | ForEach-Object { "$_" } | Where-Object { $_ -match '^(visible|not-operator|timeout) ' } | Select-Object -First 1)
    $vc = if ($word.Count -and $word[0] -match '^visible ') { 0 } elseif ($word.Count -and $word[0] -match '^not-operator ') { 3 } else { 4 }
  } finally { Remove-Item -Force $check -ErrorAction SilentlyContinue }
  Write-Output "ledger> $v"
  if ($vc -eq 3) { Die "$id is owned by another address on the ledger, not the operator ${Operator}: nothing funded" }
  if ($vc -ne 0) { Die "$id did not become visible as the operator's on both RPCs within $VisibleTimeoutSec s: nothing funded" }
  $r = Invoke-WithKey @($cli, 'fund', $id, '--usdc', $FundUsd, '--yes') 'fund'
  $tx = @($r.out | ForEach-Object { "$_" } | Select-String -Pattern '0x[0-9a-f]{64}' -AllMatches | ForEach-Object { $_.Matches } | ForEach-Object { $_.Value } | Where-Object { $_ -ne $id })
  Set-Content -Path (Join-Path $Root 'test1-funded.txt') -Encoding ASCII -Value ("$id funded $FundUsd USDC at $($r.stamp); exit $($r.code); tx " + $(if ($tx.Count) { $tx -join ' ' } else { '(none printed; see logs\test1-fund-' + $r.stamp + '.out)' }))
  if ($r.code -ne 0) { Die "the fund exited $($r.code) (recorded in test1-funded.txt; see the logs)" }
  Write-Output "FUNDED $id with $FundUsd USDC (recorded in test1-funded.txt)."
}
Write-Output "Next: wait for this box to claim it, then hvnode-accept.ps1 -Commit <c> -DeploymentId $id, and on the workstation hvnode-accept-remote.sh $id <A7's transportKeySha256>"
