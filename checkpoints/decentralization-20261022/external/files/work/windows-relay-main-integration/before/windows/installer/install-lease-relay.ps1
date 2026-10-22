# install-lease-relay.ps1 - this host's OWN app-funded lease relay, as a host service beside Shield, Node and Network.
#
# Why a host service: an app-funded claim, renewal or release must be submitted by SOME relay, which pays the gas and is
# reimbursed by the app's reserve in the same transaction. A relay that ran as a leased Enclave app would need a relay
# for its own lease (circular on a cold start), and relays on shared cloud machines are a single provider. Each host
# therefore relays its own lease operations: the node agent posts to this loopback relay FIRST
# (ENCLAVE_LEASE_GAS_LOCAL_RELAY=http://127.0.0.1:<port>) and to other relays only as alternates. Nothing it needs runs
# outside this machine except the public chain RPCs it names.
#
# The bootstrap capital is the host operator's: the relay key holds a small float (between -MinFloatEth and
# -MaxFloatEth; the relay refuses to start above the cap). Every relayed operation is reimbursed from the app's reserve
# atomically, so the float is not spent on apps' behalf. Reverted or raced transactions can still cost it gas (bounded by
# the cap). The key is generated HERE, written create-only into a SYSTEM + Administrators directory, and never printed,
# copied or read by this script. Fund the relay address (printed from /v1/info) only after review.
#
# From a reviewed release directory (scripts/build-lease-relay-release.mjs: lease-relay.mjs, lease-relay-check.mjs,
# manifest.json). Idempotent: an existing key or send record is kept; a different release is installed beside the old.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File install-lease-relay.ps1 -Release <dir> -ArtifactSha256 <hex> `
#     -Record C:\ProgramData\Enclave\lease-gas\deployment.json -Digest sha256:<hex> `
#     -Rpcs https://a,https://b,https://c -Quorum 2 -MaxFloatEth 0.0002 -MinFloatEth 0.00005 [-Port 8549] [-NoTask]
# -NoTask installs files only (no scheduled task registered or started), for a scratch verification under other roots.
param(
  [Parameter(Mandatory = $true)][string]$Release,
  [Parameter(Mandatory = $true)][string]$ArtifactSha256,
  [Parameter(Mandatory = $true)][string]$Record,
  [Parameter(Mandatory = $true)][string]$Digest,
  [Parameter(Mandatory = $true)][string]$Rpcs,
  [Parameter(Mandatory = $true)][int]$Quorum,
  [Parameter(Mandatory = $true)][string]$MaxFloatEth,
  [Parameter(Mandatory = $true)][string]$MinFloatEth,
  [int]$Port = 8549,
  [string]$ProgramRoot = (Join-Path $env:ProgramFiles 'Enclave'),
  [string]$DataRoot = (Join-Path $env:ProgramData 'Enclave'),
  [string]$Node = (Join-Path (Join-Path $env:ProgramFiles 'Enclave') 'runtime\node\node.exe'),
  [switch]$NoTask
)
$ErrorActionPreference = 'Stop'
function Sha([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() } else { $null } }
function Say([string]$m) { Write-Output ("[lease-relay] " + $m) }

# ---- 1. the reviewed release: every file is its manifest's, and the artifact is the reviewed one
$ArtifactSha256 = $ArtifactSha256.ToLower()
if ($ArtifactSha256 -notmatch '^[0-9a-f]{64}$') { throw "-ArtifactSha256 must be 64 hex" }
$manifest = Get-Content -LiteralPath (Join-Path $Release 'manifest.json') -Raw | ConvertFrom-Json
if ($manifest.format -ne 'enclave-lease-relay-release/v1') { throw "$Release\manifest.json is not a lease relay release manifest" }
if ($manifest.artifact.sha256 -ne $ArtifactSha256) { throw "the release manifest names artifact $($manifest.artifact.sha256), not the reviewed $ArtifactSha256" }
if ((Sha (Join-Path $Release 'lease-relay.mjs')) -ne $ArtifactSha256) { throw "lease-relay.mjs is not the reviewed artifact" }
if ((Sha (Join-Path $Release 'lease-relay-check.mjs')) -ne $manifest.check.sha256) { throw "lease-relay-check.mjs is not the manifest's" }
if (-not (Test-Path -LiteralPath $Node -PathType Leaf)) { throw "no node runtime at $Node" }
if ($Port -lt 1 -or $Port -gt 65535) { throw "-Port must be 1..65535" }
if ($Quorum -lt 2) { throw "-Quorum must be at least 2" }

# ---- 2. the program files: releases\<sha>\ (read-only data; the run loop starts exactly this directory's files)
$relDir = Join-Path $ProgramRoot "lease-relay\releases\$ArtifactSha256"
New-Item -ItemType Directory -Force -Path $relDir | Out-Null
foreach ($f in 'lease-relay.mjs', 'lease-relay-check.mjs', 'manifest.json') {
  $src = Join-Path $Release $f; $dst = Join-Path $relDir $f
  if ((Sha $dst) -ne (Sha $src)) { Copy-Item -LiteralPath $src -Destination "$dst.tmp" -Force; Move-Item -LiteralPath "$dst.tmp" -Destination $dst -Force }
  if ((Sha $dst) -ne (Sha $src)) { throw "$dst did not install intact" }
}
Say "release $ArtifactSha256 installed in $relDir"

