param([string]$Stage)
$ErrorActionPreference='Stop';$ProgressPreference='SilentlyContinue'
$task='cutover-api-canary-'+(Split-Path -Leaf $Stage);$taskPath='\Enclave\'
if(Get-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue){throw 'task collision'}
$registered=$false;$samples=@();$result=[ordered]@{task=$task;productionTaskTouched=$false}
try {
 $payload=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes('Start-Sleep -Seconds 45'))
 $a=New-ScheduledTaskAction -Execute "$PSHOME\powershell.exe" -Argument ('-NoProfile -NonInteractive -EncodedCommand '+$payload)
 $p=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
 $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
 $null=Register-ScheduledTask -TaskPath $taskPath -TaskName $task -Action $a -Principal $p -Settings $settings;$registered=$true
 foreach($i in 1,2) {
  $sw=[Diagnostics.Stopwatch]::StartNew();Start-ScheduledTask -TaskPath $taskPath -TaskName $task;$startMs=$sw.ElapsedMilliseconds
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  do{$state=[string](Get-ScheduledTask -TaskPath $taskPath -TaskName $task).State;if($state -ne 'Running'){Start-Sleep -Milliseconds 100}}while($state -ne 'Running' -and [DateTime]::UtcNow -lt $deadline)
  if($state -ne 'Running'){throw 'own test task did not run'}
  $sw.Restart();Stop-ScheduledTask -TaskPath $taskPath -TaskName $task;$stopMs=$sw.ElapsedMilliseconds
  $deadline=[DateTime]::UtcNow.AddSeconds(10)
  do{$state=[string](Get-ScheduledTask -TaskPath $taskPath -TaskName $task).State;if($state -eq 'Running'){Start-Sleep -Milliseconds 100}}while($state -eq 'Running' -and [DateTime]::UtcNow -lt $deadline)
  if($state -ne 'Ready'){throw 'own test task did not stop'}
  $samples += [ordered]@{round=$i;startMs=$startMs;stopMs=$stopMs;stateAfterStop=$state}
 }
 $result.pass=$true;$result.samples=$samples
} finally {
 if($registered){Stop-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskPath $taskPath -TaskName $task -Confirm:$false}
 $result.taskGone=-not [bool](Get-ScheduledTask -TaskPath $taskPath -TaskName $task -ErrorAction SilentlyContinue)
}
$result|ConvertTo-Json -Depth 6 -Compress
