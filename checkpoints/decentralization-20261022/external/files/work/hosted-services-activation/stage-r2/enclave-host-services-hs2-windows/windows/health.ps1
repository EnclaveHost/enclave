# Stage-1 health of Windows stage hs2: the task is running, a FRESH decision of the unchanged platform host policy
# gate for this host, the four roles, served artifacts, real DNS (including every static platform label), the policy
# mirror. Exit 0 healthy, 2 unhealthy.
param([int]$WaitSeconds = 0, [switch]$AllArtifacts)
. (Join-Path $PSScriptRoot 'common.ps1')
$t = Get-Task
if ($null -eq $t -or $t.State -ne 'Running') { Write-Output "FAIL  task $TaskPath$TaskName is not running ($(if ($t) { $t.State } else { 'absent' }))"; exit 2 }
$sup = Get-Supervisor
$extra = @(); if ($AllArtifacts) { $extra = @('--artifacts', 'all') }
$deadline = (Get-Date).AddSeconds($WaitSeconds)
while ($true) {
  & $sup.node "$Opt\bin\stage-tool.mjs" health --config "$Cfg\host-services.json" @extra
  if ($LASTEXITCODE -eq 0) { exit 0 }
  if ((Get-Date) -ge $deadline) { exit 2 }
  Write-Output '(not healthy yet; retrying in 10 s)'; Start-Sleep -Seconds 10
}
