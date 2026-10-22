# common.ps1 - shared definitions for the local-relay migration release (dot-sourced; changes nothing by itself).
# Public paths and values only: no key, credential, environment or database content is read or printed by any of these
# scripts. The moved relay key is only tested for presence and size; the send record is public signed bytes.
$ErrorActionPreference = 'Stop'
$PlanId    = 'local-relay-20261021'
$PF        = Join-Path $env:ProgramFiles 'Enclave'
$PD        = Join-Path $env:ProgramData 'Enclave'
$Control   = Join-Path $PF 'control'
$Node      = Join-Path $PF 'runtime\node\node.exe'
$Agent     = Join-Path $Control 'windows\node\agent.mjs'
$NodeCfg   = Join-Path $PD 'node-config.cmd'
$NodeLocal = Join-Path $PD 'node-config.local.cmd'
$LeaseDir  = Join-Path $PD 'lease-gas'
$LeaseCmd  = Join-Path $LeaseDir 'lease-gas-config.cmd'
$LeaseDep  = Join-Path $LeaseDir 'deployment.json'
$CallLine  = 'call "' + $LeaseCmd + '"'
$ActState  = Join-Path $PD 'control-activation'
$ToolState = Join-Path $ActState $PlanId
$CfgState  = Join-Path $ActState "$PlanId-config"
$Tool      = Join-Path $Stage 'tool\activate-control-source.mjs'
$CfgCheck  = Join-Path $Stage 'tool\lease-gas-config-check.mjs'
$Plan      = Join-Path $Stage 'control-plan.json'
$Source    = Join-Path $Stage 'source'
$NewBundle = Join-Path $Source 'windows\node\lease-gas-runtime.bundle.mjs'
$NewCfg    = Join-Path $Stage 'lease-gas\lease-gas-config.cmd'
# the relay: the moved us-west key, served on this machine's loopback only
$RelayData  = Join-Path $PD 'lease-relay'
$RelayKey   = Join-Path $RelayData 'relay.key'
$RelaySend  = Join-Path $RelayData 'relay-send.json'
$RelayPort  = 8549
$RelayUrl   = "http://127.0.0.1:$RelayPort"
$Payee      = '0x51ff183da8fF3b2dE08Da88331EED65e2F6A835c'   # the funded us-west relay key (relays-active.json)
$SourceOrigin = 'https://134.199.235.187'                      # where that key serves today (DigitalOcean us-west)
$Fallback   = 'https://134.209.248.172'                        # eu-central: the approved secondary, a TEMPORARY fallback
$Rpcs       = 'https://base-rpc.publicnode.com,https://mainnet.base.org,https://base-mainnet.public.blastapi.io'
$Quorum     = 2
$MaxFloat   = '0.0002'                                         # the approved float (the source relay's relay.env)
$MinFloat   = '0.00005'
$Digest     = 'sha256:1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089'
$Relay      = Join-Path $Stage 'relay'
$RelaySha   = '74d09e015c375e9cf2047ca4db578801b6ca41217593e61bbe2574bc2959bc64'   # lease-relay.mjs (scripts/build-lease-relay-release.mjs; reproducible, run r5)
$Migration  = Join-Path $Relay 'lease-relay-migration-check.mjs'
# the node's lease-gas settings: the bytes before (the previous activation's) and after (LOCAL_RELAY + eu-central)
$CfgBefore = '9ed3c199db6968a4274b40e9940a65a591f68295b1c3dae44e23084a27efa56e'
$CfgAfter  = '2324904b7b7b55e52108734447468849da25a4b857111b5cbc10525a701f603a'
$DepSha    = '1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089'

