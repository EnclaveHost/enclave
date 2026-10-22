# Shared by every Windows stage script (dot-sourced). Stage @LABEL@. Windows PowerShell 5.1 compatible.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$Label    = '@LABEL@'
$Stage    = Split-Path -Parent $PSScriptRoot                                  # the extracted stage directory
$Opt      = 'C:\Program Files\Enclave\host-services\' + $Label                # bin, packages, windows scripts (read-only to the service)
$Root     = 'C:\ProgramData\Enclave\host-services\' + $Label
$Cfg      = $Root + '\config'                                                 # host-services.json, supervisor.json, install-receipt.txt
$Data     = $Root + '\data'                                                   # PUBLIC data filled by an administrator; read-only to the service
$State    = $Root + '\state'                                                  # the service's only writable directory
$Receipt  = $Cfg + '\install-receipt.txt'
$TaskPath = '\Enclave\'
$TaskName = 'enclave-host-services-' + $Label
$LocalService = '*S-1-5-19'                                                   # NT AUTHORITY\LOCAL SERVICE (unprivileged, like DynamicUser)
function Fail([string]$m, [int]$code = 3) { Write-Error ("{0}: {1}" -f (Split-Path -Leaf $MyInvocation.PSCommandPath), $m) -ErrorAction Continue; exit $code }
function Sha([string]$p) { (Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLowerInvariant() }
function Test-StageSums {
  foreach ($line in Get-Content -LiteralPath (Join-Path $Stage 'STAGE-SHA256SUMS')) {
    if ($line -notmatch '^([0-9a-f]{64})  (.+)$') { Fail "malformed STAGE-SHA256SUMS line: $line" }
    $f = Join-Path $Stage ($Matches[2] -replace '/', '\')
    if (-not (Test-Path -LiteralPath $f -PathType Leaf) -or (Sha $f) -ne $Matches[1]) { Fail "the stage does not match STAGE-SHA256SUMS: $($Matches[2])" }
  }
}
function Get-Task { Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -ErrorAction SilentlyContinue }
function Get-Supervisor { Get-Content -Raw -LiteralPath ($Cfg + '\supervisor.json') | ConvertFrom-Json }
function Get-StagePorts {
  $c = Get-Content -Raw -LiteralPath ($Cfg + '\host-services.json') | ConvertFrom-Json
  $ports = @()
  foreach ($s in $c.services) { foreach ($k in 'port', 'dnsPort', 'apiPort') { if ($s.config.PSObject.Properties.Name -contains $k) { $ports += [int]$s.config.$k } } }
  $ports
}
