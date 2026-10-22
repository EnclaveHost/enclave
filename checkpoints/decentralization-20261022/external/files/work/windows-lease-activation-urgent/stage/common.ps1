# common.ps1 - shared definitions for the app-lease activation scripts (dot-sourced; changes nothing by itself).
# Public paths only. No key, credential, environment or database content is read or printed by any of these scripts;
# the node configuration files are only tested for one exact line (a yes/no answer) and appended to.
$ErrorActionPreference = 'Stop'
$PlanId    = 'app-lease-recovery-20261020'
$PF        = Join-Path $env:ProgramFiles 'Enclave'
$PD        = Join-Path $env:ProgramData 'Enclave'
$Control   = Join-Path $PF 'control'
$Node      = Join-Path $PF 'runtime\node\node.exe'
$Agent     = Join-Path $Control 'windows\node\agent.mjs'
$RunNode   = Join-Path $PD 'run-node.cmd'
$NodeCfg   = Join-Path $PD 'node-config.cmd'
$NodeLocal = Join-Path $PD 'node-config.local.cmd'
$LeaseDir  = Join-Path $PD 'lease-gas'
$LeaseCmd  = Join-Path $LeaseDir 'lease-gas-config.cmd'
$LeaseDep  = Join-Path $LeaseDir 'deployment.json'
$ActState  = Join-Path $PD 'control-activation'
$CfgState  = Join-Path $ActState "$PlanId-config"
$CallLine  = 'call "' + $LeaseCmd + '"'
$LocalCall = 'call "' + $NodeLocal + '"'
$Tool      = Join-Path $Stage 'tool\activate-control-source.mjs'
$Plan      = Join-Path $Stage 'control-plan.json'
$Source    = Join-Path $Stage 'source'
$Want = @{ 'deployment.json' = '1665c2186e59bf0178387d43562f4982d6f2748230d4afa627f09705a19e6089'
           'lease-gas-config.cmd' = '9ed3c199db6968a4274b40e9940a65a591f68295b1c3dae44e23084a27efa56e' }

function Sha([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() } else { $null } }
function Say([string]$m) { Write-Output ("[" + [DateTime]::UtcNow.ToString('o') + "] " + $m) }
# the node agent (the node.exe running control\windows\node\agent.mjs) and its run-node.cmd loop
function AgentProcs { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { [string]$_.CommandLine -like ('*' + $Agent + '*') }) }
function LoopProcs  { @(Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { [string]$_.CommandLine -like '*run-node.cmd*' }) }
# a yes/no answer for one exact line; the file's content is never printed
function HasLine([string]$file, [string]$line) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  return [bool](Select-String -LiteralPath $file -SimpleMatch -Pattern $line -Quiet)
}
function SetsLeaseGas([string]$file) {
  if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
  return [bool](Select-String -LiteralPath $file -Pattern '^\s*@?set\s+"?(ENCLAVE_)?LEASE_GAS_' -Quiet)
}
# where the call is added: node-config.local.cmd when node-config.cmd calls it (updates never write that file), else node-config.cmd
function ConfigTarget { if (HasLine $NodeCfg $LocalCall) { $NodeLocal } else { $NodeCfg } }
# only the lease mode (and the operator address, public) from the agent's loopback state
function LeaseMode {
  try { $s = Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:9600/v1/host/state'; return [pscustomobject]@{ leaseGas = $s.availability.leaseGas; operator = $s.availability.operator } }
  catch { return [pscustomobject]@{ leaseGas = $null; operator = $null; error = $_.Exception.Message } }
}
function Vms { try { @((Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:8091/vms').vms | Select-Object id, status) } catch { $null } }
$ToolState = Join-Path $ActState $PlanId
# the tool's own status for the plan (JSON it prints): file states before/after/other, agent, VMs
function ToolStatus { $o = (& $Node $Tool status --plan $Plan | Out-String); return ($o | ConvertFrom-Json) }
function AllBefore { $s = ToolStatus; return (@($s.files | Where-Object { $_.state -ne 'before' }).Count -eq 0) }
# a NEW directory readable by SYSTEM and Administrators only (inheritance removed), made before anything is put in it
function NewPrivateDir([string]$d) {
  if (Test-Path -LiteralPath $d) { throw "$d already exists" }
  New-Item -ItemType Directory -Path $d | Out-Null
  & icacls.exe $d /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "could not restrict $d" }
  $acl = Get-Acl -LiteralPath $d
  $ids = @($acl.Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object -Unique)
  if (-not $acl.AreAccessRulesProtected -or ($ids -join ',') -ne 'S-1-5-18,S-1-5-32-544') { throw "$d is not SYSTEM + Administrators only ($($ids -join ','))" }
}
# create-only writes: an existing file is never replaced
function WriteNew([string]$p, [string]$text) {
  $fs = [IO.File]::Open($p, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
  try { $b = [Text.Encoding]::ASCII.GetBytes($text); $fs.Write($b, 0, $b.Length); $fs.Flush($true) } finally { $fs.Close() }
}
# replace $dst by the bytes of $src atomically, keeping $dst's OWN ACL (not the temp file's inherited one)
function RestoreKeepAcl([string]$src, [string]$dst) {
  $tmp = "$dst.rollback-tmp"
  [IO.File]::Copy($src, $tmp, $true)
  Get-Acl -LiteralPath $dst | Set-Acl -LiteralPath $tmp
  Move-Item -LiteralPath $tmp -Destination $dst -Force
}