function Sha([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() } else { $null } }
function Say([string]$m) { Write-Output ("[" + [DateTime]::UtcNow.ToString('o') + "] " + $m) }
# ALWAYS count as @(...).Count: PowerShell 5 unrolls a one-element result to the bare CIM object (measured on this host)
function AgentProcs { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { [string]$_.CommandLine -like ('*' + $Agent + '*') }) }
function LoopProcs  { @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { [string]$_.CommandLine -like '*run-node.cmd*' }) }
function RelayProcs { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { [string]$_.CommandLine -like '*lease-relay\releases\*lease-relay.mjs*' }) }
function HasLine([string]$file, [string]$line) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  return [bool](Select-String -LiteralPath $file -SimpleMatch -Pattern $line -Quiet)
}
function LeaseMode {
  try { $s = Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:9600/v1/host/state'; return [pscustomobject]@{ leaseGas = $s.availability.leaseGas; operator = $s.availability.operator } }
  catch { return [pscustomobject]@{ leaseGas = $null; operator = $null; error = $_.Exception.Message } }
}
function Healthy { try { return [bool](Invoke-RestMethod -TimeoutSec 3 'http://127.0.0.1:9600/v1/health').ok } catch { return $false } }
function Vms { try { @((Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:8091/vms').vms | Select-Object id, status) } catch { $null } }
# the local relay's public answer (payee, chain, reserve, executor) or $null
function RelayInfo { try { return Invoke-RestMethod -TimeoutSec 3 "$RelayUrl/v1/info" } catch { return $null } }
function RelayIsTheMovedKey {
  $i = RelayInfo; if (-not $i) { return $false }
  $rec = Get-Content -LiteralPath $LeaseDep -Raw | ConvertFrom-Json
  return ([string]$i.payee -eq $Payee) -and ([int64]$i.chainId -eq [int64]$rec.chainId) -and ([string]$i.reserve -eq [string]$rec.reserve) -and ([string]$i.executor -eq [string]$rec.executor)
}
function PortListeners([int]$p) { @(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) }
function CfgState { $h = Sha $LeaseCmd; if ($h -eq $CfgBefore) { 'before' } elseif ($h -eq $CfgAfter) { 'after' } else { 'other' } }
# the config check: the node's settings file loaded by a given runtime bundle exactly as the agent loads it (no RPC, no signing)
function CfgCheck([string]$bundle, [string]$cfg, [string]$local, [string]$relays) {
  $o = (& $Node $CfgCheck --bundle $bundle --config $cfg --expect-local $local --expect-relays $relays | Out-String)
  return [pscustomobject]@{ ok = ($LASTEXITCODE -eq 0); out = $o.Trim() }
}
function ToolStatus {
  $o = (& $Node $Tool status --plan $Plan | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "activation tool status failed; outcome unknown" }
  $observed = $o | ConvertFrom-Json
  $expectedCount = @((Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json).files).Count
  if ($observed.plan -ne $PlanId -or @($observed.files).Count -ne $expectedCount) { throw "activation tool status did not cover the reviewed plan" }
  return $observed
}
function AllState([string]$want) { $s = ToolStatus; return (@($s.files | Where-Object { $_.state -ne $want }).Count -eq 0) }
function SettingsCalled { return (HasLine $NodeLocal $CallLine) -or (HasLine $NodeCfg $CallLine) }
# the relay data directory: SYSTEM + Administrators only, inheritance removed
function RelayDirAclOk {
  if (-not (Test-Path -LiteralPath $RelayData -PathType Container)) { return $false }
  $acl = Get-Acl -LiteralPath $RelayData
  $ids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
  return $acl.AreAccessRulesProtected -and (($ids -join ',') -eq 'S-1-5-18,S-1-5-32-544')
}
# stop the Node task, its run-node.cmd loop and the agent; VMs keep running in the manager (the agent re-adopts them)
function StopNode {
  Stop-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' -ErrorAction SilentlyContinue
  for ($i = 0; $i -lt 30 -and (@(LoopProcs).Count -or @(AgentProcs).Count); $i++) { Start-Sleep 1 }
  foreach ($p in @(LoopProcs)) { Stop-Process -Id $p.ProcessId -Force }
  foreach ($p in @(AgentProcs)) { Stop-Process -Id $p.ProcessId -Force }
  for ($i = 0; $i -lt 15 -and (@(LoopProcs).Count -or @(AgentProcs).Count); $i++) { Start-Sleep 1 }
  return -not (@(LoopProcs).Count -or @(AgentProcs).Count)
}
function StartNode { Enable-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' | Out-Null; Start-ScheduledTask -TaskPath '\Enclave\' -TaskName 'Node' }
# compare-and-swap the node's lease-gas settings: only from exactly $from to exactly $to (bytes staged/backed up), atomic rename
function SwapCfg([string]$fromSha, [string]$toFile, [string]$toSha) {
  if ((Sha $LeaseCmd) -ne $fromSha) { throw "lease-gas-config.cmd is $(Sha $LeaseCmd), not the expected ${fromSha}: not changed" }
  if ((Sha $toFile) -ne $toSha) { throw "$toFile is not the reviewed $toSha" }
  $tmp = "$LeaseCmd.$PlanId.tmp"
  Copy-Item -LiteralPath $toFile -Destination $tmp -Force
  if ((Sha $tmp) -ne $toSha) { Remove-Item -LiteralPath $tmp -Force; throw "the staged copy did not write intact" }
  if ((Sha $LeaseCmd) -ne $fromSha) { Remove-Item -LiteralPath $tmp -Force; throw "lease-gas-config.cmd changed during the swap: not changed" }
  Move-Item -LiteralPath $tmp -Destination $LeaseCmd -Force
  if ((Sha $LeaseCmd) -ne $toSha) { throw "lease-gas-config.cmd is not $toSha after the swap" }
}