# ---- 3. the private data directory: SYSTEM + Administrators only, made before anything goes into it
$dataDir = Join-Path $DataRoot 'lease-relay'
if (-not (Test-Path -LiteralPath $dataDir)) {
  New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
  & icacls.exe $dataDir /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not restrict $dataDir" }
}
$acl = Get-Acl -LiteralPath $dataDir
$ids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
if (-not $acl.AreAccessRulesProtected -or ($ids -join ',') -ne 'S-1-5-18,S-1-5-32-544') { throw "$dataDir is not SYSTEM + Administrators only ($($ids -join ',')); fix it before installing a key there" }

# ---- 4. the key: generated HERE, create-only, never printed or read back by this script
$keyFile = Join-Path $dataDir 'relay.key'
if (Test-Path -LiteralPath $keyFile) { Say "the existing relay key is kept ($keyFile)" }
else {
  & $Node -e "const c=require('crypto'),fs=require('fs');const d=Buffer.from(c.generateKeyPairSync('ec',{namedCurve:'secp256k1'}).privateKey.export({format:'jwk'}).d,'base64url');if(d.length!==32)throw new Error('bad key length');fs.writeFileSync(process.argv[1],d.toString('hex')+'\n',{flag:'wx'});" $keyFile
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $keyFile)) { throw "the relay key could not be created" }
  Say "a new relay key was generated in $keyFile (not displayed)"
}

# ---- 5. the public settings and the run loop (no key or secret in either)
$record = (Resolve-Path -LiteralPath $Record).Path
$stateFile = Join-Path $dataDir 'relay-send.json'
$cfg = Join-Path $dataDir 'relay-config.cmd'
$listen = "127.0.0.1:$Port"
@(
  '@echo off',
  'rem The host lease relay settings. Written by install-lease-relay.ps1; public values only (the key stays in relay.key).',
  "set `"LEASE_RELAY_RECORD=$record`"",
  "set `"LEASE_RELAY_DIGEST=$Digest`"",
  "set `"LEASE_RELAY_RPCS=$Rpcs`"",
  "set `"LEASE_RELAY_QUORUM=$Quorum`"",
  "set `"LEASE_RELAY_MAX_FLOAT_ETH=$MaxFloatEth`"",
  "set `"LEASE_RELAY_MIN_FLOAT_ETH=$MinFloatEth`"",
  "set `"LEASE_RELAY_LISTEN=$listen`"",
  "set `"LEASE_RELAY_KEY_FILE=$keyFile`"",
  "set `"LEASE_RELAY_STATE=$stateFile`"",
  "set `"LEASE_RELAY_ARTIFACT_SHA256=$ArtifactSha256`""
) | Set-Content -Encoding ASCII -LiteralPath $cfg
$log = Join-Path $DataRoot 'logs\lease-relay.log'
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
$run = Join-Path $DataRoot 'run-relay.cmd'
@(
  '@echo off',
  'rem The host lease relay. Written by install-lease-relay.ps1. The check refuses unless every setting is explicit and valid',
  'rem and this directory holds the reviewed artifact; the relay itself refuses a key above its float cap.',
  "call `"$cfg`"",
  "cd /d `"$relDir`"",
  ':loop',
  "`"$Node`" `"$relDir\lease-relay-check.mjs`" >> `"$log`" 2>&1",
  'if errorlevel 1 (',
  "  echo %date% %time% [run] configuration check failed; retrying in 60 s >> `"$log`"",
  '  ping -n 61 127.0.0.1 >nul',
  '  goto loop',
  ')',
  "`"$Node`" `"$relDir\lease-relay.mjs`" >> `"$log`" 2>&1",
  "echo %date% %time% [run] relay exited %errorlevel%; restarting in 10 s >> `"$log`"",
  'ping -n 11 127.0.0.1 >nul',
  'goto loop'
) | Set-Content -Encoding ASCII -LiteralPath $run
Say "settings $cfg, run loop $run, log $log"

# ---- 6. the scheduled task, like Shield, Node and Network (SYSTEM, at startup)
if ($NoTask) { Say "-NoTask: no scheduled task registered or started"; exit 0 }
$a = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/c `"$run`""
$t = New-ScheduledTaskTrigger -AtStartup; $t.Delay = 'PT60S'
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$s = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
$existing = Get-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Relay' -ErrorAction SilentlyContinue
if ($existing) { Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Relay' -ErrorAction SilentlyContinue }
Register-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Relay' -Action $a -Trigger $t -Principal $p -Settings $s -Force | Out-Null
Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Relay'
Say "task \Enclave\Relay registered and started"
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep 1
  try { $info = Invoke-RestMethod -TimeoutSec 3 "http://$listen/v1/info"; Say "serving: payee (fund this relay address with its float) $($info.payee); reserve $($info.reserve)"; exit 0 } catch {}
}
Say "the relay did not answer on $listen within 90 s: see $log (an unfunded key still serves; a key above its cap refuses to start)"
exit 3
