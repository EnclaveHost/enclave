# W8 + W4 from a LOCAL SERVICE scheduled task (our own unique task; no trigger): the supervisor, running as LOCAL SERVICE,
# creates the Global\ stop event (SeCreateGlobalPrivilege); an Administrator opens and sets it; the runner gets CTRL_BREAK
# through the task's console and stops gracefully. The task is then unregistered (it is ours).
. "$PSScriptRoot\common-val.ps1"
$run = "$V\runs\w8"; $name = 'EnclaveHostServicesValidation-20261021-LocalService'
if (Get-ScheduledTask -TaskPath '\' -TaskName $name -ErrorAction SilentlyContinue) { throw "refusing: task $name already exists" }
$action = New-ScheduledTaskAction -Execute $Sup -Argument "run $run\supervisor.json" -WorkingDirectory "$run\state"
$principal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\LOCAL SERVICE' -LogonType ServiceAccount -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskPath '\' -TaskName $name -Action $action -Principal $principal -Settings $settings | Out-Null
try {
  Start-ScheduledTask -TaskPath '\' -TaskName $name
  $up = Wait-Until { (Test-Path "$run\state\runner.json") -and @((Read-Json "$run\state\runner.json").children).Count -eq 3 } 60
  $log = Text "$run\state\supervisor.log"
  Check 'W8 the LOCAL SERVICE supervisor created its Global stop event and started the runner' ($up -and $log -notmatch 'stop event:') ([ordered]@{ taskState = (Get-ScheduledTask -TaskPath '\' -TaskName $name).State.ToString() })
  $r = if ($up) { Read-Json "$run\state\runner.json" } else { $null }
  $rc = Stop-Sup $run
  Check 'W8 an Administrator opened and set the Global event' ($rc -eq 0) $rc
  $done = Wait-Until { (Get-ScheduledTask -TaskPath '\' -TaskName $name).State.ToString() -ne 'Running' } 45
  $log = Text "$run\state\supervisor.log"; $fake = Text "$run\state\fake-runner.log"
  Check 'W4 from the LOCAL SERVICE task: CTRL_BREAK reached the runner, graceful exit 0' ($done -and $log -match 'runner stopped \(0\)' -and $log -notmatch 'terminating the job' -and $fake -match 'SIGBREAK received') ([ordered]@{ lastTaskResult = (Get-ScheduledTaskInfo -TaskPath '\' -TaskName $name).LastTaskResult })
  if ($r) { Check 'W8 nothing of the tree remains' (Wait-Until { @(@($r.children) + @([int]$r.pid) | Where-Object { Alive $_ }).Count -eq 0 } 10) $null }
} finally {
  if ((Get-ScheduledTask -TaskPath '\' -TaskName $name).State.ToString() -eq 'Running') { Stop-ScheduledTask -TaskPath '\' -TaskName $name }
  Unregister-ScheduledTask -TaskPath '\' -TaskName $name -Confirm:$false
}
Check 'W8 our validation task is unregistered' ($null -eq (Get-ScheduledTask -TaskPath '\' -TaskName $name -ErrorAction SilentlyContinue)) $null
Done
