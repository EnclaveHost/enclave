#Requires -RunAsAdministrator
# Stop stage hs2: the supervisor's stop event -> CTRL_BREAK to the runner (it stops every role and exits 0); after
# stopTimeoutSec the supervisor terminates the job. If the task is still running 15 s after that, the task is ended
# (KILL_ON_JOB_CLOSE ends the whole tree). Then prove none of the stage's ports is listening. Nothing public changes.
. (Join-Path $PSScriptRoot 'common.ps1')
$sup = Get-Supervisor
$t = Get-Task
if ($t -and $t.State -eq 'Running') {
  & "$Opt\bin\hostsvc-supervisor.exe" stop "$Cfg\supervisor.json"
  $deadline = (Get-Date).AddSeconds([int]$sup.stopTimeoutSec + 15)
  while ((Get-Task).State -eq 'Running' -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
  if ((Get-Task).State -eq 'Running') { Write-Warning 'the supervisor did not exit in time: ending the task (the job kills the tree)'; Stop-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName }
}
Start-Sleep -Seconds 2
$left = @()
foreach ($p in Get-StagePorts) {
  if (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) { $left += "tcp/$p" }
  if (Get-NetUDPEndpoint -LocalPort $p -ErrorAction SilentlyContinue) { $left += "udp/$p" }
}
if ($left.Count) { Fail "ports still listening after stop: $($left -join ', ')" }
Write-Output "stopped $TaskPath$TaskName; none of the stage ports ($((Get-StagePorts) -join ' ')) is listening"
