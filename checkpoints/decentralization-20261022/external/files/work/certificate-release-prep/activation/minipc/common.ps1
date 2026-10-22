# common.ps1 - shared definitions for the certificate (Shield app-zone) release on minipc (dot-sourced; changes nothing).
# Public paths and values only: no key, credential, environment or database content is read or printed. Settings files are
# changed by compare-and-swap on their sha256 (never printed) with a verified backup.
$ErrorActionPreference = 'Stop'
$PlanId     = 'certificate-shield-appzone-20261021'
$PF         = Join-Path $env:ProgramFiles 'Enclave'
$PD         = Join-Path $env:ProgramData 'Enclave'
$Control    = Join-Path $PF 'control'
$Node       = Join-Path $PF 'runtime\node\node.exe'
$Agent      = Join-Path $Control 'windows\node\agent.mjs'
$Tool       = Join-Path $Stage 'tool\activate-control-source.mjs'   # byte-identical to the relay migration's (1815e173...)
$Plan       = Join-Path $Stage 'control-plan.json'
$Source     = Join-Path $Stage 'source'
$ShieldCfg  = Join-Path $PD 'shield-config.cmd'          # the manager's settings (task \Enclave\Shield)
$NodeLocal  = Join-Path $PD 'node-config.local.cmd'      # the node's local settings (task \Enclave\Node)
$DirectDir  = Join-Path $PD 'shield-direct'               # this release's public settings and the staged image
$MgrSet     = Join-Path $DirectDir 'shield-direct-manager.cmd'
$NodeSet    = Join-Path $DirectDir 'shield-direct-node.cmd'
$MgrCall    = 'call "' + $MgrSet + '"'
$NodeCall   = 'call "' + $NodeSet + '"'
$State      = Join-Path $PD "control-activation\$PlanId-settings"
. (Join-Path $Stage 'pins.ps1')                            # $ImageSha, $ImageFile, $RuntimeJsonSha, $RuntimeId (generated from the build)
$ImageDir   = Join-Path $DirectDir ("image-" + $ImageSha.Substring(0, 12))

function Sha([string]$p) { if (Test-Path -LiteralPath $p -PathType Leaf) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() } else { $null } }
function Say([string]$m) { Write-Output ("[" + [DateTime]::UtcNow.ToString('o') + "] " + $m) }
function AgentProcs { @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { [string]$_.CommandLine -like ('*' + $Agent + '*') }) }
function Healthy { try { return [bool](Invoke-RestMethod -TimeoutSec 3 'http://127.0.0.1:9600/v1/health').ok } catch { return $false } }
function Vms { try { @((Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:8091/vms').vms | Select-Object id, status) } catch { $null } }
function MgrHealth { try { return Invoke-RestMethod -TimeoutSec 5 'http://127.0.0.1:8091/health' } catch { return $null } }
function HasLine([string]$file, [string]$line) { (Test-Path -LiteralPath $file -PathType Leaf) -and [bool](Select-String -LiteralPath $file -SimpleMatch -Pattern $line -Quiet) }
function ToolStatus { $o = (& $Node $Tool status --plan $Plan | Out-String); if ($LASTEXITCODE -ne 0) { throw 'activation tool status failed' }; return ($o | ConvertFrom-Json) }
# append ONE call line to a settings file by compare-and-swap: from exactly $before, with a verified backup in $State
function AppendCall([string]$file, [string]$line, [string]$before) {
  $now = Sha $file
  if ($before -eq 'absent') { if ($now) { throw "$file exists ($now) but the preflight saw it absent: not changed" } }
  elseif ($now -ne $before) { throw "$file is $now, not the preflight's $before: not changed" }
  $bak = Join-Path $State ((Split-Path $file -Leaf) + '.before')
  if ($now) { Copy-Item -LiteralPath $file -Destination $bak; if ((Sha $bak) -ne $before) { throw "the backup of $file is not intact: not changed" } }
  else { Set-Content -LiteralPath ($bak + '.absent') -Value 'absent' -Encoding ASCII }
  $tmp = "$file.$PlanId.tmp"
  if ($now) { Copy-Item -LiteralPath $file -Destination $tmp -Force } else { Set-Content -LiteralPath $tmp -Value '@echo off' -Encoding ASCII }
  Add-Content -LiteralPath $tmp -Value $line -Encoding ASCII
  if ((Sha $file) -ne $now) { Remove-Item -LiteralPath $tmp -Force; throw "$file changed during the edit: not changed" }
  Move-Item -LiteralPath $tmp -Destination $file -Force
  if (-not (HasLine $file $line)) { throw "$file does not carry the call line after the edit" }
  return (Sha $file)
}
