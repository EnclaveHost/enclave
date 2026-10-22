# common.ps1 - shared definitions for the hardening release (dot-sourced; changes nothing by itself). Public paths only:
# no key, credential, environment or database content is read or printed. The lease-gas settings installed by the
# previous activation are only hash-checked (they stay exactly as they are).
$ErrorActionPreference = 'Stop'
$PlanId    = 'app-lease-hardening-20261021'
$PF        = Join-Path $env:ProgramFiles 'Enclave'
$PD        = Join-Path $env:ProgramData 'Enclave'
$Control   = Join-Path $PF 'control'
$Node      = Join-Path $PF 'runtime\node\node.exe'
$Agent     = Join-Path $Control 'windows\node\agent.mjs'
$NodeCfg   = Join-Path $PD 'node-config.cmd'
$NodeLocal = Join-Path $PD 'node-config.local.cmd'
$LeaseDir  = Join-Path $PD 'lease-gas'
$LeaseCmd  = Join-Path $LeaseDir 'lease-gas-config.cmd'
$CallLine  = 'call "' + $LeaseCmd + '"'
$ActState  = Join-Path $PD 'control-activation'
$ToolState = Join-Path $ActState $PlanId
$Tool      = Join-Path $Stage 'tool\activate-control-source.mjs'
$Plan      = Join-Path $Stage 'control-plan.json'
$Source    = Join-Path $Stage 'source'
$Want = @{ 'deployment.json' = '1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089'
           'lease-gas-config.cmd' = '9ed3c199db6968a4274b40e9940a65a591f68295b1c3dae44e23084a27efa56e' }

function Sha([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() } else { $null } }
function Say([string]$m) { Write-Output ("[" + [DateTime]::UtcNow.ToString('o') + "] " + $m) }
# the node agent (node.exe running control\windows\node\agent.mjs) and its run-node.cmd loop. ALWAYS count them as
# @(AgentProcs).Count: PowerShell 5 unrolls a one-element result to the bare CIM object, whose .Count is null
# (measured on this host 2026-10-21; the previous activation's observer reported UNOBSERVED for that reason).
function AgentProcs { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { [string]$_.CommandLine -like ('*' + $Agent + '*') }) }
function LoopProcs  { @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { [string]$_.CommandLine -like '*run-node.cmd*' }) }
function HasLine([string]$file, [string]$line) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  return [bool](Select-String -LiteralPath $file -SimpleMatch -Pattern $line -Quiet)
}
# only the lease mode and the operator address (public) from the agent's loopback state
function LeaseMode {
  try { $s = Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:9600/v1/host/state'; return [pscustomobject]@{ leaseGas = $s.availability.leaseGas; operator = $s.availability.operator } }
  catch { return [pscustomobject]@{ leaseGas = $null; operator = $null; error = $_.Exception.Message } }
}
function Healthy { try { return [bool](Invoke-RestMethod -TimeoutSec 3 'http://127.0.0.1:9600/v1/health').ok } catch { return $false } }
function Vms { try { @((Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:8091/vms').vms | Select-Object id, status) } catch { $null } }
# the tool's own status for this plan; anything incomplete is an error (outcome unknown), never "fine"
function ToolStatus {
  $o = (& $Node $Tool status --plan $Plan | Out-String)
  if ($LASTEXITCODE -ne 0) { throw "activation tool status failed; outcome unknown" }
  $observed = $o | ConvertFrom-Json
  $expectedCount = @((Get-Content -LiteralPath $Plan -Raw | ConvertFrom-Json).files).Count
  if ($observed.plan -ne $PlanId -or @($observed.files).Count -ne $expectedCount) { throw "activation tool status did not cover the reviewed plan" }
  return $observed
}
function AllState([string]$want) { $s = ToolStatus; return (@($s.files | Where-Object { $_.state -ne $want }).Count -eq 0) }
function SettingsOk { foreach ($f in $Want.Keys) { if ((Sha (Join-Path $LeaseDir $f)) -ne $Want[$f]) { return $false } }; return (HasLine $NodeLocal $CallLine) -or (HasLine $NodeCfg $CallLine) }
