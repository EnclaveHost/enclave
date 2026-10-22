# Shared by every Windows stage script (dot-sourced). Stage hs2. Windows PowerShell 5.1 compatible.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3
$Label    = 'hs2'
$Stage    = Split-Path -Parent $PSScriptRoot                                  # the extracted stage directory
$LocalService = '*S-1-5-19'                                                   # NT AUTHORITY\LOCAL SERVICE (unprivileged, like DynamicUser)
function Fail([string]$m, [int]$code = 3) { Write-Error ("{0}: {1}" -f (Split-Path -Leaf $MyInvocation.PSCommandPath), $m) -ErrorAction Continue; exit $code }
# Production defaults. -InstallRoot <dir> -TaskName <name> (both, on every script) select an ISOLATED install instead:
# <dir>\program and <dir>\root replace the two production directories, the task is \<name> and the stop event is derived
# from <dir>. <dir> must be a canonical, not yet existing directory under C:\ProgramData that overlaps no production
# stage path. Every script calls Use-StageRoot right after dot-sourcing this file: a refusal (Fail) must exit the SCRIPT,
# and `exit` reached while this file is still being dot-sourced would only leave this file. Nothing is written here.
function Use-StageRoot {
  $script:Isolated = [string](Get-Variable -Name InstallRoot -Scope Script -ValueOnly -ErrorAction SilentlyContinue)
  $script:IsoTask  = [string](Get-Variable -Name TaskName -Scope Script -ValueOnly -ErrorAction SilentlyContinue)
  $iso = $script:Isolated; $tn = $script:IsoTask
  if ($iso -or $tn) {
    if (-not ($iso -and $tn)) { Fail '-InstallRoot and -TaskName go together (an isolated install has its own task)' }
    if ($iso -notmatch '^C:\\ProgramData\\[^\\]' -or $iso.EndsWith('\') -or [IO.Path]::GetFullPath($iso) -ne $iso -or $iso.Contains('/')) {
      Fail "-InstallRoot must be a canonical absolute path under C:\ProgramData (got '$iso')" }
    $lower = $iso.ToLowerInvariant() + '\'
    foreach ($p in 'C:\ProgramData\Enclave\host-services\', 'C:\Program Files\Enclave\') {
      $q = $p.ToLowerInvariant(); if ($lower.StartsWith($q) -or $q.StartsWith($lower)) { Fail "-InstallRoot '$iso' overlaps the production path $p" } }
    if ($tn -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' -or $tn -like 'enclave-host-services-*') { Fail "-TaskName '$tn' is not a distinct task name" }
    $script:Opt      = $iso + '\program'
    $script:Root     = $iso + '\root'
    $script:TaskPath = '\'
    $script:TaskName = $tn
    $sha = [Security.Cryptography.SHA256]::Create()
    $script:EventLabel = $Label + '-' + (-join ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($lower))[0..3] | ForEach-Object { $_.ToString('x2') }))
  } else {
    $script:Opt      = 'C:\Program Files\Enclave\host-services\' + $Label   # bin, packages, windows scripts (read-only to the service)
    $script:Root     = 'C:\ProgramData\Enclave\host-services\' + $Label
    $script:TaskPath = '\Enclave\'
    $script:TaskName = 'enclave-host-services-' + $Label
    $script:EventLabel = $Label
  }
  $script:Cfg     = $script:Root + '\config'                                # host-services.json, supervisor.json, install-receipt.txt
  $script:Data    = $script:Root + '\data'                                  # PUBLIC data filled by an administrator; read-only to the service
  $script:State   = $script:Root + '\state'                                 # the service's only writable directory
  $script:Receipt = $script:Cfg + '\install-receipt.txt'
}
# Native tools report progress on stderr. When the caller redirects output (*> log, 2>&1), Windows PowerShell 5.1 turns
# every stderr line into an error record, and under 'Stop' the FIRST one aborts the script (W9: fill-data stopped after
# one object). Here stderr lines pass through as plain host text and the tool's exit code ($LASTEXITCODE) decides.
function Invoke-Tool([string]$Exe, [object[]]$ToolArgs = @()) {
  $ErrorActionPreference = 'Continue'
  & $Exe @ToolArgs 2>&1 | ForEach-Object { if ($_ -is [Management.Automation.ErrorRecord]) { Write-Host ([string]$_) } else { $_ } }
}
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
