#Requires -RunAsAdministrator
# Roll Windows stage hs2 back to exactly the pre-install state, touching ONLY what install.ps1 recorded: stop; remove
# the one scheduled task (only if its action is still this stage's supervisor); remove each installed file whose bytes are
# still what install wrote (a changed file is KEPT and reported, exit 4); remove the filled data and the state (unless
# -KeepData / -KeepState) and the directories install created. Stage 1 published nothing: there is no public rollback.
param([switch]$KeepData, [switch]$KeepState)
. (Join-Path $PSScriptRoot 'common.ps1')
if (-not (Test-Path -LiteralPath $Receipt)) { Fail "no install receipt ($Receipt): nothing of stage $Label to roll back" }
$lines = Get-Content -LiteralPath $Receipt
$modified = $false
& (Join-Path $PSScriptRoot 'stop.ps1')
foreach ($l in $lines) {
  if ($l -match '^task (\\Enclave\\)(\S+) (.+)$') {
    $t = Get-ScheduledTask -TaskPath $Matches[1] -TaskName $Matches[2] -ErrorAction SilentlyContinue
    if ($t) {
      if ($t.Actions[0].Execute -ne $Matches[3]) { Write-Warning "KEPT (changed since install): task $($Matches[1])$($Matches[2])"; $modified = $true }
      else { Unregister-ScheduledTask -TaskPath $Matches[1] -TaskName $Matches[2] -Confirm:$false }
    }
  }
}
foreach ($l in $lines) {
  if ($l -match '^file ([0-9a-f]{64}) (.+)$') {
    $f = $Matches[2]
    if ($f -eq $Receipt -or -not (Test-Path -LiteralPath $f)) { continue }
    if ((Sha $f) -eq $Matches[1]) { Remove-Item -LiteralPath $f -Force } else { Write-Warning "KEPT (changed since install): $f"; $modified = $true }
  }
}
if (-not $KeepData) { foreach ($d in "$Data\artifacts", "$Data\policy-import") { if (Test-Path -LiteralPath $d) { Remove-Item -LiteralPath $d -Recurse -Force } } }
if (-not $KeepState -and (Test-Path -LiteralPath $State)) { Remove-Item -LiteralPath $State -Recurse -Force }
if (-not $modified) { Remove-Item -LiteralPath $Receipt -Force }
# directories install created, deepest first, removed only when empty
$dirs = @($lines | Where-Object { $_ -like 'dir *' } | ForEach-Object { $_.Substring(4) })
[array]::Reverse($dirs)
foreach ($d in $dirs) { if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force | Select-Object -First 1)) { Remove-Item -LiteralPath $d -Force } }
Write-Output "rolled back Windows stage $Label$(if ($KeepData) { ' (data kept)' })$(if ($KeepState) { ' (state kept)' })"
if ($modified) { exit 4 }
